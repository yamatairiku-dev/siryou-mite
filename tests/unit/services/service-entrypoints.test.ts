import { describe, expect, it, vi } from "vitest";

describe("サービスのエントリーポイント", () => {
  it.each([
    ["../../../services/display/index", "display", "T12"],
    ["../../../services/preview/index", "preview", "T18"],
    ["../../../services/maintenance/index", "maintenance", "T19"],
  ] as const)(
    "%s は自身の名称と担当タスクを説明する",
    async (modulePath, serviceName, taskId) => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      const service = await import(modulePath);

      expect(service.SERVICE_NAME).toBe(serviceName);
      expect(service.describeService()).toContain(serviceName);
      expect(service.describeService()).toContain(taskId);

      // importするだけでは起動処理(main)が実行されない(モジュールとして安全に読み込める)。
      expect(logSpy).not.toHaveBeenCalled();

      logSpy.mockRestore();
    },
  );
});
