import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocumentRecord } from "~/lib/db/documents.server";
import { createUserSession, type AppUser } from "~/lib/session.server";

/**
 * T15 単体テスト: プレビュー状態resource route(設計 §5.3, §11.1, §13)。
 *
 * - 認証済み・`active`な資料の現在のプレビュー状態(`pending`/`ready`/`failed`)を
 *   返すこと、資料表示画面と同じく所有者以外のログイン済み利用者でも取得できる
 *   ことを確認する。
 * - 削除済み・未存在・UUID形式でない`documentId`が同じ404になり、UUID形式でない
 *   場合はDBへ触れる前に拒否されることを確認する。
 * - 応答にファイル名・メールアドレス・オーナーID・Blobキーなどの機微情報を
 *   含まないこと、`Cache-Control: no-store`が付くことを確認する。
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

const { loader } = await import("~/routes/documents.$documentId.preview-status");

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

function loaderArgs(url: string, cookie?: string) {
  return {
    request: new Request(url, cookie ? { headers: { Cookie: cookie } } : {}),
    params: { documentId: url.split("/preview-status")[0]?.split("/documents/")[1] },
  } as unknown as Parameters<typeof loader>[0];
}

beforeEach(() => {
  findDocumentByIdMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("loader", () => {
  it("未ログインはrequireUserへ委譲する(302 redirect)", async () => {
    await expect(
      loader(
        loaderArgs(
          `http://localhost:3000/documents/${DOCUMENT_ID}/preview-status`,
        ),
      ),
    ).rejects.toMatchObject({ status: 302 });

    expect(findDocumentByIdMock).not.toHaveBeenCalled();
  });

  it.each(["pending", "ready", "failed"] as const)(
    "所有者本人はプレビュー状態(%s)を取得できる",
    async (previewStatus) => {
      findDocumentByIdMock.mockResolvedValue(documentRecord({ previewStatus }));
      const cookie = await sessionCookieFor(owner);

      const response = await loader(
        loaderArgs(
          `http://localhost:3000/documents/${DOCUMENT_ID}/preview-status`,
          cookie,
        ),
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({ previewStatus });
    },
  );

  it("所有者以外のログイン済み利用者でも、activeな資料であれば取得できる(閲覧と同じ認可)", async () => {
    findDocumentByIdMock.mockResolvedValue(documentRecord({ previewStatus: "ready" }));
    const cookie = await sessionCookieFor(otherUser);

    const response = await loader(
      loaderArgs(
        `http://localhost:3000/documents/${DOCUMENT_ID}/preview-status`,
        cookie,
      ),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ previewStatus: "ready" });
  });

  it("削除済み資料は404「資料が見つかりません」を返す", async () => {
    findDocumentByIdMock.mockResolvedValue(
      documentRecord({ status: "deleted", title: null, originalFileName: null }),
    );
    const cookie = await sessionCookieFor(owner);

    await expect(
      loader(
        loaderArgs(
          `http://localhost:3000/documents/${DOCUMENT_ID}/preview-status`,
          cookie,
        ),
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("未存在の資料は削除済みと同じ404になる(存在有無を区別しない)", async () => {
    findDocumentByIdMock.mockResolvedValue(null);
    const cookie = await sessionCookieFor(owner);

    await expect(
      loader(
        loaderArgs(
          `http://localhost:3000/documents/${DOCUMENT_ID}/preview-status`,
          cookie,
        ),
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("UUID形式でないdocumentIdはDBへ触れる前に404で拒否する", async () => {
    const cookie = await sessionCookieFor(owner);

    await expect(
      loader(
        loaderArgs(
          "http://localhost:3000/documents/not-a-uuid/preview-status",
          cookie,
        ),
      ),
    ).rejects.toMatchObject({ status: 404 });

    expect(findDocumentByIdMock).not.toHaveBeenCalled();
  });

  it("応答は`Cache-Control: no-store`を含む", async () => {
    findDocumentByIdMock.mockResolvedValue(documentRecord());
    const cookie = await sessionCookieFor(owner);

    const response = await loader(
      loaderArgs(
        `http://localhost:3000/documents/${DOCUMENT_ID}/preview-status`,
        cookie,
      ),
    );

    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("応答にファイル名・メールアドレス・オーナーID・Blobキーなどの機微情報を含まない", async () => {
    findDocumentByIdMock.mockResolvedValue(documentRecord());
    const cookie = await sessionCookieFor(owner);

    const response = await loader(
      loaderArgs(
        `http://localhost:3000/documents/${DOCUMENT_ID}/preview-status`,
        cookie,
      ),
    );

    const body = (await response.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["previewStatus"]);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("資料.html");
    expect(serialized).not.toContain(owner.email);
    expect(serialized).not.toContain(owner.id);
  });
});
