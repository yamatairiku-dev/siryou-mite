/**
 * Preview Job（プレビュー生成ワーカー）のエントリーポイント。
 *
 * 設計: docs/APPLICATION_DESIGN.md §7.5, §7.6
 *
 * 責務:
 *   - Storage Queueから1メッセージだけを受信し、1実行で1メッセージを処理する
 *   - `dequeueCount` で最大3回まで試行し、3回目の失敗でDBの状態を`failed`にする
 *   - JavaScript無効・外部ネットワーク接続なし・Chromium sandbox有効のPlaywrightで
 *     1280x720のJPEGプレビューを撮影する(1MB以下)
 *   - 成否を監査・運用ログへ記録する
 *
 * 処理手順は`worker.ts`、外部I/Oの組み立ては`dependencies.ts`、撮影は`capture.ts`に
 * あり、このファイルは環境変数の検証と起動・終了だけを担う。実行にはChromiumを含む
 * 専用Dockerfile(`Dockerfile.preview`)と専用imageを使う（設計 §7.6）。
 */
import { fileURLToPath } from "node:url";
import { createPreviewRuntime } from "./dependencies.js";
import { parsePreviewEnvironment } from "./env.js";
import { runPreviewWorkerOnce, type PreviewWorkerOutcome } from "./worker.js";

export const SERVICE_NAME = "preview" as const;

export function describeService(): string {
  return `${SERVICE_NAME} job: processes one preview generation message per run`;
}

/**
 * Job実行上限(設計 §7.5「Job実行上限は45秒」)を超えた場合の強制終了。
 * メッセージは削除されないため、visibility timeout経過後に再配信される。
 */
function armJobTimeout(maxRuntimeMs: number): NodeJS.Timeout {
  const timer = setTimeout(() => {
    logJobEvent("preview_job_timeout", "failed");
    process.exit(1);
  }, maxRuntimeMs);
  timer.unref();
  return timer;
}

/** 起動・終了ログ。設定値・秘密情報・資料の内容は含めない(設計 §9.5, §15.2)。 */
function logJobEvent(event: string, result: "success" | "failed"): void {
  console.log(
    JSON.stringify({ time: new Date().toISOString(), event, result }),
  );
}

/** 結果に応じた終了コード。再試行はQueueの再配信で行うため0で終わる。 */
export function exitCodeForOutcome(outcome: PreviewWorkerOutcome): number {
  return outcome === "retry_scheduled" ? 1 : 0;
}

async function runPreviewJob(): Promise<number> {
  // 不正な環境変数はここで例外になり、Jobが動かない(fail closed)。
  const env = parsePreviewEnvironment(process.env);
  const timer = armJobTimeout(env.PREVIEW_JOB_MAX_RUNTIME_SECONDS * 1_000);
  const runtime = createPreviewRuntime(env);

  try {
    const result = await runPreviewWorkerOnce(runtime.dependencies);
    return exitCodeForOutcome(result.outcome);
  } finally {
    clearTimeout(timer);
    await runtime.close().catch(() => undefined);
  }
}

function main(): void {
  runPreviewJob()
    .then((exitCode) => {
      logJobEvent("preview_job_finished", exitCode === 0 ? "success" : "failed");
      process.exit(exitCode);
    })
    .catch(() => {
      // 例外の内容(Blobキー・接続文字列などを含み得る)はログへ出さない。
      logJobEvent("preview_job_failed", "failed");
      process.exit(1);
    });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
