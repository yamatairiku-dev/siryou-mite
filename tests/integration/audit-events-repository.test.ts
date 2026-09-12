import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Client } from "pg";
import {
  auditErrorCategories,
  insertAuditEvent,
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
