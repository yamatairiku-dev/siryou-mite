import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoutesStub } from "react-router";
import type { DocumentRecord } from "~/lib/db/documents.server";
import { createUserSession, type AppUser } from "~/lib/session.server";

/**
 * T13 単体テスト: 資料表示画面(設計 §5.4, §7.2, §9.2, §10.3, §13)。
 *
 * - loaderは未ログインをrequireUserへ委譲し、同じURLへ戻すこと、所有者以外でも
 *   `active`な資料を閲覧できること、削除済み・未存在・不正な`documentId`が
 *   同じ404になること、不正な`documentId`はDBへ触れないことを確認する。
 * - コンポーネントはgrantをhidden formのPOST bodyだけでiframeへ送り、URL・
 *   クエリ文字列・`<a href>`へ出さないこと、iframeのsandboxが
 *   `allow-popups allow-popups-to-escape-sandbox`だけであること、「URLをコピー」が
 *   アプリ側固定URLだけをコピーすること、「初期画面へ戻る」があることを確認する。
 */

const findDocumentByIdMock = vi.fn<
  (documentId: string) => Promise<DocumentRecord | null>
>();

vi.mock("~/lib/db/documents.server", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("~/lib/db/documents.server")>();
  return {
    ...actual,
    findDocumentById: (documentId: string) => findDocumentByIdMock(documentId),
  };
});

const { loader, default: DocumentView } = await import(
  "~/routes/documents.$documentId"
);

const DOCUMENT_ID = "11111111-1111-4111-8111-111111111111";

const owner: AppUser = {
  id: "oid-owner",
  tenantId: "tenant-001",
  name: "所有者 太郎",
  email: "owner@example.com",
  roles: ["User"],
  groups: ["ZAA535-A"],
};

const otherUser: AppUser = {
  id: "oid-someone-else",
  tenantId: "tenant-001",
  name: "閲覧者 花子",
  email: "viewer@example.com",
  roles: ["User"],
  groups: ["ZAA535-A"],
};

function documentRecord(overrides: Partial<DocumentRecord> = {}): DocumentRecord {
  return {
    id: DOCUMENT_ID,
    ownerSubjectId: owner.id,
    ownerEmailAtUpload: owner.email,
    originalFileName: "資料.html",
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

function loaderArgs(url: string, cookie?: string) {
  return {
    request: new Request(url, cookie ? { headers: { Cookie: cookie } } : {}),
    params: { documentId: url.split("/documents/")[1]?.split(/[?#]/)[0] },
  } as unknown as Parameters<typeof loader>[0];
}

beforeEach(() => {
  findDocumentByIdMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("loader", () => {
  it("未ログインはrequireUserへ委譲し、同じURLへ戻す(open redirectにしない)", async () => {
    await expect(
      loader(loaderArgs(`http://localhost:3000/documents/${DOCUMENT_ID}`)),
    ).rejects.toMatchObject({ status: 302 });

    expect(findDocumentByIdMock).not.toHaveBeenCalled();
  });

  it("未ログイン時のredirect先が同じpathへのreturnToになっている", async () => {
    try {
      await loader(loaderArgs(`http://localhost:3000/documents/${DOCUMENT_ID}`));
      expect.unreachable();
    } catch (error) {
      const response = error as Response;
      const location = response.headers.get("Location") ?? "";
      const returnTo = new URL(location, "http://localhost:3000").searchParams.get(
        "returnTo",
      );
      expect(returnTo).toBe(`/documents/${DOCUMENT_ID}`);
    }
  });

  it("所有者以外のログイン済み利用者でも、activeな資料であれば閲覧でき、grantが発行される", async () => {
    findDocumentByIdMock.mockResolvedValue(documentRecord());
    const cookie = await sessionCookieFor(otherUser);

    const result = await loader(
      loaderArgs(`http://localhost:3000/documents/${DOCUMENT_ID}`, cookie),
    );

    expect(findDocumentByIdMock).toHaveBeenCalledWith(DOCUMENT_ID);
    expect(result.documentId).toBe(DOCUMENT_ID);
    expect(result.title).toBe("資料タイトル");
    expect(result.displayOrigin).toBe("http://localhost:3100");
    // grantは `<header>.<payload>.<signature>` 形式のbase64url 3セグメント。
    expect(result.grant).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(result.grantExpiresAt).toBeGreaterThan(Date.now());
  });

  it("削除済み資料は一般利用者に404「資料が見つかりません」を返す", async () => {
    findDocumentByIdMock.mockResolvedValue(
      documentRecord({ status: "deleted", title: null, originalFileName: null }),
    );
    const cookie = await sessionCookieFor(owner);

    await expect(
      loader(loaderArgs(`http://localhost:3000/documents/${DOCUMENT_ID}`, cookie)),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("未存在の資料は削除済みと同じ404表示になる(存在有無を区別しない)", async () => {
    findDocumentByIdMock.mockResolvedValue(null);
    const cookie = await sessionCookieFor(owner);

    await expect(
      loader(loaderArgs(`http://localhost:3000/documents/${DOCUMENT_ID}`, cookie)),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("UUID形式でないdocumentIdはDBへ触れる前に404で拒否する", async () => {
    const cookie = await sessionCookieFor(owner);

    await expect(
      loader(loaderArgs("http://localhost:3000/documents/not-a-uuid", cookie)),
    ).rejects.toMatchObject({ status: 404 });

    expect(findDocumentByIdMock).not.toHaveBeenCalled();
  });
});

/** コンポーネント表示の確認(loaderは差し替え、`createRoutesStub`で描画する)。 */
function renderDocumentView(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  const loaderData = {
    documentId: DOCUMENT_ID,
    title: "資料タイトル",
    displayOrigin: "http://localhost:3100",
    grant: "header-part.payload-part.signature-part",
    grantExpiresAt: now + 60_000,
    grantFormField: "grant",
    ...overrides,
  };

  const Stub = createRoutesStub([
    {
      path: `/documents/${DOCUMENT_ID}`,
      Component: DocumentView,
      loader: () => loaderData,
    },
  ]);

  return { loaderData, ...render(<Stub initialEntries={[`/documents/${DOCUMENT_ID}`]} />) };
}

describe("資料表示画面コンポーネント", () => {
  let requestSubmitSpy: ReturnType<
    typeof vi.fn<(submitter?: HTMLElement | null) => void>
  >;

  beforeEach(() => {
    requestSubmitSpy = vi.fn<(submitter?: HTMLElement | null) => void>();
    // jsdomはフォームの実navigationを実装していないため、送信自体はspyで確認する。
    HTMLFormElement.prototype.requestSubmit = requestSubmitSpy;
  });

  it("hidden formがDISPLAY_ORIGINの/displayへPOSTし、targetがiframe名を指し、enctypeがurlencodedで、送信先にクエリ文字列が無い", async () => {
    renderDocumentView();

    const form = (await screen.findByTestId(
      "display-grant-form",
    )) as HTMLFormElement;

    expect(form.getAttribute("method")).toBe("post");
    expect(form.getAttribute("action")).toBe("http://localhost:3100/display");
    expect(new URL(form.getAttribute("action") ?? "").search).toBe("");
    expect(form.getAttribute("enctype")).toBe(
      "application/x-www-form-urlencoded",
    );

    const iframe = screen.getByTestId("document-display-frame");
    expect(form.getAttribute("target")).toBe(iframe.getAttribute("name"));
  });

  it("iframeのsandboxはallow-popups allow-popups-to-escape-sandboxだけである", async () => {
    renderDocumentView();

    const iframe = await screen.findByTestId("document-display-frame");
    expect(iframe.getAttribute("sandbox")).toBe(
      "allow-popups allow-popups-to-escape-sandbox",
    );
  });

  it("マウント時にhidden formを自動送信してgrantをPOSTする(URL・クエリへは出さない)", async () => {
    renderDocumentView();

    await screen.findByTestId("display-grant-form");
    expect(requestSubmitSpy).toHaveBeenCalledTimes(1);

    // grantはhidden inputの値としてのみ存在し、リンクや現在のURLには現れない。
    const hiddenInput = document.querySelector(
      'input[name="grant"]',
    ) as HTMLInputElement;
    expect(hiddenInput.value).toBe("header-part.payload-part.signature-part");
    expect(hiddenInput.type).toBe("hidden");

    for (const anchor of Array.from(document.querySelectorAll("a"))) {
      expect(anchor.getAttribute("href") ?? "").not.toContain("header-part");
    }
    expect(window.location.href).not.toContain("header-part");
    expect(window.location.search).toBe("");
  });

  it("grantが期限切れ間際の場合は送信せず、再取得(revalidate)を行う", async () => {
    renderDocumentView({ grantExpiresAt: Date.now() - 1_000 });

    await screen.findByTestId("display-grant-form");
    expect(requestSubmitSpy).not.toHaveBeenCalled();
  });

  it("「URLをコピー」はアプリ側固定URLだけをコピーし、grantやDisplay originを含まない", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    renderDocumentView();

    const copyButton = await screen.findByRole("button", { name: "URLをコピー" });
    fireEvent.click(copyButton);

    await vi.waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const [copiedUrl] = writeText.mock.calls[0] ?? [];
    expect(copiedUrl).toBe(`http://localhost:3000/documents/${DOCUMENT_ID}`);
    expect(copiedUrl).not.toContain("header-part");
    expect(copiedUrl).not.toContain("localhost:3100");
  });

  it("「初期画面へ戻る」の導線がある", async () => {
    renderDocumentView();

    const backLink = await screen.findByRole("link", { name: "初期画面へ戻る" });
    expect(backLink.getAttribute("href")).toBe("/app");
  });
});
