import { describe, expect, it } from "vitest";
import { parseEnvironment } from "~/lib/env.server";

const validEntraEnvironment: NodeJS.ProcessEnv = {
  NODE_ENV: "production",
  APP_ORIGIN: "https://app.example.com",
  AUTH_MODE: "entra",
  SESSION_SECRET: "test-session-secret-at-least-32-characters",
  ENTRA_CLIENT_ID: "client-id",
  ENTRA_CLIENT_SECRET: "client-secret",
  ENTRA_TENANT_ID: "tenant-id",
  ENTRA_REDIRECT_URI: "https://app.example.com/auth/callback",
  ENTRA_ALLOWED_EMAIL_DOMAINS: "EXAMPLE.COM, subsidiary.example.com,example.com",
};

describe("parseEnvironment", () => {
  it("許可ドメインを正規化して重複を除く", () => {
    expect(
      parseEnvironment(validEntraEnvironment).ENTRA_ALLOWED_EMAIL_DOMAINS,
    ).toEqual(["example.com", "subsidiary.example.com"]);
  });

  it("Entra認証で許可ドメインが未設定の場合は拒否する", () => {
    const environment = { ...validEntraEnvironment };
    delete environment.ENTRA_ALLOWED_EMAIL_DOMAINS;

    expect(() => parseEnvironment(environment)).toThrow(
      "ENTRA_ALLOWED_EMAIL_DOMAINS は AUTH_MODE=entra のとき必須です",
    );
  });

  it.each([
    "example",
    "-example.com",
    "example-.com",
    "example.com,",
  ])("不正な許可ドメイン %s を拒否する", (allowedDomains) => {
    expect(() =>
      parseEnvironment({
        ...validEntraEnvironment,
        ENTRA_ALLOWED_EMAIL_DOMAINS: allowedDomains,
      }),
    ).toThrow("有効なメールドメインを指定してください");
  });
});
