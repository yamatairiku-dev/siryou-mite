/**
 * Blob Storage / Storage Queueクライアント(設計 §7.3, §7.5)。
 *
 * `services/` 配下は `app/` を一切importしない方針(docs/ARCHITECTURE.md, T04 Q-005)
 * だが、逆方向(`app/` → `services/shared/`)の依存はこの制約に反しない。Blob/Queue
 * 操作は複数実行単位(Web・Display・Preview・Maintenance)で共有される実処理であり、
 * 環境変数検証(`services/shared/env.ts`)のように重複させるとAzure SDK呼び出しが
 * 分岐して食い違うリスクが大きいため、実装はここへ集約する。Web側は
 * `app/lib/storage.server.ts`から本モジュールを再importする薄いラッパーにする。
 *
 * - Blobキーは資料IDから決定的に導出し、DBへ保存しない(設計 §7.3)。
 * - すべてのBlob/Queue操作へ明示的なtimeout(`abortSignal`)を設定する。
 * - HTML保存時の`Content-Type`は固定値を使い、利用者由来の値をヘッダーへ使わない。
 * - Blob削除・Queueメッセージ削除は対象が既に存在しなくても失敗しない(冪等)。
 * - Queueメッセージは`schemaVersion`と`documentId`だけを含む(設計 §7.5)。
 */
import { DefaultAzureCredential } from "@azure/identity";
import {
  BlobServiceClient,
  type ContainerClient,
} from "@azure/storage-blob";
import { QueueServiceClient, type QueueClient } from "@azure/storage-queue";
import { z } from "zod";

/**
 * Blob/Queue操作すべてに設定する既定timeout(ms)。
 * T05完了条件「timeoutを設定している」を満たすため、呼び出し側が省略しても
 * 必ず`abortSignal`付きでSDKを呼ぶ。
 */
export const DEFAULT_STORAGE_OPERATION_TIMEOUT_MS = 10_000;

/** Queueメッセージのvisibility timeout既定値(設計 §7.5、秒)。 */
export const DEFAULT_QUEUE_VISIBILITY_TIMEOUT_SECONDS = 60;

export interface StorageOperationOptions {
  /** 省略時は`DEFAULT_STORAGE_OPERATION_TIMEOUT_MS`。 */
  timeoutMs?: number;
}

function abortSignalFor(options?: StorageOperationOptions): AbortSignal {
  return AbortSignal.timeout(
    options?.timeoutMs ?? DEFAULT_STORAGE_OPERATION_TIMEOUT_MS,
  );
}

// --- 接続設定(設計 §7.3「サービス間はManaged Identityを使用する」) ---

export type StorageConnectionConfig =
  | { readonly kind: "connectionString"; readonly connectionString: string }
  | { readonly kind: "managedIdentity"; readonly accountName: string };

/**
 * ローカル・開発は接続文字列、本番はManaged Identity(account名)を使う。
 * どちらも無い場合は例外にする(fail closed)。値そのものは例外メッセージへ
 * 含めない(設計 §9.5)。呼び出し側(Web・各service)は自身のZod検証済み環境変数
 * (`AZURE_STORAGE_CONNECTION_STRING`/`AZURE_STORAGE_ACCOUNT_NAME`は排他)から
 * この関数を呼ぶ想定であり、本番で接続文字列を許可しない検証自体は
 * `validateStorageConfig`(env schema側)が既に行う。
 */
export function resolveStorageConnectionConfig(value: {
  AZURE_STORAGE_CONNECTION_STRING?: string | undefined;
  AZURE_STORAGE_ACCOUNT_NAME?: string | undefined;
}): StorageConnectionConfig {
  if (value.AZURE_STORAGE_CONNECTION_STRING) {
    return {
      kind: "connectionString",
      connectionString: value.AZURE_STORAGE_CONNECTION_STRING,
    };
  }

  if (value.AZURE_STORAGE_ACCOUNT_NAME) {
    return { kind: "managedIdentity", accountName: value.AZURE_STORAGE_ACCOUNT_NAME };
  }

  throw new Error(
    "Storage接続設定がありません(AZURE_STORAGE_CONNECTION_STRING または AZURE_STORAGE_ACCOUNT_NAME が必要です)",
  );
}

export function createBlobServiceClient(
  config: StorageConnectionConfig,
): BlobServiceClient {
  if (config.kind === "connectionString") {
    return BlobServiceClient.fromConnectionString(config.connectionString);
  }

  return new BlobServiceClient(
    `https://${config.accountName}.blob.core.windows.net`,
    new DefaultAzureCredential(),
  );
}

export function createQueueServiceClient(
  config: StorageConnectionConfig,
): QueueServiceClient {
  if (config.kind === "connectionString") {
    return QueueServiceClient.fromConnectionString(config.connectionString);
  }

  return new QueueServiceClient(
    `https://${config.accountName}.queue.core.windows.net`,
    new DefaultAzureCredential(),
  );
}

export function getDocumentsContainerClient(
  blobServiceClient: BlobServiceClient,
  containerName: string,
): ContainerClient {
  return blobServiceClient.getContainerClient(containerName);
}

export function getPreviewQueueClient(
  queueServiceClient: QueueServiceClient,
  queueName: string,
): QueueClient {
  return queueServiceClient.getQueueClient(queueName);
}

// --- Blobキー導出(設計 §7.3) ---

/** 資料IDから決定的にBlobキーを導出する前提のUUID検証。パストラバーサル・
 * インジェクション対策として、`../`や`/`を含む値はここで拒否される
 * (`z.uuid()`は正規のUUID文字列だけを許可する)。 */
const documentIdSchema = z.uuid();

export class InvalidDocumentIdError extends Error {
  constructor() {
    super("資料IDの形式が不正です");
    this.name = "InvalidDocumentIdError";
  }
}

function assertDocumentId(documentId: string): string {
  const result = documentIdSchema.safeParse(documentId);
  if (!result.success) {
    throw new InvalidDocumentIdError();
  }
  return result.data;
}

/** 非公開HTMLのBlobキー(設計 §7.3)。DBへは保存しない。 */
export function documentHtmlBlobKey(documentId: string): string {
  return `html/${assertDocumentId(documentId)}/document.html`;
}

/** プレビュー画像のBlobキー(設計 §7.3)。DBへは保存しない。 */
export function documentPreviewBlobKey(documentId: string): string {
  return `preview/${assertDocumentId(documentId)}/preview.jpg`;
}

/** HTML保存時に固定で使う`Content-Type`。利用者由来の値は使わない。 */
export const HTML_BLOB_CONTENT_TYPE = "text/html; charset=utf-8";
/** プレビュー画像保存時に固定で使う`Content-Type`。 */
export const PREVIEW_BLOB_CONTENT_TYPE = "image/jpeg";

// --- Blob操作 ---

async function uploadBlob(
  containerClient: ContainerClient,
  blobKey: string,
  content: Buffer,
  contentType: string,
  options?: StorageOperationOptions,
): Promise<void> {
  const blockBlobClient = containerClient.getBlockBlobClient(blobKey);
  await blockBlobClient.uploadData(content, {
    abortSignal: abortSignalFor(options),
    blobHTTPHeaders: { blobContentType: contentType },
  });
}

async function streamToBuffer(
  readable: NodeJS.ReadableStream | undefined,
): Promise<Buffer> {
  if (!readable) {
    return Buffer.alloc(0);
  }

  const chunks: Buffer[] = [];
  for await (const chunk of readable) {
    chunks.push(
      typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer),
    );
  }
  return Buffer.concat(chunks);
}

async function downloadBlob(
  containerClient: ContainerClient,
  blobKey: string,
  options?: StorageOperationOptions,
): Promise<Buffer> {
  const blobClient = containerClient.getBlobClient(blobKey);
  const response = await blobClient.download(undefined, undefined, {
    abortSignal: abortSignalFor(options),
  });
  return streamToBuffer(response.readableStreamBody);
}

async function deleteBlob(
  containerClient: ContainerClient,
  blobKey: string,
  options?: StorageOperationOptions,
): Promise<void> {
  const blobClient = containerClient.getBlobClient(blobKey);
  // 冪等: 既に存在しないBlobを削除しても失敗させない。
  await blobClient.deleteIfExists({ abortSignal: abortSignalFor(options) });
}

export async function uploadDocumentHtml(
  containerClient: ContainerClient,
  documentId: string,
  html: Buffer,
  options?: StorageOperationOptions,
): Promise<void> {
  await uploadBlob(
    containerClient,
    documentHtmlBlobKey(documentId),
    html,
    HTML_BLOB_CONTENT_TYPE,
    options,
  );
}

export async function downloadDocumentHtml(
  containerClient: ContainerClient,
  documentId: string,
  options?: StorageOperationOptions,
): Promise<Buffer> {
  return downloadBlob(containerClient, documentHtmlBlobKey(documentId), options);
}

export async function deleteDocumentHtml(
  containerClient: ContainerClient,
  documentId: string,
  options?: StorageOperationOptions,
): Promise<void> {
  await deleteBlob(containerClient, documentHtmlBlobKey(documentId), options);
}

export async function uploadDocumentPreview(
  containerClient: ContainerClient,
  documentId: string,
  jpeg: Buffer,
  options?: StorageOperationOptions,
): Promise<void> {
  await uploadBlob(
    containerClient,
    documentPreviewBlobKey(documentId),
    jpeg,
    PREVIEW_BLOB_CONTENT_TYPE,
    options,
  );
}

export async function downloadDocumentPreview(
  containerClient: ContainerClient,
  documentId: string,
  options?: StorageOperationOptions,
): Promise<Buffer> {
  return downloadBlob(
    containerClient,
    documentPreviewBlobKey(documentId),
    options,
  );
}

export async function deleteDocumentPreview(
  containerClient: ContainerClient,
  documentId: string,
  options?: StorageOperationOptions,
): Promise<void> {
  await deleteBlob(containerClient, documentPreviewBlobKey(documentId), options);
}

// --- Storage Queue(設計 §7.5) ---

/** 現時点で発行するQueueメッセージのschema version。増分は後方非互換の変更時のみ。 */
export const PREVIEW_QUEUE_SCHEMA_VERSION = 1;

/**
 * プレビュー生成メッセージ(設計 §7.5「`schemaVersion`と`documentId`だけを含む」)。
 * `.strict()`で未知フィールドを拒否する。
 */
export const previewQueueMessageSchema = z
  .object({
    schemaVersion: z.literal(PREVIEW_QUEUE_SCHEMA_VERSION),
    documentId: z.uuid(),
  })
  .strict();

export type PreviewQueueMessage = z.infer<typeof previewQueueMessageSchema>;

export class InvalidQueueMessageError extends Error {
  constructor() {
    super("Queueメッセージの形式が不正です");
    this.name = "InvalidQueueMessageError";
  }
}

/**
 * メッセージ本文はStorage Queueの予約文字(XML)を避けるためbase64で送る
 * (Azure Storage Queueのbase64エンコード方針、公式クライアントの標準的な使い方)。
 */
export function encodePreviewQueueMessage(documentId: string): string {
  const message = previewQueueMessageSchema.parse({
    schemaVersion: PREVIEW_QUEUE_SCHEMA_VERSION,
    documentId,
  });
  return Buffer.from(JSON.stringify(message), "utf8").toString("base64");
}

/**
 * 受信したQueueメッセージ本文を検証する。未知フィールド・不正な`schemaVersion`・
 * 不正な`documentId`はすべて`InvalidQueueMessageError`として拒否する
 * (恒久失敗として扱えるよう、呼び出し側で分類できる専用の例外にする)。
 */
export function parsePreviewQueueMessage(messageText: string): PreviewQueueMessage {
  let decoded: string;
  try {
    decoded = Buffer.from(messageText, "base64").toString("utf8");
  } catch {
    throw new InvalidQueueMessageError();
  }

  let json: unknown;
  try {
    json = JSON.parse(decoded);
  } catch {
    throw new InvalidQueueMessageError();
  }

  const result = previewQueueMessageSchema.safeParse(json);
  if (!result.success) {
    throw new InvalidQueueMessageError();
  }
  return result.data;
}

export interface SendPreviewQueueMessageOptions extends StorageOperationOptions {
  /** メッセージのtime-to-live(秒)。既定はStorage Queueの既定値(7日)。 */
  messageTimeToLiveSeconds?: number;
}

export async function sendPreviewGenerationMessage(
  queueClient: QueueClient,
  documentId: string,
  options?: SendPreviewQueueMessageOptions,
): Promise<void> {
  const messageText = encodePreviewQueueMessage(documentId);
  await queueClient.sendMessage(messageText, {
    abortSignal: abortSignalFor(options),
    ...(options?.messageTimeToLiveSeconds !== undefined
      ? { messageTimeToLive: options.messageTimeToLiveSeconds }
      : {}),
  });
}

export interface ReceivePreviewQueueMessagesOptions extends StorageOperationOptions {
  /** 既定は`DEFAULT_QUEUE_VISIBILITY_TIMEOUT_SECONDS`(設計 §7.5の60秒)。 */
  visibilityTimeoutSeconds?: number;
  /** 既定は1件(設計 §7.5「1実行で1メッセージだけを処理する」)。 */
  numberOfMessages?: number;
}

export interface ReceivedPreviewQueueMessage {
  messageId: string;
  popReceipt: string;
  /** `dequeueCount`(設計 §7.5「最大3回」の判定に使う)。 */
  dequeueCount: number;
  /** 検証済みのメッセージ本文。不正な本文は`InvalidQueueMessageError`を投げる。 */
  message: PreviewQueueMessage;
}

/**
 * Queueからメッセージを受信し、検証済みの形へ変換して返す。不正な本文は
 * 例外にするため、呼び出し側(Preview Job)は個別メッセージ単位で恒久失敗として
 * 扱える。visibility timeoutは既定60秒(設計 §7.5)。
 */
export async function receivePreviewGenerationMessages(
  queueClient: QueueClient,
  options?: ReceivePreviewQueueMessagesOptions,
): Promise<ReceivedPreviewQueueMessage[]> {
  const response = await queueClient.receiveMessages({
    abortSignal: abortSignalFor(options),
    visibilityTimeout:
      options?.visibilityTimeoutSeconds ??
      DEFAULT_QUEUE_VISIBILITY_TIMEOUT_SECONDS,
    ...(options?.numberOfMessages !== undefined
      ? { numberOfMessages: options.numberOfMessages }
      : {}),
  });

  return response.receivedMessageItems.map((item) => ({
    messageId: item.messageId,
    popReceipt: item.popReceipt,
    dequeueCount: item.dequeueCount,
    message: parsePreviewQueueMessage(item.messageText),
  }));
}

/**
 * 処理済みメッセージを削除する。既に削除済み・存在しないメッセージへの呼び出しは
 * 冪等に扱い、"MessageNotFound"は成功として扱う(重複配信・重複削除への耐性)。
 */
export async function deletePreviewGenerationMessage(
  queueClient: QueueClient,
  messageId: string,
  popReceipt: string,
  options?: StorageOperationOptions,
): Promise<void> {
  try {
    await queueClient.deleteMessage(messageId, popReceipt, {
      abortSignal: abortSignalFor(options),
    });
  } catch (error) {
    if (isMessageNotFoundError(error)) {
      return;
    }
    throw error;
  }
}

function isMessageNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "statusCode" in error &&
    (error as { statusCode?: unknown }).statusCode === 404
  );
}
