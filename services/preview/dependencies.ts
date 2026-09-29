/**
 * Preview Jobの外部I/O(Storage Queue・Blob Storage・PostgreSQL・Chromium)の組み立て。
 *
 * 設計: docs/APPLICATION_DESIGN.md §7.3, §7.4, §7.5, §15.1
 *
 * `worker.ts`(処理手順)から外部クライアントを切り離し、結合テストでも本番と同じ
 * 経路(実際のPostgreSQL・Azurite)を通せるようにする(Displayの`dependencies.ts`と
 * 同じ構成)。
 *
 * - Blob/Queue操作は`services/shared/storage.ts`の実処理を使い、すべてtimeout付き。
 * - Blobキーは資料IDから決定的に導出し、DBへ保存しない(設計 §7.3)。
 * - プレビュー状態の更新と監査は同じトランザクションで保存する(設計 §15.1)。
 */
import { randomUUID } from "node:crypto";
import type { ContainerClient } from "@azure/storage-blob";
import type { QueueClient } from "@azure/storage-queue";
import type { Pool } from "pg";
import {
  insertAuditEvent,
  searchAuditEvents,
} from "../shared/db/audit-events.js";
import {
  findDocumentById,
  updateDocumentPreviewStatus,
} from "../shared/db/documents.js";
import type { Queryable } from "../shared/db/pool.js";
import { createDatabasePool, withTransactionOn } from "../shared/db/pool.js";
import { createOperationLogger, type OperationLogger } from "../shared/log.js";
import {
  createBlobServiceClient,
  createQueueServiceClient,
  deleteDocumentPreview,
  deletePreviewGenerationMessage,
  downloadDocumentHtml,
  getDocumentsContainerClient,
  getPreviewQueueClient,
  receivePreviewGenerationEnvelopes,
  resolveStorageConnectionConfig,
  uploadDocumentPreview,
} from "../shared/storage.js";
import { capturePreviewJpeg } from "./capture.js";
import type { PreviewEnvironment } from "./env.js";
import type {
  PreviewWorkerDependencies,
  RecordPreviewResultInput,
} from "./worker.js";

/** Preview Jobの接続をDB側で識別するための`application_name`(設計 §7.4)。 */
export const PREVIEW_APPLICATION_NAME = "siryou-mite-preview";

/** Blob取得・保存のtimeout(ms)。処理上限(既定30秒)に収まる値にする。 */
export const PREVIEW_BLOB_TIMEOUT_MS = 10_000;

/** Queue受信・削除のtimeout(ms)。 */
export const PREVIEW_QUEUE_TIMEOUT_MS = 10_000;

/**
 * プレビュー生成の監査に使う`action`(設計 §12.2のenum)。
 *
 * プレビュー生成はアップロード処理の続き(設計 §10.1(9), §10.2)であり、
 * `upload`として記録する。`admin_operation`は管理画面の操作に取っておく。
 */
export const PREVIEW_AUDIT_ACTION = "upload" as const;

export type PreviewRuntime = {
  dependencies: PreviewWorkerDependencies;
  /** 実行終了時に接続を閉じる。 */
  close(): Promise<void>;
};

export type PreviewRuntimeOverrides = {
  /**
   * 撮影処理。省略時はPlaywright + Chromium。結合テストではChromiumを起動せずに
   * 前後の手順(Queue・DB・Blob)を検証するために差し替える。
   */
  capturePreview?: (html: Buffer, signal: AbortSignal) => Promise<Buffer>;
};

export function createPreviewRuntime(
  env: PreviewEnvironment,
  overrides: PreviewRuntimeOverrides = {},
): PreviewRuntime {
  const pool: Pool = createDatabasePool({
    connectionString: env.DATABASE_URL,
    applicationName: PREVIEW_APPLICATION_NAME,
    // 本番(Azure Database for PostgreSQL)はTLS必須。証明書検証は無効化しない。
    requireTls: env.NODE_ENV === "production",
  });

  const storageConfig = resolveStorageConnectionConfig(env);
  const containerClient: ContainerClient = getDocumentsContainerClient(
    createBlobServiceClient(storageConfig),
    env.AZURE_STORAGE_CONTAINER,
  );
  const queueClient: QueueClient = getPreviewQueueClient(
    createQueueServiceClient(storageConfig),
    env.AZURE_STORAGE_QUEUE_NAME,
  );

  const logger: OperationLogger = createOperationLogger(env.LOG_HMAC_KEY);

  const dependencies: PreviewWorkerDependencies = {
    maxDequeueCount: env.QUEUE_MAX_DEQUEUE_COUNT,
    processingTimeoutMs: env.QUEUE_MESSAGE_PROCESSING_TIMEOUT_SECONDS * 1_000,
    logger,
    newCorrelationId: () => randomUUID(),

    async receiveMessage() {
      const [envelope] = await receivePreviewGenerationEnvelopes(queueClient, {
        // 設計 §7.5「1実行で1メッセージだけを処理する」。
        numberOfMessages: 1,
        visibilityTimeoutSeconds: env.QUEUE_VISIBILITY_TIMEOUT_SECONDS,
        timeoutMs: PREVIEW_QUEUE_TIMEOUT_MS,
      });
      return envelope ?? null;
    },

    async deleteMessage(envelope, signal) {
      await deletePreviewGenerationMessage(
        queueClient,
        envelope.messageId,
        envelope.popReceipt,
        {
          timeoutMs: PREVIEW_QUEUE_TIMEOUT_MS,
          ...(signal ? { abortSignal: signal } : {}),
        },
      );
    },

    // DB呼び出しには`abortSignal`を渡さない。`pg`はsignalでの中止に対応しておらず、
    // 打ち切りはpool設定の`statement_timeout`・`query_timeout`(設計 §14)で行う。
    // 処理上限のsignalは`worker.ts`の`step`が呼び出し**前**に判定する。
    async findDocument(documentId) {
      const document = await findDocumentById(documentId, pool);
      if (!document) {
        return null;
      }
      return {
        isActive: document.status === "active",
        previewStatus: document.previewStatus,
      };
    },

    async fetchHtml(documentId, signal) {
      return downloadDocumentHtml(containerClient, documentId, {
        timeoutMs: PREVIEW_BLOB_TIMEOUT_MS,
        abortSignal: signal,
      });
    },

    capturePreview:
      overrides.capturePreview ??
      ((html: Buffer, signal: AbortSignal) =>
        // HTMLはアップロード時にUTF-8として検証済み(設計 §6.1)。
        capturePreviewJpeg(html.toString("utf8"), {
          maxBytes: env.MAX_PREVIEW_IMAGE_BYTES,
          // 処理上限を超えたらChromiumを閉じて撮影を打ち切る(設計 §7.5)。
          signal,
        })),

    async savePreview(documentId, jpeg, signal) {
      await uploadDocumentPreview(containerClient, documentId, jpeg, {
        timeoutMs: PREVIEW_BLOB_TIMEOUT_MS,
        abortSignal: signal,
      });
    },

    async discardPreview(documentId, signal) {
      await deleteDocumentPreview(containerClient, documentId, {
        timeoutMs: PREVIEW_BLOB_TIMEOUT_MS,
        ...(signal ? { abortSignal: signal } : {}),
      });
    },

    async recordPreviewResult(input) {
      return withTransactionOn(pool, async (tx) =>
        savePreviewStatusWithAudit(tx, input, logger),
      );
    },
  };

  return {
    dependencies,
    async close() {
      await pool.end();
    },
  };
}

/**
 * プレビュー状態を更新し、同じトランザクションで監査を保存する(設計 §15.1)。
 *
 * 更新対象が無い場合は監査を残さずに`false`を返す。削除済み資料は`preview_status`が
 * NULLへ消去済みで、プレビューの成否を記録する意味が無い。`failed`は
 * `preview_status = 'pending'`の資料にだけ書けるため(`updateDocumentPreviewStatus`)、
 * 別の配信で既に`ready`・`failed`が確定している資料でも`false`になり、確定した状態と
 * 監査を後続の配信が上書きしない(設計 §7.5の冪等性、§11.1)。
 */
async function savePreviewStatusWithAudit(
  tx: Queryable,
  input: RecordPreviewResultInput,
  logger: OperationLogger,
): Promise<boolean> {
  const updated = await updateDocumentPreviewStatus(
    { documentId: input.documentId, previewStatus: input.previewStatus },
    tx,
  );

  if (!updated) {
    return false;
  }

  const actor = await resolveAuditActor(tx, input.documentId);
  if (!actor) {
    // 監査の`actor_subject_id`・`actor_tenant_id`はNOT NULLで、ワーカーには
    // 操作者がいない。アップロード監査(同一トランザクションで必ず保存される)が
    // 見つからないのは想定外のため、監査は作らずに状態更新だけを確定させ、
    // 運用ログへ分類だけを残す。
    logger.logOperationEvent({
      event: "preview_audit_actor_unresolved",
      correlationId: input.correlationId,
      result: "failed",
      errorCategory: "database_failed",
      documentId: input.documentId,
    });
    return true;
  }

  await insertAuditEvent(
    {
      action: PREVIEW_AUDIT_ACTION,
      result: input.previewStatus === "ready" ? "success" : "failed",
      documentId: input.documentId,
      actorSubjectId: actor.actorSubjectId,
      actorTenantId: actor.actorTenantId,
      // ワーカーは利用者の個人データを扱わないため、メールアドレス・所属・
      // App Roleは残さない(設計 §12.2の最小化)。
      actorEmailAtEvent: null,
      actorGroupValues: null,
      actorRoles: null,
      correlationId: input.correlationId,
      errorCategory: input.errorCategory,
    },
    tx,
  );

  return true;
}

/**
 * 監査に記録する操作者を決める。
 *
 * プレビュー生成は利用者の操作ではなくJobの処理だが、`audit_events`は
 * `actor_subject_id`・`actor_tenant_id`がNOT NULL(設計 §12.2)。同じ資料の
 * アップロード監査(同一トランザクションで必ず保存される、設計 §15.1)から
 * 資料の所有者とtenantを引き継ぎ、アップロードの続きとして記録する。
 *
 * 2回目以降はこの検索がプレビュー生成自身の監査行(同じ`action`・`result`)に
 * 当たることがあるが、その行の`actor_subject_id`・`actor_tenant_id`は
 * アップロード監査から引き継いだ同じ値であり、結果は変わらない。
 */
async function resolveAuditActor(
  tx: Queryable,
  documentId: string,
): Promise<{ actorSubjectId: string; actorTenantId: string } | null> {
  const page = await searchAuditEvents(
    {
      documentId,
      action: PREVIEW_AUDIT_ACTION,
      result: "success",
      limit: 1,
    },
    tx,
  );

  const uploadEvent = page.events[0];
  if (!uploadEvent) {
    return null;
  }

  return {
    actorSubjectId: uploadEvent.actorSubjectId,
    actorTenantId: uploadEvent.actorTenantId,
  };
}
