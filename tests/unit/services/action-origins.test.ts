import { describe, expect, it } from "vitest";
import { allowedActionOriginHosts } from "../../../services/shared/action-origins";

/**
 * React RouterのCSRF検査へ渡す許可Origin(設計 §7.1.1)。
 * server buildへの受け渡しと実際の検査は、結合テスト
 * (`tests/integration/web-origin-check.test.ts`)で確認する。
 */
describe("allowedActionOriginHosts", () => {
  it("APP_ORIGINのhostだけを許可する(schemeは含めない)", () => {
    expect(
      allowedActionOriginHosts(
        "https://ca-siryou-mite-stg-web.example.azurecontainerapps.io",
      ),
    ).toEqual(["ca-siryou-mite-stg-web.example.azurecontainerapps.io"]);
  });

  it("既定以外のportはhostへ含める", () => {
    expect(allowedActionOriginHosts("http://localhost:3000")).toEqual([
      "localhost:3000",
    ]);
  });

  it("未設定の場合は追加の許可をしない", () => {
    expect(allowedActionOriginHosts(undefined)).toEqual([]);
    expect(allowedActionOriginHosts("")).toEqual([]);
  });

  it("形式不正の値は例外にして起動させない", () => {
    expect(() => allowedActionOriginHosts("not-a-url")).toThrow();
  });
});
