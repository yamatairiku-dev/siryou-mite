import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  base64KeySchema,
  databaseUrlSchema,
  ed25519PublicKeyPemSchema,
  nodeEnvSchema,
  originSchema,
  storageAccountNameSchema,
  storageConnectionStringSchema,
} from "../../../services/shared/env";

describe("services/shared/env", () => {
  it("nodeEnvSchemaはdevelopmentを既定値にする", () => {
    expect(nodeEnvSchema.parse(undefined)).toBe("development");
  });

  it("nodeEnvSchemaは未知の値を拒否する", () => {
    expect(nodeEnvSchema.safeParse("staging").success).toBe(false);
  });

  it("databaseUrlSchemaはpostgres以外のprotocolを拒否する", () => {
    expect(
      databaseUrlSchema.safeParse("mysql://user:pass@localhost:3306/db")
        .success,
    ).toBe(false);
  });

  it("storageAccountNameSchemaは大文字・記号を拒否する", () => {
    expect(storageAccountNameSchema.safeParse("Invalid-Name").success).toBe(
      false,
    );
    expect(storageAccountNameSchema.safeParse("validname1").success).toBe(
      true,
    );
  });

  it("base64KeySchemaはbase64形式でない値を拒否する", () => {
    const schema = base64KeySchema("TEST_KEY", 32);

    expect(schema.safeParse("not base64 !!").success).toBe(false);
  });

  it("base64KeySchemaは最小byte数未満を拒否する", () => {
    const schema = base64KeySchema("TEST_KEY", 32);

    expect(schema.safeParse(Buffer.alloc(16).toString("base64")).success).toBe(
      false,
    );
  });

  it("ed25519PublicKeyPemSchemaはEd25519以外の公開鍵を拒否する", () => {
    const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const schema = ed25519PublicKeyPemSchema("TEST_PUBLIC_KEY");

    const result = schema.safeParse(
      publicKey.export({ type: "spki", format: "pem" }).toString(),
    );

    expect(result.success).toBe(false);
  });

  it("storageAccountNameSchemaは空文字を未設定として扱う", () => {
    const result = storageAccountNameSchema.safeParse("");

    expect(result.success).toBe(true);
    expect(result.success && result.data).toBeUndefined();
  });

  it("storageConnectionStringSchemaは空文字を未設定として扱う", () => {
    const result = storageConnectionStringSchema.safeParse("");

    expect(result.success).toBe(true);
    expect(result.success && result.data).toBeUndefined();
  });

  it("originSchemaはscheme+host+portだけを許可する", () => {
    const schema = originSchema();

    expect(schema.parse("http://example.com:3000")).toBe(
      "http://example.com:3000",
    );
    expect(schema.parse("http://example.com:3000/")).toBe(
      "http://example.com:3000",
    );
    expect(schema.safeParse("http://example.com:3000/path").success).toBe(
      false,
    );
    expect(schema.safeParse("http://example.com:3000?x=1").success).toBe(
      false,
    );
    expect(schema.safeParse("not a url").success).toBe(false);
  });
});
