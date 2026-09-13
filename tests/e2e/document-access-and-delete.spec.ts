/**
 * 資料へのアクセス制御と削除のE2E(設計 §4.2, §5.2, §5.4, §5.5, §10.4, §18.3)。
 */
import { expect, test } from "@playwright/test";
import { createPersona } from "./helpers/principal.js";
import { plainValidHtml } from "./helpers/html-fixtures.js";
import { uploadHtmlViaUi } from "./helpers/upload.js";

async function newPersonaPage(
  browser: import("@playwright/test").Browser,
  namePrefix: string,
) {
  const persona = createPersona({
    namePrefix,
    roles: ["User"],
    groups: ["ZAA535-A"],
  });
  const context = await browser.newContext({
    extraHTTPHeaders: { "X-MS-CLIENT-PRINCIPAL": persona.header },
  });
  const page = await context.newPage();
  return { persona, context, page };
}

test("URLを知っている別ユーザーは資料を閲覧でき、一覧には出ない", async ({
  browser,
}) => {
  const owner = await newPersonaPage(browser, "owner-view");
  await owner.page.goto("/app");
  const title = `別ユーザー閲覧-${owner.persona.oid.slice(0, 8)}`;
  const uploadResult = await uploadHtmlViaUi(owner.page, "shared.html", plainValidHtml(title));
  if (!uploadResult.ok) {
    throw new Error("upload failed");
  }

  const other = await newPersonaPage(browser, "other-view");
  const response = await other.page.goto(uploadResult.body.documentUrl);
  expect(response?.status()).toBe(200);
  await expect(
    other.page.getByRole("heading", { name: title }),
  ).toBeVisible();

  // 他人の資料はURLを知らない限り一覧に出ない(設計 §4.2「他人の資料一覧・検索は不可」)。
  await other.page.goto("/app");
  await expect(other.page.getByText(title)).toHaveCount(0);
  await expect(other.page.getByText("まだ資料がありません。")).toBeVisible();

  await owner.context.close();
  await other.context.close();
});

test("オーナーは資料を削除でき、削除後は誰も閲覧できない", async ({
  browser,
}) => {
  const owner = await newPersonaPage(browser, "owner-delete");
  await owner.page.goto("/app");
  const title = `削除確認-${owner.persona.oid.slice(0, 8)}`;
  const uploadResult = await uploadHtmlViaUi(owner.page, "todelete.html", plainValidHtml(title));
  if (!uploadResult.ok) {
    throw new Error("upload failed");
  }

  const other = await newPersonaPage(browser, "other-delete-check");
  const beforeDelete = await other.page.goto(uploadResult.body.documentUrl);
  expect(beforeDelete?.status()).toBe(200);

  await owner.page.goto(`${uploadResult.body.documentUrl}/delete`);
  await expect(
    owner.page.getByRole("heading", { name: "資料を削除しますか？" }),
  ).toBeVisible();
  await expect(owner.page.getByRole("heading", { name: title })).toBeVisible();

  await owner.page.getByRole("button", { name: "削除する" }).click();
  await owner.page.waitForURL(/\/app$/);

  const afterOwner = await owner.page.goto(uploadResult.body.documentUrl);
  expect(afterOwner?.status()).toBe(404);

  const afterOther = await other.page.goto(uploadResult.body.documentUrl);
  expect(afterOther?.status()).toBe(404);

  await owner.context.close();
  await other.context.close();
});

test("一般ユーザーは他人の資料を削除できない", async ({ browser }) => {
  const owner = await newPersonaPage(browser, "owner-protect");
  await owner.page.goto("/app");
  const title = `他人削除拒否-${owner.persona.oid.slice(0, 8)}`;
  const uploadResult = await uploadHtmlViaUi(
    owner.page,
    "protected.html",
    plainValidHtml(title),
  );
  if (!uploadResult.ok) {
    throw new Error("upload failed");
  }

  const stranger = await newPersonaPage(browser, "stranger-delete");
  const confirmResponse = await stranger.page.goto(
    `${uploadResult.body.documentUrl}/delete`,
  );
  expect(confirmResponse?.status()).toBe(403);
  await expect(
    stranger.page.getByText("この資料を削除する権限がありません"),
  ).toBeVisible();

  // 確認画面を経由しない直接POSTも同じ認可(requireDocumentDeletionScope)で拒否される。
  const appOrigin = new URL(owner.page.url()).origin;
  const postResponse = await stranger.context.request.post(
    `${uploadResult.body.documentUrl}/delete`,
    { headers: { Origin: appOrigin } },
  );
  expect(postResponse.status()).toBe(403);
  // 直接POSTはSSRの通常document応答(root ErrorBoundary)になるため、
  // メッセージが本文へ含まれることを確認する(`toBe`はHTML全文になり脆いため使わない)。
  await expect(postResponse.text()).resolves.toContain(
    "この資料を削除する権限がありません",
  );

  // Originヘッダーが無い(または不一致の)POSTは、認可の判定より前に
  // `assertSameOrigin`が拒否する(CSRF対策、AGENTS.md 7項)。owner本人でも拒否される
  // ことで、資料の所有権と同一オリジン検証が別レイヤーであることを確認する。
  const csrfResponse = await owner.context.request.post(
    `${uploadResult.body.documentUrl}/delete`,
  );
  expect(csrfResponse.status()).toBe(403);
  await expect(csrfResponse.text()).resolves.toContain("不正なリクエストです");

  const stillThere = await owner.page.goto(uploadResult.body.documentUrl);
  expect(stillThere?.status()).toBe(200);

  await owner.context.close();
  await stranger.context.close();
});
