import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { ContainerClient } from "@azure/storage-blob";
import type { Client } from "pg";
import {
  createDocument,
  deleteDocumentAsOwner,
  findDocumentById,
  updateDocumentPreviewStatus,
  type DocumentRecord,
} from "~/lib/db/documents.server";
import { closePool } from "~/lib/db/pool.server";
import {
  handlePreviewImageRequest,
  type PreviewImageDependencies,
} from "~/lib/documents/preview-image.server";
import { createUserSession, type AppUser } from "~/lib/session.server";
import {
  createBlobServiceClient,
  deleteDocumentPreview,
  downloadDocumentPreview,
  getDocumentsContainerClient,
  uploadDocumentPreview,
} from "../../services/shared/storage.js";
import { dropSchema, migrateFreshSchema, newClient } from "./helpers/schema.js";
import {
  requireStorageConnectionString,
  uniqueTestName,
} from "./helpers/storage.js";

/**
 * T23 結合テスト: プレビュー画像の配信経路(設計 §5.3, §7.3, §13、Q-030)。
 *
 * 実際のPostgreSQL(テスト専用schema)とAzurite(テスト専用container)に対して
 * 配信処理本体をそのまま実行し、`ready`の資料だけがBlobの中身をそのまま
 * `image/jpeg`で返すこと、`ready`以外・削除済み・Blob未存在では画像を返さないこと、
 * 監査行を作らないことを確認する。
 */

const schema = "t23_it_document_preview_image";
const origin = "http://localhost:3000";

const owner: AppUser = {
  id: "oid-integration-owner",
  tenantId: "tenant-integration",
  name: "結合テスト所有者",
  email: "owner@example.com",
  roles: ["User"],
  groups: ["ZAA535-A"],
};

const viewer: AppUser = {
  id: "oid-integration-viewer",
  tenantId: "tenant-integration",
  name: "結合テスト閲覧者",
  email: "viewer@example.com",
  roles: ["User"],
  groups: ["ZAA535-A"],
};

/** JPEGのSOIマーカーで始まるダミー画像(Preview Jobが保存する形式と同じ先頭)。 */
const JPEG_BYTES = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  Buffer.from("integration-preview", "utf8"),
  Buffer.from([0xff, 0xd9]),
]);

let client: Client;
let containerClient: ContainerClient;

beforeAll(async () => {
  await migrateFreshSchema(schema);
  client = newClient();
  await client.connect();
  await client.query(`SET search_path TO "${schema}"`);

  containerClient = getDocumentsContainerClient(
    createBlobServiceClient({
      kind: "connectionString",
      connectionString: requireStorageConnectionString(),
    }),
    uniqueTestName("t23-documents"),
  );
  await containerClient.createIfNotExists();
}, 30_000);

afterAll(async () => {
  await closePool();
  await client.end();
  await dropSchema(schema);
  await containerClient?.deleteIfExists();
}, 30_000);

beforeEach(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  await client.query("TRUNCATE audit_events, documents");
});

afterEach(() => {
  vi.restoreAllMocks();
});

function integrationDependencies(): PreviewImageDependencies {
  return {
    findDocumentById: (documentId) => findDocumentById(documentId, client),
    downloadPreview: (documentId, options) =>
      downloadDocumentPreview(containerClient, documentId, options),
  };
}

async function addDocument(
  previewStatus: "pending" | "ready" | "failed",
  options: { uploadPreview?: boolean } = {},
): Promise<DocumentRecord> {
  const document = await createDocument(
    {
      ownerSubjectId: owner.id,
      ownerEmailAtUpload: owner.email,
      originalFileName: "結合テスト資料.html",
      title: "結合テスト資料",
      byteSize: 1024,
      warningCodes: [],
    },
    client,
  );
  if (previewStatus !== "pending") {
    await updateDocumentPreviewStatus(
      { documentId: document.id, previewStatus },
      client,
    );
  }
  if (options.uploadPreview ?? true) {
    await uploadDocumentPreview(containerClient, document.id, JPEG_BYTES);
  }
  return document;
}

async function requestPreviewAs(
  user: AppUser,
  documentId: string,
): Promise<Response> {
  const cookie =
    (await createUserSession(user)).headers.get("Set-Cookie") ?? "";
  try {
    return await handlePreviewImageRequest(
      new Request(`${origin}/documents/${documentId}/preview`, {
        headers: { Cookie: cookie },
      }),
      { documentId },
      integrationDependencies(),
    );
  } catch (error) {
    if (error instanceof Response) {
      return error;
    }
    throw error;
  }
}

async function auditRowCount(): Promise<number> {
  const result = await client.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM audit_events",
  );
  return Number(result.rows[0]?.count ?? "0");
}

describe("readyの資料", () => {
  it("所有者以外のログイン済み利用者にも、Blobの中身をimage/jpegのまま中継する", async () => {
    const document = await addDocument("ready");

    const response = await requestPreviewAs(viewer, document.id);

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/jpeg");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(JPEG_BYTES);
    // 画像の参照は監査しない(Q-032)。
    expect(await auditRowCount()).toBe(0);
  });

  it("Blobが存在しない場合は画像を返さず404にする", async () => {
    const document = await addDocument("ready", { uploadPreview: false });

    const response = await requestPreviewAs(owner, document.id);

    expect(response.status).toBe(404);
    expect(response.headers.get("Content-Type")).not.toBe("image/jpeg");
  });
});

describe("画像を返さない場合", () => {
  it.each(["pending", "failed"] as const)(
    "%sの資料はBlobがあっても404にする",
    async (previewStatus) => {
      const document = await addDocument(previewStatus);

      const response = await requestPreviewAs(owner, document.id);

      expect(response.status).toBe(404);
      expect(await response.text()).toBe("資料が見つかりません");
    },
  );

  it("削除済み資料は、Blobが残っていても未存在と同じ404にする", async () => {
    const document = await addDocument("ready");
    await deleteDocumentAsOwner(
      { documentId: document.id, ownerSubjectId: owner.id },
      client,
    );

    const deleted = await requestPreviewAs(owner, document.id);
    const missing = await requestPreviewAs(
      owner,
      "99999999-9999-4999-8999-999999999999",
    );

    expect(deleted.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await deleted.text()).toBe(await missing.text());
    expect(await auditRowCount()).toBe(0);

    await deleteDocumentPreview(containerClient, document.id);
  });
});
