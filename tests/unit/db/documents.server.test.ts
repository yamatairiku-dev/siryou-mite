import { describe, expect, it } from "vitest";
import {
  createDocument,
  decodeDocumentCursor,
  deleteDocumentAsAdmin,
  deleteDocumentAsOwner,
  encodeDocumentCursor,
  findDocumentById,
  getOwnerUsage,
  getSystemUsage,
  InvalidCursorError,
  escapeLikePattern,
  listDocumentsByOwner,
  markBlobCleanupCompleted,
  searchDocumentsForAdmin,
  updateDocumentPreviewStatus,
} from "~/lib/db/documents.server";
import { createStubExecutor, lastCall } from "./stub-executor";

const ownerSubjectId = "00000000-0000-4000-8000-owner-oid";
const documentId = "11111111-2222-4333-8444-555555555555";
const otherDocumentId = "99999999-2222-4333-8444-555555555555";

function documentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: documentId,
    owner_subject_id: ownerSubjectId,
    owner_email_at_upload: "owner@example.com",
    original_file_name: "資料.html",
    title: "資料タイトル",
    byte_size: "1024",
    preview_status: "pending",
    warning_codes: ["script_disabled"],
    status: "active",
    created_at: new Date("2026-01-02T03:04:05.000Z"),
    deleted_at: null,
    deleted_by_subject_id: null,
    blob_cleanup_pending: false,
    ...overrides,
  };
}

describe("cursor(keyset pagination)", () => {
  it("`created_at`と`id`を往復できる", () => {
    const cursor = encodeDocumentCursor({
      createdAt: new Date("2026-01-02T03:04:05.000Z"),
      id: documentId,
    });

    expect(decodeDocumentCursor(cursor)).toEqual({
      createdAt: "2026-01-02T03:04:05.000Z",
      id: documentId,
    });
  });

  it.each([
    ["base64でない値", "!!!not-base64!!!"],
    ["JSONでない値", Buffer.from("plain text", "utf8").toString("base64url")],
    [
      "資料IDがUUIDでない値",
      Buffer.from(
        JSON.stringify({ createdAt: "2026-01-02T03:04:05.000Z", id: "1 OR 1=1" }),
        "utf8",
      ).toString("base64url"),
    ],
    [
      "余計な項目を含む値",
      Buffer.from(
        JSON.stringify({
          createdAt: "2026-01-02T03:04:05.000Z",
          id: documentId,
          ownerSubjectId: "other-user",
        }),
        "utf8",
      ).toString("base64url"),
    ],
  ])("%s を拒否する", (_label, cursor) => {
    expect(() => decodeDocumentCursor(cursor)).toThrow(InvalidCursorError);
  });
});

describe("listDocumentsByOwner", () => {
  it("所有者と`active`で絞り込み、新しい順に20件+1件を取得する", async () => {
    const { executor, calls } = createStubExecutor([[documentRow()]]);

    const page = await listDocumentsByOwner({ ownerSubjectId }, executor);

    const call = lastCall(calls);
    expect(call.text).toContain("owner_subject_id = $1");
    expect(call.text).toContain("status = 'active'");
    expect(call.text).toContain("ORDER BY created_at DESC, id DESC");
    expect(call.values).toEqual([ownerSubjectId, 21]);
    // 利用者入力をSQL文字列へ連結していないこと。
    expect(call.text).not.toContain(ownerSubjectId);
    expect(page.nextCursor).toBeNull();
    expect(page.documents[0]).toMatchObject({
      id: documentId,
      ownerSubjectId,
      byteSize: 1024,
      warningCodes: ["script_disabled"],
      status: "active",
    });
  });

  it("cursor指定時も所有者条件を必ず併用する(改ざんされても他人の資料を返さない)", async () => {
    const cursor = encodeDocumentCursor({
      createdAt: new Date("2026-01-02T03:04:05.000Z"),
      id: documentId,
    });
    const { executor, calls } = createStubExecutor([[]]);

    await listDocumentsByOwner({ ownerSubjectId, cursor, limit: 5 }, executor);

    const call = lastCall(calls);
    expect(call.text).toContain("owner_subject_id = $1");
    expect(call.text).toContain("(created_at, id) < ($2::timestamptz, $3::uuid)");
    expect(call.text).not.toContain("OFFSET");
    expect(call.values).toEqual([
      ownerSubjectId,
      "2026-01-02T03:04:05.000Z",
      documentId,
      6,
    ]);
  });

  it("次ページがある場合だけ最後の行からcursorを作る", async () => {
    const rows = [
      documentRow({ created_at: new Date("2026-01-03T00:00:00.000Z") }),
      documentRow({
        id: otherDocumentId,
        created_at: new Date("2026-01-02T00:00:00.000Z"),
      }),
    ];
    const { executor } = createStubExecutor([rows]);

    const page = await listDocumentsByOwner(
      { ownerSubjectId, limit: 1 },
      executor,
    );

    expect(page.documents).toHaveLength(1);
    expect(page.nextCursor).not.toBeNull();
    expect(decodeDocumentCursor(page.nextCursor ?? "")).toEqual({
      createdAt: "2026-01-03T00:00:00.000Z",
      id: documentId,
    });
  });

  it("壊れたcursorではSQLを実行しない", async () => {
    const { executor, calls } = createStubExecutor([[]]);

    await expect(
      listDocumentsByOwner({ ownerSubjectId, cursor: "broken" }, executor),
    ).rejects.toBeInstanceOf(InvalidCursorError);
    expect(calls).toHaveLength(0);
  });

  it.each([0, 101])("limit %s を拒否する", async (limit) => {
    const { executor } = createStubExecutor([[]]);

    await expect(
      listDocumentsByOwner({ ownerSubjectId, limit }, executor),
    ).rejects.toThrow();
  });
});

describe("findDocumentById", () => {
  it("資料IDをプレースホルダーで渡す", async () => {
    const { executor, calls } = createStubExecutor([[documentRow()]]);

    const record = await findDocumentById(documentId, executor);

    expect(lastCall(calls).values).toEqual([documentId]);
    expect(record?.id).toBe(documentId);
  });

  it("UUIDでない資料IDはSQLを実行せずnullを返す", async () => {
    const { executor, calls } = createStubExecutor([[documentRow()]]);

    expect(await findDocumentById("' OR 1=1 --", executor)).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("該当なしはnullを返す", async () => {
    const { executor } = createStubExecutor([[]]);

    expect(await findDocumentById(documentId, executor)).toBeNull();
  });
});

describe("createDocument", () => {
  it("`active`・プレビュー`pending`で登録する", async () => {
    const { executor, calls } = createStubExecutor([[documentRow()]]);

    const record = await createDocument(
      {
        id: documentId,
        ownerSubjectId,
        ownerEmailAtUpload: "owner@example.com",
        originalFileName: "資料.html",
        title: "資料タイトル",
        byteSize: 1024,
        warningCodes: ["script_disabled"],
      },
      executor,
    );

    const call = lastCall(calls);
    expect(call.text).toContain("INSERT INTO documents");
    expect(call.text).toContain("'active'");
    expect(call.values).toEqual([
      documentId,
      ownerSubjectId,
      "owner@example.com",
      "資料.html",
      "資料タイトル",
      1024,
      "pending",
      ["script_disabled"],
    ]);
    expect(record.status).toBe("active");
  });

  it("設計 §12.1に無い項目を渡すと拒否する", async () => {
    const { executor, calls } = createStubExecutor([[documentRow()]]);

    await expect(
      createDocument(
        {
          ownerSubjectId,
          // @ts-expect-error 設計に無い項目は型でも実行時でも受け付けない
          blobKey: "html/x/document.html",
        },
        executor,
      ),
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it.each([
    ["所有者IDが空", { ownerSubjectId: "" }],
    ["メールアドレスが不正", { ownerSubjectId, ownerEmailAtUpload: "not-mail" }],
    ["byteSizeが負数", { ownerSubjectId, byteSize: -1 }],
    ["preview_statusが未定義値", { ownerSubjectId, previewStatus: "done" }],
  ])("%s の入力を拒否する", async (_label, input) => {
    const { executor } = createStubExecutor([[documentRow()]]);

    await expect(
      createDocument(input as Parameters<typeof createDocument>[0], executor),
    ).rejects.toThrow();
  });

  it("登録結果が返らない場合はエラーにする", async () => {
    const { executor } = createStubExecutor([[]]);

    await expect(createDocument({ ownerSubjectId }, executor)).rejects.toThrow(
      "資料を登録できませんでした",
    );
  });

  it("型チェック: executorの渡し忘れはコンパイルエラーになる(業務更新と監査が別トランザクションになることを防ぐ)", () => {
    // @ts-expect-error executorは必須引数(既定値なし)。
    const shouldNotCompile = () => createDocument({ ownerSubjectId });
    expect(typeof shouldNotCompile).toBe("function");
  });
});

describe("削除(active から deleted への状態遷移)", () => {
  const deletedRow = documentRow({
    owner_email_at_upload: null,
    original_file_name: null,
    title: null,
    byte_size: null,
    preview_status: null,
    warning_codes: null,
    status: "deleted",
    deleted_at: new Date("2026-01-03T00:00:00.000Z"),
    deleted_by_subject_id: ownerSubjectId,
    blob_cleanup_pending: true,
  });

  it("所有者削除は所有者条件付きで、機微項目を消去する", async () => {
    const { executor, calls } = createStubExecutor([[deletedRow]]);

    const record = await deleteDocumentAsOwner(
      { documentId, ownerSubjectId },
      executor,
    );

    const call = lastCall(calls);
    expect(call.text).toContain("SET status = 'deleted'");
    expect(call.text).toContain("owner_email_at_upload = NULL");
    expect(call.text).toContain("original_file_name = NULL");
    expect(call.text).toContain("title = NULL");
    expect(call.text).toContain("byte_size = NULL");
    expect(call.text).toContain("preview_status = NULL");
    expect(call.text).toContain("warning_codes = NULL");
    expect(call.text).toContain("blob_cleanup_pending = true");
    expect(call.text).toContain("AND status = 'active'");
    expect(call.text).toContain("owner_subject_id = $3::text");
    expect(call.values).toEqual([documentId, ownerSubjectId, ownerSubjectId]);
    expect(record).toMatchObject({
      status: "deleted",
      ownerEmailAtUpload: null,
      byteSize: null,
      blobCleanupPending: true,
    });
  });

  it("他人の資料は更新されずnullを返す", async () => {
    const { executor } = createStubExecutor([[]]);

    expect(
      await deleteDocumentAsOwner(
        { documentId, ownerSubjectId: "other-user" },
        executor,
      ),
    ).toBeNull();
  });

  it("管理者削除は所有者で絞り込まず、実行者を記録する", async () => {
    const { executor, calls } = createStubExecutor([[deletedRow]]);

    await deleteDocumentAsAdmin(
      { documentId, adminSubjectId: "admin-oid" },
      executor,
    );

    expect(lastCall(calls).values).toEqual([documentId, "admin-oid", null]);
  });

  it("UUIDでない資料IDではSQLを実行しない", async () => {
    const { executor, calls } = createStubExecutor([[deletedRow]]);

    expect(
      await deleteDocumentAsOwner(
        { documentId: "not-a-uuid", ownerSubjectId },
        executor,
      ),
    ).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("削除実行者IDが空の場合は拒否する", async () => {
    const { executor } = createStubExecutor([[deletedRow]]);

    await expect(
      deleteDocumentAsAdmin({ documentId, adminSubjectId: " " }, executor),
    ).rejects.toThrow();
  });

  it("型チェック: deleteDocumentAsOwner/deleteDocumentAsAdminはexecutorの渡し忘れをコンパイルエラーにする", () => {
    const shouldNotCompile = () => [
      // @ts-expect-error executorは必須引数(既定値なし)。
      deleteDocumentAsOwner({ documentId, ownerSubjectId }),
      // @ts-expect-error executorは必須引数(既定値なし)。
      deleteDocumentAsAdmin({ documentId, adminSubjectId: "admin-oid" }),
    ];
    expect(typeof shouldNotCompile).toBe("function");
  });
});

describe("updateDocumentPreviewStatus(設計 §10.1(9))", () => {
  it("`active`な資料のプレビュー状態だけを更新する", async () => {
    const { executor, calls } = createStubExecutor([[{ id: documentId }]]);

    expect(
      await updateDocumentPreviewStatus(
        { documentId, previewStatus: "failed" },
        executor,
      ),
    ).toBe(true);
    expect(lastCall(calls).text).toContain("SET preview_status = $2");
    expect(lastCall(calls).text).toContain("status = 'active'");
    expect(lastCall(calls).text).not.toContain("SET status");
    expect(lastCall(calls).values).toEqual([documentId, "failed"]);
  });

  it("該当が無い場合はfalseを返す", async () => {
    const { executor } = createStubExecutor([[]]);

    expect(
      await updateDocumentPreviewStatus(
        { documentId, previewStatus: "ready" },
        executor,
      ),
    ).toBe(false);
  });

  it("UUIDでない資料IDではSQLを実行しない", async () => {
    const { executor, calls } = createStubExecutor([[{ id: documentId }]]);

    expect(
      await updateDocumentPreviewStatus(
        { documentId: "not-a-uuid", previewStatus: "ready" },
        executor,
      ),
    ).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe("markBlobCleanupCompleted", () => {
  it("再試行待ちの資料だけを更新する", async () => {
    const { executor, calls } = createStubExecutor([[{ id: documentId }]]);

    expect(await markBlobCleanupCompleted(documentId, executor)).toBe(true);
    expect(lastCall(calls).text).toContain("blob_cleanup_pending = true");
    expect(lastCall(calls).values).toEqual([documentId]);
  });

  it("該当が無い場合はfalseを返す", async () => {
    const { executor } = createStubExecutor([[]]);

    expect(await markBlobCleanupCompleted(documentId, executor)).toBe(false);
  });

  it("UUIDでない資料IDではSQLを実行しない", async () => {
    const { executor, calls } = createStubExecutor([[{ id: documentId }]]);

    expect(await markBlobCleanupCompleted("not-a-uuid", executor)).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe("使用量の集計", () => {
  it("利用者単位の件数と合計byte数を返す", async () => {
    const { executor, calls } = createStubExecutor([
      [{ document_count: "3", total_byte_size: "3072" }],
    ]);

    expect(await getOwnerUsage(ownerSubjectId, executor)).toEqual({
      documentCount: 3,
      totalByteSize: 3072,
    });
    expect(lastCall(calls).values).toEqual([ownerSubjectId]);
    expect(lastCall(calls).text).toContain("status = 'active'");
  });

  it("システム全体の件数と合計byte数を返す", async () => {
    const { executor, calls } = createStubExecutor([
      [{ document_count: "0", total_byte_size: "0" }],
    ]);

    expect(await getSystemUsage(executor)).toEqual({
      documentCount: 0,
      totalByteSize: 0,
    });
    expect(lastCall(calls).values).toEqual([]);
  });

  it("BIGINTがJavaScriptの安全な整数を超える場合はエラーにする", async () => {
    const { executor } = createStubExecutor([
      [{ document_count: "1", total_byte_size: "9007199254740993" }],
    ]);

    await expect(getSystemUsage(executor)).rejects.toThrow(
      "安全な整数の範囲を超えています",
    );
  });
});

/**
 * T16: 管理画面の横断検索(設計 §5.6)。
 *
 * 所有者で絞らない唯一の一覧SQLであるため、条件の受け渡しとパラメーター化を
 * ここで固定する。実際のSQL実行と検索結果は結合テストで確認する。
 */
describe("searchDocumentsForAdmin", () => {
  const adminSearchRow = documentRow({ owner_email_at_upload: "owner@example.com" });

  it("条件を指定しない場合は`active`だけで絞り込み、新しい順に20件+1件を取得する", async () => {
    const { executor, calls } = createStubExecutor([[adminSearchRow]]);

    const page = await searchDocumentsForAdmin({}, executor);

    const call = lastCall(calls);
    expect(call.text).toContain("status = 'active'");
    // 所有者による絞り込み条件は付かない(管理者は全資料を検索できる。設計 §4.2)。
    expect(call.text).not.toContain("owner_subject_id =");
    expect(call.text).not.toContain("ILIKE");
    expect(call.text).toContain("ORDER BY created_at DESC, id DESC");
    expect(call.values).toEqual([21]);
    expect(page.documents[0]).toMatchObject({
      id: documentId,
      ownerEmailAtUpload: "owner@example.com",
    });
    expect(page.nextCursor).toBeNull();
  });

  it("4つの検索条件をすべてプレースホルダーで渡す", async () => {
    const { executor, calls } = createStubExecutor([[]]);

    await searchDocumentsForAdmin(
      {
        documentId,
        ownerEmail: "owner@example.com",
        originalFileName: "資料",
        uploadedFrom: "2026-01-01T00:00:00.000Z",
        uploadedTo: "2026-02-01T00:00:00.000Z",
      },
      executor,
    );

    const call = lastCall(calls);
    expect(call.text).toContain("id = $1::uuid");
    expect(call.text).toContain("owner_email_at_upload ILIKE $2 ESCAPE '\\'");
    expect(call.text).toContain("original_file_name ILIKE $3 ESCAPE '\\'");
    expect(call.text).toContain("created_at >= $4::timestamptz");
    expect(call.text).toContain("created_at < $5::timestamptz");
    expect(call.values).toEqual([
      documentId,
      "%owner@example.com%",
      "%資料%",
      "2026-01-01T00:00:00.000Z",
      "2026-02-01T00:00:00.000Z",
      21,
    ]);
    // 利用者入力はSQL文字列へ連結されていない。
    expect(call.text).not.toContain("owner@example.com");
    expect(call.text).not.toContain("資料");
  });

  it("空文字・空白だけの条件では絞り込まない", async () => {
    const { executor, calls } = createStubExecutor([[]]);

    await searchDocumentsForAdmin(
      { ownerEmail: "", originalFileName: "   " },
      executor,
    );

    const call = lastCall(calls);
    expect(call.text).not.toContain("ILIKE");
    expect(call.values).toEqual([21]);
  });

  it("`LIKE`のワイルドカードをエスケープし、全件一致にしない", async () => {
    const { executor, calls } = createStubExecutor([[]]);

    await searchDocumentsForAdmin(
      { ownerEmail: "%", originalFileName: "a_b\\c%" },
      executor,
    );

    expect(lastCall(calls).values).toEqual([
      "%\\%%",
      "%a\\_b\\\\c\\%%",
      21,
    ]);
    expect(escapeLikePattern("100%_\\")).toBe("100\\%\\_\\\\");
  });

  it("SQLインジェクションを狙う入力も値として渡す", async () => {
    const injection = "' OR 1=1 --";
    const { executor, calls } = createStubExecutor([[]]);

    await searchDocumentsForAdmin({ originalFileName: injection }, executor);

    const call = lastCall(calls);
    expect(call.text).not.toContain("OR 1=1");
    expect(call.values).toContain(`%${injection}%`);
  });

  it("資料IDがUUIDでない場合はSQLを実行せずに拒否する", async () => {
    const { executor, calls } = createStubExecutor([[]]);

    await expect(
      searchDocumentsForAdmin({ documentId: "not-a-uuid" }, executor),
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it("日時がISO形式でない場合はSQLを実行せずに拒否する", async () => {
    const { executor, calls } = createStubExecutor([[]]);

    await expect(
      searchDocumentsForAdmin({ uploadedFrom: "2026/01/01" }, executor),
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it("極端に長い検索文字列はSQLを実行せずに拒否する", async () => {
    const { executor, calls } = createStubExecutor([[]]);

    await expect(
      searchDocumentsForAdmin({ ownerEmail: "a".repeat(321) }, executor),
    ).rejects.toThrow();
    await expect(
      searchDocumentsForAdmin({ originalFileName: "a".repeat(1001) }, executor),
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it("未知の検索条件を受け付けない(所有者条件の偽装などを防ぐ)", async () => {
    const { executor, calls } = createStubExecutor([[]]);

    await expect(
      searchDocumentsForAdmin(
        { ownerSubjectId: "oid-someone-else" } as never,
        executor,
      ),
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it("次ページがある場合はcursorを返し、cursor指定時は行値比較で続きを取得する", async () => {
    const rows = Array.from({ length: 3 }, (_, index) =>
      documentRow({ id: `1111111${index}-1111-4111-8111-111111111111` }),
    );
    const first = createStubExecutor([rows]);

    const page = await searchDocumentsForAdmin({ limit: 2 }, first.executor);

    expect(page.documents).toHaveLength(2);
    expect(page.nextCursor).not.toBeNull();

    const second = createStubExecutor([[]]);
    await searchDocumentsForAdmin(
      { limit: 2, cursor: page.nextCursor ?? "" },
      second.executor,
    );

    const call = lastCall(second.calls);
    expect(call.text).toContain("(created_at, id) < ($1::timestamptz, $2::uuid)");
    expect(call.text).not.toContain("OFFSET");
    expect(call.values).toEqual([
      "2026-01-02T03:04:05.000Z",
      "11111111-1111-4111-8111-111111111111",
      3,
    ]);
  });

  it("壊れたcursorはSQLを実行せずに拒否する", async () => {
    const { executor, calls } = createStubExecutor([[]]);

    await expect(
      searchDocumentsForAdmin({ cursor: "!!!not-base64!!!" }, executor),
    ).rejects.toThrow(InvalidCursorError);
    expect(calls).toHaveLength(0);
  });
});
