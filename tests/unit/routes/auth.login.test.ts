import { describe, expect, it } from "vitest";
import { getUser } from "~/lib/session.server";
import { action } from "~/routes/auth.login";

/**
 * 開発用ログイン(`AUTH_MODE=dev`)で、通常の開発ユーザーと`Admin`ロール付きの
 * 開発管理者を選べることを確認する。`AUTH_MODE=dev`は本番では起動できない
 * (`tests/unit/env.server.test.ts`)。
 */

const ORIGIN = "http://localhost:3000";

async function login(fields: Record<string, string>, origin = ORIGIN) {
  const request = new Request(`${ORIGIN}/auth/login`, {
    method: "POST",
    headers: { Origin: origin },
    body: new URLSearchParams({ returnTo: "/app", ...fields }),
  });
  return action({ request, params: {}, context: {} } as never) as Promise<Response>;
}

async function userFromResponse(response: Response) {
  const cookie = response.headers.get("Set-Cookie")?.split(";")[0] ?? "";
  return getUser(new Request(`${ORIGIN}/app`, { headers: { Cookie: cookie } }));
}

describe("開発用ログイン", () => {
  it("既定ではUserロールだけの開発ユーザーでログインする", async () => {
    const user = await userFromResponse(await login({}));
    expect(user?.id).toBe("dev-user");
    expect(user?.roles).toEqual(["User"]);
  });

  it("devRole=adminではAdminロール付きの開発管理者でログインする", async () => {
    const response = await login({ devRole: "admin" });
    expect(response.headers.get("Location")).toBe("/app");
    const user = await userFromResponse(response);
    expect(user?.id).toBe("dev-admin");
    expect(user?.roles).toEqual(["User", "Admin"]);
  });

  it("未定義のdevRoleは拒否する", async () => {
    await expect(login({ devRole: "root" })).rejects.toMatchObject({
      status: 400,
    });
  });

  it("別オリジンからのPOSTは拒否する", async () => {
    await expect(
      login({ devRole: "admin" }, "http://evil.example"),
    ).rejects.toMatchObject({ status: 403 });
  });
});
