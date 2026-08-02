import { describe, expect, it } from "vitest";
import {
  createUserSession,
  destroyUserSession,
  getUser,
  requireUser,
  safeInternalPath,
  type AppUser,
} from "~/lib/session.server";

const testUser: AppUser = {
  id: "user-001",
  tenantId: "tenant-001",
  name: "テスト利用者",
  email: "user@example.com",
  roles: ["User"],
  groups: ["ZAA535-A"],
};

describe("safeInternalPath", () => {
  it("アプリ内部のパスを許可する", () => {
    expect(safeInternalPath("/app?tab=profile")).toBe("/app?tab=profile");
  });

  it.each([
    [undefined, "/app"],
    ["", "/app"],
    ["https://attacker.example", "/app"],
    ["//attacker.example", "/app"],
  ])("%s を安全な既定値へ変換する", (input, expected) => {
    expect(safeInternalPath(input)).toBe(expected);
  });
});

describe("ユーザーセッション", () => {
  it("認証済みユーザーをCookieへ保存して復元する", async () => {
    const response = await createUserSession(testUser, "/app?tab=profile");
    const cookie = response.headers.get("Set-Cookie");

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/app?tab=profile");
    expect(cookie).toContain("HttpOnly");

    const user = await getUser(
      new Request("http://localhost:3000/app", {
        headers: { Cookie: cookie ?? "" },
      }),
    );
    expect(user).toEqual(testUser);
  });

  it("未認証の場合はログイン画面へ戻り先付きで遷移させる", async () => {
    await expect(
      requireUser(new Request("http://localhost:3000/app?tab=profile")),
    ).rejects.toMatchObject({
      status: 302,
      headers: expect.any(Headers),
    });
  });

  it("認証済みの場合はユーザーを返す", async () => {
    const response = await createUserSession(testUser);
    const request = new Request("http://localhost:3000/app", {
      headers: { Cookie: response.headers.get("Set-Cookie") ?? "" },
    });

    await expect(requireUser(request)).resolves.toEqual(testUser);
  });

  it("App Roleがないユーザーを拒否する", async () => {
    const response = await createUserSession({ ...testUser, roles: [] });
    const request = new Request("http://localhost:3000/app", {
      headers: { Cookie: response.headers.get("Set-Cookie") ?? "" },
    });

    await expect(requireUser(request)).rejects.toMatchObject({ status: 403 });
  });

  it("所属情報がないユーザーを拒否する", async () => {
    const response = await createUserSession({ ...testUser, groups: [] });
    const request = new Request("http://localhost:3000/app", {
      headers: { Cookie: response.headers.get("Set-Cookie") ?? "" },
    });

    await expect(requireUser(request)).rejects.toMatchObject({ status: 403 });
  });

  it("ログアウト時にセッションCookieを破棄する", async () => {
    const response = await createUserSession(testUser);
    const logout = await destroyUserSession(
      new Request("http://localhost:3000/auth/logout", {
        headers: { Cookie: response.headers.get("Set-Cookie") ?? "" },
      }),
    );

    expect(logout.status).toBe(302);
    expect(logout.headers.get("Location")).toBe("/");
    expect(logout.headers.get("Set-Cookie")).toContain(
      "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
    );
  });
});
