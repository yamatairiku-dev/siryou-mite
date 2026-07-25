import { expect, test } from "@playwright/test";

test("未認証ユーザーが開発ログインしてアプリを表示できる", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", {
      name: "社内業務を、安全で分かりやすいWebアプリに。",
    }),
  ).toBeVisible();

  await page.getByRole("link", { name: "ログインして開始" }).click();
  await page
    .getByRole("button", { name: "開発ユーザーでログイン" })
    .click();

  await expect(
    page.getByRole("heading", { name: "開発ユーザーさん、こんにちは" }),
  ).toBeVisible();
});

test("ヘルスチェックが正常応答する", async ({ request }) => {
  const response = await request.get("/health");
  expect(response.ok()).toBeTruthy();
  await expect(response.json()).resolves.toMatchObject({ status: "ok" });
});
