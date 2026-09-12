import type { ContainerClient } from "@azure/storage-blob";
import type { QueueClient } from "@azure/storage-queue";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_QUEUE_VISIBILITY_TIMEOUT_SECONDS,
  DEFAULT_STORAGE_OPERATION_TIMEOUT_MS,
  createBlobServiceClient,
  createQueueServiceClient,
  deleteDocumentHtml,
  deleteDocumentPreview,
  deletePreviewGenerationMessage,
  documentHtmlBlobKey,
  documentPreviewBlobKey,
  downloadDocumentHtml,
  downloadDocumentPreview,
  encodePreviewQueueMessage,
  getDocumentsContainerClient,
  getPreviewQueueClient,
  HTML_BLOB_CONTENT_TYPE,
  InvalidDocumentIdError,
  InvalidQueueMessageError,
  parsePreviewQueueMessage,
  PREVIEW_BLOB_CONTENT_TYPE,
  PREVIEW_QUEUE_SCHEMA_VERSION,
  receivePreviewGenerationMessages,
  resolveStorageConnectionConfig,
  sendPreviewGenerationMessage,
  uploadDocumentHtml,
  uploadDocumentPreview,
} from "../../../services/shared/storage";

const documentId = "11111111-2222-4333-8444-555555555555";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Blobキー導出(設計 §7.3)", () => {
  it("資料IDから決定的にキーを導出する", () => {
    expect(documentHtmlBlobKey(documentId)).toBe(
      `html/${documentId}/document.html`,
    );
    expect(documentPreviewBlobKey(documentId)).toBe(
      `preview/${documentId}/preview.jpg`,
    );
  });

  it.each([
    ["空文字", ""],
    ["パストラバーサル", "../../etc/passwd"],
    ["スラッシュを含む値", "11111111-2222-4333-8444-555555555555/evil"],
    ["UUIDでない値", "not-a-uuid"],
    ["SQLインジェクション風の値", "1'; DROP TABLE documents;--"],
  ])("%s を拒否する", (_label, invalidId) => {
    expect(() => documentHtmlBlobKey(invalidId)).toThrow(InvalidDocumentIdError);
    expect(() => documentPreviewBlobKey(invalidId)).toThrow(
      InvalidDocumentIdError,
    );
  });
});

describe("接続設定の解決", () => {
  it("接続文字列があればconnectionString kindを返す", () => {
    expect(
      resolveStorageConnectionConfig({
        AZURE_STORAGE_CONNECTION_STRING: "UseDevelopmentStorage=true",
      }),
    ).toEqual({
      kind: "connectionString",
      connectionString: "UseDevelopmentStorage=true",
    });
  });

  it("account名があればmanagedIdentity kindを返す", () => {
    expect(
      resolveStorageConnectionConfig({ AZURE_STORAGE_ACCOUNT_NAME: "mystorageacct" }),
    ).toEqual({ kind: "managedIdentity", accountName: "mystorageacct" });
  });

  it("どちらも無い場合は値を含まない例外にする", () => {
    expect(() => resolveStorageConnectionConfig({})).toThrow(
      /AZURE_STORAGE_CONNECTION_STRING/,
    );
  });

  it("createBlobServiceClient/createQueueServiceClientはkindに応じたclientを作る(接続はしない)", () => {
    const blobClient = createBlobServiceClient({
      kind: "connectionString",
      connectionString: "UseDevelopmentStorage=true",
    });
    expect(blobClient.accountName).toBe("devstoreaccount1");

    const queueClient = createQueueServiceClient({
      kind: "managedIdentity",
      accountName: "mystorageacct",
    });
    expect(queueClient.url).toContain("mystorageacct.queue.core.windows.net");

    const containerClient = getDocumentsContainerClient(blobClient, "documents");
    expect(containerClient.containerName).toBe("documents");

    const queue = getPreviewQueueClient(queueClient, "preview-generation");
    expect(queue.name).toBe("preview-generation");
  });
});

describe("Queueメッセージ(設計 §7.5)", () => {
  it("schemaVersionとdocumentIdだけを含む値を往復できる", () => {
    const encoded = encodePreviewQueueMessage(documentId);
    const decoded = parsePreviewQueueMessage(encoded);

    expect(decoded).toEqual({
      schemaVersion: PREVIEW_QUEUE_SCHEMA_VERSION,
      documentId,
    });
  });

  it("資料IDがUUIDでない場合は送信時に拒否する", () => {
    expect(() => encodePreviewQueueMessage("not-a-uuid")).toThrow();
  });

  it.each([
    [
      "base64でない値",
      "!!!not-base64!!!",
    ],
    [
      "JSONでない値",
      Buffer.from("plain text", "utf8").toString("base64"),
    ],
    [
      "schemaVersionが不正な値",
      Buffer.from(
        JSON.stringify({ schemaVersion: 2, documentId }),
        "utf8",
      ).toString("base64"),
    ],
    [
      "documentIdがUUIDでない値",
      Buffer.from(
        JSON.stringify({ schemaVersion: 1, documentId: "1 OR 1=1" }),
        "utf8",
      ).toString("base64"),
    ],
    [
      "未知のfieldを含む値",
      Buffer.from(
        JSON.stringify({ schemaVersion: 1, documentId, extra: "x" }),
        "utf8",
      ).toString("base64"),
    ],
  ])("%s を拒否する", (_label, raw) => {
    expect(() => parsePreviewQueueMessage(raw)).toThrow(
      InvalidQueueMessageError,
    );
  });
});

/** ContainerClient/QueueClientをネットワークなしで検証するためのstub。 */
function createStubContainerClient() {
  const calls: Record<string, unknown[]> = {};
  const blockBlobClient = {
    uploadData: vi.fn(async (...args: unknown[]) => {
      calls.uploadData = args;
    }),
  };
  const blobClient = {
    download: vi.fn(async (...args: unknown[]) => {
      calls.download = args;
      return { readableStreamBody: undefined };
    }),
    deleteIfExists: vi.fn(async (...args: unknown[]) => {
      calls.deleteIfExists = args;
    }),
  };
  const containerClient = {
    getBlockBlobClient: vi.fn(() => blockBlobClient),
    getBlobClient: vi.fn(() => blobClient),
  } as unknown as ContainerClient;

  return { containerClient, blockBlobClient, blobClient, calls };
}

describe("Blob操作(設計 §7.3)", () => {
  it("HTML保存は固定のContent-Typeで既定timeoutのabortSignalを渡す", async () => {
    const { containerClient, blockBlobClient } = createStubContainerClient();

    await uploadDocumentHtml(containerClient, documentId, Buffer.from("<html></html>"));

    expect(blockBlobClient.uploadData).toHaveBeenCalledTimes(1);
    const [content, options] = blockBlobClient.uploadData.mock.calls[0] as [
      Buffer,
      { abortSignal: AbortSignal; blobHTTPHeaders: { blobContentType: string } },
    ];
    expect(content.toString()).toBe("<html></html>");
    expect(options.blobHTTPHeaders.blobContentType).toBe(HTML_BLOB_CONTENT_TYPE);
    expect(options.abortSignal).toBeInstanceOf(AbortSignal);
  });

  it("プレビュー画像保存は固定のContent-Typeを使う", async () => {
    const { containerClient, blockBlobClient } = createStubContainerClient();

    await uploadDocumentPreview(containerClient, documentId, Buffer.from([1, 2, 3]));

    const [, options] = blockBlobClient.uploadData.mock.calls[0] as [
      Buffer,
      { blobHTTPHeaders: { blobContentType: string } },
    ];
    expect(options.blobHTTPHeaders.blobContentType).toBe(
      PREVIEW_BLOB_CONTENT_TYPE,
    );
  });

  it("timeoutMsを指定するとその値でabortSignalを作る", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const { containerClient } = createStubContainerClient();

    await uploadDocumentHtml(containerClient, documentId, Buffer.from("x"), {
      timeoutMs: 1234,
    });

    expect(timeoutSpy).toHaveBeenCalledWith(1234);
  });

  it("指定が無い場合は既定timeoutを使う", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const { containerClient } = createStubContainerClient();

    await downloadDocumentHtml(containerClient, documentId);

    expect(timeoutSpy).toHaveBeenCalledWith(DEFAULT_STORAGE_OPERATION_TIMEOUT_MS);
  });

  it("HTMLダウンロードはBlob本文をBufferへ結合する", async () => {
    const { containerClient, blobClient } = createStubContainerClient();
    blobClient.download.mockResolvedValueOnce({
      readableStreamBody: (async function* () {
        yield Buffer.from("hello-");
        yield Buffer.from("world");
      })(),
    });

    const result = await downloadDocumentHtml(containerClient, documentId);

    expect(result.toString()).toBe("hello-world");
  });

  it("削除は存在しないBlobに対しても失敗しない(deleteIfExistsを使う)", async () => {
    const { containerClient, blobClient } = createStubContainerClient();

    await deleteDocumentHtml(containerClient, documentId);
    await deleteDocumentPreview(containerClient, documentId);

    expect(blobClient.deleteIfExists).toHaveBeenCalledTimes(2);
  });

  it("不正な資料IDに対しては呼び出し前に例外にする", async () => {
    const { containerClient, blockBlobClient } = createStubContainerClient();

    await expect(
      uploadDocumentHtml(containerClient, "not-a-uuid", Buffer.from("x")),
    ).rejects.toThrow(InvalidDocumentIdError);
    expect(blockBlobClient.uploadData).not.toHaveBeenCalled();
  });
});

function createStubQueueClient() {
  const sendMessage = vi.fn(async () => ({}));
  const receiveMessages = vi.fn(async () => ({ receivedMessageItems: [] as unknown[] }));
  const deleteMessage = vi.fn(async () => ({}));
  const queueClient = {
    sendMessage,
    receiveMessages,
    deleteMessage,
  } as unknown as QueueClient;

  return { queueClient, sendMessage, receiveMessages, deleteMessage };
}

describe("Queue操作(設計 §7.5)", () => {
  it("送信はbase64エンコードしたschemaVersion/documentIdだけを送る", async () => {
    const { queueClient, sendMessage } = createStubQueueClient();

    await sendPreviewGenerationMessage(queueClient, documentId);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [messageText, options] = sendMessage.mock.calls[0] as [
      string,
      { abortSignal: AbortSignal },
    ];
    expect(parsePreviewQueueMessage(messageText)).toEqual({
      schemaVersion: PREVIEW_QUEUE_SCHEMA_VERSION,
      documentId,
    });
    expect(options.abortSignal).toBeInstanceOf(AbortSignal);
  });

  it("受信は既定visibility timeout(60秒)とdequeueCountを含めて返す", async () => {
    const { queueClient, receiveMessages } = createStubQueueClient();
    receiveMessages.mockResolvedValueOnce({
      receivedMessageItems: [
        {
          messageId: "m1",
          popReceipt: "p1",
          dequeueCount: 2,
          messageText: encodePreviewQueueMessage(documentId),
        },
      ],
    });

    const result = await receivePreviewGenerationMessages(queueClient);

    expect(receiveMessages).toHaveBeenCalledWith(
      expect.objectContaining({
        visibilityTimeout: DEFAULT_QUEUE_VISIBILITY_TIMEOUT_SECONDS,
      }),
    );
    expect(result).toEqual([
      {
        messageId: "m1",
        popReceipt: "p1",
        dequeueCount: 2,
        message: { schemaVersion: PREVIEW_QUEUE_SCHEMA_VERSION, documentId },
      },
    ]);
  });

  it("不正な本文のメッセージは例外にする", async () => {
    const { queueClient, receiveMessages } = createStubQueueClient();
    receiveMessages.mockResolvedValueOnce({
      receivedMessageItems: [
        { messageId: "m1", popReceipt: "p1", dequeueCount: 1, messageText: "!!!" },
      ],
    });

    await expect(receivePreviewGenerationMessages(queueClient)).rejects.toThrow(
      InvalidQueueMessageError,
    );
  });

  it("削除済みメッセージ(404)の再削除は冪等に成功する", async () => {
    const { queueClient, deleteMessage } = createStubQueueClient();
    deleteMessage.mockRejectedValueOnce(
      Object.assign(new Error("not found"), { statusCode: 404 }),
    );

    await expect(
      deletePreviewGenerationMessage(queueClient, "m1", "p1"),
    ).resolves.toBeUndefined();
  });

  it("404以外のエラーは伝播する", async () => {
    const { queueClient, deleteMessage } = createStubQueueClient();
    deleteMessage.mockRejectedValueOnce(
      Object.assign(new Error("server error"), { statusCode: 500 }),
    );

    await expect(
      deletePreviewGenerationMessage(queueClient, "m1", "p1"),
    ).rejects.toThrow("server error");
  });
});
