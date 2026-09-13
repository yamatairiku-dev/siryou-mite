/**
 * 管理画面・監査履歴のE2E(設計 §4.2, §5.6, §5.7, §18.3)。
 */
import { expect, test } from "@playwright/test";
import { createPersona } from "./helpers/principal.js";
import { plainValidHtml } from "./helpers/html-fixtures.js";
import { uploadHtmlViaUi } from "./helpers/upload.js";

async function newPersonaPage(
  browser: import("@playwright/test").Browser,
  options: { namePrefix: string; roles: string[]; groups?: string[] },
) {
  const persona = createPersona({
    namePrefix: options.namePrefix,
    roles: options.roles,
    groups: options.groups ?? ["ZAA535-A"],
  });
  const context = await browser.newContext({
    extraHTTPHeaders: { "X-MS-CLIENT-PRINCIPAL": persona.header },
  });
  const page = await context.newPage();
  return { persona, context, page };
}

test("一般ユーザーは管理画面と監査履歴画面を利用できない", async ({
  browser,
}) => {
  const user = await newPersonaPage(browser, {
    namePrefix: "admin-denied",
    roles: ["User"],
  });

  const documentsResponse = await user.page.goto("/admin/documents");
  expect(documentsResponse?.status()).toBe(403);

  const auditResponse = await user.page.goto("/admin/audit");
  expect(auditResponse?.status()).toBe(403);

  await user.context.close();
});

test("管理者は資料を検索・閲覧・強制削除でき、監査履歴を確認できる", async ({
  browser,
}) => {
  const owner = await newPersonaPage(browser, {
    namePrefix: "admin-owner",
    roles: ["User"],
    groups: ["ZAA535-A", "ZAA777-B"],
  });
  await owner.page.goto("/app");
  const title = `管理者検証-${owner.persona.oid.slice(0, 8)}`;
  const uploadResult = await uploadHtmlViaUi(
    owner.page,
    "admin-target.html",
    plainValidHtml(title),
  );
  if (!uploadResult.ok) {
    throw new Error("upload failed");
  }

  const admin = await newPersonaPage(browser, {
    namePrefix: "admin-actor",
    roles: ["Admin"],
    groups: ["ZAA999-A"],
  });

  // 検索(設計 §5.6): オーナーのメールアドレスで絞り込める。
  await admin.page.goto(
    `/admin/documents?ownerEmail=${encodeURIComponent(owner.persona.email)}`,
  );
  await expect(admin.page.getByRole("heading", { name: title })).toBeVisible();
  await expect(admin.page.getByText(owner.persona.email)).toBeVisible();

  // 閲覧(設計 §5.6): URLを知っているログイン済み利用者として閲覧できる。
  const displayResponsePromise = admin.page.waitForResponse((response) =>
    response.url().includes("/display"),
  );
  const viewResponse = await admin.page.goto(uploadResult.body.documentUrl);
  expect(viewResponse?.status()).toBe(200);
  // 閲覧監査はDisplayがHTMLを返す直前に保存される(設計 §10.3(6))ため、
  // hidden formのPOSTが完了するまで待つ。
  await displayResponsePromise;

  // 強制削除(設計 §5.6, §5.5): 確認画面を経由してから削除する。
  await admin.page.goto(`${uploadResult.body.documentUrl}/delete`);
  await expect(
    admin.page.getByRole("heading", { name: "資料を削除しますか？" }),
  ).toBeVisible();
  await admin.page.getByRole("button", { name: "削除する" }).click();
  await admin.page.waitForURL(/\/app$/);

  const afterDelete = await owner.page.goto(uploadResult.body.documentUrl);
  expect(afterDelete?.status()).toBe(404);

  // 監査履歴(設計 §5.7): アップロード・閲覧・削除のいずれも資料IDで追跡できる。
  await admin.page.goto(
    `/admin/audit?documentId=${uploadResult.body.documentId}`,
  );
  await expect(
    admin.page.getByRole("heading", { name: "アップロード／成功" }),
  ).toBeVisible();
  await expect(
    admin.page.getByRole("heading", { name: "閲覧／成功" }),
  ).toBeVisible();
  await expect(
    admin.page.getByRole("heading", { name: "削除／成功" }),
  ).toBeVisible();

  // アップロード監査行に、複数所属コードがそのまま記録されていること
  // (設計 §7.1.2「複数`groups`の抽出」)。
  await expect(admin.page.getByText("ZAA535-A、ZAA777-B")).toBeVisible();

  await owner.context.close();
  await admin.context.close();
});

test("一般ユーザーは他人の資料の強制削除相当の操作もできない", async ({
  browser,
}) => {
  const owner = await newPersonaPage(browser, {
    namePrefix: "admin-protect-owner",
    roles: ["User"],
  });
  await owner.page.goto("/app");
  const uploadResult = await uploadHtmlViaUi(
    owner.page,
    "protected-admin.html",
    plainValidHtml("一般ユーザー保護"),
  );
  if (!uploadResult.ok) {
    throw new Error("upload failed");
  }

  const stranger = await newPersonaPage(browser, {
    namePrefix: "admin-protect-stranger",
    roles: ["User"],
  });
  const response = await stranger.page.goto(`${uploadResult.body.documentUrl}/delete`);
  expect(response?.status()).toBe(403);

  await owner.context.close();
  await stranger.context.close();
});
