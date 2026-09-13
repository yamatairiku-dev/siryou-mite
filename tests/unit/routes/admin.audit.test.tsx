import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoutesStub } from "react-router";
import type {
  AuditEventInput,
  AuditEventPage,
  AuditEventSearchRecord,
  SearchAuditEventsOptions,
} from "~/lib/db/audit-events.server";
import { InvalidAuditCursorError } from "~/lib/db/audit-events.server";
import type { Queryable } from "~/lib/db/pool.server";
import { createUserSession, type AppUser } from "~/lib/session.server";

/**
 * T17 単体テスト: 監査履歴画面`/admin/audit`(設計 §5.7, §4.2, §12.2, §15.1)。
 *
 * - 一般ユーザー・未認証が拒否され、監査履歴のSELECTへ1回も到達しないことを
 *   確認する(UIの非表示ではなくloaderで認可していることの根拠)。
 * - 検索条件(日時・利用者・資料ID・操作・結果)がZod検証を通ってrepositoryへ
 *   渡ること、enum外・形式不正の値がDBへ渡らないことを確認する。
 * - 監査履歴の閲覧自体が`admin_operation`として、検索と同じトランザクションで
 *   監査されることを確認する(監査保存に失敗した閲覧結果は返さない)。
 * - 運用ログへ検索条件・メールアドレス・roles/groupsが出ないことを確認する。
 */

const searchAuditEventsMock = vi.fn<
  (options: SearchAuditEventsOptions, tx: Queryable) => Promise<AuditEventPage>
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

vi.mock("~/lib/db/audit-events.server", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("~/lib/db/audit-events.server")>();
  return {
    ...actual,
    searchAuditEvents: (options: SearchAuditEventsOptions, executor: Queryable) =>
      searchAuditEventsMock(options, executor),
    insertAuditEvent: (input: AuditEventInput, executor: Queryable) =>
      insertAuditEventMock(input, executor),
  };
});

const { loader, default: AdminAudit } = await import("~/routes/admin.audit");

const origin = "http://localhost:3000";
const DOCUMENT_ID = "11111111-1111-4111-8111-111111111111";
const EVENT_ID = "99999999-9999-4999-8999-999999999999";
const CORRELATION_ID = "33333333-4444-4555-8666-777777777777";

const adminUser: AppUser = {
  id: "oid-admin",
  tenantId: "tenant-001",
  name: "管理者 次郎",
  email: "admin@example.com",
  roles: ["Admin"],
  groups: ["ZAA535-A"],
};

/** 管理者ではない一般利用者(監査履歴を検索できない)。 */
const generalUser: AppUser = {
  id: "oid-user",
  tenantId: "tenant-001",
  name: "一般 太郎",
  email: "user@example.com",
  roles: ["User"],
  groups: ["ZAA535-A"],
};

/** 他人の操作を含む監査履歴の1行。 */
function auditEventRecord(
  overrides: Partial<AuditEventSearchRecord> = {},
): AuditEventSearchRecord {
  return {
    id: EVENT_ID,
    occurredAt: new Date("2026-01-02T15:30:00.000Z"),
    action: "upload",
    result: "success",
    documentId: DOCUMENT_ID,
    actorSubjectId: "oid-someone-else",
    actorTenantId: "tenant-001",
    actorEmailAtEvent: "owner@example.com",
    actorGroupValues: ["ZAA535-B"],
    actorRoles: ["User"],
    correlationId: CORRELATION_ID,
    errorCategory: null,
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
      `${origin}/admin/audit${query}`,
      cookie ? { headers: { Cookie: cookie } } : {},
    ),
  } as unknown as Parameters<typeof loader>[0];
}

async function searchAs(user: AppUser, query = "") {
  return loader(loaderArgs(query, await sessionCookieFor(user)));
}

/** 直近の検索条件(repositoryへ渡された値)。 */
function lastSearchOptions(): SearchAuditEventsOptions {
  const call = searchAuditEventsMock.mock.calls.at(-1);
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
  searchAuditEventsMock.mockReset();
  searchAuditEventsMock.mockResolvedValue({ events: [], nextCursor: null });
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

// --- 認可(設計 §4.2, §5.7) ---

describe("認可", () => {
  it("一般ユーザー(Adminなし)は403で拒否され、監査履歴の検索SQLが1回も実行されない", async () => {
    const denial = (await searchAs(generalUser).catch(
      (error: Response) => error,
    )) as Response;

    expect(denial.status).toBe(403);
    expect(await denial.text()).toBe("管理機能を利用する権限がありません");
    expect(searchAuditEventsMock).not.toHaveBeenCalled();
    expect(insertAuditEventMock).not.toHaveBeenCalled();
    expect(transactionCalls).toEqual([]);
  });

  it("一般ユーザーは検索条件を付けても他人の監査履歴へ到達できない", async () => {
    await expect(
      searchAs(generalUser, "?actorEmail=owner%40example.com"),
    ).rejects.toMatchObject({ status: 403 });

    expect(searchAuditEventsMock).not.toHaveBeenCalled();
  });

  it("未認証はログイン画面へ戻し、検索も監査も実行されない", async () => {
    await expect(loader(loaderArgs(""))).rejects.toMatchObject({ status: 302 });

    expect(searchAuditEventsMock).not.toHaveBeenCalled();
    expect(insertAuditEventMock).not.toHaveBeenCalled();
  });

  it("権限不足の拒否は運用ログへ残す(検索条件は出さない)", async () => {
    await searchAs(generalUser, "?actorEmail=owner%40example.com").catch(
      () => undefined,
    );

    const denied = loggedEvents().find((event) => event.result === "denied");
    expect(denied).toMatchObject({
      event: "admin_audit_search",
      result: "denied",
      errorCategory: "not_authorized",
    });
    expect(JSON.stringify(loggedEvents())).not.toContain("owner@example.com");
  });

  it("管理者は他人の操作を含む監査履歴を閲覧できる", async () => {
    searchAuditEventsMock.mockResolvedValue({
      events: [auditEventRecord()],
      nextCursor: null,
    });

    const result = await searchAs(adminUser);

    // 利用者(操作者)で自動的に絞らない。管理者は全利用者の履歴が対象(設計 §5.7)。
    expect(lastSearchOptions()).toMatchObject({ actorSubjectId: null });
    expect(result.page.events[0]).toMatchObject({
      id: EVENT_ID,
      action: "upload",
      result: "success",
      documentId: DOCUMENT_ID,
      actorSubjectId: "oid-someone-else",
      actorEmail: "owner@example.com",
      actorRoles: ["User"],
      actorGroupValues: ["ZAA535-B"],
      correlationId: CORRELATION_ID,
    });
  });
});

// --- 検索条件(設計 §5.7) ---

describe("検索条件", () => {
  it("条件を指定しない場合は絞り込まず、1ページ20件で取得する", async () => {
    await searchAs(adminUser);

    expect(lastSearchOptions()).toEqual({
      occurredFrom: null,
      occurredTo: null,
      actorSubjectId: null,
      actorEmail: null,
      documentId: null,
      action: null,
      result: null,
      limit: 20,
      cursor: null,
    });
  });

  it("日時・利用者・資料ID・操作・結果をZod検証してからrepositoryへ渡す", async () => {
    await searchAs(
      adminUser,
      "?occurredFrom=2026-01-02T00%3A00&occurredTo=2026-01-02T23%3A59" +
        `&actorEmail=owner%40example.com&actorSubjectId=oid-someone-else&documentId=${DOCUMENT_ID}` +
        "&action=delete&result=denied",
    );

    expect(lastSearchOptions()).toMatchObject({
      // 入力は日本時間、repositoryへはUTCのISO日時で渡す(設計 §5.2)。
      occurredFrom: "2026-01-01T15:00:00.000Z",
      // 上限は指定した分の終わりまでを含める。repositoryのSQLは
      // `occurred_at < occurredTo`(排他的上限)なので、23:59 JSTの1分後を渡す。
      occurredTo: "2026-01-02T15:00:00.000Z",
      actorEmail: "owner@example.com",
      actorSubjectId: "oid-someone-else",
      documentId: DOCUMENT_ID,
      action: "delete",
      result: "denied",
      limit: 20,
    });
  });

  it("`LIKE`のワイルドカードを含む入力もそのまま渡す(エスケープはrepositoryが行う)", async () => {
    await searchAs(adminUser, "?actorEmail=%25");

    expect(lastSearchOptions()).toMatchObject({ actorEmail: "%" });
  });

  it.each([
    ["enum外の操作", "?action=drop_table"],
    ["enum外の結果", "?result=partial"],
    ["大文字の操作名", "?action=UPLOAD"],
    ["UUIDでない資料ID", "?documentId=not-a-uuid"],
    ["日付として存在しない日時", "?occurredFrom=2026-02-30T00%3A00"],
    ["形式が違う日時", "?occurredFrom=2026%2F01%2F02"],
    ["秒まで含む日時", "?occurredTo=2026-01-02T00%3A00%3A00"],
    ["極端に長いメールアドレス", `?actorEmail=${"a".repeat(321)}`],
    ["極端に長い利用者ID", `?actorSubjectId=${"a".repeat(201)}`],
    ["極端に長いcursor", `?cursor=${"a".repeat(501)}`],
  ])("%s はDBへ渡す前に400で拒否する", async (_label, query) => {
    const denial = (await searchAs(adminUser, query).catch(
      (error: Response) => error,
    )) as Response;

    expect(denial.status).toBe(400);
    expect(await denial.text()).toContain("検索条件の形式が正しくありません");
    expect(searchAuditEventsMock).not.toHaveBeenCalled();
    // 入力検証エラーは監査へ残さない(QUESTIONS Q-034)。
    expect(insertAuditEventMock).not.toHaveBeenCalled();
  });

  it("未知のクエリ文字列は検索条件として扱わない", async () => {
    await searchAs(adminUser, "?actorTenantId=tenant-999&limit=1000");

    expect(lastSearchOptions()).toMatchObject({ limit: 20 });
    expect(JSON.stringify(lastSearchOptions())).not.toContain("tenant-999");
  });
});

// --- ページング(keyset pagination) ---

describe("ページング", () => {
  it("次ページがある場合はcursorを返し、cursor指定をrepositoryへ渡す", async () => {
    searchAuditEventsMock.mockResolvedValue({
      events: [auditEventRecord()],
      nextCursor: "next-cursor-token",
    });

    const first = await searchAs(adminUser, "?action=view");
    expect(first.page.nextCursor).toBe("next-cursor-token");

    await searchAs(adminUser, "?action=view&cursor=next-cursor-token");
    expect(lastSearchOptions()).toMatchObject({
      action: "view",
      cursor: "next-cursor-token",
    });
  });

  it("壊れたcursorは400で拒否する", async () => {
    searchAuditEventsMock.mockRejectedValue(new InvalidAuditCursorError());

    const denial = (await searchAs(adminUser, "?cursor=broken").catch(
      (error: Response) => error,
    )) as Response;

    expect(denial.status).toBe(400);
    expect(await denial.text()).toContain("監査履歴の続きを取得できませんでした");
  });
});

// --- 監査履歴閲覧の監査(設計 §5.7, §15.1) ---

describe("監査履歴閲覧の監査", () => {
  it("監査履歴の閲覧を`admin_operation`として操作者の情報とともに記録する", async () => {
    searchAuditEventsMock.mockResolvedValue({
      events: [auditEventRecord()],
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

  it("検索と監査を同じトランザクションで実行する(設計 §15.1)", async () => {
    await searchAs(adminUser);

    expect(transactionCalls).toEqual(["begin", "commit"]);
    expect(searchAuditEventsMock.mock.calls[0]?.[1]).toBe(tx);
    expect(insertAuditEventMock.mock.calls[0]?.[1]).toBe(tx);
  });

  it("監査保存に失敗した閲覧結果は画面へ返さない(設計 §15.1)", async () => {
    searchAuditEventsMock.mockResolvedValue({
      events: [auditEventRecord()],
      nextCursor: null,
    });
    insertAuditEventMock.mockRejectedValue(new Error("audit insert failed"));

    const failure = (await searchAs(adminUser).catch(
      (error: Response) => error,
    )) as Response;

    expect(failure.status).toBe(500);
    const body = await failure.text();
    expect(body).toContain("監査履歴を検索できませんでした");
    // 内部情報(例外メッセージ)は画面へ出さない(設計 §14)。
    expect(body).not.toContain("audit insert failed");
    expect(transactionCalls).toEqual(["begin", "rollback"]);
  });

  it("検索に失敗した場合も内部情報を出さず500にする", async () => {
    searchAuditEventsMock.mockRejectedValue(new Error("select failed"));

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

  it("資料IDで絞り込み、その資料の履歴が見つかった場合だけ資料IDを監査へ残す", async () => {
    searchAuditEventsMock.mockResolvedValue({
      events: [auditEventRecord()],
      nextCursor: null,
    });

    await searchAs(adminUser, `?documentId=${DOCUMENT_ID}`);

    expect(lastAuditInput().documentId).toBe(DOCUMENT_ID);
  });

  it("資料IDで検索しても該当が無ければ`document_id = null`で記録する", async () => {
    await searchAs(adminUser, `?documentId=${DOCUMENT_ID}`);

    expect(lastAuditInput().documentId).toBeNull();
  });

  it("監査へ検索条件(検索対象のメールアドレス・利用者ID)を保存しない(設計 §12.2)", async () => {
    searchAuditEventsMock.mockResolvedValue({
      events: [auditEventRecord()],
      nextCursor: null,
    });

    await searchAs(
      adminUser,
      "?actorEmail=owner%40example.com&actorSubjectId=oid-someone-else",
    );

    const audited = JSON.stringify(lastAuditInput());
    expect(audited).not.toContain("owner@example.com");
    expect(audited).not.toContain("oid-someone-else");
    // 操作者本人のメールアドレスだけは設計 §12.2で保存してよい項目。
    expect(lastAuditInput().actorEmailAtEvent).toBe(adminUser.email);
  });

  it("運用ログに検索条件・メールアドレス・roles/groupsを出さない(設計 §15.2)", async () => {
    searchAuditEventsMock.mockResolvedValue({
      events: [auditEventRecord()],
      nextCursor: null,
    });

    await searchAs(
      adminUser,
      "?actorEmail=owner%40example.com&actorSubjectId=oid-someone-else&action=delete",
    );

    const logged = JSON.stringify(loggedEvents());
    expect(logged).not.toContain("owner@example.com");
    expect(logged).not.toContain("admin@example.com");
    expect(logged).not.toContain("oid-someone-else");
    expect(logged).not.toContain("oid-admin");
    expect(logged).not.toContain("ZAA535");
    expect(logged).not.toContain("Admin");
    expect(loggedEvents().at(-1)).toMatchObject({
      event: "admin_audit_search",
      result: "success",
    });
  });
});

// --- 画面(設計 §5.7) ---

function eventFrom(overrides: Record<string, unknown> = {}) {
  return {
    id: EVENT_ID,
    occurredAt: new Date("2026-01-02T15:30:00.000Z"),
    action: "upload" as const,
    result: "success" as const,
    documentId: DOCUMENT_ID,
    actorSubjectId: "oid-someone-else",
    actorEmail: "owner@example.com",
    actorGroupValues: ["ZAA535-B"],
    actorRoles: ["User"],
    correlationId: CORRELATION_ID,
    errorCategory: null,
    ...overrides,
  };
}

const emptyCriteria = {
  occurredFrom: "",
  occurredTo: "",
  actorSubjectId: "",
  actorEmail: "",
  documentId: "",
  action: "",
  result: "",
  cursor: "",
};

function renderAdminAudit(
  options: {
    events?: ReturnType<typeof eventFrom>[];
    nextCursor?: string | null;
    criteria?: Partial<typeof emptyCriteria>;
  } = {},
) {
  const Stub = createRoutesStub([
    {
      path: "/admin/audit",
      Component: AdminAudit,
      loader: async () => ({
        criteria: { ...emptyCriteria, ...options.criteria },
        page: {
          events: options.events ?? [],
          nextCursor: options.nextCursor ?? null,
        },
      }),
    },
  ]);

  return render(<Stub initialEntries={["/admin/audit"]} />);
}

describe("監査履歴画面コンポーネント", () => {
  it("5種類の検索条件の入力欄を表示する(設計 §5.7)", async () => {
    renderAdminAudit();

    await screen.findByLabelText("日時（開始）");
    expect(screen.getByLabelText("日時（終了）")).toBeTruthy();
    expect(screen.getByLabelText("利用者のメールアドレス")).toBeTruthy();
    expect(screen.getByLabelText("利用者ID")).toBeTruthy();
    expect(screen.getByLabelText("資料ID")).toBeTruthy();
    expect(screen.getByLabelText("操作")).toBeTruthy();
    expect(screen.getByLabelText("結果")).toBeTruthy();
  });

  it("操作・結果は自由入力ではなく選択肢にする(設計 §12.2のenum)", async () => {
    renderAdminAudit();

    const action = (await screen.findByLabelText("操作")) as HTMLSelectElement;
    expect([...action.options].map((option) => option.value)).toEqual([
      "",
      "upload",
      "view",
      "delete",
      "admin_operation",
    ]);
    const result = screen.getByLabelText("結果") as HTMLSelectElement;
    expect([...result.options].map((option) => option.value)).toEqual([
      "",
      "success",
      "denied",
      "failed",
    ]);
  });

  it("検索フォームは読み取りのみのGETで、更新のactionを持たない", async () => {
    renderAdminAudit({ criteria: { actorEmail: "owner@example.com" } });

    const input = await screen.findByLabelText("利用者のメールアドレス");
    const form = input.closest("form");
    expect(form?.getAttribute("method")).toBe("get");
    expect(form?.querySelector('[name="cursor"]')).toBeNull();
    expect((input as HTMLInputElement).value).toBe("owner@example.com");
    expect(document.querySelector('form[method="post"]')).toBeNull();
  });

  it("監査履歴の内容を日本時間で表示する", async () => {
    renderAdminAudit({ events: [eventFrom()] });

    // UTC 15:30 → JST 翌日00:30(設計 §5.2)。
    await screen.findByText("2026/01/03 00:30");
    expect(screen.getByText("アップロード／成功")).toBeTruthy();
    expect(screen.getByText("owner@example.com")).toBeTruthy();
    expect(screen.getByText("oid-someone-else")).toBeTruthy();
    expect(screen.getByText(DOCUMENT_ID)).toBeTruthy();
    expect(screen.getByText(CORRELATION_ID)).toBeTruthy();
  });

  it("CSV出力と詳細分析の操作を置かない(設計 §5.7)", async () => {
    renderAdminAudit({ events: [eventFrom()] });

    await screen.findByText("アップロード／成功");
    expect(screen.queryByText(/CSV/)).toBeNull();
    expect(screen.queryByText(/ダウンロード/)).toBeNull();
    expect(screen.queryByText(/集計|分析/)).toBeNull();
  });

  it("次ページのリンクへ検索条件とcursorを引き継ぐ", async () => {
    renderAdminAudit({
      events: [eventFrom()],
      nextCursor: "next-cursor-token",
      criteria: { action: "upload" },
    });

    const next = (await screen.findByRole("link", {
      name: "次を表示",
    })) as HTMLAnchorElement;
    const url = new URL(next.getAttribute("href") ?? "", origin);
    expect(url.pathname).toBe("/admin/audit");
    expect(url.searchParams.get("action")).toBe("upload");
    expect(url.searchParams.get("cursor")).toBe("next-cursor-token");
    // 未指定の条件は引き継がない。
    expect(url.searchParams.get("actorEmail")).toBeNull();
  });

  it("該当が無い場合は案内を表示する", async () => {
    renderAdminAudit({ events: [] });

    await screen.findByText("条件に一致する監査履歴はありません。");
  });
});
