/**
 * Displayの外部I/O(PostgreSQL・Blob Storage)の組み立て(設計 §7.2, §7.3, §7.4)。
 *
 * `server.ts`(HTTP処理)から外部クライアントを切り離し、結合テストでも本番と
 * 同じ経路(実際のPostgreSQL・Azurite)を通せるようにする。
 *
 * - DBは`services/shared/db/`のrepositoryをそのまま使う(Webと同じSQL・同じZod
 *   schema)。閲覧監査は`documents`を更新しない単独INSERTのため、Poolを
 *   `Queryable`として渡して自動commitで保存する(設計 §15.1の「業務更新と監査を
 *   同じトランザクション」はupload・delete・管理操作の要件で、Displayは業務更新を
 *   行わない)。監査保存に失敗した場合は例外がそのまま伝播し、HTMLを返さない。
 * - Blob取得には`services/shared/storage.ts`の既定timeout(`abortSignal`)が効く。
 * - Blobキーは資料IDから決定的に導出し、DBへ保存しない(設計 §7.3)。
 */
import type { Pool } from "pg";
import { insertAuditEvent } from "../shared/db/audit-events.js";
import { findDocumentById } from "../shared/db/documents.js";
import { createDatabasePool } from "../shared/db/pool.js";
import { createOperationLogger } from "../shared/log.js";
import {
  createBlobServiceClient,
  downloadDocumentHtml,
  getDocumentsContainerClient,
  resolveStorageConnectionConfig,
} from "../shared/storage.js";
import { createDisplayGrantVerificationKeys } from "../shared/grant.js";
import type { DisplayEnvironment } from "./env.js";
import type { DisplayDependencies } from "./server.js";

/** Displayの接続をDB側で識別するための`application_name`(設計 §7.4の用途別identity)。 */
export const DISPLAY_APPLICATION_NAME = "siryou-mite-display";

/** Blob取得のtimeout(ms)。表示は利用者を待たせるため、既定より短くする。 */
export const DISPLAY_BLOB_TIMEOUT_MS = 5_000;

export type DisplayRuntime = {
  dependencies: DisplayDependencies;
  /** プロセス終了時に閉じる。 */
  close(): Promise<void>;
};

export function createDisplayRuntime(env: DisplayEnvironment): DisplayRuntime {
  const pool: Pool = createDatabasePool({
    connectionString: env.DATABASE_URL,
    applicationName: DISPLAY_APPLICATION_NAME,
    // 本番(Azure Database for PostgreSQL)はTLS必須。証明書検証は無効化しない。
    requireTls: env.NODE_ENV === "production",
  });

  const containerClient = getDocumentsContainerClient(
    createBlobServiceClient(resolveStorageConnectionConfig(env)),
    env.AZURE_STORAGE_CONTAINER,
  );

  const dependencies: DisplayDependencies = {
    appOrigin: env.APP_ORIGIN,
    maxPostBodyBytes: env.DISPLAY_MAX_POST_BODY_BYTES,
    grantMaxAgeSeconds: env.GRANT_MAX_AGE_SECONDS,
    verificationKeys: createDisplayGrantVerificationKeys(
      env.GRANT_VERIFICATION_KEYS,
    ),
    logger: createOperationLogger(env.LOG_HMAC_KEY),
    async isDocumentActive(documentId) {
      const document = await findDocumentById(documentId, pool);
      // 未存在と削除済みを区別しない(設計 §10.4)。
      return document?.status === "active";
    },
    async saveViewAudit(audit) {
      await insertAuditEvent(
        {
          action: "view",
          result: audit.result,
          documentId: audit.documentId,
          actorSubjectId: audit.actorSubjectId,
          actorTenantId: audit.actorTenantId,
          actorEmailAtEvent: audit.actorEmailAtEvent,
          // Displayはgrantに含まれる情報だけを保存する。所属・App Roleは
          // grantへ含めない(設計 §7.2)ため`null`のままにする。
          actorGroupValues: null,
          actorRoles: null,
          correlationId: audit.correlationId,
          errorCategory: audit.errorCategory,
        },
        pool,
      );
    },
    async fetchDocumentHtml(documentId) {
      return downloadDocumentHtml(containerClient, documentId, {
        timeoutMs: DISPLAY_BLOB_TIMEOUT_MS,
      });
    },
  };

  return {
    dependencies,
    async close() {
      await pool.end();
    },
  };
}
