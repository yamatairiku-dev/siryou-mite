import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseDisplayEnvironment } from "../../../services/display/env";

const { publicKey } = generateKeyPairSync("ed25519");
const validPublicKeyPem = publicKey
  .export({ type: "spki", format: "pem" })
  .toString();

const validLogHmacKey = Buffer.alloc(32, 2).toString("base64");

const baseEnvironment: NodeJS.ProcessEnv = {
  NODE_ENV: "development",
  DATABASE_URL:
    "postgres://dbuser:sup3r-secret-db-password@localhost:5432/siryou_mite",
  APP_ORIGIN: "http://localhost:3000",
  AZURE_STORAGE_CONNECTION_STRING: "UseDevelopmentStorage=true",
  LOG_HMAC_KEY: validLogHmacKey,
  GRANT_VERIFICATION_KEYS: JSON.stringify([
    { keyId: "key-1", publicKey: validPublicKeyPem },
  ]),
};

describe("parseDisplayEnvironment", () => {
  it("有効な設定を受け付け、設計どおりの既定値を設定する", () => {
    const result = parseDisplayEnvironment(baseEnvironment);

    expect(result.PORT).toBe(8080);
    expect(result.GRANT_MAX_AGE_SECONDS).toBe(60);
    expect(result.DISPLAY_MAX_POST_BODY_BYTES).toBe(8 * 1024);
    expect(result.GRANT_VERIFICATION_KEYS).toHaveLength(1);
    expect(result.GRANT_VERIFICATION_KEYS[0]?.keyId).toBe("key-1");
  });

  it("新旧複数のkeyIdを併用できる", () => {
    const { publicKey: otherPublicKey } = generateKeyPairSync("ed25519");

    const result = parseDisplayEnvironment({
      ...baseEnvironment,
      GRANT_VERIFICATION_KEYS: JSON.stringify([
        { keyId: "key-1", publicKey: validPublicKeyPem },
        {
          keyId: "key-2",
          publicKey: otherPublicKey.export({ type: "spki", format: "pem" }),
        },
      ]),
    });

    expect(result.GRANT_VERIFICATION_KEYS).toHaveLength(2);
  });

  it("keyIdが重複する場合は拒否する", () => {
    expect(() =>
      parseDisplayEnvironment({
        ...baseEnvironment,
        GRANT_VERIFICATION_KEYS: JSON.stringify([
          { keyId: "key-1", publicKey: validPublicKeyPem },
          { keyId: "key-1", publicKey: validPublicKeyPem },
        ]),
      }),
    ).toThrow("keyId は重複できません");
  });

  it("GRANT_VERIFICATION_KEYSがJSONでない場合は拒否する", () => {
    expect(() =>
      parseDisplayEnvironment({
        ...baseEnvironment,
        GRANT_VERIFICATION_KEYS: "not json",
      }),
    ).toThrow("JSON配列である必要があります");
  });

  it("公開鍵の代わりに秘密鍵を指定すると拒否する", () => {
    const { privateKey } = generateKeyPairSync("ed25519");

    expect(() =>
      parseDisplayEnvironment({
        ...baseEnvironment,
        GRANT_VERIFICATION_KEYS: JSON.stringify([
          {
            keyId: "key-1",
            publicKey: privateKey.export({ type: "pkcs8", format: "pem" }),
          },
        ]),
      }),
    ).toThrow("PEM形式のEd25519公開鍵");
  });

  it("本番はManaged Identity用account名を受け付ける", () => {
    const environment = { ...baseEnvironment };
    delete environment.AZURE_STORAGE_CONNECTION_STRING;

    expect(() =>
      parseDisplayEnvironment({
        ...environment,
        NODE_ENV: "production",
        AZURE_STORAGE_ACCOUNT_NAME: "storageaccount1",
      }),
    ).not.toThrow();
  });

  it("本番でAZURE_STORAGE_CONNECTION_STRINGを指定すると拒否する", () => {
    expect(() =>
      parseDisplayEnvironment({
        ...baseEnvironment,
        NODE_ENV: "production",
      }),
    ).toThrow("本番環境では AZURE_STORAGE_CONNECTION_STRING を使用できません");
  });

  it("APP_ORIGINが未設定の場合は拒否する", () => {
    const environment = { ...baseEnvironment };
    delete environment.APP_ORIGIN;

    expect(() => parseDisplayEnvironment(environment)).toThrow("APP_ORIGIN");
  });

  it("APP_ORIGINにパスを含む場合は拒否する", () => {
    expect(() =>
      parseDisplayEnvironment({
        ...baseEnvironment,
        APP_ORIGIN: "http://localhost:3000/login",
      }),
    ).toThrow("APP_ORIGIN");
  });

  it("APP_ORIGINの末尾スラッシュを正規化する", () => {
    const result = parseDisplayEnvironment({
      ...baseEnvironment,
      APP_ORIGIN: "http://localhost:3000/",
    });

    expect(result.APP_ORIGIN).toBe("http://localhost:3000");
  });

  it("GRANT_MAX_AGE_SECONDSが120秒を超える場合は拒否する", () => {
    expect(() =>
      parseDisplayEnvironment({
        ...baseEnvironment,
        GRANT_MAX_AGE_SECONDS: "121",
      }),
    ).toThrow("GRANT_MAX_AGE_SECONDS");
  });

  it("DISPLAY_MAX_POST_BODY_BYTESが16KBを超える場合は拒否する", () => {
    expect(() =>
      parseDisplayEnvironment({
        ...baseEnvironment,
        DISPLAY_MAX_POST_BODY_BYTES: String(16 * 1024 + 1),
      }),
    ).toThrow("DISPLAY_MAX_POST_BODY_BYTES");
  });

  it("HMAC鍵・DBパスワードが不正な場合でもエラーメッセージへ値そのものを含めない", () => {
    const invalidLogHmacKey = "not-a-valid-base64-log-hmac-key-value";
    const invalidDatabaseUrl =
      "mysql://dbuser:sup3r-secret-db-password@localhost:3306/siryou_mite";

    let message = "";
    try {
      parseDisplayEnvironment({
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
