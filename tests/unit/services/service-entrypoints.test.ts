import { describe, expect, it, vi } from "vitest";

describe("サービスのエントリーポイント", () => {
  it.each([
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

  it("display は公開する経路を説明し、importだけでは起動しない(T12で実装済み)", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const service = await import("../../../services/display/index");

    expect(service.SERVICE_NAME).toBe("display");
    expect(service.describeService()).toContain("display");
    // 公開するのは`GET /health`と`POST /display`だけ(設計 §7.2)。
    expect(service.describeService()).toContain("GET /health");
    expect(service.describeService()).toContain("POST /display");

    // 環境変数の検証もサーバー起動もimport時には行わない。
    expect(logSpy).not.toHaveBeenCalled();

    logSpy.mockRestore();
  });
});
