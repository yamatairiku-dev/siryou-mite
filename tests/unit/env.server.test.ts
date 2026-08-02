import { describe, expect, it } from "vitest";
import { parseEnvironment } from "~/lib/env.server";

const validEasyAuthEnvironment: NodeJS.ProcessEnv = {
  NODE_ENV: "production",
  APP_ORIGIN: "https://app.example.com",
  AUTH_MODE: "easyauth",
  ENTRA_TENANT_ID: "tenant-id",
};

describe("parseEnvironment", () => {
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
      parseEnvironment({ ...validEasyAuthEnvironment, AUTH_MODE: "dev" }),
    ).toThrow("本番環境では AUTH_MODE=easyauth が必須です");
  });
});
