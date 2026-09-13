/**
 * Maintenance Job(定期保守ジョブ)の処理本体。
 *
 * 設計: docs/APPLICATION_DESIGN.md §7.7, §10.4, §15.2, §16
 *
 * 1回の実行で次の5つの処理を順に行う。外部I/O(DB・Blob)はすべて
 * `MaintenanceJobDependencies`として受け取り、このmoduleは手順と判定だけを持つ
 * (`services/preview/worker.ts`と同じ構成)。
 *
 *   1. `blob_cleanup_pending`の再試行(設計 §7.7, §10.4(5))
 *   2. 保持期間(1年)を過ぎた監査履歴のpurge(設計 §16)
 *   3. 保持期間(1年)を過ぎた削除済み資料メタデータのpurge(設計 §7.7, §16)
 *   4. 孤児Blobの掃除(T09のBlob削除補償が失敗した場合の最後の回収経路)
 *   5. `upload_attempts`の古い行のpurge(Q-011)
 *
 * 順序の意味:
 *   - 監査(2)を資料メタデータ(3)より先に行う。`audit_events.document_id`のFKは
 *     ON DELETE指定なしのため、監査が残っている資料は削除できない。
 *   - 孤児Blob掃除(4)はpurge(3)の後に行う。purge済みの資料IDはDBに行が無く、
 *     Blobも既に削除済みのため掃除対象には現れない。
 *
 * 部分失敗の扱い:
 *   - 1件のBlob削除失敗で他の資料の再試行を止めない。件数と分類だけを記録する。
 *   - 1つの処理が例外で落ちても、残りの処理は実行する(1日1回しか動かないため、
 *     1つの不具合で他の保守が丸ごと止まると滞留が雪だるま式に増える)。
 *   - 失敗が1件でもあれば実行全体を`failed`として報告する(設計 §17の監視対象)。
 *
 * ログには固定の`event`名・結果・エラー分類・相関ID・資料ID・件数だけを出す。
 * Blobキー、ファイル名、メールアドレス、監査本文は出さない(設計 §15.2)。
 */
import type { AuditErrorCategory } from "../shared/db/audit-events.js";
import type {
  BlobCleanupCandidate,
  BlobCleanupCursor,
} from "../shared/db/maintenance.js";
import type { OperationLogger } from "../shared/log.js";
import type {
  ParsedDocumentBlobKey,
  StoredBlobPage,
} from "../shared/storage.js";
import {
  HTML_BLOB_KEY_PREFIX,
  PREVIEW_BLOB_KEY_PREFIX,
  parseDocumentBlobKey,
} from "../shared/storage.js";

/** 保守処理の種類。運用ログの`task`と監視の集計キーになる固定文字列。 */
export const maintenanceTasks = [
  "blob_cleanup_retry",
  "expired_audit_purge",
  "expired_document_purge",
  "orphan_blob_cleanup",
  "upload_attempt_purge",
] as const;
export type MaintenanceTaskName = (typeof maintenanceTasks)[number];

export type MaintenanceTaskReport = {
  task: MaintenanceTaskName;
  /** 1件でも失敗した場合は`failed`。対象0件は`success`。 */
  result: "success" | "failed";
  /** 処理対象として取り出した件数。 */
  examined: number;
  /** 完了した件数(Blob削除+フラグ解除、purgeした行数、削除した孤児Blob数)。 */
  succeeded: number;
  /** 失敗した件数。 */
  failed: number;
  /** Job実行上限に達して途中で打ち切ったか。 */
  truncated: boolean;
};

export type MaintenanceJobResult = {
  correlationId: string;
  tasks: MaintenanceTaskReport[];
  /** 1つでも失敗した処理があるか(Jobの終了コードと監視に使う)。 */
  hasFailure: boolean;
};

/** 件数つきの運用ログ(`OperationLogger`は件数を持たないため別に受け取る)。 */
export type MaintenanceSummaryLogger = (
  summary: MaintenanceTaskReport & { correlationId: string },
) => void;

export type MaintenanceJobDependencies = {
  logger: OperationLogger;
  logTaskSummary: MaintenanceSummaryLogger;
  newCorrelationId(): string;
  /** DBの抽出・削除1回あたりの件数。 */
  batchSize: number;
  /** Blob一覧1ページあたりの件数。 */
  blobListPageSize: number;
  /** 孤児Blobと判定するまでの猶予(ms)。 */
  orphanBlobGraceMs: number;
  /** `upload_attempts`の保持期間(秒)。 */
  uploadAttemptRetentionSeconds: number;

  // --- 1. blob_cleanup_pending の再試行 ---
  listBlobCleanupPendingDocuments(
    after: BlobCleanupCursor | null,
    limit: number,
  ): Promise<BlobCleanupCandidate[]>;
  /** HTML・プレビューの両Blobを冪等に削除する。 */
  deleteDocumentBlobs(documentId: string, signal: AbortSignal): Promise<void>;
  /** `blob_cleanup_pending`を下ろす。対象が無ければ`false`。 */
  completeBlobCleanup(documentId: string): Promise<boolean>;

  // --- 2, 3, 5. purge ---
  purgeExpiredAuditEvents(limit: number): Promise<number>;
  purgeExpiredDocuments(limit: number): Promise<number>;
  purgeOldUploadAttempts(
    retentionSeconds: number,
    limit: number,
  ): Promise<number>;

  // --- 4. 孤児Blobの掃除 ---
  listDocumentBlobs(
    prefix: string,
    continuationToken: string | null,
    pageSize: number,
    signal: AbortSignal,
  ): Promise<StoredBlobPage>;
  findExistingDocumentIds(documentIds: string[]): Promise<Set<string>>;
  deleteOrphanBlob(
    blob: ParsedDocumentBlobKey,
    signal: AbortSignal,
  ): Promise<void>;
};

/** 孤児Blob掃除で走査するBlobキーの接頭辞(設計 §7.3の2領域)。 */
const orphanScanPrefixes = [
  HTML_BLOB_KEY_PREFIX,
  PREVIEW_BLOB_KEY_PREFIX,
] as const;

type TaskCounters = {
  examined: number;
  succeeded: number;
  failed: number;
  truncated: boolean;
};

function newCounters(): TaskCounters {
  return { examined: 0, succeeded: 0, failed: 0, truncated: false };
}

function toReport(
  task: MaintenanceTaskName,
  counters: TaskCounters,
): MaintenanceTaskReport {
  return {
    task,
    result: counters.failed === 0 ? "success" : "failed",
    examined: counters.examined,
    succeeded: counters.succeeded,
    failed: counters.failed,
    truncated: counters.truncated,
  };
}

/**
 * 1回の実行で5つの保守処理を順に行う。
 *
 * `signal`はJob実行上限(設計 §7.7の日次実行に収まる範囲)。期限を過ぎたら
 * **新しいバッチ・新しい対象を始めない**という意味で使い、実行中の1件の後始末は
 * 中断しない(すべての処理が冪等なので、残りは次回の実行が続きから行う)。
 */
export async function runMaintenanceJobOnce(
  dependencies: MaintenanceJobDependencies,
  signal: AbortSignal,
): Promise<MaintenanceJobResult> {
  const correlationId = dependencies.newCorrelationId();
  const tasks: MaintenanceTaskReport[] = [];

  // 各stepは`counters`を**引数で受け取って加算する**。戻り値で返すと、例外が出た
  // 時点までに完了していた件数が失われ、運用ログ・監視(設計 §17)の値が実際より
  // 少なく見えてしまうため。
  const steps: Array<{
    task: MaintenanceTaskName;
    run: (counters: TaskCounters) => Promise<void>;
  }> = [
    {
      task: "blob_cleanup_retry",
      run: (counters) =>
        retryPendingBlobCleanup(dependencies, correlationId, signal, counters),
    },
    {
      task: "expired_audit_purge",
      run: (counters) =>
        purgeInBatches(
          signal,
          dependencies.batchSize,
          (limit) => dependencies.purgeExpiredAuditEvents(limit),
          counters,
        ),
    },
    {
      task: "expired_document_purge",
      run: (counters) =>
        purgeInBatches(
          signal,
          dependencies.batchSize,
          (limit) => dependencies.purgeExpiredDocuments(limit),
          counters,
        ),
    },
    {
      task: "orphan_blob_cleanup",
      run: (counters) =>
        cleanupOrphanBlobs(dependencies, correlationId, signal, counters),
    },
    {
      task: "upload_attempt_purge",
      run: (counters) =>
        purgeInBatches(
          signal,
          dependencies.batchSize,
          (limit) =>
            dependencies.purgeOldUploadAttempts(
              dependencies.uploadAttemptRetentionSeconds,
              limit,
            ),
          counters,
        ),
    },
  ];

  for (const step of steps) {
    const counters = newCounters();
    try {
      await step.run(counters);
    } catch (error) {
      // 1つの処理の想定外エラーで残りの保守を止めない。例外の内容(接続文字列・
      // Blobキーを含み得る)はログへ出さず、分類だけを残す。途中まで進んだ件数は
      // `counters`にそのまま残る。
      counters.failed += 1;
      dependencies.logger.logOperationEvent({
        event: `maintenance_${step.task}`,
        correlationId,
        result: "failed",
        errorCategory: classifyMaintenanceError(error),
      });
    }

    const report = toReport(step.task, counters);
    tasks.push(report);
    dependencies.logTaskSummary({ ...report, correlationId });
  }

  return {
    correlationId,
    tasks,
    hasFailure: tasks.some((task) => task.result === "failed"),
  };
}

/**
 * 想定外エラーの分類(設計 §12.2の固定enumだけを使う)。
 * 失敗の内訳はDB由来かStorage由来かの区別が付かないことがあるため、
 * 判別できないものは`internal_error`にする。
 */
export function classifyMaintenanceError(error: unknown): AuditErrorCategory {
  if (typeof error === "object" && error !== null) {
    const name = (error as { name?: unknown }).name;
    if (name === "AbortError" || name === "TimeoutError") {
      return "storage_failed";
    }
  }
  return "internal_error";
}

/**
 * 1. `blob_cleanup_pending`の資料のBlobを冪等に再試行する(設計 §7.7, §10.4(5))。
 *
 * HTML・プレビューの両方を削除できた資料だけフラグを下ろす。既に存在しないBlobの
 * 削除は成功扱い(`deleteIfExists`)なので、同じ資料を何度処理しても壊れない。
 * 失敗した資料はフラグが残るため次回の実行で再試行される。keyset cursorで
 * 次のバッチへ進むので、失敗した資料を掴み続けて他が進まないことはない。
 */
async function retryPendingBlobCleanup(
  dependencies: MaintenanceJobDependencies,
  correlationId: string,
  signal: AbortSignal,
  counters: TaskCounters,
): Promise<void> {
  let cursor: BlobCleanupCursor | null = null;

  while (!signal.aborted) {
    const candidates = await dependencies.listBlobCleanupPendingDocuments(
      cursor,
      dependencies.batchSize,
    );

    if (candidates.length === 0) {
      return;
    }

    for (const candidate of candidates) {
      if (signal.aborted) {
        counters.truncated = true;
        return;
      }

      counters.examined += 1;
      try {
        await dependencies.deleteDocumentBlobs(candidate.documentId, signal);
        const cleared = await dependencies.completeBlobCleanup(
          candidate.documentId,
        );
        // Blob削除は完了しているため件数は成功として数える。ただしフラグが
        // 下りなかった場合(更新0行)は、その資料が翌日以降も再試行対象として
        // 残り続けるため、別のeventで観測できるようにする(設計 §17)。
        counters.succeeded += 1;
        dependencies.logger.logOperationEvent({
          event: cleared
            ? "maintenance_blob_cleanup_retry"
            : "maintenance_blob_cleanup_flag_unchanged",
          correlationId,
          result: cleared ? "success" : "failed",
          errorCategory: cleared ? null : "database_failed",
          documentId: candidate.documentId,
        });
      } catch (error) {
        counters.failed += 1;
        dependencies.logger.logOperationEvent({
          event: "maintenance_blob_cleanup_retry",
          correlationId,
          result: "failed",
          errorCategory: classifyMaintenanceError(error),
          documentId: candidate.documentId,
        });
      }
    }

    const last = candidates[candidates.length - 1];
    if (!last || candidates.length < dependencies.batchSize) {
      return;
    }
    cursor = { deletedAt: last.deletedAt, documentId: last.documentId };
  }

  counters.truncated = true;
}

/**
 * 2, 3, 5. 件数が`limit`未満になるまでバッチでpurgeを繰り返す。
 * 1回のSQLが扱う行数を制限し、大量データでもメモリとロックを抑える。
 */
async function purgeInBatches(
  signal: AbortSignal,
  batchSize: number,
  purge: (limit: number) => Promise<number>,
  counters: TaskCounters,
): Promise<void> {
  while (!signal.aborted) {
    const deleted = await purge(batchSize);
    counters.examined += deleted;
    counters.succeeded += deleted;

    if (deleted < batchSize) {
      return;
    }
  }

  counters.truncated = true;
}

/**
 * 4. DBに対応する行が無いHTML・プレビューBlobを削除する。
 *
 * T09のBlob削除補償そのものが失敗した場合(資料レコードを作らずにBlobだけが
 * 残った場合)、資料IDがDBに無いためBlob削除の再試行(処理1)では回収できない。
 * ここが唯一の回収経路になる。
 *
 * 取り返しのつかない操作のため、次をすべて満たすBlobだけを削除する。
 *   - キーが`documentHtmlBlobKey`/`documentPreviewBlobKey`の形と完全に一致する
 *     (想定外のキーは種類が分からないので触らない)
 *   - 最終更新日時が取得でき、猶予(`orphanBlobGraceMs`)より古い
 *     (アップロードはBlob保存→DB登録の順のため、保存直後は正常でもDBに行が無い)
 *   - `documents`に同じ資料IDの行が1件も無い(`status`は問わない)
 */
async function cleanupOrphanBlobs(
  dependencies: MaintenanceJobDependencies,
  correlationId: string,
  signal: AbortSignal,
  counters: TaskCounters,
): Promise<void> {
  const threshold = Date.now() - dependencies.orphanBlobGraceMs;

  for (const prefix of orphanScanPrefixes) {
    let continuationToken: string | null = null;

    do {
      if (signal.aborted) {
        counters.truncated = true;
        return;
      }

      const page: StoredBlobPage = await dependencies.listDocumentBlobs(
        prefix,
        continuationToken,
        dependencies.blobListPageSize,
        signal,
      );

      const candidates = page.blobs.flatMap((blob) => {
        const parsed = parseDocumentBlobKey(blob.key);
        if (!parsed) {
          return [];
        }
        // 最終更新日時が分からないBlobは猶予を判定できないため触らない。
        if (!blob.lastModified || blob.lastModified.getTime() > threshold) {
          return [];
        }
        return [parsed];
      });

      if (candidates.length > 0) {
        const existingIds = await dependencies.findExistingDocumentIds(
          Array.from(new Set(candidates.map((blob) => blob.documentId))),
        );

        for (const candidate of candidates) {
          if (existingIds.has(candidate.documentId)) {
            continue;
          }
          if (signal.aborted) {
            counters.truncated = true;
            return;
          }

          counters.examined += 1;
          try {
            await dependencies.deleteOrphanBlob(candidate, signal);
            counters.succeeded += 1;
            dependencies.logger.logOperationEvent({
              event: "maintenance_orphan_blob_deleted",
              correlationId,
              result: "success",
              documentId: candidate.documentId,
            });
          } catch (error) {
            counters.failed += 1;
            dependencies.logger.logOperationEvent({
              event: "maintenance_orphan_blob_deleted",
              correlationId,
              result: "failed",
              errorCategory: classifyMaintenanceError(error),
              documentId: candidate.documentId,
            });
          }
        }
      }

      continuationToken = page.continuationToken;
    } while (continuationToken);
  }
}
