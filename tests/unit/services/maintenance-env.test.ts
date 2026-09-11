import { describe, expect, it } from "vitest";
import { parseMaintenanceEnvironment } from "../../../services/maintenance/env";

const baseEnvironment: NodeJS.ProcessEnv = {
  NODE_ENV: "development",
  DATABASE_URL: "postgres://user:pass@localhost:5432/siryou_mite",
  AZURE_STORAGE_CONNECTION_STRING: "UseDevelopmentStorage=true",
  LOG_HMAC_KEY: Buffer.alloc(32, 4).toString("base64"),
};

describe("parseMaintenanceEnvironment", () => {
  it("有効な設定を受け付け、設計どおりの既定値を設定する", () => {
    const result = parseMaintenanceEnvironment(baseEnvironment);

    expect(result.AZURE_STORAGE_CONTAINER).toBe("documents");
  });

  it("本番でAZURE_STORAGE_CONNECTION_STRINGを指定すると拒否する", () => {
    expect(() =>
      parseMaintenanceEnvironment({
        ...baseEnvironment,
        NODE_ENV: "production",
      }),
    ).toThrow("本番環境では AZURE_STORAGE_CONNECTION_STRING を使用できません");
  });

  it("本番はManaged Identity用account名を受け付ける", () => {
    const environment = { ...baseEnvironment };
    delete environment.AZURE_STORAGE_CONNECTION_STRING;

    expect(() =>
      parseMaintenanceEnvironment({
        ...environment,
        NODE_ENV: "production",
        AZURE_STORAGE_ACCOUNT_NAME: "storageaccount1",
      }),
    ).not.toThrow();
  });

  it("接続文字列とaccount名を両方指定すると拒否する", () => {
    expect(() =>
      parseMaintenanceEnvironment({
        ...baseEnvironment,
        AZURE_STORAGE_ACCOUNT_NAME: "storageaccount1",
      }),
    ).toThrow(
      "AZURE_STORAGE_CONNECTION_STRING と AZURE_STORAGE_ACCOUNT_NAME は同時に指定できません",
    );
  });

  it("AZURE_STORAGE_ACCOUNT_NAMEが空文字の場合は未設定として扱う", () => {
    const result = parseMaintenanceEnvironment({
      ...baseEnvironment,
      AZURE_STORAGE_ACCOUNT_NAME: "",
    });

    expect(result.AZURE_STORAGE_ACCOUNT_NAME).toBeUndefined();
  });

  it("LOG_HMAC_KEYが未設定の場合は拒否する", () => {
    const environment = { ...baseEnvironment };
    delete environment.LOG_HMAC_KEY;

    expect(() => parseMaintenanceEnvironment(environment)).toThrow(
      "LOG_HMAC_KEY",
    );
  });
});
