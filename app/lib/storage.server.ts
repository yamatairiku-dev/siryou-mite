/**
 * Blob Storage / Storage QueueクライアントのWeb向け薄いラッパー(設計 §7.3, §7.5)。
 *
 * 実処理は`services/shared/storage.ts`に実装する(Blob/Queue操作をWeb・各serviceで
 * 重複させないため)。`services/`配下は`app/`をimportしない方針(docs/ARCHITECTURE.md、
 * T04 Q-005)だが、逆方向(`app/` → `services/shared/`)はこの制約に反しない。
 * このファイルはWeb固有の関心事、すなわち`app/lib/env.server.ts`(Zod検証済み
 * 環境変数)からBlobServiceClient・QueueServiceClientを組み立てて使い回す部分
 * だけを持つ。ドキュメント単位のBlob操作・Queueメッセージ検証などの純粋な処理は
 * `services/shared/storage.ts`をそのまま再エクスポートする。
 */
import type { BlobServiceClient, ContainerClient } from "@azure/storage-blob";
import type { QueueClient, QueueServiceClient } from "@azure/storage-queue";
import { env } from "~/lib/env.server";
import {
  createBlobServiceClient,
  createQueueServiceClient,
  getDocumentsContainerClient,
  getPreviewQueueClient,
  resolveStorageConnectionConfig,
} from "../../services/shared/storage";

export {
  DEFAULT_QUEUE_VISIBILITY_TIMEOUT_SECONDS,
  DEFAULT_STORAGE_OPERATION_TIMEOUT_MS,
  deleteDocumentHtml,
  deleteDocumentPreview,
  deletePreviewGenerationMessage,
  documentHtmlBlobKey,
  documentPreviewBlobKey,
  downloadDocumentHtml,
  downloadDocumentPreview,
  encodePreviewQueueMessage,
  HTML_BLOB_CONTENT_TYPE,
  InvalidDocumentIdError,
  InvalidQueueMessageError,
  parsePreviewQueueMessage,
  PREVIEW_BLOB_CONTENT_TYPE,
  PREVIEW_QUEUE_SCHEMA_VERSION,
  previewQueueMessageSchema,
  receivePreviewGenerationMessages,
  sendPreviewGenerationMessage,
  uploadDocumentHtml,
  uploadDocumentPreview,
} from "../../services/shared/storage";
export type {
  PreviewQueueMessage,
  ReceivedPreviewQueueMessage,
  ReceivePreviewQueueMessagesOptions,
  SendPreviewQueueMessageOptions,
  StorageConnectionConfig,
  StorageOperationOptions,
} from "../../services/shared/storage";

let cachedBlobServiceClient: BlobServiceClient | undefined;
let cachedQueueServiceClient: QueueServiceClient | undefined;

function getBlobServiceClientSingleton(): BlobServiceClient {
  if (!cachedBlobServiceClient) {
    cachedBlobServiceClient = createBlobServiceClient(
      resolveStorageConnectionConfig(env),
    );
  }
  return cachedBlobServiceClient;
}

function getQueueServiceClientSingleton(): QueueServiceClient {
  if (!cachedQueueServiceClient) {
    cachedQueueServiceClient = createQueueServiceClient(
      resolveStorageConnectionConfig(env),
    );
  }
  return cachedQueueServiceClient;
}

/** 資料HTML・プレビュー画像を保存するcontainerのclient(設計 §7.3)。 */
export function getDocumentsContainerClientForWeb(): ContainerClient {
  return getDocumentsContainerClient(
    getBlobServiceClientSingleton(),
    env.AZURE_STORAGE_CONTAINER,
  );
}

/** プレビュー生成メッセージを送るqueueのclient(設計 §7.5)。 */
export function getPreviewQueueClientForWeb(): QueueClient {
  return getPreviewQueueClient(
    getQueueServiceClientSingleton(),
    env.AZURE_STORAGE_QUEUE_NAME,
  );
}

/** テスト後片付け用。プロセス内で使い回すclientのキャッシュを破棄する。 */
export function resetStorageClientsForTest(): void {
  cachedBlobServiceClient = undefined;
  cachedQueueServiceClient = undefined;
}
