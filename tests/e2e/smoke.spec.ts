import { expect, test } from "@playwright/test";
import { DISPLAY_ORIGIN } from "./helpers/constants.js";
import { createPersona } from "./helpers/principal.js";

test("未認証ユーザーはホームからログイン導線へ進める", async ({ page }) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", {
      // 句ごとのinline-blockの間に、アクセシブルネームでは空白が入る。
      name: /^その資料、\s*URLで「みて！」と\s*送ろう。$/,
    }),
  ).toBeVisible();

  await page.getByRole("link", { name: "ログインして始める" }).click();
  await expect(page.getByRole("heading", { name: "ログイン" })).toBeVisible();
  await expect(page.getByText("Microsoftでログイン")).toBeVisible();
});

test("Easy Authのprincipal headerがあればアプリ画面を表示できる", async ({
  browser,
}) => {
  const user = createPersona({
    namePrefix: "smoke-user",
    roles: ["User"],
    groups: ["ZAA000-A"],
  });
  const context = await browser.newContext({
    extraHTTPHeaders: { "X-MS-CLIENT-PRINCIPAL": user.header },
  });
  const page = await context.newPage();

  await page.goto("/app");
  await expect(page.getByRole("heading", { name: "資料一覧" })).toBeVisible();
  await expect(page.getByText(user.email)).toBeVisible();

  await context.close();
});

test("Webのヘルスチェックが正常応答する", async ({ request }) => {
  const response = await request.get("/health");
  expect(response.ok()).toBeTruthy();
  await expect(response.json()).resolves.toMatchObject({ status: "ok" });
});

test("Displayのヘルスチェックが正常応答する", async ({ request }) => {
  const response = await request.get(`${DISPLAY_ORIGIN}/health`);
  expect(response.ok()).toBeTruthy();
});
