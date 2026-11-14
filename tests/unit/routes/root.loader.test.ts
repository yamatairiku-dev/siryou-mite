import { describe, expect, it } from "vitest";
import { loader } from "~/root";
import { createUserSession, type AppUser } from "~/lib/session.server";

/**
 * ヘッダーの管理画面への導線は`Admin`ロールを持つ利用者にだけ表示する
 * (設計 §5.6, §5.7)。表示制御であって認可ではなく、管理画面のloaderが
 * `requireAdmin`で判定し直す(設計 §4.2)。
 */

function userWith(roles: AppUser["roles"]): AppUser {
  return {
    id: "oid-root-test",
    tenantId: "tenant-001",
    name: "利用者 太郎",
    email: "user@example.com",
    roles,
    groups: ["ZAA535-A"],
  };
}

async function load(user?: AppUser) {
  const headers: Record<string, string> = {};
  if (user) {
    const response = await createUserSession(user);
    headers.Cookie = response.headers.get("Set-Cookie") ?? "";
  }
  return loader({
    request: new Request("http://localhost:3000/app", { headers }),
  } as unknown as Parameters<typeof loader>[0]);
}

describe("root loader", () => {
  it("未ログインでは管理画面への導線を出さない", async () => {
    const data = await load();
    expect(data.user).toBeNull();
    expect(data.canUseAdminScreen).toBe(false);
  });

  it("Userロールだけでは管理画面への導線を出さない", async () => {
    expect((await load(userWith(["User"]))).canUseAdminScreen).toBe(false);
  });

  it("Adminロールがあれば管理画面への導線を出す", async () => {
    expect((await load(userWith(["Admin"]))).canUseAdminScreen).toBe(true);
  });
});
