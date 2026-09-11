import { describe, expect, it } from "vitest";
import { parsePreviewEnvironment } from "../../../services/preview/env";

const validLogHmacKey = Buffer.alloc(32, 3).toString("base64");

const baseEnvironment: NodeJS.ProcessEnv = {
  NODE_ENV: "development",
  DATABASE_URL:
    "postgres://dbuser:sup3r-secret-db-password@localhost:5432/siryou_mite",
  AZURE_STORAGE_CONNECTION_STRING: "UseDevelopmentStorage=true",
  LOG_HMAC_KEY: validLogHmacKey,
};

describe("parsePreviewEnvironment", () => {
  it("有効な設定を受け付け、設計どおりの既定値を設定する", () => {
    const result = parsePreviewEnvironment(baseEnvironment);

    expect(result.AZURE_STORAGE_QUEUE_NAME).toBe("preview-generation");
    expect(result.QUEUE_VISIBILITY_TIMEOUT_SECONDS).toBe(60);
    expect(result.QUEUE_MESSAGE_PROCESSING_TIMEOUT_SECONDS).toBe(30);
    expect(result.PREVIEW_JOB_MAX_RUNTIME_SECONDS).toBe(45);
    expect(result.QUEUE_MAX_DEQUEUE_COUNT).toBe(3);
    expect(result.MAX_PREVIEW_IMAGE_BYTES).toBe(1024 * 1024);
  });

  it("メッセージ処理上限がvisibility timeoutを超える場合は拒否する", () => {
    expect(() =>
      parsePreviewEnvironment({
        ...baseEnvironment,
        QUEUE_VISIBILITY_TIMEOUT_SECONDS: "30",
        QUEUE_MESSAGE_PROCESSING_TIMEOUT_SECONDS: "60",
      }),
    ).toThrow("QUEUE_MESSAGE_PROCESSING_TIMEOUT_SECONDS");
  });

  it("Job実行上限がメッセージ処理上限未満の場合は拒否する", () => {
    expect(() =>
      parsePreviewEnvironment({
        ...baseEnvironment,
        QUEUE_MESSAGE_PROCESSING_TIMEOUT_SECONDS: "30",
        PREVIEW_JOB_MAX_RUNTIME_SECONDS: "10",
      }),
    ).toThrow("PREVIEW_JOB_MAX_RUNTIME_SECONDS");
  });

  it("最大試行回数の範囲外を拒否する", () => {
    expect(() =>
      parsePreviewEnvironment({
        ...baseEnvironment,
        QUEUE_MAX_DEQUEUE_COUNT: "0",
      }),
    ).toThrow("QUEUE_MAX_DEQUEUE_COUNT");
  });

  it("DATABASE_URLが未設定の場合は拒否する", () => {
    const environment = { ...baseEnvironment };
    delete environment.DATABASE_URL;

    expect(() => parsePreviewEnvironment(environment)).toThrow(
      "DATABASE_URL",
    );
  });

  it("Storage設定が未設定の場合は拒否する", () => {
    const environment = { ...baseEnvironment };
    delete environment.AZURE_STORAGE_CONNECTION_STRING;

    expect(() => parsePreviewEnvironment(environment)).toThrow(
      "AZURE_STORAGE_CONNECTION_STRING または AZURE_STORAGE_ACCOUNT_NAME が必要です",
    );
  });

  it("本番でAZURE_STORAGE_CONNECTION_STRINGを指定すると拒否する", () => {
    expect(() =>
      parsePreviewEnvironment({
        ...baseEnvironment,
        NODE_ENV: "production",
      }),
    ).toThrow("本番環境では AZURE_STORAGE_CONNECTION_STRING を使用できません");
  });

  it("本番はManaged Identity用account名を受け付ける", () => {
    const environment = { ...baseEnvironment };
    delete environment.AZURE_STORAGE_CONNECTION_STRING;

    expect(() =>
      parsePreviewEnvironment({
        ...environment,
        NODE_ENV: "production",
        AZURE_STORAGE_ACCOUNT_NAME: "storageaccount1",
      }),
    ).not.toThrow();
  });

  it("AZURE_STORAGE_ACCOUNT_NAMEが空文字の場合は未設定として扱う", () => {
    const result = parsePreviewEnvironment({
      ...baseEnvironment,
      AZURE_STORAGE_ACCOUNT_NAME: "",
    });

    expect(result.AZURE_STORAGE_ACCOUNT_NAME).toBeUndefined();
  });

  it("HMAC鍵・DBパスワードが不正な場合でもエラーメッセージへ値そのものを含めない", () => {
    const invalidLogHmacKey = "not-a-valid-base64-log-hmac-key-value";
    const invalidDatabaseUrl =
      "mysql://dbuser:sup3r-secret-db-password@localhost:3306/siryou_mite";

    let message = "";
    try {
      parsePreviewEnvironment({
        ...baseEnvironment,
        LOG_HMAC_KEY: invalidLogHmacKey,
        DATABASE_URL: invalidDatabaseUrl,
      });
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain("LOG_HMAC_KEY");
    expect(message).toContain("DATABASE_URL");
    expect(message).not.toContain(invalidLogHmacKey);
    expect(message).not.toContain("sup3r-secret-db-password");
  });
});
