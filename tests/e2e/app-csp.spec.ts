/**
 * Webアプリ(HTML文書応答)のCSPのE2E。
 *
 * CSPはnonce付きのインラインスクリプトしか許可しないため、React Routerの
 * hydrationスクリプトにnonceが付かないと画面が静かに動かなくなる。ここでは
 * ヘッダーが付くことに加え、アップロード(fetch)→資料表示(別オリジンiframeへの
 * hidden form POST)の一連の操作でCSP違反とhydrationの不一致が出ないことを確認する。
 */
import { expect, test } from "@playwright/test";
import { DISPLAY_ORIGIN } from "./helpers/constants.js";
import { plainValidHtml } from "./helpers/html-fixtures.js";
import { createPersona } from "./helpers/principal.js";
import { displayFrameLocator, uploadHtmlViaUi } from "./helpers/upload.js";

test("HTML文書にnonce付きCSPが付き、主要操作でCSP違反・hydration不一致が起きない", async ({
  browser,
}) => {
  const persona = createPersona({
    namePrefix: "csp",
    roles: ["User"],
    groups: ["ZAA535-A"],
  });
  const context = await browser.newContext({
    extraHTTPHeaders: { "X-MS-CLIENT-PRINCIPAL": persona.header },
  });
  const page = await context.newPage();

  const problems: string[] = [];
  page.on("console", (message) => {
    const text = message.text();
    if (
      /Content Security Policy|hydrat/i.test(text) &&
      (message.type() === "error" || message.type() === "warning")
    ) {
      problems.push(text);
    }
  });
  page.on("pageerror", (error) => problems.push(error.message));

  const response = await page.goto("/app");
  // `headers()`はセキュリティ関連のヘッダーを省くことがあるため`allHeaders()`で読む。
  const policy = (await response?.allHeaders())?.["content-security-policy"] ?? "";
  expect(policy).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]+'/);
  // iframeは表示サービスだけ。資料内の外部リンクをiframe内で開かせない(設計 §6.3)。
  expect(policy).toMatch(new RegExp(`frame-src ${DISPLAY_ORIGIN};`));
  expect(policy).not.toContain("unsafe-inline");

  // 要求ごとにnonceが変わる(両方の応答からnonceを取り出して比べる)。
  const noncePattern = /'nonce-([A-Za-z0-9+/=]+)'/;
  const secondPolicy =
    (await page.request.get("/app")).headers()["content-security-policy"] ?? "";
  const firstNonce = noncePattern.exec(policy)?.[1];
  const secondNonce = noncePattern.exec(secondPolicy)?.[1];
  expect(firstNonce).toBeTruthy();
  expect(secondNonce).toBeTruthy();
  expect(secondNonce).not.toBe(firstNonce);

  const title = `CSP資料-${persona.oid.slice(0, 8)}`;
  const result = await uploadHtmlViaUi(page, "csp.html", plainValidHtml(title));
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error("upload failed");
  }

  await page.goto(result.body.documentUrl);
  const frame = displayFrameLocator(page, result.body.documentId);
  await expect(frame.getByText(`${title}の本文です。`)).toBeVisible();

  expect(problems).toEqual([]);
  await context.close();
});
