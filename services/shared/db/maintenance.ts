/**
 * 定期保守Job(設計 §7.7, §16)が使うDB操作のrepository。
 *
 * `documents`・`audit_events`・`upload_attempts`の**削除**を扱う唯一のモジュール。
 * Web・Display・Previewが使う`documents.ts`・`audit-events.ts`にはDELETEを行う関数を
 * 置かず(監査の追記専用性、設計 §12.2)、保守Jobだけがこのモジュールを読み込む。
 * DB側でも、runtime roleにはDELETEをGRANTせず、`audit_events`のtriggerが保持期間
 * 経過後かつ保守roleからのDELETEだけを通す
 * (migrations/1789280690379_add-maintenance-role-and-purge-support.sql)。
 *
 * 他のrepositoryと同じく、SQLはこのファイルの中だけに置き、値はプレースホルダーで
 * 渡す。環境変数もPoolも持たず、`executor`を必ず引数で受け取る(Q-005の集約方針)。
 *
 * 大量データでもメモリを使い切らないよう、抽出・削除はすべて`limit`付きのバッチで
 * 行う。呼び出し側(`services/maintenance/job.ts`)が戻り値の件数を見て繰り返す。
 */
import { z } from "zod";
import type { Queryable } from "./pool.js";

/**
 * 保持期間(設計 §16「削除済み最小メタデータと監査履歴は1年間保持する」)。
 *
 * 監査側はDBの`retain_until`(`occurred_at + INTERVAL '1 year'`、
 * migrations/1789169486387)が正本で、資料メタデータ側はこの定数で判定する。
 * 環境変数では短くできないようにする(保持期間の取り違えで監査を早く消さない)。
 */
export const METADATA_RETENTION_INTERVAL = "1 year";

/** バッチ件数の上限。1回のSQLが際限なく行をロックしないようにする。 */
const batchLimitSchema = z.number().int().min(1).max(5_000);

/** Blob削除の再試行対象(設計 §10.4(5), §7.7)。 */
export type BlobCleanupCandidate = {
  documentId: string;
  /**
   * 削除日時。keyset cursorに使うため、Dateではなく**DBが返した文字列のまま**扱う。
   * PostgreSQLの`timestamptz`はmicrosecond精度だが、JavaScriptの`Date`は
   * millisecond精度しか持たない。Dateへ変換してから比較値として渡すと精度が落ち、
   * 同じmillisecond内に削除された資料が次のバッチにも現れて同じ行を処理し続ける
   * (削除に失敗し続ける資料があると無限ループになる)。
   */
  deletedAt: string;
};

/** keyset順に次のバッチを取り出すための位置。 */
export type BlobCleanupCursor = {
  deletedAt: string;
  documentId: string;
};

type BlobCleanupRow = { id: string; deleted_at: string };

/**
 * `blob_cleanup_pending = true`の削除済み資料を`(deleted_at, id)`順に取り出す。
 *
 * offsetではなくkeyset(`after`)で進める。Blob削除に失敗した資料はフラグが
 * 下りないまま残るため、offsetや「常に先頭から」方式だと同じ資料を何度も掴んで
 * 後続の資料へ進めなくなる(1件の恒久的な失敗が他の資料の再試行を止めない)。
 */
export async function listBlobCleanupPendingDocuments(
  options: { limit: number; after?: BlobCleanupCursor | null },
  executor: Queryable,
): Promise<BlobCleanupCandidate[]> {
  const limit = batchLimitSchema.parse(options.limit);
  const after = options.after ?? null;

  const result = await executor.query<BlobCleanupRow>(
    `SELECT id, deleted_at::text AS deleted_at
       FROM documents
      WHERE blob_cleanup_pending = true
        AND status = 'deleted'
        AND deleted_at IS NOT NULL
        AND ($1::timestamptz IS NULL
             OR (deleted_at, id) > ($1::timestamptz, $2::uuid))
      ORDER BY deleted_at, id
      LIMIT $3`,
    [after?.deletedAt ?? null, after?.documentId ?? null, limit],
  );

  return result.rows.map((row) => ({
    documentId: row.id,
    deletedAt: row.deleted_at,
  }));
}

/**
 * 保持期間(1年)を過ぎた監査イベントを削除する(設計 §16「1年経過後の個人識別情報を
 * 自動削除する」)。
 *
 * 削除できるのは`retain_until <= now()`の行だけで、この条件はDBのtriggerでも
 * 二重に強制される(条件を満たさない行を混ぜるとDB側で例外になる)。
 * 戻り値は削除件数で、`limit`と同数なら続きがある。
 */
export async function purgeExpiredAuditEvents(
  options: { limit: number },
  executor: Queryable,
): Promise<number> {
  const limit = batchLimitSchema.parse(options.limit);

  const result = await executor.query(
    `DELETE FROM audit_events
      WHERE id IN (SELECT id
                     FROM audit_events
                    WHERE retain_until <= now()
                    ORDER BY retain_until
                    LIMIT $1)`,
    [limit],
  );

  return result.rowCount ?? 0;
}

/**
 * 保持期間(1年)を過ぎた削除済み資料の最小メタデータを削除する(設計 §7.7, §16)。
 *
 * 次の3条件をすべて満たす行だけを対象にする。
 *
 *   - `status = 'deleted'`かつ`deleted_at`が1年以上前
 *   - `blob_cleanup_pending = false`
 *     (設計 §7.7「Blob削除が完了していない資料メタデータはpurgeしない」。
 *      purgeするとBlobキーを導出する資料IDが失われ、回収経路が無くなる)
 *   - 参照している監査イベントが1件も残っていない
 *     (`audit_events.document_id`のFKはON DELETE指定なし。監査が残っている資料を
 *      消そうとするとFK違反でバッチ全体が失敗する。監査は自身の`retain_until`で
 *      先にpurgeされるため、次回以降の実行で対象になる)
 */
export async function purgeExpiredDocuments(
  options: { limit: number },
  executor: Queryable,
): Promise<number> {
  const limit = batchLimitSchema.parse(options.limit);

  const result = await executor.query(
    `DELETE FROM documents
      WHERE id IN (SELECT d.id
                     FROM documents d
                    WHERE d.status = 'deleted'
                      AND d.blob_cleanup_pending = false
                      AND d.deleted_at IS NOT NULL
                      AND d.deleted_at <= now() - INTERVAL '${METADATA_RETENTION_INTERVAL}'
                      AND NOT EXISTS (SELECT 1
                                        FROM audit_events a
                                       WHERE a.document_id = d.id)
                    ORDER BY d.deleted_at
                    LIMIT $1)`,
    [limit],
  );

  return result.rowCount ?? 0;
}

/**
 * 役目を終えた`upload_attempts`の行を削除する(Q-011)。
 *
 * 削除してよいのは、頻度判定の窓(直近1分)にも同時実行判定(未解放のlease)にも
 * 二度と使われない行だけ。判定に使う3つの時刻(`started_at`・`expires_at`・
 * `finished_at`)がすべて保持期間より古い行に限る。`expires_at > started_at`は
 * CHECK制約で保証されているため、条件は`expires_at`と`finished_at`で表現できる。
 *
 * 早く消しすぎると頻度・同時実行の上限(設計 §6.1)をすり抜けられるため、
 * 保持期間は判定窓(1分)・lease(120秒)より十分長い値を呼び出し側が渡す。
 */
export async function purgeOldUploadAttempts(
  options: { retentionSeconds: number; limit: number },
  executor: Queryable,
): Promise<number> {
  const limit = batchLimitSchema.parse(options.limit);
  const retentionSeconds = z
    .number()
    .int()
    // 判定窓(60秒)・lease(120秒)より短い保持期間は事故のもとなので受け付けない。
    .min(3_600)
    .parse(options.retentionSeconds);

  const result = await executor.query(
    `DELETE FROM upload_attempts
      WHERE id IN (SELECT id
                     FROM upload_attempts
                    WHERE expires_at < now() - make_interval(secs => $1)
                      AND (finished_at IS NULL
                           OR finished_at < now() - make_interval(secs => $1))
                    ORDER BY expires_at
                    LIMIT $2)`,
    [retentionSeconds, limit],
  );

  return result.rowCount ?? 0;
}

/**
 * 渡した資料IDのうち、`documents`に行が存在するものを返す(孤児Blobの判定用)。
 *
 * `status`は問わない。削除済み(soft delete)の資料もBlob削除の再試行対象として
 * 資料IDから回収できるため、孤児ではない。UUIDでない値は渡す前に落とす。
 */
export async function findExistingDocumentIds(
  documentIds: readonly string[],
  executor: Queryable,
): Promise<Set<string>> {
  const validIds = documentIds.filter(
    (documentId) => z.uuid().safeParse(documentId).success,
  );

  if (validIds.length === 0) {
    return new Set();
  }

  const result = await executor.query<{ id: string }>(
    `SELECT id FROM documents WHERE id = ANY($1::uuid[])`,
    [validIds],
  );

  return new Set(result.rows.map((row) => row.id));
}
