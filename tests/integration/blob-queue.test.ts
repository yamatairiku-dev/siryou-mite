import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ContainerClient } from "@azure/storage-blob";
import type { QueueClient } from "@azure/storage-queue";
import {
  createBlobServiceClient,
  createQueueServiceClient,
  deleteDocumentHtml,
  deleteDocumentPreview,
  deletePreviewGenerationMessage,
  documentHtmlBlobKey,
  documentPreviewBlobKey,
  downloadDocumentHtml,
  downloadDocumentPreview,
  getDocumentsContainerClient,
  getPreviewQueueClient,
  HTML_BLOB_CONTENT_TYPE,
  InvalidDocumentIdError,
  PREVIEW_BLOB_CONTENT_TYPE,
  receivePreviewGenerationMessages,
  sendPreviewGenerationMessage,
  uploadDocumentHtml,
  uploadDocumentPreview,
} from "../../services/shared/storage.js";
import { requireStorageConnectionString, uniqueTestName } from "./helpers/storage.js";

/**
 * Blob Storage / Storage Queueの結合テスト(設計 §7.3, §7.5, §18.2)。
 *
 * devcontainerのAzuriteへ実際に接続し、保存・取得・削除とQueueメッセージの
 * 送受信を実際のprotocolで検証する。テスト専用のcontainer/queueを作り、
 * 完了後に削除する(他テストとの干渉を避ける)。
 */
const documentId = "22222222-3333-4444-8555-666666666666";

let containerClient: ContainerClient;
let queueClient: QueueClient;
let containerName: string;
let queueName: string;

beforeAll(async () => {
  const connectionString = requireStorageConnectionString();
  containerName = uniqueTestName("t05-documents");
  queueName = uniqueTestName("t05-preview");

  const blobServiceClient = createBlobServiceClient({
    kind: "connectionString",
    connectionString,
  });
  const queueServiceClient = createQueueServiceClient({
    kind: "connectionString",
    connectionString,
  });

  containerClient = getDocumentsContainerClient(blobServiceClient, containerName);
  queueClient = getPreviewQueueClient(queueServiceClient, queueName);

  await containerClient.createIfNotExists();
  await queueClient.createIfNotExists();
}, 30_000);

afterAll(async () => {
  await containerClient?.deleteIfExists();
  await queueClient?.deleteIfExists();
}, 30_000);

describe("Blob操作", () => {
  it("HTMLを保存・取得・削除できる(設計 §7.3)", async () => {
    const html = Buffer.from("<html><body>資料</body></html>", "utf8");

    await uploadDocumentHtml(containerClient, documentId, html);

    const downloaded = await downloadDocumentHtml(containerClient, documentId);
    expect(downloaded.equals(html)).toBe(true);

    const blobClient = containerClient.getBlobClient(
      documentHtmlBlobKey(documentId),
    );
    const properties = await blobClient.getProperties();
    expect(properties.contentType).toBe(HTML_BLOB_CONTENT_TYPE);

    await deleteDocumentHtml(containerClient, documentId);
    expect(await blobClient.exists()).toBe(false);
  });

  it("プレビュー画像を保存・取得・削除できる(設計 §7.3)", async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

    await uploadDocumentPreview(containerClient, documentId, jpeg);

    const downloaded = await downloadDocumentPreview(containerClient, documentId);
    expect(downloaded.equals(jpeg)).toBe(true);

    const blobClient = containerClient.getBlobClient(
      documentPreviewBlobKey(documentId),
    );
    const properties = await blobClient.getProperties();
    expect(properties.contentType).toBe(PREVIEW_BLOB_CONTENT_TYPE);

    await deleteDocumentPreview(containerClient, documentId);
    expect(await blobClient.exists()).toBe(false);
  });

  it("存在しないBlobの削除は冪等に成功する", async () => {
    const neverUploadedId = "33333333-4444-5555-8666-777777777777";

    await expect(
      deleteDocumentHtml(containerClient, neverUploadedId),
    ).resolves.toBeUndefined();
    await expect(
      deleteDocumentPreview(containerClient, neverUploadedId),
    ).resolves.toBeUndefined();
  });

  it("不正な資料ID(パストラバーサル)はBlob呼び出し前に拒否する", async () => {
    await expect(
      uploadDocumentHtml(containerClient, "../../etc/passwd", Buffer.from("x")),
    ).rejects.toThrow(InvalidDocumentIdError);
  });

  it("明示的なtimeoutを超えると操作を中止する", async () => {
    // 実際のAzuriteに対して、既に期限切れのtimeout(1ms)を渡すと中止される。
    await expect(
      uploadDocumentHtml(containerClient, documentId, Buffer.from("x"), {
        timeoutMs: 1,
      }),
    ).rejects.toBeTruthy();
  });
});

describe("Storage Queue", () => {
  it("送信したメッセージをschemaVersion/documentIdだけで受信できる(設計 §7.5)", async () => {
    await sendPreviewGenerationMessage(queueClient, documentId);

    const [received] = await receivePreviewGenerationMessages(queueClient, {
      visibilityTimeoutSeconds: 5,
    });

    expect(received).toBeDefined();
    expect(received?.message).toEqual({ schemaVersion: 1, documentId });
    expect(received?.dequeueCount).toBe(1);

    await deletePreviewGenerationMessage(
      queueClient,
      received!.messageId,
      received!.popReceipt,
    );
  });

  it("visibility timeout経過後に同じメッセージを再受信でき、dequeueCountが増える(冪等処理の前提、設計 §7.5)", async () => {
    await sendPreviewGenerationMessage(queueClient, documentId);

    const [first] = await receivePreviewGenerationMessages(queueClient, {
      visibilityTimeoutSeconds: 1,
    });
    expect(first?.dequeueCount).toBe(1);

    // visibility timeout(1秒)が経過するまで待ち、再受信できることを確認する。
    await new Promise((resolve) => setTimeout(resolve, 1_500));

    const [second] = await receivePreviewGenerationMessages(queueClient, {
      visibilityTimeoutSeconds: 5,
    });
    expect(second?.message).toEqual({ schemaVersion: 1, documentId });
    expect(second?.dequeueCount).toBe(2);

    await deletePreviewGenerationMessage(
      queueClient,
      second!.messageId,
      second!.popReceipt,
    );
  }, 10_000);

  it("削除済みメッセージの再削除は冪等に成功する(重複配信への耐性)", async () => {
    await sendPreviewGenerationMessage(queueClient, documentId);
    const [received] = await receivePreviewGenerationMessages(queueClient, {
      visibilityTimeoutSeconds: 5,
    });

    await deletePreviewGenerationMessage(
      queueClient,
      received!.messageId,
      received!.popReceipt,
    );

    await expect(
      deletePreviewGenerationMessage(
        queueClient,
        received!.messageId,
        received!.popReceipt,
      ),
    ).resolves.toBeUndefined();
  });

  it("不正な資料IDでは送信前に拒否する", async () => {
    await expect(
      sendPreviewGenerationMessage(queueClient, "not-a-uuid"),
    ).rejects.toThrow();
  });
});
