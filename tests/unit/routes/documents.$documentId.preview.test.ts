import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocumentRecord } from "~/lib/db/documents.server";
import { createUserSession, type AppUser } from "~/lib/session.server";
import type { StorageOperationOptions } from "~/lib/storage.server";

/**
 * T23 単体テスト: プレビュー画像resource route(設計 §5.2, §5.3, §7.3, §13, §14、
 * QUESTIONS.md Q-030/Q-032)。
 *
 * - 認可は`/documents/:documentId/preview-status`と同じで、所有者以外の
 *   ログイン済み利用者も`active`かつ`ready`の資料の画像を取得できること。
 * - 削除済み・未存在・UUID形式でない`documentId`、`ready`でない資料が同じ404になり、
 *   その場合はBlobへ触れないこと。
 * - 応答ヘッダー(`Content-Type: image/jpeg`、`X-Content-Type-Options: nosniff`、
 *   `Cache-Control: no-store`)と本文(Blobの中身そのもの)。
 * - Blob取得にtimeoutと要求の中断signalを渡すこと、失敗時に画像を返さず運用ログへ
 *   分類だけを残し(Blobキー・メールアドレス・ファイル名を出さない)、監査しないこと。
 */

const findDocumentByIdMock = vi.fn<
  (documentId: string) => Promise<DocumentRecord | null>
>();
const downloadDocumentPreviewMock = vi.fn<
  (
    containerClient: unknown,
    documentId: string,
    options?: StorageOperationOptions,
  ) => Promise<Buffer>
>();
const insertAuditEventMock = vi.fn();

vi.mock("~/lib/db/documents.server", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("~/lib/db/documents.server")>();
  return {
    ...actual,
    findDocumentById: (documentId: string) => findDocumentByIdMock(documentId),
  };
});

vi.mock("~/lib/db/audit-events.server", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("~/lib/db/audit-events.server")>();
  return {
    ...actual,
    insertAuditEvent: (...args: unknown[]) => insertAuditEventMock(...args),
  };
});

vi.mock("~/lib/storage.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/storage.server")>();
  return {
    ...actual,
    getDocumentsContainerClientForWeb: () => ({ fake: "container" }),
    downloadDocumentPreview: (
      containerClient: unknown,
      documentId: string,
      options?: StorageOperationOptions,
    ) => downloadDocumentPreviewMock(containerClient, documentId, options),
  };
});

const { loader } = await import("~/routes/documents.$documentId.preview");
const { PREVIEW_IMAGE_DOWNLOAD_TIMEOUT_MS } = await import(
  "~/lib/documents/preview-image.server"
);

const DOCUMENT_ID = "11111111-1111-4111-8111-111111111111";
/** JPEGのSOIマーカーで始まるダミー画像。 */
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);

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

function loaderArgs(documentId: string, cookie?: string) {
  const url = `http://localhost:3000/documents/${documentId}/preview`;
  return {
    request: new Request(url, cookie ? { headers: { Cookie: cookie } } : {}),
    params: { documentId },
  } as unknown as Parameters<typeof loader>[0];
}

/** loaderの結果(return/throwのどちらでも)を`Response`として受け取る。 */
async function responseOf(
  args: Parameters<typeof loader>[0],
): Promise<Response> {
  try {
    return await loader(args);
  } catch (error) {
    if (error instanceof Response) {
      return error;
    }
    throw error;
  }
}

let logSpy: ReturnType<typeof vi.spyOn>;

function loggedLines(): string[] {
  return logSpy.mock.calls.map(([line]: unknown[]) => String(line));
}

function loggedEvents(): Record<string, unknown>[] {
  return loggedLines().map(
    (line) => JSON.parse(line) as Record<string, unknown>,
  );
}

beforeEach(() => {
  findDocumentByIdMock.mockReset();
  downloadDocumentPreviewMock.mockReset();
  insertAuditEventMock.mockReset();
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("認証・認可", () => {
  it("未ログインはrequireUserへ委譲する(302 redirect)", async () => {
    await expect(loader(loaderArgs(DOCUMENT_ID))).rejects.toMatchObject({
      status: 302,
    });

    expect(findDocumentByIdMock).not.toHaveBeenCalled();
    expect(downloadDocumentPreviewMock).not.toHaveBeenCalled();
  });

  it("所有者本人はreadyの資料の画像を取得できる", async () => {
    findDocumentByIdMock.mockResolvedValue(documentRecord());
    downloadDocumentPreviewMock.mockResolvedValue(JPEG_BYTES);
    const cookie = await sessionCookieFor(owner);

    const response = await responseOf(loaderArgs(DOCUMENT_ID, cookie));

    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(JPEG_BYTES);
    expect(downloadDocumentPreviewMock).toHaveBeenCalledWith(
      { fake: "container" },
      DOCUMENT_ID,
      expect.anything(),
    );
  });

  it("所有者以外のログイン済み利用者でも、activeな資料であれば取得できる(閲覧と同じ認可)", async () => {
    findDocumentByIdMock.mockResolvedValue(documentRecord());
    downloadDocumentPreviewMock.mockResolvedValue(JPEG_BYTES);
    const cookie = await sessionCookieFor(otherUser);

    const response = await responseOf(loaderArgs(DOCUMENT_ID, cookie));

    expect(response.status).toBe(200);
  });
});

describe("404の統一", () => {
  it("削除済み資料は404「資料が見つかりません」を返し、Blobへ触れない", async () => {
    findDocumentByIdMock.mockResolvedValue(
      documentRecord({
        status: "deleted",
        title: null,
        originalFileName: null,
        previewStatus: null,
      }),
    );
    const cookie = await sessionCookieFor(owner);

    const response = await responseOf(loaderArgs(DOCUMENT_ID, cookie));

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("資料が見つかりません");
    expect(downloadDocumentPreviewMock).not.toHaveBeenCalled();
  });

  it("未存在の資料は削除済みと同じ404になる", async () => {
    findDocumentByIdMock.mockResolvedValue(null);
    const cookie = await sessionCookieFor(owner);

    const response = await responseOf(loaderArgs(DOCUMENT_ID, cookie));

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("資料が見つかりません");
    expect(downloadDocumentPreviewMock).not.toHaveBeenCalled();
  });

  it("UUID形式でないdocumentIdはDBへ触れる前に404で拒否する", async () => {
    const cookie = await sessionCookieFor(owner);

    const response = await responseOf(loaderArgs("not-a-uuid", cookie));

    expect(response.status).toBe(404);
    expect(findDocumentByIdMock).not.toHaveBeenCalled();
    expect(downloadDocumentPreviewMock).not.toHaveBeenCalled();
  });

  it.each(["pending", "failed", null] as const)(
    "readyでない資料(%s)は同じ404にし、Blobへ触れない",
    async (previewStatus) => {
      findDocumentByIdMock.mockResolvedValue(documentRecord({ previewStatus }));
      const cookie = await sessionCookieFor(owner);

      const response = await responseOf(loaderArgs(DOCUMENT_ID, cookie));

      expect(response.status).toBe(404);
      expect(await response.text()).toBe("資料が見つかりません");
      expect(response.headers.get("Content-Type")).not.toBe("image/jpeg");
      expect(downloadDocumentPreviewMock).not.toHaveBeenCalled();
    },
  );
});

describe("応答ヘッダー", () => {
  it("image/jpeg・nosniff・no-store・inline・same-originを付ける", async () => {
    findDocumentByIdMock.mockResolvedValue(documentRecord());
    downloadDocumentPreviewMock.mockResolvedValue(JPEG_BYTES);
    const cookie = await sessionCookieFor(owner);

    const response = await responseOf(loaderArgs(DOCUMENT_ID, cookie));

    expect(response.headers.get("Content-Type")).toBe("image/jpeg");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Content-Disposition")).toBe("inline");
    expect(response.headers.get("Content-Length")).toBe(
      String(JPEG_BYTES.length),
    );
    expect(response.headers.get("Cross-Origin-Resource-Policy")).toBe(
      "same-origin",
    );
    // Blobを公開しない(Q-030)。Blobへのredirectや直接URLを返さない。
    expect(response.headers.get("Location")).toBeNull();
  });

  it("404応答もno-store・nosniffを付ける", async () => {
    findDocumentByIdMock.mockResolvedValue(
      documentRecord({ previewStatus: "pending" }),
    );
    const cookie = await sessionCookieFor(owner);

    const response = await responseOf(loaderArgs(DOCUMENT_ID, cookie));

    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });
});

describe("Blob取得", () => {
  it("timeoutと要求の中断signalを渡す", async () => {
    findDocumentByIdMock.mockResolvedValue(documentRecord());
    downloadDocumentPreviewMock.mockResolvedValue(JPEG_BYTES);
    const cookie = await sessionCookieFor(owner);
    const args = loaderArgs(DOCUMENT_ID, cookie);

    await responseOf(args);

    const options = downloadDocumentPreviewMock.mock.calls[0]?.[2];
    expect(options?.timeoutMs).toBe(PREVIEW_IMAGE_DOWNLOAD_TIMEOUT_MS);
    expect(options?.abortSignal).toBe(args.request.signal);
  });

  it("Blobが存在しない場合は404にし、分類だけを運用ログへ残す", async () => {
    findDocumentByIdMock.mockResolvedValue(documentRecord());
    downloadDocumentPreviewMock.mockRejectedValue(
      Object.assign(
        new Error(
          `BlobNotFound: https://example.blob.core.windows.net/documents/preview/${DOCUMENT_ID}/preview.jpg`,
        ),
        { statusCode: 404, code: "BlobNotFound" },
      ),
    );
    const cookie = await sessionCookieFor(owner);

    const response = await responseOf(loaderArgs(DOCUMENT_ID, cookie));

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("資料が見つかりません");
    expect(loggedEvents()).toEqual([
      expect.objectContaining({
        event: "document_preview_image",
        result: "failed",
        errorCategory: "document_not_found",
        documentId: DOCUMENT_ID,
      }),
    ]);
  });

  it("timeout・通信失敗は画像を返さず503にし、分類だけを運用ログへ残す", async () => {
    findDocumentByIdMock.mockResolvedValue(documentRecord());
    downloadDocumentPreviewMock.mockRejectedValue(
      Object.assign(
        new Error(
          `The operation was aborted: preview/${DOCUMENT_ID}/preview.jpg`,
        ),
        { name: "AbortError" },
      ),
    );
    const cookie = await sessionCookieFor(owner);

    const response = await responseOf(loaderArgs(DOCUMENT_ID, cookie));

    expect(response.status).toBe(503);
    expect(response.headers.get("Content-Type")).not.toBe("image/jpeg");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = await response.text();
    expect(body).not.toContain("preview/");
    expect(body).not.toContain("aborted");
    expect(loggedEvents()).toEqual([
      expect.objectContaining({
        event: "document_preview_image",
        result: "failed",
        errorCategory: "storage_failed",
        documentId: DOCUMENT_ID,
      }),
    ]);
  });

  it("JPEGでない内容はimage/jpegとして中継せず503にする", async () => {
    findDocumentByIdMock.mockResolvedValue(documentRecord());
    downloadDocumentPreviewMock.mockResolvedValue(
      Buffer.from("<!doctype html><script>alert(1)</script>", "utf8"),
    );
    const cookie = await sessionCookieFor(owner);

    const response = await responseOf(loaderArgs(DOCUMENT_ID, cookie));

    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("<script>");
    expect(loggedEvents()).toEqual([
      expect.objectContaining({
        result: "failed",
        errorCategory: "preview_failed",
      }),
    ]);
  });

  it("運用ログにBlobキー・メールアドレス・ファイル名・利用者IDの生値を出さない", async () => {
    findDocumentByIdMock.mockResolvedValue(documentRecord());
    downloadDocumentPreviewMock.mockRejectedValue(
      new Error(`failed preview/${DOCUMENT_ID}/preview.jpg`),
    );
    const cookie = await sessionCookieFor(owner);

    await responseOf(loaderArgs(DOCUMENT_ID, cookie));

    const logged = loggedLines().join("\n");
    expect(logged).not.toContain("preview/");
    expect(logged).not.toContain("preview.jpg");
    expect(logged).not.toContain(owner.email);
    expect(logged).not.toContain("資料.html");
    expect(logged).not.toContain(owner.id);
  });
});

describe("監査しない(Q-032)", () => {
  it("成功・拒否・失敗のいずれでも監査を記録しない", async () => {
    const cookie = await sessionCookieFor(owner);

    findDocumentByIdMock.mockResolvedValue(documentRecord());
    downloadDocumentPreviewMock.mockResolvedValue(JPEG_BYTES);
    await responseOf(loaderArgs(DOCUMENT_ID, cookie));

    findDocumentByIdMock.mockResolvedValue(null);
    await responseOf(loaderArgs(DOCUMENT_ID, cookie));

    findDocumentByIdMock.mockResolvedValue(documentRecord());
    downloadDocumentPreviewMock.mockRejectedValue(new Error("down"));
    await responseOf(loaderArgs(DOCUMENT_ID, cookie));

    expect(insertAuditEventMock).not.toHaveBeenCalled();
  });

  it("成功時は運用ログも出さない(高頻度のカード画像要求でノイズを作らない)", async () => {
    findDocumentByIdMock.mockResolvedValue(documentRecord());
    downloadDocumentPreviewMock.mockResolvedValue(JPEG_BYTES);
    const cookie = await sessionCookieFor(owner);

    await responseOf(loaderArgs(DOCUMENT_ID, cookie));

    expect(loggedLines()).toEqual([]);
  });
});
