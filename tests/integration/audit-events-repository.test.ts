import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Client } from "pg";
import {
  auditErrorCategories,
  insertAuditEvent,
  searchAuditEvents,
} from "~/lib/db/audit-events.server";
import { createDocument } from "~/lib/db/documents.server";
import { closePool } from "~/lib/db/pool.server";
import { dropSchema, migrateFreshSchema, newClient } from "./helpers/schema.js";

/**
 * T04 結合テスト: `audit_events` repository(設計 §12.2, §15.1, §16, §18.2)。
 *
 * 実際のPostgreSQLへ監査イベントを追記し、保存される列と値が設計 §12.2の範囲に
 * 限られること、禁止項目(HTML本文・ファイル名・token・grant・Cookie・principal
 * header・IPアドレス)がどの列にも入らないことを確認する。
 */

const schema = "t04_it_audit";
const actorSubjectId = "actor-oid-001";
const correlationId = "33333333-4444-4555-8666-777777777777";

let client: Client;

beforeAll(async () => {
  await migrateFreshSchema(schema);
  client = newClient();
  await client.connect();
  await client.query(`SET search_path TO "${schema}"`);
});

afterAll(async () => {
  await closePool();
  await client.end();
  await dropSchema(schema);
});

beforeEach(async () => {
  await client.query("TRUNCATE audit_events, documents");
});

async function storedRows() {
  const result = await client.query(
    "SELECT * FROM audit_events ORDER BY occurred_at",
  );
  return result.rows as Array<Record<string, unknown>>;
}

describe("insertAuditEvent", () => {
  it("設計 §12.2の列だけを保存し、保持期限を1年後に設定する", async () => {
    const document = await createDocument(
      { ownerSubjectId: actorSubjectId, byteSize: 10 },
      client,
    );

    const record = await insertAuditEvent(
      {
        action: "upload",
        result: "success",
        documentId: document.id,
        actorSubjectId,
        actorTenantId: "tenant-id",
        actorEmailAtEvent: "actor@example.com",
        actorGroupValues: ["ZAA535-A", "ZAA535-B"],
        actorRoles: ["User"],
        correlationId,
      },
      client,
    );

    const rows = await storedRows();
    expect(rows).toHaveLength(1);
    const row = rows[0] ?? {};

    expect(Object.keys(row).sort()).toEqual(
      [
        "action",
        "actor_email_at_event",
        "actor_group_values",
        "actor_roles",
        "actor_subject_id",
        "actor_tenant_id",
        "correlation_id",
        "document_id",
        "error_category",
        "id",
        "occurred_at",
        "result",
        "retain_until",
      ].sort(),
    );
    expect(row).toMatchObject({
      action: "upload",
      result: "success",
      document_id: document.id,
      actor_subject_id: actorSubjectId,
      actor_tenant_id: "tenant-id",
      actor_email_at_event: "actor@example.com",
      actor_group_values: ["ZAA535-A", "ZAA535-B"],
      actor_roles: ["User"],
      correlation_id: correlationId,
      error_category: null,
    });

    const occurredAt = row["occurred_at"] as Date;
    const retainUntil = row["retain_until"] as Date;
    expect(record.occurredAt.getTime()).toBe(occurredAt.getTime());
    expect(retainUntil.getUTCFullYear()).toBe(occurredAt.getUTCFullYear() + 1);
    expect(record.retainUntil.getTime()).toBe(retainUntil.getTime());
  });

  it("資料を作らずに失敗した操作も、資料IDなしで記録できる(設計 §11.1)", async () => {
    await insertAuditEvent(
      {
        action: "upload",
        result: "failed",
        actorSubjectId,
        actorTenantId: "tenant-id",
        correlationId,
        errorCategory: "html_inspection_failed",
      },
      client,
    );

    const rows = await storedRows();
    expect(rows[0]).toMatchObject({
      document_id: null,
      result: "failed",
      error_category: "html_inspection_failed",
    });
  });

  it("禁止項目を渡した操作は保存されない(設計 §12.2)", async () => {
    const forbidden = {
      action: "view",
      result: "success",
      actorSubjectId,
      actorTenantId: "tenant-id",
      correlationId,
      originalFileName: "極秘資料.html",
      htmlBody: "<html>secret</html>",
      accessToken: "ey.Jtoken",
      grant: "signed-grant-value",
      cookie: "__Host-session=abc",
      principalHeader: "base64-principal",
      ipAddress: "203.0.113.10",
    };

    await expect(
      insertAuditEvent(
        forbidden as unknown as Parameters<typeof insertAuditEvent>[0],
        client,
      ),
    ).rejects.toThrow();

    expect(await storedRows()).toEqual([]);
  });

  it("保存された行に禁止項目の値が含まれない", async () => {
    await insertAuditEvent(
      {
        action: "view",
        result: "denied",
        actorSubjectId,
        actorTenantId: "tenant-id",
        actorEmailAtEvent: "actor@example.com",
        correlationId,
        errorCategory: "not_authorized",
      },
      client,
    );

    const serialized = JSON.stringify(await storedRows());
    for (const forbiddenValue of [
      "極秘資料.html",
      "<html",
      "ey.J",
      "__Host-",
      "203.0.113.10",
      "X-MS-CLIENT-PRINCIPAL",
    ]) {
      expect(serialized).not.toContain(forbiddenValue);
    }
  });

  it("エラー分類は固定の一覧だけを保存できる", async () => {
    for (const category of auditErrorCategories) {
      await insertAuditEvent(
        {
          action: "admin_operation",
          result: "failed",
          actorSubjectId,
          actorTenantId: "tenant-id",
          correlationId,
          errorCategory: category,
        },
        client,
      );
    }

    const rows = await storedRows();
    expect(rows.map((row) => row["error_category"])).toEqual([
      ...auditErrorCategories,
    ]);

    await expect(
      insertAuditEvent(
        {
          action: "admin_operation",
          result: "failed",
          actorSubjectId,
          actorTenantId: "tenant-id",
          correlationId,
          // DBのカラムは自由記述TEXTだが、repositoryが分類以外を拒否する。
          errorCategory:
            "Error: connect ECONNREFUSED 10.0.0.1:5432" as unknown as (typeof auditErrorCategories)[number],
        },
        client,
      ),
    ).rejects.toThrow();
  });
});

describe("追記専用(設計 §12.2)", () => {
  it("保存済みの監査イベントはUPDATE・DELETEできない", async () => {
    await insertAuditEvent(
      {
        action: "delete",
        result: "success",
        actorSubjectId,
        actorTenantId: "tenant-id",
        correlationId,
      },
      client,
    );

    await expect(
      client.query("UPDATE audit_events SET result = 'failed'"),
    ).rejects.toThrow(/append-only/);
    await expect(client.query("DELETE FROM audit_events")).rejects.toThrow(
      /append-only/,
    );
    expect(await storedRows()).toHaveLength(1);
  });
});

/**
 * T17 結合テスト: 監査履歴の検索(設計 §5.7, §12.2, §18.2)。
 *
 * 実際のPostgreSQLに対して、検索条件の絞り込み・並び順・keyset paginationが
 * 期待どおりに動くこと、SELECTしか実行せず追記専用の性質を壊さないことを確認する。
 */
describe("searchAuditEvents", () => {
  const otherActorSubjectId = "actor-oid-002";

  /** 検索対象の監査イベントを時系列順に用意する。 */
  async function seedEvents() {
    const document = await createDocument(
      { ownerSubjectId: actorSubjectId, byteSize: 10 },
      client,
    );

    const upload = await insertAuditEvent(
      {
        action: "upload",
        result: "success",
        documentId: document.id,
        actorSubjectId,
        actorTenantId: "tenant-id",
        actorEmailAtEvent: "actor@example.com",
        actorGroupValues: ["ZAA535-A"],
        actorRoles: ["User"],
        correlationId,
      },
      client,
    );
    const view = await insertAuditEvent(
      {
        action: "view",
        result: "denied",
        documentId: document.id,
        actorSubjectId: otherActorSubjectId,
        actorTenantId: "tenant-id",
        actorEmailAtEvent: "other@example.com",
        actorRoles: ["User"],
        correlationId,
        errorCategory: "not_authorized",
      },
      client,
    );
    const adminOperation = await insertAuditEvent(
      {
        action: "admin_operation",
        result: "success",
        actorSubjectId: otherActorSubjectId,
        actorTenantId: "tenant-id",
        actorEmailAtEvent: "other@example.com",
        actorRoles: ["Admin"],
        correlationId,
      },
      client,
    );

    return { document, upload, view, adminOperation };
  }

  function idsOf(page: Awaited<ReturnType<typeof searchAuditEvents>>) {
    return page.events.map((event) => event.id).sort();
  }

  /**
   * 新しい順に並んでいるか(設計 §5.7の一覧)。
   *
   * `occurred_at`はマイクロ秒まで保持されるが`Date`はミリ秒までしか持てないため、
   * 同じミリ秒に見える2件の前後関係はここでは判定しない(同一時刻でも順序が一意に
   * 定まることはcursorの結合テストで確認する)。
   */
  function isSortedNewestFirst(
    page: Awaited<ReturnType<typeof searchAuditEvents>>,
  ): boolean {
    return page.events.every((event, index) => {
      const previous = page.events[index - 1];
      return (
        !previous || previous.occurredAt.getTime() >= event.occurredAt.getTime()
      );
    });
  }

  it("条件を指定しない場合は全件を新しい順に返す(設計 §5.7)", async () => {
    const seeded = await seedEvents();

    const page = await searchAuditEvents({}, client);

    expect(idsOf(page)).toEqual(
      [seeded.adminOperation.id, seeded.view.id, seeded.upload.id].sort(),
    );
    expect(isSortedNewestFirst(page)).toBe(true);
    expect(page.nextCursor).toBeNull();
  });

  it.each([
    ["操作", { action: "delete" as const }],
    ["結果", { result: "failed" as const }],
    ["利用者ID", { actorSubjectId: "actor-oid-999" }],
    ["メールアドレス", { actorEmail: "nobody@example.com" }],
  ])("%s が一致しない監査イベントは返さない", async (_label, criteria) => {
    await seedEvents();

    const page = await searchAuditEvents(criteria, client);

    expect(page.events).toEqual([]);
  });

  it("利用者・操作・結果・資料IDで絞り込める(設計 §5.7)", async () => {
    const seeded = await seedEvents();

    expect(idsOf(await searchAuditEvents({ actorSubjectId }, client))).toEqual([
      seeded.upload.id,
    ]);
    expect(idsOf(await searchAuditEvents({ action: "view" }, client))).toEqual([
      seeded.view.id,
    ]);
    expect(
      idsOf(await searchAuditEvents({ result: "denied" }, client)),
    ).toEqual([seeded.view.id]);
    expect(
      idsOf(
        await searchAuditEvents({ documentId: seeded.document.id }, client),
      ),
    ).toEqual([seeded.view.id, seeded.upload.id].sort());
  });

  it("メールアドレスは大文字小文字を区別しない部分一致で絞り込む", async () => {
    const seeded = await seedEvents();

    const page = await searchAuditEvents({ actorEmail: "OTHER@EXAMPLE" }, client);

    expect(idsOf(page)).toEqual([seeded.adminOperation.id, seeded.view.id].sort());
  });

  it("`%`だけの入力は全件一致にならない(ワイルドカードをエスケープする)", async () => {
    await seedEvents();

    const page = await searchAuditEvents({ actorEmail: "%" }, client);

    expect(page.events).toEqual([]);
  });

  it("日時の下限は含み、上限は含まない", async () => {
    const seeded = await seedEvents();
    const times = [seeded.upload, seeded.view, seeded.adminOperation].map(
      (event) => event.occurredAt.getTime(),
    );
    const oldest = new Date(Math.min(...times));
    const newest = new Date(Math.max(...times));

    // 下限は境界の値そのものを含む。
    expect(
      idsOf(
        await searchAuditEvents(
          { occurredFrom: oldest.toISOString() },
          client,
        ),
      ),
    ).toEqual([seeded.adminOperation.id, seeded.view.id, seeded.upload.id].sort());
    // 上限は境界の値を含まない。
    expect(
      (await searchAuditEvents({ occurredTo: oldest.toISOString() }, client))
        .events,
    ).toEqual([]);
    expect(
      (
        await searchAuditEvents(
          { occurredFrom: new Date(newest.getTime() + 1).toISOString() },
          client,
        )
      ).events,
    ).toEqual([]);
  });

  it("keyset paginationで重複・欠落なく続きを取得できる", async () => {
    const seeded = await seedEvents();

    const first = await searchAuditEvents({ limit: 2 }, client);
    expect(first.events).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();

    const second = await searchAuditEvents(
      { limit: 2, cursor: first.nextCursor },
      client,
    );
    expect(second.events).toHaveLength(1);
    expect(second.nextCursor).toBeNull();

    const collected = [...first.events, ...second.events].map(
      (event) => event.id,
    );
    expect(new Set(collected).size).toBe(3);
    expect(collected.sort()).toEqual(
      [seeded.adminOperation.id, seeded.view.id, seeded.upload.id].sort(),
    );
  });

  it("同じ時刻の監査イベントもcursorで取りこぼさない", async () => {
    // 同一トランザクション内の`now()`は同じ値になるため、`occurred_at`が完全に
    // 一致する監査イベントを作れる(`timestamptz`はマイクロ秒まで保持する)。
    await client.query("BEGIN");
    const seeded = await seedEvents();
    await client.query("COMMIT");

    const collected: string[] = [];
    let cursor: string | null = null;
    for (let pageIndex = 0; pageIndex < 5; pageIndex += 1) {
      const page: Awaited<ReturnType<typeof searchAuditEvents>> =
        await searchAuditEvents({ limit: 1, cursor }, client);
      collected.push(...page.events.map((event) => event.id));
      cursor = page.nextCursor;
      if (cursor === null) {
        break;
      }
    }

    expect(collected.sort()).toEqual(
      [seeded.adminOperation.id, seeded.view.id, seeded.upload.id].sort(),
    );
  });

  it("検索しても監査イベントは増減・変化しない(追記専用。設計 §12.2)", async () => {
    await seedEvents();
    const before = await storedRows();

    await searchAuditEvents({ action: "admin_operation" }, client);

    expect(await storedRows()).toEqual(before);
  });
});
