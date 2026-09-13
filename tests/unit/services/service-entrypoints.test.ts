import { describe, expect, it, vi } from "vitest";

describe("サービスのエントリーポイント", () => {
  it("maintenance は1実行で行う保守処理を説明し、importだけでは起動しない(T19で実装済み)", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const service = await import("../../../services/maintenance/index");

    expect(service.SERVICE_NAME).toBe("maintenance");
    expect(service.describeService()).toContain("maintenance");
    // 設計 §7.7「Blob削除失敗資料の再試行」と「1年経過後のpurge」。
    expect(service.describeService()).toContain("blob cleanup");
    expect(service.describeService()).toContain("purges expired data");

    // 環境変数の検証もDB接続もimport時には行わない。
    expect(logSpy).not.toHaveBeenCalled();

    logSpy.mockRestore();
  });

  it("preview は1実行1メッセージであることを説明し、importだけでは起動しない(T18で実装済み)", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const service = await import("../../../services/preview/index");

    expect(service.SERVICE_NAME).toBe("preview");
    expect(service.describeService()).toContain("preview");
    // 設計 §7.5「1実行で1メッセージだけを処理する」。
    expect(service.describeService()).toContain("one preview generation message per run");

    // 環境変数の検証もQueue受信もimport時には行わない。
    expect(logSpy).not.toHaveBeenCalled();

    logSpy.mockRestore();
  });

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
