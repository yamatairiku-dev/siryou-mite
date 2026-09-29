import { describe, expect, it } from "vitest";
import * as auditEventsModule from "~/lib/db/audit-events.server";
import {
  auditEventInputSchema,
  encodeAuditEventCursor,
  insertAuditEvent,
  InvalidAuditCursorError,
  searchAuditEvents,
  type AuditEventInput,
} from "~/lib/db/audit-events.server";
import { createStubExecutor, lastCall } from "./stub-executor";

const correlationId = "33333333-4444-4555-8666-777777777777";
const documentId = "11111111-2222-4333-8444-555555555555";

const validInput: AuditEventInput = {
  action: "upload",
  result: "success",
  documentId,
  actorSubjectId: "owner-oid",
  actorTenantId: "tenant-id",
  actorEmailAtEvent: "owner@example.com",
  actorGroupValues: ["ZAA535-A"],
  actorRoles: ["User"],
  correlationId,
};

function insertedRow() {
  return {
    id: "88888888-9999-4aaa-8bbb-cccccccccccc",
    occurred_at: new Date("2026-01-02T03:04:05.000Z"),
    retain_until: new Date("2027-01-02T03:04:05.000Z"),
  };
}

describe("insertAuditEvent", () => {
  it("設計 §12.2の項目だけをプレースホルダーで保存する", async () => {
    const { executor, calls } = createStubExecutor([[insertedRow()]]);

    const record = await insertAuditEvent(validInput, executor);

    const call = lastCall(calls);
    expect(call.text).toContain("INSERT INTO audit_events");
    expect(call.values).toEqual([
      "upload",
      "success",
      documentId,
      "owner-oid",
      "tenant-id",
      "owner@example.com",
      ["ZAA535-A"],
      ["User"],
      correlationId,
      null,
    ]);
    expect(record).toEqual({
      id: "88888888-9999-4aaa-8bbb-cccccccccccc",
      occurredAt: new Date("2026-01-02T03:04:05.000Z"),
      retainUntil: new Date("2027-01-02T03:04:05.000Z"),
    });
  });

  it("発生日時はDBの`now()`だけを使い、呼び出し側から指定できない", async () => {
    const { executor, calls } = createStubExecutor([[insertedRow()]]);

    await insertAuditEvent(validInput, executor);

    const call = lastCall(calls);
    expect(call.text).toContain("now(), now()");
    expect(
      call.values.some((value) => value instanceof Date),
    ).toBe(false);
  });

  it("資料IDを持たない失敗監査も保存できる(設計 §11.1)", async () => {
    const { executor, calls } = createStubExecutor([[insertedRow()]]);

    await insertAuditEvent(
      {
        action: "upload",
        result: "failed",
        actorSubjectId: "owner-oid",
        actorTenantId: "tenant-id",
        correlationId,
        errorCategory: "html_inspection_failed",
      },
      executor,
    );

    expect(lastCall(calls).values).toEqual([
      "upload",
      "failed",
      null,
      "owner-oid",
      "tenant-id",
      null,
      null,
      null,
      correlationId,
      "html_inspection_failed",
    ]);
  });

  it("保存結果が返らない場合はエラーにする(監査失敗は操作を失敗させる)", async () => {
    const { executor } = createStubExecutor([[]]);

    await expect(insertAuditEvent(validInput, executor)).rejects.toThrow(
      "監査イベントを保存できませんでした",
    );
  });

  it("型チェック: executorの渡し忘れはコンパイルエラーになる(業務更新と監査が別トランザクションになることを防ぐ)", () => {
    // @ts-expect-error executorは必須引数(既定値なし)。
    const shouldNotCompile = () => insertAuditEvent(validInput);
    expect(typeof shouldNotCompile).toBe("function");
  });
});

describe("監査イベントの入力検証(禁止項目)", () => {
  it.each([
    ["HTML本文", { htmlBody: "<html></html>" }],
    ["ファイル名", { originalFileName: "資料.html" }],
    ["access token", { accessToken: "ey.J.token" }],
    ["表示grant", { grant: "signed-grant" }],
    ["session cookie", { cookie: "__Host-session=abc" }],
    ["principal header", { principalHeader: "base64-principal" }],
    ["IPアドレス", { ipAddress: "203.0.113.10" }],
    ["User-Agent", { userAgent: "Mozilla/5.0" }],
    ["リンクURL", { linkUrl: "https://example.com/secret" }],
  ])("%s を渡すと拒否する", (_label, extra) => {
    const result = auditEventInputSchema.safeParse({ ...validInput, ...extra });

    expect(result.success).toBe(false);
  });

  it("禁止項目を渡した場合はSQLを実行しない", async () => {
    const { executor, calls } = createStubExecutor([[insertedRow()]]);

    await expect(
      insertAuditEvent(
        {
          ...validInput,
          // @ts-expect-error 設計 §12.2に無い項目は型でも実行時でも受け付けない
          originalFileName: "資料.html",
        },
        executor,
      ),
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it.each([
    ["操作", { action: "download" }],
    ["結果", { result: "unknown" }],
    ["エラー分類", { errorCategory: "Error: connect ECONNREFUSED 10.0.0.1:5432" }],
    ["相関ID", { correlationId: "not-a-uuid" }],
    ["資料ID", { documentId: "not-a-uuid" }],
    ["利用者ID", { actorSubjectId: "" }],
    ["tenant ID", { actorTenantId: "" }],
    ["メールアドレス", { actorEmailAtEvent: "not-mail" }],
  ])("%s が設計の値域外なら拒否する", (_label, invalid) => {
    const result = auditEventInputSchema.safeParse({ ...validInput, ...invalid });

    expect(result.success).toBe(false);
  });
});

describe("追記専用", () => {
  it("更新・削除を行う関数を公開しない", () => {
    const exported = Object.keys(auditEventsModule);

    expect(exported).toContain("insertAuditEvent");
    expect(
      exported.filter((name) => /update|delete|purge|remove/i.test(name)),
    ).toEqual([]);
  });
});

describe("searchAuditEvents(監査履歴の検索。設計 §5.7)", () => {
  const eventRow = {
    id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    occurred_at: new Date("2026-01-02T03:04:05.123Z"),
    // cursorはDBが返すマイクロ秒精度の値を使う(`Date`はミリ秒までしか持てず、
    // 同じミリ秒の監査イベントを取りこぼすため)。
    occurred_at_iso: "2026-01-02T03:04:05.123456Z",
    action: "upload",
    result: "success",
    document_id: documentId,
    actor_subject_id: "owner-oid",
    actor_tenant_id: "tenant-id",
    actor_email_at_event: "owner@example.com",
    actor_group_values: ["ZAA535-A"],
    actor_roles: ["User"],
    correlation_id: correlationId,
    error_category: null,
  };

  it("条件が無い場合は新しい順に1ページ分だけ取得する", async () => {
    const { executor, calls } = createStubExecutor([[eventRow]]);

    const page = await searchAuditEvents({}, executor);

    const call = lastCall(calls);
    expect(call.text).toContain("FROM audit_events");
    expect(call.text).toContain("ORDER BY occurred_at DESC, id DESC");
    expect(call.text).not.toContain("WHERE");
    // 次ページの有無を判定するため1件多く取得する(20 + 1)。
    expect(call.values).toEqual([21]);
    expect(call.text).toContain("AS occurred_at_iso");
    expect(page.events[0]).toEqual({
      id: eventRow.id,
      occurredAt: eventRow.occurred_at,
      action: "upload",
      result: "success",
      documentId,
      actorSubjectId: "owner-oid",
      actorTenantId: "tenant-id",
      actorEmailAtEvent: "owner@example.com",
      actorGroupValues: ["ZAA535-A"],
      actorRoles: ["User"],
      correlationId,
      errorCategory: null,
    });
    expect(page.nextCursor).toBeNull();
  });

  it("日時・利用者・資料ID・操作・結果をすべてプレースホルダーで渡す", async () => {
    const { executor, calls } = createStubExecutor([[]]);

    await searchAuditEvents(
      {
        occurredFrom: "2026-01-01T15:00:00.000Z",
        occurredTo: "2026-01-02T15:00:00.000Z",
        actorSubjectId: "owner-oid",
        actorEmail: "owner@example.com",
        documentId,
        action: "delete",
        result: "denied",
      },
      executor,
    );

    const call = lastCall(calls);
    expect(call.text).toContain("occurred_at >= $1::timestamptz");
    expect(call.text).toContain("occurred_at < $2::timestamptz");
    expect(call.text).toContain("actor_subject_id = $3");
    expect(call.text).toContain("actor_email_at_event ILIKE $4 ESCAPE");
    expect(call.text).toContain("document_id = $5::uuid");
    expect(call.text).toContain("action = $6");
    expect(call.text).toContain("result = $7");
    expect(call.values).toEqual([
      "2026-01-01T15:00:00.000Z",
      "2026-01-02T15:00:00.000Z",
      "owner-oid",
      "%owner@example.com%",
      documentId,
      "delete",
      "denied",
      21,
    ]);
    // 利用者の入力はSQL文字列へ連結しない。
    expect(call.text).not.toContain("owner@example.com");
  });

  it("メールアドレスの`LIKE`ワイルドカードをエスケープする", async () => {
    const { executor, calls } = createStubExecutor([[]]);

    await searchAuditEvents({ actorEmail: "%_\\" }, executor);

    expect(lastCall(calls).values[0]).toBe("%\\%\\_\\\\%");
  });

  it.each([
    ["enum外の操作", { action: "drop_table" }],
    ["enum外の結果", { result: "partial" }],
    ["UUIDでない資料ID", { documentId: "not-a-uuid" }],
    ["ISO日時でない下限", { occurredFrom: "2026-01-02" }],
    ["ISO日時でない上限", { occurredTo: "2026-01-02" }],
    ["上限を超える件数", { limit: 1000 }],
    ["長すぎるcursor", { cursor: "a".repeat(501) }],
    ["設計に無い条件", { actorTenantId: "tenant-id" }],
  ])("%s はSQLを実行せずに拒否する", async (_label, invalid) => {
    const { executor, calls } = createStubExecutor([[]]);

    await expect(
      // @ts-expect-error 値域外・schemaに無い条件は型でも実行時でも受け付けない
      searchAuditEvents(invalid, executor),
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it("次ページがある場合だけcursorを返し、続きを行値比較で取得する", async () => {
    const rows = Array.from({ length: 21 }, (_, index) => ({
      ...eventRow,
      id: `aaaaaaaa-bbbb-4ccc-8ddd-${String(index).padStart(12, "0")}`,
    }));
    const { executor, calls } = createStubExecutor([rows, []]);

    const page = await searchAuditEvents({}, executor);

    expect(page.events).toHaveLength(20);
    expect(page.nextCursor).not.toBeNull();

    await searchAuditEvents({ cursor: page.nextCursor }, executor);

    const call = lastCall(calls);
    expect(call.text).toContain(
      "(occurred_at, id) < ($1::timestamptz, $2::uuid)",
    );
    // ミリ秒へ丸めた値ではなく、DBのマイクロ秒精度の値で続きを取得する。
    expect(call.values).toEqual([
      eventRow.occurred_at_iso,
      "aaaaaaaa-bbbb-4ccc-8ddd-000000000019",
      21,
    ]);
  });

  it("壊れたcursorはSQLを実行せずに拒否する", async () => {
    const { executor, calls } = createStubExecutor([[]]);

    await expect(
      searchAuditEvents({ cursor: "broken" }, executor),
    ).rejects.toBeInstanceOf(InvalidAuditCursorError);
    expect(calls).toHaveLength(0);
  });

  it("cursorを改ざんしても検索条件は増減しない(位置の指定だけに使う)", async () => {
    const forged = encodeAuditEventCursor({
      occurredAt: new Date("2030-01-01T00:00:00.000Z"),
      id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    });
    const { executor, calls } = createStubExecutor([[]]);

    await searchAuditEvents({ cursor: forged, action: "view" }, executor);

    const call = lastCall(calls);
    expect(call.text).toContain("action = $1");
    expect(call.values).toEqual([
      "view",
      "2030-01-01T00:00:00.000Z",
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      21,
    ]);
  });

  it("SELECTだけを実行し、UPDATE・DELETEを含まない(追記専用。設計 §12.2)", async () => {
    const { executor, calls } = createStubExecutor([[eventRow]]);

    await searchAuditEvents({ action: "admin_operation" }, executor);

    const call = lastCall(calls);
    expect(call.text.trimStart().startsWith("SELECT")).toBe(true);
    expect(/\b(UPDATE|DELETE|INSERT)\b/.test(call.text)).toBe(false);
  });
});
