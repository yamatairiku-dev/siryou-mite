import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoutesStub } from "react-router";
import type { AuditEventInput } from "~/lib/db/audit-events.server";
import type {
  DocumentListPage,
  DocumentRecord,
  SearchDocumentsForAdminOptions,
} from "~/lib/db/documents.server";
import { InvalidCursorError } from "~/lib/db/documents.server";
import type { Queryable } from "~/lib/db/pool.server";
import { createUserSession, type AppUser } from "~/lib/session.server";

/**
 * T16 単体テスト: 管理画面`/admin/documents`(設計 §5.6, §4.2, §12.2, §15.1)。
 *
 * - 一般ユーザー・未認証が拒否され、検索SQLへ1回も到達しないことを確認する
 *   (UIの非表示ではなくloaderで認可していることの根拠)。
 * - 検索条件がZod検証を通ってrepositoryへどう渡るか、不正値がDBへ渡らないことを
 *   確認する。
 * - 検索・一覧閲覧が`admin_operation`で監査され、監査へ検索条件(メールアドレス・
 *   ファイル名)が入らないことを確認する。
 * - 強制削除の導線がT14の確認画面へのGETであり、この画面が削除を実行しないことを
 *   確認する。
 */

const searchDocumentsForAdminMock = vi.fn<
  (options: SearchDocumentsForAdminOptions, tx: Queryable) => Promise<DocumentListPage>
>();
const insertAuditEventMock = vi.fn<
  (input: AuditEventInput, tx: Queryable) => Promise<unknown>
>();

/** `withTransaction`が渡すtransaction。検索と監査が同じ値を受け取ることを確認する。 */
const tx = { query: async () => ({ rows: [] }) } as unknown as Queryable;
let transactionCalls: string[] = [];

vi.mock("~/lib/db/pool.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/db/pool.server")>();
  return {
    ...actual,
    withTransaction: async <T,>(run: (client: Queryable) => Promise<T>) => {
      transactionCalls.push("begin");
      try {
        const result = await run(tx);
        transactionCalls.push("commit");
        return result;
      } catch (error) {
        transactionCalls.push("rollback");
        throw error;
      }
    },
  };
});

vi.mock("~/lib/db/documents.server", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("~/lib/db/documents.server")>();
  return {
    ...actual,
    searchDocumentsForAdmin: (
      options: SearchDocumentsForAdminOptions,
      executor: Queryable,
    ) => searchDocumentsForAdminMock(options, executor),
  };
});

vi.mock("~/lib/db/audit-events.server", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("~/lib/db/audit-events.server")>();
  return {
    ...actual,
    insertAuditEvent: (input: AuditEventInput, executor: Queryable) =>
      insertAuditEventMock(input, executor),
  };
});

const { loader, default: AdminDocuments } = await import(
  "~/routes/admin.documents"
);

const origin = "http://localhost:3000";
const DOCUMENT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_DOCUMENT_ID = "22222222-2222-4222-8222-222222222222";

const adminUser: AppUser = {
  id: "oid-admin",
  tenantId: "tenant-001",
  name: "管理者 次郎",
  email: "admin@example.com",
  roles: ["Admin"],
  groups: ["ZAA535-A"],
};

/** 管理者ではない一般利用者(他人の資料を検索できない)。 */
const generalUser: AppUser = {
  id: "oid-user",
  tenantId: "tenant-001",
  name: "一般 太郎",
  email: "user@example.com",
  roles: ["User"],
  groups: ["ZAA535-A"],
};

/** 検索結果に混ざる「他人の資料」。 */
function documentRecord(overrides: Partial<DocumentRecord> = {}): DocumentRecord {
  return {
    id: DOCUMENT_ID,
    ownerSubjectId: "oid-someone-else",
    ownerEmailAtUpload: "owner@example.com",
    originalFileName: "極秘資料.html",
    title: "資料タイトル",
    byteSize: 2048,
    previewStatus: "ready",
    warningCodes: [],
    status: "active",
    createdAt: new Date("2026-01-02T15:30:00.000Z"),
    deletedAt: null,
    deletedBySubjectId: null,
    blobCleanupPending: false,
    ...overrides,
  };
}

async function sessionCookieFor(user: AppUser): Promise<string> {
  const response = await createUserSession(user);
  return response.headers.get("Set-Cookie") ?? "";
}

function loaderArgs(query: string, cookie?: string) {
  return {
    request: new Request(
      `${origin}/admin/documents${query}`,
      cookie ? { headers: { Cookie: cookie } } : {},
    ),
  } as unknown as Parameters<typeof loader>[0];
}

async function searchAs(user: AppUser, query = "") {
  return loader(loaderArgs(query, await sessionCookieFor(user)));
}

/** 直近の検索条件(repositoryへ渡された値)。 */
function lastSearchOptions(): SearchDocumentsForAdminOptions {
  const call = searchDocumentsForAdminMock.mock.calls.at(-1);
  if (!call) {
    throw new Error("検索が1回も実行されていません");
  }
  return call[0];
}

function lastAuditInput(): AuditEventInput {
  const call = insertAuditEventMock.mock.calls.at(-1);
  if (!call) {
    throw new Error("監査が1件も保存されていません");
  }
  return call[0];
}

let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  transactionCalls = [];
  searchDocumentsForAdminMock.mockReset();
  searchDocumentsForAdminMock.mockResolvedValue({
    documents: [],
    nextCursor: null,
  });
  insertAuditEventMock.mockReset();
  insertAuditEventMock.mockResolvedValue({});
  // 実装の`console.log`(運用ログ)でテスト出力を汚さない。
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

function loggedEvents(): Record<string, unknown>[] {
  return logSpy.mock.calls.map(
    ([line]: unknown[]) => JSON.parse(String(line)) as Record<string, unknown>,
  );
}

// --- 認可(設計 §4.2, §5.6) ---

describe("認可", () => {
  it("一般ユーザー(Adminなし)は403で拒否され、検索も監査も実行されない", async () => {
    const denial = (await searchAs(generalUser).catch(
      (error: Response) => error,
    )) as Response;

    expect(denial.status).toBe(403);
    expect(await denial.text()).toBe("管理機能を利用する権限がありません");
    expect(searchDocumentsForAdminMock).not.toHaveBeenCalled();
    expect(insertAuditEventMock).not.toHaveBeenCalled();
    expect(transactionCalls).toEqual([]);
  });

  it("一般ユーザーは検索条件を付けても他人の資料へ到達できない", async () => {
    await expect(
      searchAs(generalUser, "?ownerEmail=owner%40example.com"),
    ).rejects.toMatchObject({ status: 403 });

    expect(searchDocumentsForAdminMock).not.toHaveBeenCalled();
  });

  it("権限不足の拒否は運用ログへ残す(利用者識別子と検索条件は出さない)", async () => {
    await searchAs(generalUser, "?ownerEmail=owner%40example.com").catch(
      () => undefined,
    );

    const denied = loggedEvents().find((event) => event.result === "denied");
    expect(denied).toMatchObject({
      event: "admin_document_search",
      result: "denied",
      errorCategory: "not_authorized",
    });
    expect(JSON.stringify(loggedEvents())).not.toContain("owner@example.com");
  });

  it("未認証はログイン画面へ戻し、検索も監査も実行されない", async () => {
    await expect(loader(loaderArgs(""))).rejects.toMatchObject({ status: 302 });

    expect(searchDocumentsForAdminMock).not.toHaveBeenCalled();
    expect(insertAuditEventMock).not.toHaveBeenCalled();
  });

  it("管理者は他人の資料を含む全資料を検索できる", async () => {
    searchDocumentsForAdminMock.mockResolvedValue({
      documents: [
        documentRecord(),
        documentRecord({
          id: OTHER_DOCUMENT_ID,
          ownerSubjectId: "oid-another",
          ownerEmailAtUpload: "another@example.com",
        }),
      ],
      nextCursor: null,
    });

    const result = await searchAs(adminUser);

    // 所有者条件はrepositoryへ渡さない(管理者は全資料が対象。設計 §4.2)。
    expect(lastSearchOptions()).not.toHaveProperty("ownerSubjectId");
    expect(result.page.documents).toHaveLength(2);
    expect(result.page.documents[0]).toMatchObject({
      id: DOCUMENT_ID,
      title: "資料タイトル",
      originalFileName: "極秘資料.html",
      // オーナーのメールアドレスは管理者にだけ返す(設計 §5.6)。
      ownerEmail: "owner@example.com",
    });
  });
});

// --- 検索条件(設計 §5.6) ---

describe("検索条件", () => {
  it("条件を指定しない場合は絞り込まず、1ページ20件で取得する", async () => {
    await searchAs(adminUser);

    expect(lastSearchOptions()).toEqual({
      documentId: null,
      ownerEmail: null,
      originalFileName: null,
      uploadedFrom: null,
      uploadedTo: null,
      limit: 20,
      cursor: null,
    });
  });

  it("資料ID・オーナーのメール・元ファイル名・日時範囲をそのままrepositoryへ渡す", async () => {
    await searchAs(
      adminUser,
      `?documentId=${DOCUMENT_ID}&ownerEmail=owner%40example.com&fileName=%E8%B3%87%E6%96%99` +
        "&uploadedFrom=2026-01-02T00%3A00&uploadedTo=2026-01-02T23%3A59",
    );

    expect(lastSearchOptions()).toMatchObject({
      documentId: DOCUMENT_ID,
      ownerEmail: "owner@example.com",
      originalFileName: "資料",
      // 入力は日本時間、repositoryへはUTCのISO日時で渡す(設計 §5.2)。
      uploadedFrom: "2026-01-01T15:00:00.000Z",
      // 上限は指定した分の終わりまでを含める。repositoryのSQLは
      // `created_at < uploadedTo`(排他的上限)なので、23:59 JSTの1分後を渡す。
      uploadedTo: "2026-01-02T15:00:00.000Z",
      limit: 20,
    });
  });

  it("`LIKE`のワイルドカードを含む入力もそのまま渡す(エスケープはrepositoryが行う)", async () => {
    await searchAs(adminUser, "?fileName=%25&ownerEmail=_");

    expect(lastSearchOptions()).toMatchObject({
      originalFileName: "%",
      ownerEmail: "_",
    });
  });

  it("UUIDでない資料IDはDBへ渡す前に400で拒否する", async () => {
    const denial = (await searchAs(adminUser, "?documentId=not-a-uuid").catch(
      (error: Response) => error,
    )) as Response;

    expect(denial.status).toBe(400);
    expect(await denial.text()).toContain("検索条件の形式が正しくありません");
    expect(searchDocumentsForAdminMock).not.toHaveBeenCalled();
    expect(insertAuditEventMock).not.toHaveBeenCalled();
  });

  it.each([
    ["日付として存在しない日時", "?uploadedFrom=2026-02-30T00%3A00"],
    ["形式が違う日時", "?uploadedFrom=2026%2F01%2F02"],
    ["秒まで含む日時", "?uploadedTo=2026-01-02T00%3A00%3A00"],
    ["極端に長いメールアドレス", `?ownerEmail=${"a".repeat(321)}`],
    ["極端に長いファイル名", `?fileName=${"a".repeat(1001)}`],
    ["極端に長いcursor", `?cursor=${"a".repeat(501)}`],
  ])("%s はDBへ渡す前に400で拒否する", async (_label, query) => {
    await expect(searchAs(adminUser, query)).rejects.toMatchObject({
      status: 400,
    });

    expect(searchDocumentsForAdminMock).not.toHaveBeenCalled();
  });

  it("未知のクエリ文字列は検索条件として扱わない", async () => {
    await searchAs(adminUser, "?ownerSubjectId=oid-someone-else&limit=1000");

    expect(lastSearchOptions()).toMatchObject({ limit: 20 });
    expect(JSON.stringify(lastSearchOptions())).not.toContain(
      "oid-someone-else",
    );
  });
});

// --- ページング(keyset pagination) ---

describe("ページング", () => {
  it("次ページがある場合はcursorを返し、cursor指定をrepositoryへ渡す", async () => {
    searchDocumentsForAdminMock.mockResolvedValue({
      documents: [documentRecord()],
      nextCursor: "next-cursor-token",
    });

    const first = await searchAs(adminUser, "?fileName=%E8%B3%87%E6%96%99");
    expect(first.page.nextCursor).toBe("next-cursor-token");

    await searchAs(
      adminUser,
      "?fileName=%E8%B3%87%E6%96%99&cursor=next-cursor-token",
    );
    expect(lastSearchOptions()).toMatchObject({
      originalFileName: "資料",
      cursor: "next-cursor-token",
    });
  });

  it("壊れたcursorは400で拒否する", async () => {
    searchDocumentsForAdminMock.mockRejectedValue(new InvalidCursorError());

    const denial = (await searchAs(adminUser, "?cursor=broken").catch(
      (error: Response) => error,
    )) as Response;

    expect(denial.status).toBe(400);
    expect(await denial.text()).toContain("一覧の続きを取得できませんでした");
  });
});

// --- 監査(設計 §5.6, §12.2, §15.1) ---

describe("管理操作の監査", () => {
  it("検索・一覧閲覧を`admin_operation`として操作者の情報とともに記録する", async () => {
    searchDocumentsForAdminMock.mockResolvedValue({
      documents: [documentRecord()],
      nextCursor: null,
    });

    await searchAs(adminUser);

    expect(insertAuditEventMock).toHaveBeenCalledTimes(1);
    expect(lastAuditInput()).toMatchObject({
      action: "admin_operation",
      result: "success",
      // 対象資料が一意に定まらない検索は`document_id = null`(QUESTIONS Q-027)。
      documentId: null,
      actorSubjectId: adminUser.id,
      actorTenantId: adminUser.tenantId,
      actorEmailAtEvent: adminUser.email,
      actorRoles: ["Admin"],
      actorGroupValues: ["ZAA535-A"],
      errorCategory: null,
    });
  });

  it("監査へ検索条件(ファイル名・検索対象のメールアドレス)を保存しない(設計 §12.2)", async () => {
    searchDocumentsForAdminMock.mockResolvedValue({
      documents: [documentRecord()],
      nextCursor: null,
    });

    await searchAs(
      adminUser,
      "?ownerEmail=owner%40example.com&fileName=%E6%A5%B5%E7%A7%98%E8%B3%87%E6%96%99.html",
    );

    const audited = JSON.stringify(lastAuditInput());
    expect(audited).not.toContain("owner@example.com");
    expect(audited).not.toContain("極秘資料.html");
    // 操作者本人のメールアドレスだけは設計 §12.2で保存してよい項目。
    expect(lastAuditInput().actorEmailAtEvent).toBe(adminUser.email);
  });

  it("運用ログにも検索条件を出さない(設計 §15.2)", async () => {
    await searchAs(
      adminUser,
      "?ownerEmail=owner%40example.com&fileName=%E6%A5%B5%E7%A7%98%E8%B3%87%E6%96%99.html",
    );

    const logged = JSON.stringify(loggedEvents());
    expect(logged).not.toContain("owner@example.com");
    expect(logged).not.toContain("極秘資料.html");
    expect(loggedEvents().at(-1)).toMatchObject({
      event: "admin_document_search",
      result: "success",
    });
  });

  it("資料IDで1件に定まる検索は対象資料IDを監査へ残す", async () => {
    searchDocumentsForAdminMock.mockResolvedValue({
      documents: [documentRecord()],
      nextCursor: null,
    });

    await searchAs(adminUser, `?documentId=${DOCUMENT_ID}`);

    expect(lastAuditInput().documentId).toBe(DOCUMENT_ID);
  });

  it("資料IDで検索しても該当が無ければ`document_id = null`で記録する", async () => {
    await searchAs(adminUser, `?documentId=${DOCUMENT_ID}`);

    expect(lastAuditInput().documentId).toBeNull();
  });

  it("検索と監査を同じトランザクションで実行する(設計 §15.1)", async () => {
    await searchAs(adminUser);

    expect(transactionCalls).toEqual(["begin", "commit"]);
    expect(searchDocumentsForAdminMock.mock.calls[0]?.[1]).toBe(tx);
    expect(insertAuditEventMock.mock.calls[0]?.[1]).toBe(tx);
  });

  it("監査保存に失敗した検索結果は画面へ返さない(設計 §15.1)", async () => {
    searchDocumentsForAdminMock.mockResolvedValue({
      documents: [documentRecord()],
      nextCursor: null,
    });
    insertAuditEventMock.mockRejectedValue(new Error("audit insert failed"));

    const failure = (await searchAs(adminUser).catch(
      (error: Response) => error,
    )) as Response;

    expect(failure.status).toBe(500);
    const body = await failure.text();
    expect(body).toContain("資料を検索できませんでした");
    // 内部情報(例外メッセージ)は画面へ出さない(設計 §14)。
    expect(body).not.toContain("audit insert failed");
    expect(transactionCalls).toEqual(["begin", "rollback"]);
  });

  it("検索に失敗した場合も内部情報を出さず500にする", async () => {
    searchDocumentsForAdminMock.mockRejectedValue(new Error("select failed"));

    const failure = (await searchAs(adminUser).catch(
      (error: Response) => error,
    )) as Response;

    expect(failure.status).toBe(500);
    expect(await failure.text()).not.toContain("select failed");
    expect(loggedEvents().at(-1)).toMatchObject({
      result: "failed",
      errorCategory: "database_failed",
    });
  });
});

// --- 画面(設計 §5.2のカード項目, §5.6) ---

function cardFrom(overrides: Record<string, unknown> = {}) {
  return {
    id: DOCUMENT_ID,
    title: "資料タイトル",
    originalFileName: "極秘資料.html",
    ownerEmail: "owner@example.com",
    byteSize: 2048,
    previewStatus: "ready" as const,
    createdAt: new Date("2026-01-02T15:30:00.000Z"),
    ...overrides,
  };
}

const emptyCriteria = {
  documentId: "",
  ownerEmail: "",
  fileName: "",
  uploadedFrom: "",
  uploadedTo: "",
  cursor: "",
};

function renderAdminDocuments(options: {
  documents?: ReturnType<typeof cardFrom>[];
  nextCursor?: string | null;
  criteria?: Partial<typeof emptyCriteria>;
} = {}) {
  const Stub = createRoutesStub([
    {
      path: "/admin/documents",
      Component: AdminDocuments,
      loader: async () => ({
        criteria: { ...emptyCriteria, ...options.criteria },
        page: {
          documents: options.documents ?? [],
          nextCursor: options.nextCursor ?? null,
        },
      }),
    },
  ]);

  return render(<Stub initialEntries={["/admin/documents"]} />);
}

describe("管理画面コンポーネント", () => {
  it("4つの検索条件の入力欄を表示する(設計 §5.6)", async () => {
    renderAdminDocuments();

    await screen.findByLabelText("資料ID");
    expect(screen.getByLabelText("オーナーのメールアドレス")).toBeTruthy();
    expect(screen.getByLabelText("元ファイル名")).toBeTruthy();
    expect(screen.getByLabelText("アップロード日時（開始）")).toBeTruthy();
    expect(screen.getByLabelText("アップロード日時（終了）")).toBeTruthy();
  });

  it("検索フォームは読み取りのみのGETで、cursorを引き継がない", async () => {
    renderAdminDocuments({ criteria: { fileName: "資料" } });

    const input = await screen.findByLabelText("元ファイル名");
    const form = input.closest("form");
    expect(form?.getAttribute("method")).toBe("get");
    expect(form?.querySelector('[name="cursor"]')).toBeNull();
    expect((input as HTMLInputElement).value).toBe("資料");
  });

  it("カードにオーナーのメールアドレスと資料の情報を表示する", async () => {
    renderAdminDocuments({ documents: [cardFrom()] });

    await screen.findByText("資料タイトル");
    expect(screen.getByText("owner@example.com")).toBeTruthy();
    expect(screen.getByText("極秘資料.html")).toBeTruthy();
    // UTC 15:30 → JST 翌日00:30(設計 §5.2)。
    expect(screen.getByText("2026/01/03 00:30")).toBeTruthy();
    expect(screen.getByText("2.0 KB")).toBeTruthy();
    expect(screen.getByText("生成済み")).toBeTruthy();
  });

  it("資料表示画面と削除確認画面への導線を出す(この画面では削除しない)", async () => {
    renderAdminDocuments({ documents: [cardFrom()] });

    const open = (await screen.findByRole("link", {
      name: "資料を開く",
    })) as HTMLAnchorElement;
    expect(open.getAttribute("href")).toBe(`/documents/${DOCUMENT_ID}`);

    const forceDelete = screen.getByRole("link", {
      name: "強制削除",
    }) as HTMLAnchorElement;
    // T14の確認画面へのGET遷移だけを持ち、削除のPOSTはこの画面に無い(設計 §5.5)。
    expect(forceDelete.getAttribute("href")).toBe(
      `/documents/${DOCUMENT_ID}/delete`,
    );
    expect(
      document.querySelector('form[method="post"]'),
    ).toBeNull();
  });

  it("オーナー変更の操作を置かない(設計 §5.6)", async () => {
    renderAdminDocuments({ documents: [cardFrom()] });

    await screen.findByText("資料タイトル");
    expect(screen.queryByText(/オーナー変更/)).toBeNull();
    expect(screen.queryByLabelText(/新しいオーナー/)).toBeNull();
  });

  it("次ページのリンクへ検索条件とcursorを引き継ぐ", async () => {
    renderAdminDocuments({
      documents: [cardFrom()],
      nextCursor: "next-cursor-token",
      criteria: { fileName: "資料" },
    });

    const next = (await screen.findByRole("link", {
      name: "次を表示",
    })) as HTMLAnchorElement;
    const url = new URL(next.getAttribute("href") ?? "", origin);
    expect(url.pathname).toBe("/admin/documents");
    expect(url.searchParams.get("fileName")).toBe("資料");
    expect(url.searchParams.get("cursor")).toBe("next-cursor-token");
    // 未指定の条件は引き継がない。
    expect(url.searchParams.get("ownerEmail")).toBeNull();
  });

  it("該当が無い場合は案内を表示する", async () => {
    renderAdminDocuments({ documents: [] });

    await screen.findByText("条件に一致する資料はありません。");
  });
});
