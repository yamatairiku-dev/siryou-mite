import { afterEach, describe, expect, it, vi } from "vitest";
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

  it("`Admin`だけのユーザーも一般機能を利用できる", async () => {
    const admin = { ...testUser, roles: ["Admin"] };
    const response = await createUserSession(admin);
    const request = new Request("http://localhost:3000/app", {
      headers: { Cookie: response.headers.get("Set-Cookie") ?? "" },
    });

    await expect(requireUser(request)).resolves.toEqual(admin);
  });

  it("未知のroles値を権限として扱わない", async () => {
    const response = await createUserSession({
      ...testUser,
      roles: ["ZAA535-A", "user"],
    });
    const request = new Request("http://localhost:3000/app", {
      headers: { Cookie: response.headers.get("Set-Cookie") ?? "" },
    });

    await expect(requireUser(request)).rejects.toMatchObject({ status: 403 });
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

/**
 * `AUTH_MODE=easyauth`での経路(設計 §7.1)。`env`はmodule読み込み時に確定するため、
 * 環境変数を差し替えてからmoduleを読み直す。
 */
describe("Easy Auth経路のrequireUser", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function loadSessionModule(
    overrides: Record<string, string | undefined> = {},
  ) {
    vi.stubEnv("AUTH_MODE", "easyauth");
    vi.stubEnv("ENTRA_TENANT_ID", "tenant-001");
    for (const [key, value] of Object.entries(overrides)) {
      vi.stubEnv(key, value);
    }
    vi.resetModules();
    return import("~/lib/session.server");
  }

  function principalRequest(claims: Array<{ typ: string; val: string }>) {
    const principal = Buffer.from(
      JSON.stringify({ auth_typ: "aad", claims }),
    ).toString("base64");
    return new Request("http://localhost:3000/app", {
      headers: { "X-MS-CLIENT-PRINCIPAL": principal },
    });
  }

  const validClaims = [
    { typ: "oid", val: "oid-001" },
    { typ: "tid", val: "tenant-001" },
    { typ: "name", val: "テスト利用者" },
    { typ: "preferred_username", val: "user@example.com" },
    { typ: "roles", val: "User" },
    { typ: "groups", val: "ZAA535-A" },
  ];

  it("principal headerから利用者を組み立てる", async () => {
    const { requireUser: requireEasyAuthUser } = await loadSessionModule();

    await expect(
      requireEasyAuthUser(principalRequest(validClaims)),
    ).resolves.toMatchObject({
      id: "oid-001",
      tenantId: "tenant-001",
      roles: ["User"],
      groups: ["ZAA535-A"],
    });
  });

  it("principal headerが無い要求はログイン画面へ遷移させる", async () => {
    const { requireUser: requireEasyAuthUser } = await loadSessionModule();

    await expect(
      requireEasyAuthUser(new Request("http://localhost:3000/app")),
    ).rejects.toMatchObject({ status: 302 });
  });

  it("所属が0件のprincipalをfail closedで拒否する", async () => {
    const { requireUser: requireEasyAuthUser } = await loadSessionModule();
    const claims = validClaims.filter((claim) => claim.typ !== "groups");

    await expect(
      requireEasyAuthUser(principalRequest(claims)),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("group overageのprincipalをfail closedで拒否する", async () => {
    const { requireUser: requireEasyAuthUser } = await loadSessionModule();
    const claims = validClaims
      .filter((claim) => claim.typ !== "groups")
      .concat([{ typ: "_claim_names", val: '{"groups":"src1"}' }]);

    await expect(
      requireEasyAuthUser(principalRequest(claims)),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("tenantが異なるprincipalを拒否する", async () => {
    const { requireUser: requireEasyAuthUser } = await loadSessionModule({
      ENTRA_TENANT_ID: "tenant-999",
    });

    await expect(
      requireEasyAuthUser(principalRequest(validClaims)),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("Easy Authモードではアプリ内セッションを発行しない", async () => {
    const { createUserSession: createEasyAuthSession } =
      await loadSessionModule();

    await expect(createEasyAuthSession(testUser)).rejects.toThrow(
      /ローカル開発専用/,
    );
  });

  it("ログアウトはEasy Authのlogout endpointへ遷移させる", async () => {
    const { destroyUserSession: destroyEasyAuthSession } =
      await loadSessionModule();

    const response = await destroyEasyAuthSession(
      new Request("http://localhost:3000/auth/logout", { method: "POST" }),
    );
    expect(response.headers.get("Location")).toContain("/.auth/logout");
  });
});
