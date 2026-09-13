import { act } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoutesStub } from "react-router";
import type {
  DocumentListPage,
  DocumentRecord,
} from "~/lib/db/documents.server";
import { InvalidCursorError } from "~/lib/db/documents.server";
import { createUserSession, type AppUser } from "~/lib/session.server";
import type { UploadErrorBody, UploadSuccessBody } from "~/lib/upload/upload.server";

/**
 * T10 単体テスト: 初期画面(設計 §5.2, §5.3, §13)。
 *
 * - loaderは`listDocumentsByOwner`を必ずログイン利用者自身の`ownerSubjectId`で
 *   呼び出しており、他人の資料が混ざり得ないことを確認する。
 * - 画面コンポーネントは1ファイル制限、警告表示、日時のJST表示、ページング、
 *   プレビュー状態の切り替え、オーナーのみの削除導線を確認する。
 *
 * T15追加分: `pending`のカードだけが`/documents/:documentId/preview-status`を
 * ポーリングし、`pending`以外になったら止まること、`pending`のカードが
 * 無いときはポーリングしないことを確認する(設計 §5.3, §13)。
 */

const listDocumentsByOwnerMock = vi.fn<
  (options: { ownerSubjectId: string; cursor: string | null }) => Promise<DocumentListPage>
>();

vi.mock("~/lib/db/documents.server", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("~/lib/db/documents.server")>();
  return {
    ...actual,
    listDocumentsByOwner: (options: {
      ownerSubjectId: string;
      cursor: string | null;
    }) => listDocumentsByOwnerMock(options),
  };
});

const { loader, default: Application } = await import("~/routes/app");

const owner: AppUser = {
  id: "oid-owner",
  tenantId: "tenant-001",
  name: "所有者 太郎",
  email: "owner@example.com",
  roles: ["User"],
  groups: ["ZAA535-A"],
};

/** 同じ利用者が`Admin`ロールも持つ場合(管理画面への導線の表示確認に使う)。 */
const ownerAdmin: AppUser = {
  ...owner,
  id: "oid-owner-admin",
  name: "所有者 兼 管理者",
  roles: ["User", "Admin"],
};

const otherUserId = "oid-someone-else";

function documentRecord(overrides: Partial<DocumentRecord> = {}): DocumentRecord {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    ownerSubjectId: owner.id,
    ownerEmailAtUpload: owner.email,
    originalFileName: "資料.html",
    title: "資料タイトル",
    byteSize: 2048,
    previewStatus: "pending",
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

beforeEach(() => {
  listDocumentsByOwnerMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("loader (所有者の資料だけを取得する)", () => {
  it("ログイン利用者自身のownerSubjectIdだけで一覧を取得する(他人の資料は要求しない)", async () => {
    listDocumentsByOwnerMock.mockResolvedValue({
      documents: [documentRecord()],
      nextCursor: null,
    });
    const cookie = await sessionCookieFor(owner);

    await loader({
      request: new Request("http://localhost:3000/app", {
        headers: { Cookie: cookie },
      }),
    } as unknown as Parameters<typeof loader>[0]);

    expect(listDocumentsByOwnerMock).toHaveBeenCalledTimes(1);
    const [options] = listDocumentsByOwnerMock.mock.calls[0] ?? [];
    // 呼び出しに使われた所有者IDは常にログイン利用者自身であり、他の利用者IDや
    // クライアントが指定した値ではない(他人の資料が出ないことの根拠)。
    expect(options).toMatchObject({ ownerSubjectId: owner.id });
    expect(options?.ownerSubjectId).not.toBe(otherUserId);
  });

  it("取得した資料をカード表示用DTOへ変換し、オーナー本人には削除導線を許可する", async () => {
    listDocumentsByOwnerMock.mockResolvedValue({
      documents: [documentRecord()],
      nextCursor: "next-cursor-token",
    });
    const cookie = await sessionCookieFor(owner);

    const result = await loader({
      request: new Request("http://localhost:3000/app", {
        headers: { Cookie: cookie },
      }),
    } as unknown as Parameters<typeof loader>[0]);

    expect(result.page.documents).toHaveLength(1);
    expect(result.page.documents[0]).toMatchObject({
      title: "資料タイトル",
      originalFileName: "資料.html",
      byteSize: 2048,
      previewStatus: "pending",
      canDelete: true,
    });
    expect(result.page.nextCursor).toBe("next-cursor-token");
  });

  it("管理画面への導線は`Admin`ロールを持つ利用者にだけ許可する(設計 §5.6)", async () => {
    listDocumentsByOwnerMock.mockResolvedValue({ documents: [], nextCursor: null });

    const asGeneralUser = await loader({
      request: new Request("http://localhost:3000/app", {
        headers: { Cookie: await sessionCookieFor(owner) },
      }),
    } as unknown as Parameters<typeof loader>[0]);
    expect(asGeneralUser.canUseAdminScreen).toBe(false);

    const asAdmin = await loader({
      request: new Request("http://localhost:3000/app", {
        headers: { Cookie: await sessionCookieFor(ownerAdmin) },
      }),
    } as unknown as Parameters<typeof loader>[0]);
    expect(asAdmin.canUseAdminScreen).toBe(true);

    // この値は表示制御であって認可ではない。管理画面側の認可は
    // `/admin/documents`のloaderが`requireAdmin`で判定する(設計 §4.2)。
    expect(asGeneralUser.page.documents).toEqual([]);
  });

  it("未認証はログイン画面へredirectする(処理をrequireUserへ委譲)", async () => {
    listDocumentsByOwnerMock.mockResolvedValue({ documents: [], nextCursor: null });

    await expect(
      loader({
        request: new Request("http://localhost:3000/app"),
      } as unknown as Parameters<typeof loader>[0]),
    ).rejects.toMatchObject({ status: 302 });

    expect(listDocumentsByOwnerMock).not.toHaveBeenCalled();
  });

  it("cursorが壊れている場合は400で短い日本語メッセージを返す", async () => {
    listDocumentsByOwnerMock.mockRejectedValue(new InvalidCursorError());
    const cookie = await sessionCookieFor(owner);

    await expect(
      loader({
        request: new Request("http://localhost:3000/app?cursor=broken", {
          headers: { Cookie: cookie },
        }),
      } as unknown as Parameters<typeof loader>[0]),
    ).rejects.toMatchObject({ status: 400 });
  });
});

/** コンポーネント表示の確認(loaderは差し替え、`createRoutesStub`で描画する)。 */
function renderApp(options: {
  documents?: ReturnType<typeof cardFrom>[];
  nextCursor?: string | null;
  canUseAdminScreen?: boolean;
  loadMorePage?: { documents: ReturnType<typeof cardFrom>[]; nextCursor: string | null };
} = {}) {
  const Stub = createRoutesStub([
    {
      path: "/app",
      Component: Application,
      loader: async ({ request }: { request: Request }) => {
        const url = new URL(request.url);
        if (url.searchParams.get("cursor") && options.loadMorePage) {
          return {
            user: { name: owner.name, email: owner.email },
            canUseAdminScreen: options.canUseAdminScreen ?? false,
            page: options.loadMorePage,
          };
        }
        return {
          user: { name: owner.name, email: owner.email },
          canUseAdminScreen: options.canUseAdminScreen ?? false,
          page: {
            documents: options.documents ?? [],
            nextCursor: options.nextCursor ?? null,
          },
        };
      },
    },
  ]);

  return render(<Stub initialEntries={["/app"]} />);
}

function cardFrom(overrides: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    title: "資料タイトル",
    originalFileName: "資料.html",
    byteSize: 2048,
    previewStatus: "pending" as const,
    createdAt: new Date("2026-01-02T15:30:00.000Z"),
    canDelete: true,
    ...overrides,
  };
}

describe("初期画面コンポーネント", () => {
  it("氏名とメールアドレス、資料が無い場合の案内を表示する", async () => {
    renderApp({ documents: [] });

    await screen.findByText(/所有者 太郎さん/);
    expect(screen.getByText(/owner@example.com/)).toBeTruthy();
    expect(screen.getByText("まだ資料がありません。ファイルをアップロードしてください。")).toBeTruthy();
  });

  it("カードに元ファイル名、日時(JST)、ファイルサイズ、プレビュー状態、削除導線を表示する", async () => {
    renderApp({ documents: [cardFrom()] });

    await screen.findByText("資料タイトル");
    expect(screen.getByText("資料.html")).toBeTruthy();
    // UTC 15:30 → JST 翌日00:30
    expect(screen.getByText("2026/01/03 00:30")).toBeTruthy();
    expect(screen.getByText("2.0 KB")).toBeTruthy();
    expect(screen.getByText("生成中")).toBeTruthy();
    expect(screen.getByRole("button", { name: "削除" })).toBeTruthy();
  });

  it("削除導線は確認画面へのGET遷移で、直接の削除POSTにしない(設計 §5.5)", async () => {
    renderApp({ documents: [cardFrom()] });

    const deleteButton = await screen.findByRole("button", { name: "削除" });
    const form = deleteButton.closest("form");
    expect(form?.getAttribute("method")).toBe("get");
    expect(form?.getAttribute("action")).toBe(
      `/documents/${cardFrom().id}/delete`,
    );
  });

  it("canDeleteがfalseの場合は削除導線を表示しない(オーナー以外には出さない)", async () => {
    renderApp({ documents: [cardFrom({ canDelete: false })] });

    await screen.findByText("資料タイトル");
    expect(screen.queryByRole("button", { name: "削除" })).toBeNull();
  });

  it("管理者には管理画面へのリンクを表示し、一般利用者には表示しない(設計 §5.6)", async () => {
    const general = renderApp({ documents: [], canUseAdminScreen: false });
    await screen.findByText(/所有者 太郎さん/);
    expect(
      screen.queryByRole("link", { name: "管理画面（全資料の検索）" }),
    ).toBeNull();
    general.unmount();

    renderApp({ documents: [], canUseAdminScreen: true });
    const adminLink = (await screen.findByRole("link", {
      name: "管理画面（全資料の検索）",
    })) as HTMLAnchorElement;
    // 表示のみのGET遷移。この画面では管理操作を実行しない。
    expect(adminLink.getAttribute("href")).toBe("/admin/documents");
  });

  it("プレビュー状態が生成失敗の場合は代替画像を使う", async () => {
    renderApp({ documents: [cardFrom({ previewStatus: "failed" })] });

    const image = await screen.findByRole("img");
    expect(image.getAttribute("src")).toBe("/preview-fallback.svg");
  });

  it("プレビュー状態が生成中の場合は処理中画像を使う", async () => {
    renderApp({ documents: [cardFrom({ previewStatus: "pending" })] });

    const image = await screen.findByRole("img");
    expect(image.getAttribute("src")).toBe("/preview-processing.svg");
  });

  it("次を表示ボタンで追加の資料を20件ずつ取得して追記する", async () => {
    renderApp({
      documents: [cardFrom({ id: "doc-1", title: "1件目" })],
      nextCursor: "cursor-1",
      loadMorePage: {
        documents: [cardFrom({ id: "doc-2", title: "2件目" })],
        nextCursor: null,
      },
    });

    await screen.findByText("1件目");
    fireEvent.click(screen.getByRole("button", { name: "次を表示" }));

    await screen.findByText("2件目");
    expect(screen.getByText("1件目")).toBeTruthy();
    // 次ページが無くなったのでボタンは消える。
    expect(screen.queryByRole("button", { name: "次を表示" })).toBeNull();
  });

  it("複数ファイルの選択(ドロップ)は1ファイル制限として拒否する", async () => {
    renderApp({ documents: [] });

    // loaderの解決(非同期)を待ってからinputを取得する。待たずに
    // `document.querySelector`で同期的に探すと、まだ描画されていない
    // (または前のテストの残骸を拾ってしまう)ため不安定になる。
    const input = await screen.findByLabelText("アップロードするファイル");

    const files = [
      new File(["<html></html>"], "a.html", { type: "text/html" }),
      new File(["<html></html>"], "b.html", { type: "text/html" }),
    ];
    Object.defineProperty(input, "files", { value: files });
    fireEvent.change(input as Element);

    expect(
      await screen.findByText("一度にアップロードできるファイルは1つだけです。"),
    ).toBeTruthy();
  });

  it("アップロード成功時は警告と「資料を開く」導線を表示する", async () => {
    const successBody: UploadSuccessBody = {
      documentId: "22222222-2222-4222-8222-222222222222",
      documentUrl: "/documents/22222222-2222-4222-8222-222222222222",
      previewStatus: "pending",
      warnings: [{ code: "script", message: "JavaScriptは実行されません。" }],
      correlationId: "corr-1",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(successBody), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    renderApp({ documents: [] });

    const input = await screen.findByLabelText("アップロードするファイル");
    const file = new File(["<html></html>"], "a.html", { type: "text/html" });
    Object.defineProperty(input, "files", { value: [file] });
    fireEvent.change(input);

    await screen.findByText("アップロードが完了しました。");
    expect(screen.getByText("JavaScriptは実行されません。")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "資料を開く" }).getAttribute("href"),
    ).toBe(successBody.documentUrl);
  });

  it("アップロード失敗時はメッセージと相関IDを表示する(§14)", async () => {
    const errorBody: UploadErrorBody = {
      message: "登録できる資料の件数が上限に達しています。不要な資料を削除してください。",
      correlationId: "corr-err-1",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(errorBody), {
          status: 409,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    renderApp({ documents: [] });

    const input = await screen.findByLabelText("アップロードするファイル");
    const file = new File(["<html></html>"], "a.html", { type: "text/html" });
    Object.defineProperty(input, "files", { value: [file] });
    fireEvent.change(input);

    await screen.findByText(errorBody.message);
    expect(screen.getByText(/corr-err-1/)).toBeTruthy();
  });

  it("ファイル名・titleはHTMLとして解釈されずエスケープされた文字列として描画される", async () => {
    renderApp({
      documents: [
        cardFrom({
          title: "<script>alert(1)</script>",
          originalFileName: "<img src=x onerror=alert(1)>.html",
        }),
      ],
    });

    // まずloaderの解決(非同期)を待って描画を確定させる。`waitFor`で
    // 「scriptタグが無い」ことだけを先に確認すると、未描画の空DOMでも
    // 条件が満たされてしまい、実際の描画を待たずに次のアサーションへ
    // 進んでしまう(意図しない誤通過)。
    expect(
      await screen.findByText("<script>alert(1)</script>"),
    ).toBeTruthy();
    expect(screen.getByText("<img src=x onerror=alert(1)>.html")).toBeTruthy();
    expect(document.querySelector("script")).toBeNull();
  });
});

/** アプリのポーリング間隔(`app.tsx`の`PREVIEW_POLL_INTERVAL_MS`と一致させる)。 */
const PREVIEW_POLL_INTERVAL_MS = 5_000;

/**
 * ポーリング(T15)のテスト用ヘルパー。
 *
 * `window.setInterval`/`clearInterval`のうち、アプリのポーリング間隔
 * (`PREVIEW_POLL_INTERVAL_MS`)で呼ばれたものだけを差し替え、コールバックを
 * 手動で起動できるようにする。`@testing-library`の`waitFor`系は内部で別間隔
 * (50ms)の`setInterval`を使っており、無条件に差し替えるとそちらまで止めて
 * しまいテストが固まる。間隔で見分けることで実タイマーのまま動作させる。
 */
function spyOnPollingInterval() {
  const realSetInterval = window.setInterval.bind(window);
  const realClearInterval = window.clearInterval.bind(window);
  let callback: (() => void) | null = null;
  let registrationCount = 0;
  let clearCount = 0;
  const pollingHandle = {} as ReturnType<typeof window.setInterval>;

  vi.spyOn(window, "setInterval").mockImplementation(((
    fn: () => void,
    ms?: number,
    ...rest: unknown[]
  ) => {
    if (ms === PREVIEW_POLL_INTERVAL_MS) {
      callback = fn;
      registrationCount += 1;
      return pollingHandle;
    }
    return realSetInterval(fn as () => void, ms, ...rest);
  }) as unknown as typeof window.setInterval);
  vi.spyOn(window, "clearInterval").mockImplementation(((handle?: unknown) => {
    if (handle === pollingHandle) {
      callback = null;
      clearCount += 1;
      return;
    }
    return realClearInterval(handle as Parameters<typeof clearInterval>[0]);
  }) as unknown as typeof window.clearInterval);

  return {
    triggerTick: () => callback?.(),
    hasActiveInterval: () => callback !== null,
    registrationCount: () => registrationCount,
    clearCount: () => clearCount,
  };
}

function stubFetchJsonOnce(body: unknown, status = 200) {
  return vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

describe("プレビュー状態ポーリング(T15)", () => {
  it("pendingの資料が無いときはポーリングしない", async () => {
    const { registrationCount } = spyOnPollingInterval();

    renderApp({ documents: [cardFrom({ previewStatus: "ready" })] });

    await screen.findByText("生成済み");
    expect(registrationCount()).toBe(0);
  });

  it("pendingの資料はポーリングし、readyに変わったら画像・ラベルが切り替わり止まる", async () => {
    const { registrationCount, clearCount, triggerTick } =
      spyOnPollingInterval();
    const fetchMock = stubFetchJsonOnce({ previewStatus: "ready" });
    vi.stubGlobal("fetch", fetchMock);

    renderApp({
      documents: [cardFrom({ id: "doc-1", previewStatus: "pending" })],
    });

    await screen.findByText("生成中");
    expect(
      (await screen.findByRole("img")).getAttribute("src"),
    ).toBe("/preview-processing.svg");
    expect(registrationCount()).toBe(1);

    await act(async () => {
      triggerTick();
    });

    await screen.findByText("生成済み");
    expect(fetchMock).toHaveBeenCalledWith(
      "/documents/doc-1/preview-status",
      expect.anything(),
    );
    expect(screen.getByRole("img").getAttribute("src")).toBe(
      "/preview-fallback.svg",
    );
    // pending以外になったのでこのカードのポーリングを止める(intervalをclear)。
    await vi.waitFor(() => expect(clearCount()).toBe(1));

    const callsAfterUpdate = fetchMock.mock.calls.length;
    await act(async () => {
      triggerTick();
    });
    // effectがcleanup済みのため、以降のtickが来ても追加のfetchは発生しない。
    expect(fetchMock.mock.calls.length).toBe(callsAfterUpdate);
  });

  it("pendingの資料がfailedへ変わった場合も画像・ラベルが切り替わり止まる", async () => {
    const { clearCount, triggerTick } = spyOnPollingInterval();
    const fetchMock = stubFetchJsonOnce({ previewStatus: "failed" });
    vi.stubGlobal("fetch", fetchMock);

    renderApp({
      documents: [cardFrom({ id: "doc-2", previewStatus: "pending" })],
    });

    await screen.findByText("生成中");

    await act(async () => {
      triggerTick();
    });

    await screen.findByText("生成失敗");
    expect(screen.getByRole("img").getAttribute("src")).toBe(
      "/preview-fallback.svg",
    );
    await vi.waitFor(() => expect(clearCount()).toBe(1));
  });

  it("アンマウント時にポーリングのintervalを後片付けする", async () => {
    const { registrationCount, clearCount } = spyOnPollingInterval();
    vi.stubGlobal("fetch", stubFetchJsonOnce({ previewStatus: "ready" }));

    const { unmount } = renderApp({
      documents: [cardFrom({ id: "doc-3", previewStatus: "pending" })],
    });

    await screen.findByText("生成中");
    expect(registrationCount()).toBe(1);

    unmount();

    expect(clearCount()).toBe(1);
  });
});
