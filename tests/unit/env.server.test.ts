import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseEnvironment } from "~/lib/env.server";

const { privateKey } = generateKeyPairSync("ed25519");
const validPrivateKeyPem = privateKey
  .export({ type: "pkcs8", format: "pem" })
  .toString();

const validBase64Key = Buffer.alloc(32, 1).toString("base64");

const baseEnvironment: NodeJS.ProcessEnv = {
  NODE_ENV: "development",
  APP_ORIGIN: "http://localhost:3000",
  AUTH_MODE: "dev",
  SESSION_SECRET: "test-session-secret-at-least-32-characters",
  DATABASE_URL: "postgres://dbuser:sup3r-secret-db-password@localhost:5432/siryou_mite",
  DISPLAY_ORIGIN: "http://localhost:3100",
  AZURE_STORAGE_CONNECTION_STRING: "UseDevelopmentStorage=true",
  GRANT_SIGNING_KEY_ID: "key-1",
  GRANT_SIGNING_PRIVATE_KEY: validPrivateKeyPem,
  LOG_HMAC_KEY: validBase64Key,
};

const validEasyAuthEnvironment: NodeJS.ProcessEnv = {
  ...baseEnvironment,
  NODE_ENV: "production",
  APP_ORIGIN: "https://app.example.com",
  AUTH_MODE: "easyauth",
  ENTRA_TENANT_ID: "tenant-id",
  AZURE_STORAGE_ACCOUNT_NAME: "storageaccount1",
};
delete validEasyAuthEnvironment.AZURE_STORAGE_CONNECTION_STRING;
delete validEasyAuthEnvironment.SESSION_SECRET;

describe("parseEnvironment", () => {
  it("開発設定を受け付け、上限値へ設計どおりの既定値を設定する", () => {
    const result = parseEnvironment(baseEnvironment);

    expect(result.MAX_HTML_UPLOAD_BYTES).toBe(10 * 1024 * 1024);
    expect(result.MAX_ACTIVE_DOCUMENTS_PER_USER).toBe(100);
    expect(result.MAX_TOTAL_HTML_BYTES_PER_USER).toBe(500 * 1024 * 1024);
    expect(result.MAX_TOTAL_HTML_BYTES_SYSTEM).toBe(50 * 1024 * 1024 * 1024);
    expect(result.SYSTEM_HTML_BYTES_WARNING_THRESHOLD).toBe(
      40 * 1024 * 1024 * 1024,
    );
    expect(result.UPLOAD_RATE_LIMIT_PER_MINUTE).toBe(5);
    expect(result.MAX_CONCURRENT_UPLOADS_PER_USER).toBe(1);
    expect(result.GRANT_TTL_SECONDS).toBe(60);
    expect(result.AZURE_STORAGE_CONTAINER).toBe("documents");
    expect(result.AZURE_STORAGE_QUEUE_NAME).toBe("preview-generation");
  });

  it("Easy Auth本番設定を受け付ける", () => {
    expect(parseEnvironment(validEasyAuthEnvironment).AUTH_MODE).toBe(
      "easyauth",
    );
  });

  it("Easy Authでtenantが未設定の場合は拒否する", () => {
    const environment = { ...validEasyAuthEnvironment };
    delete environment.ENTRA_TENANT_ID;

    expect(() => parseEnvironment(environment)).toThrow(
      "ENTRA_TENANT_ID は AUTH_MODE=easyauth のとき必須です",
    );
  });

  it("本番のdev認証を拒否する", () => {
    expect(() =>
      parseEnvironment({
        ...validEasyAuthEnvironment,
        AUTH_MODE: "dev",
        SESSION_SECRET: "test-session-secret-at-least-32-characters",
      }),
    ).toThrow("本番環境では AUTH_MODE=easyauth が必須です");
  });

  it("dev認証でSESSION_SECRETが未設定の場合は拒否する", () => {
    const environment = { ...baseEnvironment };
    delete environment.SESSION_SECRET;

    expect(() => parseEnvironment(environment)).toThrow(
      "SESSION_SECRET は AUTH_MODE=dev のとき必須です",
    );
  });

  it("DATABASE_URLが未設定の場合は拒否する", () => {
    const environment = { ...baseEnvironment };
    delete environment.DATABASE_URL;

    expect(() => parseEnvironment(environment)).toThrow("DATABASE_URL");
  });

  it("DATABASE_URLがpostgres以外のprotocolの場合は拒否する", () => {
    expect(() =>
      parseEnvironment({
        ...baseEnvironment,
        DATABASE_URL: "https://localhost:5432/siryou_mite",
      }),
    ).toThrow("DATABASE_URL");
  });

  it("DISPLAY_ORIGINが未設定の場合は拒否する", () => {
    const environment = { ...baseEnvironment };
    delete environment.DISPLAY_ORIGIN;

    expect(() => parseEnvironment(environment)).toThrow("DISPLAY_ORIGIN");
  });

  it("DISPLAY_ORIGINがURL形式でない場合は拒否する", () => {
    expect(() =>
      parseEnvironment({ ...baseEnvironment, DISPLAY_ORIGIN: "not-a-url" }),
    ).toThrow("DISPLAY_ORIGIN");
  });

  it("GRANT_SIGNING_PRIVATE_KEYが未設定の場合は拒否する", () => {
    const environment = { ...baseEnvironment };
    delete environment.GRANT_SIGNING_PRIVATE_KEY;

    expect(() => parseEnvironment(environment)).toThrow(
      "GRANT_SIGNING_PRIVATE_KEY",
    );
  });

  it("GRANT_SIGNING_PRIVATE_KEYがPEM形式でない場合は拒否する", () => {
    expect(() =>
      parseEnvironment({
        ...baseEnvironment,
        GRANT_SIGNING_PRIVATE_KEY: "not-a-pem-key",
      }),
    ).toThrow("GRANT_SIGNING_PRIVATE_KEY はPEM形式のEd25519秘密鍵(PRIVATE KEY)");
  });

  it("GRANT_SIGNING_PRIVATE_KEYがPEMヘッダーはあるが解析できない場合は拒否する", () => {
    expect(() =>
      parseEnvironment({
        ...baseEnvironment,
        GRANT_SIGNING_PRIVATE_KEY:
          "-----BEGIN PRIVATE KEY-----\nnot-valid-base64-der\n-----END PRIVATE KEY-----",
      }),
    ).toThrow("GRANT_SIGNING_PRIVATE_KEY はPEM形式のEd25519秘密鍵である必要があります");
  });

  it("GRANT_SIGNING_PRIVATE_KEYがEd25519以外の鍵種別の場合は拒否する", () => {
    const { privateKey: rsaPrivateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
    });

    expect(() =>
      parseEnvironment({
        ...baseEnvironment,
        GRANT_SIGNING_PRIVATE_KEY: rsaPrivateKey
          .export({ type: "pkcs8", format: "pem" })
          .toString(),
      }),
    ).toThrow("GRANT_SIGNING_PRIVATE_KEY はEd25519秘密鍵");
  });

  it("LOG_HMAC_KEYが32byte未満のbase64の場合は拒否する", () => {
    expect(() =>
      parseEnvironment({
        ...baseEnvironment,
        LOG_HMAC_KEY: Buffer.alloc(16, 1).toString("base64"),
      }),
    ).toThrow("LOG_HMAC_KEY は");
  });

  it("LOG_HMAC_KEYがbase64形式でない場合は拒否する", () => {
    expect(() =>
      parseEnvironment({
        ...baseEnvironment,
        LOG_HMAC_KEY: "not base64 !!",
      }),
    ).toThrow("LOG_HMAC_KEY はbase64形式");
  });

  it("上限値の数値範囲外を拒否する", () => {
    expect(() =>
      parseEnvironment({
        ...baseEnvironment,
        UPLOAD_RATE_LIMIT_PER_MINUTE: "0",
      }),
    ).toThrow("UPLOAD_RATE_LIMIT_PER_MINUTE");
  });

  it("警告閾値が全体上限を超える場合は拒否する", () => {
    expect(() =>
      parseEnvironment({
        ...baseEnvironment,
        MAX_TOTAL_HTML_BYTES_SYSTEM: String(10 * 1024 * 1024 * 1024),
        SYSTEM_HTML_BYTES_WARNING_THRESHOLD: String(20 * 1024 * 1024 * 1024),
      }),
    ).toThrow("SYSTEM_HTML_BYTES_WARNING_THRESHOLD");
  });

  it("本番でAZURE_STORAGE_CONNECTION_STRINGを指定すると拒否する", () => {
    expect(() =>
      parseEnvironment({
        ...validEasyAuthEnvironment,
        AZURE_STORAGE_CONNECTION_STRING: "UseDevelopmentStorage=true",
      }),
    ).toThrow("本番環境では AZURE_STORAGE_CONNECTION_STRING を使用できません");
  });

  it("本番でAZURE_STORAGE_ACCOUNT_NAMEが未設定の場合は拒否する", () => {
    const environment = { ...validEasyAuthEnvironment };
    delete environment.AZURE_STORAGE_ACCOUNT_NAME;

    expect(() => parseEnvironment(environment)).toThrow(
      "AZURE_STORAGE_CONNECTION_STRING または AZURE_STORAGE_ACCOUNT_NAME が必要です",
    );
  });

  it("接続文字列とaccount名を両方指定すると拒否する", () => {
    expect(() =>
      parseEnvironment({
        ...baseEnvironment,
        AZURE_STORAGE_ACCOUNT_NAME: "storageaccount1",
      }),
    ).toThrow(
      "AZURE_STORAGE_CONNECTION_STRING と AZURE_STORAGE_ACCOUNT_NAME は同時に指定できません",
    );
  });

  it("AZURE_STORAGE_ACCOUNT_NAMEの形式が不正な場合は拒否する", () => {
    expect(() =>
      parseEnvironment({
        ...validEasyAuthEnvironment,
        AZURE_STORAGE_ACCOUNT_NAME: "InvalidName!",
      }),
    ).toThrow("AZURE_STORAGE_ACCOUNT_NAME");
  });

  it("AZURE_STORAGE_ACCOUNT_NAMEが空文字の場合は未設定として扱う", () => {
    const result = parseEnvironment({
      ...baseEnvironment,
      AZURE_STORAGE_ACCOUNT_NAME: "",
    });

    expect(result.AZURE_STORAGE_ACCOUNT_NAME).toBeUndefined();
  });

  it("AZURE_STORAGE_CONNECTION_STRINGが空文字の場合は未設定として扱う", () => {
    const result = parseEnvironment({
      ...validEasyAuthEnvironment,
      AZURE_STORAGE_CONNECTION_STRING: "",
    });

    expect(result.AZURE_STORAGE_CONNECTION_STRING).toBeUndefined();
    expect(result.AZURE_STORAGE_ACCOUNT_NAME).toBe("storageaccount1");
  });

  it("APP_ORIGINにパスを含む場合は拒否する", () => {
    expect(() =>
      parseEnvironment({
        ...baseEnvironment,
        APP_ORIGIN: "http://localhost:3000/path",
      }),
    ).toThrow("APP_ORIGIN");
  });

  it("APP_ORIGINの末尾スラッシュを正規化する", () => {
    const result = parseEnvironment({
      ...baseEnvironment,
      APP_ORIGIN: "http://localhost:3000/",
    });

    expect(result.APP_ORIGIN).toBe("http://localhost:3000");
  });

  it("DISPLAY_ORIGINにクエリ文字列を含む場合は拒否する", () => {
    expect(() =>
      parseEnvironment({
        ...baseEnvironment,
        DISPLAY_ORIGIN: "http://localhost:3100?x=1",
      }),
    ).toThrow("DISPLAY_ORIGIN");
  });

  it("GRANT_TTL_SECONDSが120秒を超える場合は拒否する", () => {
    expect(() =>
      parseEnvironment({
        ...baseEnvironment,
        GRANT_TTL_SECONDS: "121",
      }),
    ).toThrow("GRANT_TTL_SECONDS");
  });

  it("秘密鍵本体・HMAC鍵・DBパスワードが不正な場合でもエラーメッセージへ値そのものを含めない", () => {
    const { privateKey: invalidPrivateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
    });
    const invalidPrivateKeyPem = invalidPrivateKey
      .export({ type: "pkcs8", format: "pem" })
      .toString();
    const invalidLogHmacKey = "not-a-valid-base64-log-hmac-key-value";
    const invalidDatabaseUrl =
      "mysql://dbuser:sup3r-secret-db-password@localhost:3306/siryou_mite";

    let message = "";
    try {
      parseEnvironment({
        ...baseEnvironment,
        GRANT_SIGNING_PRIVATE_KEY: invalidPrivateKeyPem,
        LOG_HMAC_KEY: invalidLogHmacKey,
        DATABASE_URL: invalidDatabaseUrl,
      });
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain("GRANT_SIGNING_PRIVATE_KEY");
    expect(message).toContain("LOG_HMAC_KEY");
    expect(message).toContain("DATABASE_URL");
    expect(message).not.toContain(invalidPrivateKeyPem);
    expect(message).not.toContain(invalidLogHmacKey);
    expect(message).not.toContain("sup3r-secret-db-password");
  });
});
