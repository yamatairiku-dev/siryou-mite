/**
 * Maintenance Jobの外部I/O(PostgreSQL・Blob Storage)の組み立て。
 *
 * 設計: docs/APPLICATION_DESIGN.md §7.3, §7.4, §7.7, §16
 *
 * `job.ts`(処理手順)から外部クライアントを切り離し、結合テストでも本番と同じ経路
 * (実際のPostgreSQL・Azurite)を通せるようにする(Preview Jobの`dependencies.ts`と
 * 同じ構成)。
 *
 * - DB操作は`services/shared/db/maintenance.ts`(purge専用のSQL)と
 *   `documents.ts`の`markBlobCleanupCompleted`を使う。
 * - Blob操作は`services/shared/storage.ts`の実処理を使い、すべてtimeout付き。
 *   Blobキーは資料IDから決定的に導出する(設計 §7.3)。
 * - 保守Jobは監査を書かない。purgeは設計 §16が定める保持期間経過後の自動削除で、
 *   監査を書くとその監査自体が新たな1年の保持対象になり永久に残る。実行結果は
 *   件数つきの運用ログ(`log.ts`)で残す(設計 §15.2, §17)。
 * - DB接続は保守Job専用のManaged Identity・DB role
 *   (`siryou_mite_maintenance`)で行う前提(設計 §7.4)。
 */
import { randomUUID } from "node:crypto";
import type { ContainerClient } from "@azure/storage-blob";
import type { Pool } from "pg";
import { markBlobCleanupCompleted } from "../shared/db/documents.js";
import {
  findExistingDocumentIds,
  listBlobCleanupPendingDocuments,
  purgeExpiredAuditEvents,
  purgeExpiredDocuments,
  purgeOldUploadAttempts,
} from "../shared/db/maintenance.js";
import { createDatabasePool } from "../shared/db/pool.js";
import { createOperationLogger, type OperationLogger } from "../shared/log.js";
import {
  createBlobServiceClient,
  deleteDocumentHtml,
  deleteDocumentPreview,
  getDocumentsContainerClient,
  listBlobsByPrefix,
  resolveStorageConnectionConfig,
} from "../shared/storage.js";
import type { MaintenanceEnvironment } from "./env.js";
import type { MaintenanceJobDependencies } from "./job.js";
import { createMaintenanceSummaryLogger } from "./log.js";

/** Maintenance Jobの接続をDB側で識別するための`application_name`(設計 §7.4)。 */
export const MAINTENANCE_APPLICATION_NAME = "siryou-mite-maintenance";

/** Blob操作1回あたりのtimeout(ms)。 */
export const MAINTENANCE_BLOB_TIMEOUT_MS = 10_000;

export type MaintenanceRuntime = {
  dependencies: MaintenanceJobDependencies;
  /** 実行終了時に接続を閉じる。 */
  close(): Promise<void>;
};

export function createMaintenanceRuntime(
  env: MaintenanceEnvironment,
): MaintenanceRuntime {
  const pool: Pool = createDatabasePool({
    connectionString: env.DATABASE_URL,
    applicationName: MAINTENANCE_APPLICATION_NAME,
    // 本番(Azure Database for PostgreSQL)はTLS必須。証明書検証は無効化しない。
    requireTls: env.NODE_ENV === "production",
  });

  const containerClient: ContainerClient = getDocumentsContainerClient(
    createBlobServiceClient(resolveStorageConnectionConfig(env)),
    env.AZURE_STORAGE_CONTAINER,
  );

  const logger: OperationLogger = createOperationLogger(env.LOG_HMAC_KEY);

  const dependencies: MaintenanceJobDependencies = {
    logger,
    logTaskSummary: createMaintenanceSummaryLogger(),
    newCorrelationId: () => randomUUID(),
    batchSize: env.MAINTENANCE_BATCH_SIZE,
    blobListPageSize: env.MAINTENANCE_BLOB_LIST_PAGE_SIZE,
    orphanBlobGraceMs: env.MAINTENANCE_ORPHAN_BLOB_GRACE_HOURS * 3_600_000,
    uploadAttemptRetentionSeconds:
      env.MAINTENANCE_UPLOAD_ATTEMPT_RETENTION_DAYS * 24 * 3_600,

    // DB呼び出しには`abortSignal`を渡さない。`pg`はsignalでの中止に対応しておらず、
    // 打ち切りはpool設定の`statement_timeout`・`query_timeout`(設計 §14)で行う。
    // Job実行上限のsignalは`job.ts`が呼び出し**前**に判定する。
    async listBlobCleanupPendingDocuments(after, limit) {
      return listBlobCleanupPendingDocuments({ limit, after }, pool);
    },

    async deleteDocumentBlobs(documentId, signal) {
      // 冪等: 既に存在しないBlobの削除も成功する(`deleteIfExists`)。
      // 両方成功した場合だけフラグを下ろすため、順に待ち合わせる。
      await deleteDocumentHtml(containerClient, documentId, {
        timeoutMs: MAINTENANCE_BLOB_TIMEOUT_MS,
        abortSignal: signal,
      });
      await deleteDocumentPreview(containerClient, documentId, {
        timeoutMs: MAINTENANCE_BLOB_TIMEOUT_MS,
        abortSignal: signal,
      });
    },

    async completeBlobCleanup(documentId) {
      return markBlobCleanupCompleted(documentId, pool);
    },

    async purgeExpiredAuditEvents(limit) {
      return purgeExpiredAuditEvents({ limit }, pool);
    },

    async purgeExpiredDocuments(limit) {
      return purgeExpiredDocuments({ limit }, pool);
    },

    async purgeOldUploadAttempts(retentionSeconds, limit) {
      return purgeOldUploadAttempts({ retentionSeconds, limit }, pool);
    },

    async listDocumentBlobs(prefix, continuationToken, pageSize, signal) {
      return listBlobsByPrefix(containerClient, prefix, {
        pageSize,
        continuationToken,
        timeoutMs: MAINTENANCE_BLOB_TIMEOUT_MS,
        abortSignal: signal,
      });
    },

    async findExistingDocumentIds(documentIds) {
      return findExistingDocumentIds(documentIds, pool);
    },

    async deleteOrphanBlob(blob, signal) {
      const options = {
        timeoutMs: MAINTENANCE_BLOB_TIMEOUT_MS,
        abortSignal: signal,
      };
      if (blob.kind === "html") {
        await deleteDocumentHtml(containerClient, blob.documentId, options);
        return;
      }
      await deleteDocumentPreview(containerClient, blob.documentId, options);
    },
  };

  return {
    dependencies,
    async close() {
      await pool.end();
    },
  };
}
