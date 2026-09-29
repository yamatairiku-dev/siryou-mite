/**
 * 認証・認可のE2E(設計 §18.3, §4.1, §7.1, §7.1.2)。
 *
 * Easy Authのprincipal headerをfixture(`tests/e2e/helpers/principal.ts`)で
 * 再現する。`AUTH_MODE=easyauth`のWebに対し`X-MS-CLIENT-PRINCIPAL`を
 * `extraHTTPHeaders`で送るだけで、アプリ側にテスト専用の分岐は追加しない。
 */
import { expect, test } from "@playwright/test";
import { WRONG_TENANT_ID } from "./helpers/constants.js";
import { createPersona, encodeEasyAuthPrincipal } from "./helpers/principal.js";

test.describe("未ログイン", () => {
  test("保護されたページは/auth/loginへredirectする", async ({ page }) => {
    const response = await page.goto("/app");
    expect(response?.status()).toBe(200); // redirect後の最終応答
    await expect(page).toHaveURL(/\/auth\/login\?returnTo=%2Fapp/);
    await expect(page.getByRole("heading", { name: "ログイン" })).toBeVisible();
  });
});

test.describe("正常なログイン(設計 §4.1, §4.2)", () => {
  test("Userロール・複数所属コードでアプリを利用できる", async ({ browser }) => {
    const user = createPersona({
      namePrefix: "auth-user",
      roles: ["User"],
      groups: ["ZAA535-A", "ZAA777-B"],
    });
    const context = await browser.newContext({
      extraHTTPHeaders: { "X-MS-CLIENT-PRINCIPAL": user.header },
    });
    const page = await context.newPage();

    await page.goto("/app");
    await expect(page.getByRole("heading", { name: "資料一覧" })).toBeVisible();
    await expect(page.getByText(user.email)).toBeVisible();
    // Userロールだけでは管理画面への導線を表示しない(設計 §4.2、表示制御)。
    await expect(
      page.getByRole("link", { name: "管理画面（全資料の検索）" }),
    ).toHaveCount(0);

    await context.close();
  });

  test("Adminロールは管理機能の導線が見え、一般機能も使える", async ({
    browser,
  }) => {
    const admin = createPersona({
      namePrefix: "auth-admin",
      roles: ["Admin"],
      groups: ["ZAA999-A"],
    });
    const context = await browser.newContext({
      extraHTTPHeaders: { "X-MS-CLIENT-PRINCIPAL": admin.header },
    });
    const page = await context.newPage();

    await page.goto("/app");
    await expect(page.getByRole("heading", { name: "資料一覧" })).toBeVisible();
    await expect(
      page.getByRole("link", { name: "管理画面（全資料の検索）" }),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: "監査履歴" })).toBeVisible();

    await context.close();
  });
});

test.describe("fail closedな拒否(設計 §4.1, §7.1, §18.3)", () => {
  test("App Role(User/Admin)が無い要求は403", async ({ browser }) => {
    const noRole = createPersona({
      namePrefix: "no-role",
      roles: [],
      groups: ["ZAA000-A"],
    });
    const context = await browser.newContext({
      extraHTTPHeaders: { "X-MS-CLIENT-PRINCIPAL": noRole.header },
    });
    const page = await context.newPage();

    const response = await page.goto("/app");
    expect(response?.status()).toBe(403);
    await expect(
      page.getByText("このアプリを利用する権限がありません"),
    ).toBeVisible();

    await context.close();
  });

  test("所属(groups)が無い要求は403", async ({ browser }) => {
    const noGroups = createPersona({
      namePrefix: "no-groups",
      roles: ["User"],
      groups: [],
    });
    const context = await browser.newContext({
      extraHTTPHeaders: { "X-MS-CLIENT-PRINCIPAL": noGroups.header },
    });
    const page = await context.newPage();

    const response = await page.goto("/app");
    expect(response?.status()).toBe(403);
    await expect(page.getByText("所属情報を確認できません")).toBeVisible();

    await context.close();
  });

  test("構成と異なるtenantの要求は拒否される", async ({ browser }) => {
    const wrongTenant = createPersona({
      namePrefix: "wrong-tenant",
      roles: ["User"],
      groups: ["ZAA000-A"],
      tenantId: WRONG_TENANT_ID,
    });
    const context = await browser.newContext({
      extraHTTPHeaders: { "X-MS-CLIENT-PRINCIPAL": wrongTenant.header },
    });
    const page = await context.newPage();

    const response = await page.goto("/app");
    // `parseEasyAuthPrincipal`のtenant不一致は401(`unauthorized`)。
    expect(response?.status()).toBe(401);
    await expect(page.getByText("許可されていないテナントです")).toBeVisible();

    await context.close();
  });

  test("必須claim(oid)が欠落した要求は拒否される", async ({ browser }) => {
    const header = encodeEasyAuthPrincipal({
      roles: ["User"],
      groups: ["ZAA000-A"],
      omitObjectId: true,
    });
    const context = await browser.newContext({
      extraHTTPHeaders: { "X-MS-CLIENT-PRINCIPAL": header },
    });
    const page = await context.newPage();

    const response = await page.goto("/app");
    expect(response?.status()).toBe(401);
    await expect(page.getByText("必須の認証クレームがありません")).toBeVisible();

    await context.close();
  });

  test("必須claim(email)が欠落した要求は拒否される", async ({ browser }) => {
    const header = encodeEasyAuthPrincipal({
      roles: ["User"],
      groups: ["ZAA000-A"],
      omitEmail: true,
    });
    const context = await browser.newContext({
      extraHTTPHeaders: { "X-MS-CLIENT-PRINCIPAL": header },
    });
    const page = await context.newPage();

    const response = await page.goto("/app");
    expect(response?.status()).toBe(401);
    await expect(page.getByText("必須の認証クレームがありません")).toBeVisible();

    await context.close();
  });

  test("auth_typがaad以外の要求は拒否される", async ({ browser }) => {
    const header = encodeEasyAuthPrincipal({
      roles: ["User"],
      groups: ["ZAA000-A"],
      authType: "unknown-provider",
    });
    const context = await browser.newContext({
      extraHTTPHeaders: { "X-MS-CLIENT-PRINCIPAL": header },
    });
    const page = await context.newPage();

    const response = await page.goto("/app");
    expect(response?.status()).toBe(401);
    await expect(page.getByText("認証情報を検証できません")).toBeVisible();

    await context.close();
  });
});

test.describe("ログアウト(設計 §5.1)", () => {
  test("ログアウトボタンをクリックするとEasy Authのlogoutへ案内される", async ({
    browser,
  }) => {
    const user = createPersona({
      namePrefix: "logout-click",
      roles: ["User"],
      groups: ["ZAA000-A"],
    });
    const context = await browser.newContext({
      extraHTTPHeaders: { "X-MS-CLIENT-PRINCIPAL": user.header },
    });
    const page = await context.newPage();
    await page.goto("/app");

    await page.getByRole("button", { name: "ログアウト" }).click();
    // Easy Authの`/.auth/logout`はこのE2E環境には実在しない(App Service platform
    // 機能のため)。ブラウザが最終的にそこへ遷移することだけを確認する
    // (実際のセッション破棄はEasy Auth側の責務、設計 §7.1)。
    await page.waitForURL(/\/\.auth\/logout\?post_logout_redirect_uri=/);

    await context.close();
  });
});
