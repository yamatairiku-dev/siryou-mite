/**
 * Maintenance Jobの件数つき運用ログ(設計 §15.2, §17)。
 *
 * `services/shared/log.ts`の`OperationLogger`は監査と同じ項目(相関ID・処理名・
 * 成否・エラー分類・pseudonymize化した利用者識別子・資料ID)だけを受け付け、
 * 件数を持たない。保守Jobの監視(設計 §17「Maintenance Jobの失敗」)には処理ごとの
 * 件数が要るため、共有moduleの契約は変えずにJob専用の集計ログをここへ置く。
 *
 * 出力するのは固定の処理名と件数だけで、資料ID・Blobキー・ファイル名・
 * メールアドレス・監査本文は含めない(設計 §15.2)。
 */
import type { MaintenanceSummaryLogger, MaintenanceTaskReport } from "./job.js";

export type MaintenanceTaskSummary = MaintenanceTaskReport & {
  correlationId: string;
};

/**
 * 1行1eventのJSONをstdoutへ出力する。ログ出力の失敗で保守処理を止めない
 * (設計 §15.2)。
 */
export function createMaintenanceSummaryLogger(): MaintenanceSummaryLogger {
  return (summary: MaintenanceTaskSummary) => {
    try {
      console.log(
        JSON.stringify({
          time: new Date().toISOString(),
          event: "maintenance_task_finished",
          task: summary.task,
          result: summary.result,
          correlationId: summary.correlationId,
          examined: summary.examined,
          succeeded: summary.succeeded,
          failed: summary.failed,
          truncated: summary.truncated,
        }),
      );
    } catch {
      // ログ出力の失敗は握りつぶす(業務処理を止めない)。
    }
  };
}
