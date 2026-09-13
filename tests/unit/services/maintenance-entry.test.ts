import { describe, expect, it, vi } from "vitest";
import { exitCodeForResult, SHUTDOWN_GRACE_MS } from "../../../services/maintenance/index";
import { createMaintenanceSummaryLogger } from "../../../services/maintenance/log";
import type { MaintenanceJobResult } from "../../../services/maintenance/job";

/**
 * T19 単体テスト: Maintenance Jobのentrypointと集計ログ(設計 §15.2, §17)。
 */

function resultWith(hasFailure: boolean): MaintenanceJobResult {
  return {
    correlationId: "00000000-0000-4000-8000-000000000001",
    tasks: [],
    hasFailure,
  };
}

describe("exitCodeForResult(設計 §17)", () => {
  it("1つでも失敗した処理があれば終了コード1にする", () => {
    expect(exitCodeForResult(resultWith(true))).toBe(1);
    expect(exitCodeForResult(resultWith(false))).toBe(0);
  });

  it("強制終了はJob実行上限に猶予を足した時点で行う", () => {
    expect(SHUTDOWN_GRACE_MS).toBeGreaterThan(0);
  });
});

describe("createMaintenanceSummaryLogger(設計 §15.2)", () => {
  it("処理名・成否・件数だけを1行のJSONで出力する", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    createMaintenanceSummaryLogger()({
      task: "expired_audit_purge",
      result: "success",
      examined: 3,
      succeeded: 3,
      failed: 0,
      truncated: false,
      correlationId: "00000000-0000-4000-8000-000000000001",
    });

    expect(logSpy).toHaveBeenCalledTimes(1);
    const line = JSON.parse(String(logSpy.mock.calls[0]?.[0]));
    expect(line).toMatchObject({
      event: "maintenance_task_finished",
      task: "expired_audit_purge",
      result: "success",
      examined: 3,
      succeeded: 3,
      failed: 0,
      truncated: false,
      correlationId: "00000000-0000-4000-8000-000000000001",
    });
    // 資料ID・Blobキー・ファイル名などは出力しない。
    expect(Object.keys(line).sort()).toEqual([
      "correlationId",
      "event",
      "examined",
      "failed",
      "result",
      "succeeded",
      "task",
      "time",
      "truncated",
    ]);

    logSpy.mockRestore();
  });

  it("ログ出力に失敗しても例外を投げない", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {
      throw new Error("stdout closed");
    });

    expect(() =>
      createMaintenanceSummaryLogger()({
        task: "blob_cleanup_retry",
        result: "failed",
        examined: 1,
        succeeded: 0,
        failed: 1,
        truncated: false,
        correlationId: "00000000-0000-4000-8000-000000000001",
      }),
    ).not.toThrow();

    logSpy.mockRestore();
  });
});
