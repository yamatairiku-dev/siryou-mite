/**
 * Maintenance Job(定期保守ジョブ)のエントリーポイント。
 *
 * 設計: docs/APPLICATION_DESIGN.md §7.6, §7.7, §16
 *
 * 責務(毎日UTC 18:00 / JST 03:00に1回実行、設計 §7.7):
 *   - `blob_cleanup_pending`の資料のBlob削除を冪等に再試行する
 *   - 保持期間(1年)を過ぎた監査履歴と削除済み資料メタデータをpurgeする
 *     (Blob削除が完了していない資料メタデータはpurgeしない)
 *   - DBに行が無い孤児Blobを、十分な猶予を置いてから掃除する
 *   - `upload_attempts`の古い行をpurgeする(Q-011)
 *
 * 処理手順は`job.ts`、外部I/Oの組み立ては`dependencies.ts`、環境変数schemaは
 * `env.ts`にあり、このファイルは環境変数の検証と起動・終了だけを担う。
 * Web、Display、Migrationと同じNode.js用Docker imageから、このentryだけを
 * 異なるcommandで起動する(設計 §7.6)。
 */
import { fileURLToPath } from "node:url";
import { createMaintenanceRuntime } from "./dependencies.js";
import { parseMaintenanceEnvironment } from "./env.js";
import { runMaintenanceJobOnce, type MaintenanceJobResult } from "./job.js";

export const SERVICE_NAME = "maintenance" as const;

export function describeService(): string {
  return `${SERVICE_NAME} job: retries pending blob cleanup and purges expired data once per run`;
}

/**
 * Job実行上限を超えても終わらない場合の強制終了。
 *
 * `runMaintenanceJobOnce`へ渡す`AbortSignal`は「新しいバッチを始めない」ための
 * ものなので、DB・Blobの呼び出しが応答しない場合に備えて余裕(`SHUTDOWN_GRACE_MS`)を
 * 足した時点でプロセスを落とす。すべての処理が冪等なため、途中で落ちても次回の
 * 実行が続きから行う。
 */
export const SHUTDOWN_GRACE_MS = 60_000;

function armJobTimeout(maxRuntimeMs: number): NodeJS.Timeout {
  const timer = setTimeout(() => {
    logJobEvent("maintenance_job_timeout", "failed");
    process.exit(1);
  }, maxRuntimeMs + SHUTDOWN_GRACE_MS);
  timer.unref();
  return timer;
}

/** 起動・終了ログ。設定値・秘密情報・資料の内容は含めない(設計 §9.5, §15.2)。 */
function logJobEvent(event: string, result: "success" | "failed"): void {
  console.log(
    JSON.stringify({ time: new Date().toISOString(), event, result }),
  );
}

/**
 * 結果に応じた終了コード。1つでも失敗した処理があれば1にする
 * (設計 §17「Maintenance Jobの失敗」を監視するため)。
 */
export function exitCodeForResult(result: MaintenanceJobResult): number {
  return result.hasFailure ? 1 : 0;
}

async function runMaintenanceJob(): Promise<number> {
  // 不正な環境変数はここで例外になり、Jobが動かない(fail closed)。
  const env = parseMaintenanceEnvironment(process.env);
  const maxRuntimeMs = env.MAINTENANCE_JOB_MAX_RUNTIME_SECONDS * 1_000;
  const timer = armJobTimeout(maxRuntimeMs);
  const runtime = createMaintenanceRuntime(env);

  try {
    const result = await runMaintenanceJobOnce(
      runtime.dependencies,
      AbortSignal.timeout(maxRuntimeMs),
    );
    return exitCodeForResult(result);
  } finally {
    clearTimeout(timer);
    await runtime.close().catch(() => undefined);
  }
}

function main(): void {
  runMaintenanceJob()
    .then((exitCode) => {
      logJobEvent(
        "maintenance_job_finished",
        exitCode === 0 ? "success" : "failed",
      );
      process.exit(exitCode);
    })
    .catch(() => {
      // 例外の内容(接続文字列・Blobキーなどを含み得る)はログへ出さない。
      logJobEvent("maintenance_job_failed", "failed");
      process.exit(1);
    });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
