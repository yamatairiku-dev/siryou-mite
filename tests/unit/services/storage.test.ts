import type {
  ContainerClient,
  HttpHeaders,
  RequestPolicy,
  WebResource,
} from "@azure/storage-blob";
import { RestError, type QueueClient } from "@azure/storage-queue";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AZURE_STORAGE_API_VERSION,
  createApiVersionPolicyFactory,
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
  listBlobsByPrefix,
  parseDocumentBlobKey,
  parsePreviewQueueMessage,
  PREVIEW_BLOB_CONTENT_TYPE,
  PREVIEW_QUEUE_SCHEMA_VERSION,
  receivePreviewGenerationEnvelopes,
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

  it("接続文字列経路でもBlob/Queue双方のclientを作れる", () => {
    const blobClient = createBlobServiceClient({
      kind: "connectionString",
      connectionString: "UseDevelopmentStorage=true",
    });
    expect(blobClient.accountName).toBe("devstoreaccount1");
    expect(blobClient.url).toContain("devstoreaccount1");

    const queueClient = createQueueServiceClient({
      kind: "connectionString",
      connectionString: "UseDevelopmentStorage=true",
    });
    expect(queueClient.accountName).toBe("devstoreaccount1");
    expect(queueClient.url).toContain("devstoreaccount1");
  });

  it("Managed Identity経路でもBlob/Queue双方のclientを作れる", () => {
    const blobClient = createBlobServiceClient({
      kind: "managedIdentity",
      accountName: "mystorageacct",
    });
    expect(blobClient.url).toContain("mystorageacct.blob.core.windows.net");

    const queueClient = createQueueServiceClient({
      kind: "managedIdentity",
      accountName: "mystorageacct",
    });
    expect(queueClient.url).toContain("mystorageacct.queue.core.windows.net");
  });
});

/**
 * `RequestPolicy`が要求する最小のfake headers/request/response(設計 §7.3, §7.5)。
 * Azure SDKの生成コードは`x-ms-version`を`isConstant: true`のパラメータとして
 * 固定してしまうため、送信直前にpipelineのpolicyでヘッダーを上書きしている
 * (`createApiVersionPolicyFactory`)。ここではSDKの公開型(`HttpHeaders`・
 * `WebResource`)をそのまま満たすfakeを作り、実際にpolicyを通した結果を検証する。
 */
function createFakeHeaders(initial?: Record<string, string>): HttpHeaders {
  const store = new Map<string, string>(Object.entries(initial ?? {}));
  const headers: HttpHeaders = {
    set(name, value) {
      store.set(name.toLowerCase(), String(value));
    },
    get(name) {
      return store.get(name.toLowerCase());
    },
    contains(name) {
      return store.has(name.toLowerCase());
    },
    remove(name) {
      return store.delete(name.toLowerCase());
    },
    rawHeaders() {
      return Object.fromEntries(store);
    },
    headersArray() {
      return Array.from(store, ([name, value]) => ({ name, value }));
    },
    headerNames() {
      return Array.from(store.keys());
    },
    headerValues() {
      return Array.from(store.values());
    },
    clone() {
      return createFakeHeaders(Object.fromEntries(store));
    },
    toJson() {
      return Object.fromEntries(store);
    },
  };
  return headers;
}

function createFakeWebResource(headers: HttpHeaders): WebResource {
  const resource: WebResource = {
    url: "https://example.invalid/devstoreaccount1/documents",
    method: "GET",
    headers,
    withCredentials: false,
    timeout: 0,
    requestId: "test-request-id",
    clone() {
      return createFakeWebResource(headers.clone());
    },
    validateRequestProperties() {
      // fake用途のため検証しない。
    },
    prepare() {
      return resource;
    },
  };
  return resource;
}

describe("APIバージョン固定policy(設計 §7.3, §7.5)", () => {
  it("送信直前にx-ms-versionヘッダーを固定値へ上書きする", async () => {
    const factory = createApiVersionPolicyFactory();
    const headers = createFakeHeaders({ "x-ms-version": "2026-06-06" });
    const request = createFakeWebResource(headers);

    const nextPolicy: RequestPolicy = {
      sendRequest: vi.fn(async (req) => ({
        status: 200,
        request: req,
        headers: req.headers,
      })),
    };

    const policy = factory.create(nextPolicy, {
      log() {
        // fake用途のため何もしない。
      },
      shouldLog() {
        return false;
      },
    });

    await policy.sendRequest(request);

    expect(headers.get("x-ms-version")).toBe(AZURE_STORAGE_API_VERSION);
    expect(nextPolicy.sendRequest).toHaveBeenCalledTimes(1);
  });

  it("ヘッダーが未設定でも固定値を設定する", async () => {
    const factory = createApiVersionPolicyFactory();
    const headers = createFakeHeaders();
    const request = createFakeWebResource(headers);

    const nextPolicy: RequestPolicy = {
      sendRequest: vi.fn(async (req) => ({
        status: 200,
        request: req,
        headers: req.headers,
      })),
    };

    const policy = factory.create(nextPolicy, {
      log() {
        // fake用途のため何もしない。
      },
      shouldLog() {
        return false;
      },
    });

    await policy.sendRequest(request);

    expect(headers.get("x-ms-version")).toBe(AZURE_STORAGE_API_VERSION);
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
    download: vi.fn(
      async (
        ...args: unknown[]
      ): Promise<{ readableStreamBody: NodeJS.ReadableStream | undefined }> => {
        calls.download = args;
        return { readableStreamBody: undefined };
      },
    ),
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
      readableStreamBody: Readable.from([
        Buffer.from("hello-"),
        Buffer.from("world"),
      ]),
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

interface StubSendMessageOptions {
  abortSignal?: AbortSignal;
  messageTimeToLive?: number;
}

function createStubQueueClient() {
  const sendMessage = vi.fn(
    async (_messageText: string, _options?: StubSendMessageOptions) => ({}),
  );
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
      StubSendMessageOptions | undefined,
    ];
    expect(parsePreviewQueueMessage(messageText)).toEqual({
      schemaVersion: PREVIEW_QUEUE_SCHEMA_VERSION,
      documentId,
    });
    expect(options?.abortSignal).toBeInstanceOf(AbortSignal);
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

  it("envelope受信は不正な本文をmessage=nullで返す(削除できるようにする)", async () => {
    const { queueClient, receiveMessages } = createStubQueueClient();
    receiveMessages.mockResolvedValueOnce({
      receivedMessageItems: [
        { messageId: "m1", popReceipt: "p1", dequeueCount: 3, messageText: "!!!" },
        {
          messageId: "m2",
          popReceipt: "p2",
          dequeueCount: 1,
          messageText: encodePreviewQueueMessage(documentId),
        },
      ],
    });

    const result = await receivePreviewGenerationEnvelopes(queueClient);

    expect(result).toEqual([
      { messageId: "m1", popReceipt: "p1", dequeueCount: 3, message: null },
      {
        messageId: "m2",
        popReceipt: "p2",
        dequeueCount: 1,
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

  it("削除済みメッセージ(MessageNotFound、404)の再削除は冪等に成功する", async () => {
    const { queueClient, deleteMessage } = createStubQueueClient();
    deleteMessage.mockRejectedValueOnce(
      new RestError("not found", { statusCode: 404, code: "MessageNotFound" }),
    );

    await expect(
      deletePreviewGenerationMessage(queueClient, "m1", "p1"),
    ).resolves.toBeUndefined();
  });

  it("404だがMessageNotFoundではないエラー(例: QueueNotFound)は伝播する", async () => {
    const { queueClient, deleteMessage } = createStubQueueClient();
    deleteMessage.mockRejectedValueOnce(
      new RestError("queue not found", { statusCode: 404, code: "QueueNotFound" }),
    );

    await expect(
      deletePreviewGenerationMessage(queueClient, "m1", "p1"),
    ).rejects.toThrow("queue not found");
  });

  it("404以外のエラーは伝播する", async () => {
    const { queueClient, deleteMessage } = createStubQueueClient();
    deleteMessage.mockRejectedValueOnce(
      new RestError("server error", { statusCode: 500 }),
    );

    await expect(
      deletePreviewGenerationMessage(queueClient, "m1", "p1"),
    ).rejects.toThrow("server error");
  });

  it("statusCode/codeを持たない予期しないエラーは伝播する", async () => {
    const { queueClient, deleteMessage } = createStubQueueClient();
    deleteMessage.mockRejectedValueOnce(new Error("network error"));

    await expect(
      deletePreviewGenerationMessage(queueClient, "m1", "p1"),
    ).rejects.toThrow("network error");
  });
});

/**
 * T05完了条件「すべてのBlob/Queue操作へtimeoutを設定している」を、実時間に依存しない
 * 形で網羅的に検証する(Q-006)。結合テスト側では「渡したtimeoutのsignalで実際のSDK
 * 呼び出しが中止されること」を確認し、ここでは「どの操作もSDKへtimeout由来のsignalを
 * 渡していること」と「timeout値(既定・明示指定)」を確認する。
 */
describe("すべてのBlob/Queue操作のabortSignal(設計 §7.3, §7.5, §14)", () => {
  type OperationCase = {
    name: string;
    /** 操作を実行し、SDKへ渡された options を返す。 */
    run: (options?: { timeoutMs: number }) => Promise<Record<string, unknown>>;
  };

  function optionsOf(value: unknown): Record<string, unknown> {
    return (value ?? {}) as Record<string, unknown>;
  }

  const operations: OperationCase[] = [
    {
      name: "uploadDocumentHtml",
      run: async (options) => {
        const { containerClient, blockBlobClient } = createStubContainerClient();
        await uploadDocumentHtml(containerClient, documentId, Buffer.from("x"), options);
        return optionsOf(blockBlobClient.uploadData.mock.calls[0]?.[1]);
      },
    },
    {
      name: "uploadDocumentPreview",
      run: async (options) => {
        const { containerClient, blockBlobClient } = createStubContainerClient();
        await uploadDocumentPreview(containerClient, documentId, Buffer.from("x"), options);
        return optionsOf(blockBlobClient.uploadData.mock.calls[0]?.[1]);
      },
    },
    {
      name: "downloadDocumentHtml",
      run: async (options) => {
        const { containerClient, blobClient } = createStubContainerClient();
        await downloadDocumentHtml(containerClient, documentId, options);
        return optionsOf(blobClient.download.mock.calls[0]?.[2]);
      },
    },
    {
      name: "downloadDocumentPreview",
      run: async (options) => {
        const { containerClient, blobClient } = createStubContainerClient();
        await downloadDocumentPreview(containerClient, documentId, options);
        return optionsOf(blobClient.download.mock.calls[0]?.[2]);
      },
    },
    {
      name: "deleteDocumentHtml",
      run: async (options) => {
        const { containerClient, blobClient } = createStubContainerClient();
        await deleteDocumentHtml(containerClient, documentId, options);
        return optionsOf(blobClient.deleteIfExists.mock.calls[0]?.[0]);
      },
    },
    {
      name: "deleteDocumentPreview",
      run: async (options) => {
        const { containerClient, blobClient } = createStubContainerClient();
        await deleteDocumentPreview(containerClient, documentId, options);
        return optionsOf(blobClient.deleteIfExists.mock.calls[0]?.[0]);
      },
    },
    {
      name: "sendPreviewGenerationMessage",
      run: async (options) => {
        const { queueClient, sendMessage } = createStubQueueClient();
        await sendPreviewGenerationMessage(queueClient, documentId, options);
        return optionsOf(sendMessage.mock.calls[0]?.[1]);
      },
    },
    {
      name: "receivePreviewGenerationEnvelopes",
      run: async (options) => {
        const { queueClient, receiveMessages } = createStubQueueClient();
        await receivePreviewGenerationEnvelopes(queueClient, options);
        return optionsOf(
          (receiveMessages.mock.calls[0] as unknown[] | undefined)?.[0],
        );
      },
    },
    {
      name: "receivePreviewGenerationMessages",
      run: async (options) => {
        const { queueClient, receiveMessages } = createStubQueueClient();
        await receivePreviewGenerationMessages(queueClient, options);
        return optionsOf(
          (receiveMessages.mock.calls[0] as unknown[] | undefined)?.[0],
        );
      },
    },
    {
      name: "deletePreviewGenerationMessage",
      run: async (options) => {
        const { queueClient, deleteMessage } = createStubQueueClient();
        await deletePreviewGenerationMessage(queueClient, "m1", "p1", options);
        return optionsOf(
          (deleteMessage.mock.calls[0] as unknown[] | undefined)?.[2],
        );
      },
    },
  ];

  it.each(operations)(
    "$name は既定timeoutから作ったabortSignalをSDKへ渡す",
    async ({ run }) => {
      const signal = AbortSignal.abort();
      const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(signal);

      const options = await run();

      expect(timeoutSpy).toHaveBeenCalledWith(DEFAULT_STORAGE_OPERATION_TIMEOUT_MS);
      // SDKへ渡ったsignalが、timeoutから作られたsignalそのものであること。
      expect(options.abortSignal).toBe(signal);
    },
  );

  it.each(operations)(
    "$name は指定したtimeoutMsからabortSignalを作る",
    async ({ run }) => {
      const signal = AbortSignal.abort();
      const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(signal);

      const options = await run({ timeoutMs: 4321 });

      expect(timeoutSpy).toHaveBeenCalledWith(4321);
      expect(options.abortSignal).toBe(signal);
    },
  );
});

describe("Blobキーの逆引き(設計 §7.3, §7.7の孤児Blob掃除)", () => {
  it("導出したキーから資料IDと種別を復元する", () => {
    expect(parseDocumentBlobKey(documentHtmlBlobKey(documentId))).toEqual({
      kind: "html",
      documentId,
    });
    expect(parseDocumentBlobKey(documentPreviewBlobKey(documentId))).toEqual({
      kind: "preview",
      documentId,
    });
  });

  it.each([
    ["接頭辞が違う", `other/${documentId}/document.html`],
    ["ファイル名が違う", `html/${documentId}/document.htm`],
    ["余分なパスがある", `html/extra/${documentId}/document.html`],
    ["資料IDがUUIDでない", "html/not-a-uuid/document.html"],
    ["資料IDが空", "html//document.html"],
    ["パストラバーサル", "html/../../etc/passwd/document.html"],
    ["接頭辞だけ", "html/"],
    ["空文字", ""],
  ])("%s キーは対象外(null)にする", (_label, key) => {
    expect(parseDocumentBlobKey(key)).toBeNull();
  });

  it("大文字のUUIDは対象外にする(Blobキーは大文字小文字を区別する)", () => {
    const mixedCaseId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee".toUpperCase();

    expect(
      parseDocumentBlobKey(`html/${mixedCaseId}/document.html`),
    ).toBeNull();
    // 同じUUIDでも小文字なら対象になる。
    expect(
      parseDocumentBlobKey(`html/${mixedCaseId.toLowerCase()}/document.html`),
    ).toEqual({ kind: "html", documentId: mixedCaseId.toLowerCase() });
  });
});

/** `listBlobsFlat().byPage()`だけを持つ最小のContainerClient stub。 */
function createStubListContainerClient(
  pages: Array<{
    blobItems: Array<{ name: string; properties: { lastModified?: Date } }>;
    continuationToken?: string;
  }>,
) {
  const byPage = vi.fn((_options: unknown) => {
    let index = 0;
    return {
      async next() {
        const page = pages[index];
        index += 1;
        // 実際のSDKは`{ segment: { blobItems }, continuationToken }`を返す。
        return page
          ? {
              done: false,
              value: {
                segment: { blobItems: page.blobItems },
                continuationToken: page.continuationToken,
              },
            }
          : { done: true, value: undefined };
      },
    };
  });
  const listBlobsFlat = vi.fn((_options: unknown) => ({ byPage }));

  return {
    containerClient: { listBlobsFlat } as unknown as ContainerClient,
    listBlobsFlat,
    byPage,
  };
}

describe("Blob一覧(設計 §7.7の孤児Blob掃除)", () => {
  it("接頭辞・ページサイズ・abortSignalを渡し、1ページだけ読む", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const lastModified = new Date("2026-01-01T00:00:00.000Z");
    const { containerClient, listBlobsFlat, byPage } =
      createStubListContainerClient([
        {
          blobItems: [
            { name: `html/${documentId}/document.html`, properties: { lastModified } },
          ],
          continuationToken: "next-page",
        },
      ]);

    const page = await listBlobsByPrefix(containerClient, "html/", {
      pageSize: 2,
      timeoutMs: 4321,
    });

    expect(listBlobsFlat).toHaveBeenCalledWith(
      expect.objectContaining({ prefix: "html/" }),
    );
    const [listOptions] = listBlobsFlat.mock.calls[0] as [
      { abortSignal: AbortSignal },
    ];
    expect(listOptions.abortSignal).toBeInstanceOf(AbortSignal);
    expect(timeoutSpy).toHaveBeenCalledWith(4321);
    expect(byPage).toHaveBeenCalledWith(
      expect.objectContaining({ maxPageSize: 2 }),
    );
    expect(page).toEqual({
      blobs: [{ key: `html/${documentId}/document.html`, lastModified }],
      continuationToken: "next-page",
    });
  });

  it("continuationTokenを指定すると続きから読む", async () => {
    const { containerClient, byPage } = createStubListContainerClient([
      { blobItems: [] },
    ]);

    const page = await listBlobsByPrefix(containerClient, "preview/", {
      pageSize: 10,
      continuationToken: "token-1",
    });

    expect(byPage).toHaveBeenCalledWith(
      expect.objectContaining({ continuationToken: "token-1" }),
    );
    // 続きが無い場合は`null`(空文字は返さない)。
    expect(page.continuationToken).toBeNull();
  });

  it("最終更新日時が無いBlobはnullとして返す(呼び出し側が猶予を判定できない)", async () => {
    const { containerClient } = createStubListContainerClient([
      { blobItems: [{ name: `html/${documentId}/document.html`, properties: {} }] },
    ]);

    const page = await listBlobsByPrefix(containerClient, "html/", {
      pageSize: 10,
    });

    expect(page.blobs[0]?.lastModified).toBeNull();
  });

  it("ページが1件も無い場合は空を返す", async () => {
    const { containerClient } = createStubListContainerClient([]);

    await expect(
      listBlobsByPrefix(containerClient, "html/", { pageSize: 10 }),
    ).resolves.toEqual({ blobs: [], continuationToken: null });
  });
});
