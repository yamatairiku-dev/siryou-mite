/**
 * アップロード・警告表示・資料表示のE2E(設計 §5.2, §5.3, §5.4, §6.2, §6.3, §9.2, §18.3)。
 */
import { expect, test } from "@playwright/test";
import { APP_ORIGIN } from "./helpers/constants.js";
import { createPersona } from "./helpers/principal.js";
import {
  frameNavigationHtml,
  htmlWithBaseHref,
  htmlWithCustomSchemeLink,
  htmlWithDataSchemeLink,
  htmlWithFileSchemeLink,
  htmlWithRelativeLink,
  plainValidHtml,
  scriptedHtml,
} from "./helpers/html-fixtures.js";
import { displayFrameLocator, uploadHtmlViaUi } from "./helpers/upload.js";

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

test.describe("アップロードと資料表示", () => {
  test("正常なHTMLをアップロードして表示できる", async ({ browser }) => {
    const { persona, context, page } = await newPersonaPage(browser, "upload-ok");
    await page.goto("/app");

    const title = `E2E資料-${persona.oid.slice(0, 8)}`;
    const result = await uploadHtmlViaUi(page, "resource.html", plainValidHtml(title));
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("upload failed");
    }
    expect(result.status).toBe(201);
    expect(result.body.warnings).toEqual([]);

    // 初期画面の一覧にも反映される(設計 §5.2)。
    await expect(page.getByRole("heading", { name: title })).toBeVisible();

    await page.goto(result.body.documentUrl);
    await expect(page.getByRole("heading", { name: title })).toBeVisible();

    const frame = displayFrameLocator(page, result.body.documentId);
    await expect(frame.getByText(`${title}の本文です。`)).toBeVisible();

    await context.close();
  });

  test("警告付きHTMLは警告を表示し、表示時にJavaScriptが実行されず外部通信も発生しない", async ({
    browser,
  }) => {
    const { persona, context, page } = await newPersonaPage(browser, "upload-warn");
    await page.goto("/app");

    const title = `E2E警告-${persona.oid.slice(0, 8)}`;
    const result = await uploadHtmlViaUi(page, "scripted.html", scriptedHtml(title));
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("upload failed");
    }
    expect(result.body.warnings.map((warning) => warning.code).sort()).toEqual(
      ["inline_event_handler", "javascript_url", "script"].sort(),
    );

    // アップロード結果の警告一覧がUIへ表示される(設計 §5.3)。
    await expect(page.getByText("アップロードが完了しました。")).toBeVisible();
    for (const warning of result.body.warnings) {
      await expect(page.getByText(warning.message)).toBeVisible();
    }

    const externalRequests: string[] = [];
    context.on("request", (request) => {
      if (request.url().includes("e2e-should-not-load.example.invalid")) {
        externalRequests.push(request.url());
      }
    });

    await page.goto(result.body.documentUrl);
    const frame = displayFrameLocator(page, result.body.documentId);

    // script-src 'none'によりscriptが実行されないため、マーカーは書き換わらない
    // (設計 §9.2, §9.4)。
    await expect(frame.locator("#marker")).toHaveText("original");
    // scriptが実行されていれば発生するはずのfetchも発生しない(外部resource禁止)。
    expect(externalRequests).toEqual([]);

    await context.close();
  });

  test("CSPヘッダーが設計どおり設定される", async ({ browser }) => {
    const { context, page } = await newPersonaPage(browser, "upload-csp");
    await page.goto("/app");

    const result = await uploadHtmlViaUi(
      page,
      "csp.html",
      plainValidHtml("CSP確認"),
    );
    if (!result.ok) {
      throw new Error("upload failed");
    }

    const displayResponsePromise = page.waitForResponse((response) =>
      response.url().includes("/display"),
    );
    await page.goto(result.body.documentUrl);
    const displayResponse = await displayResponsePromise;
    const csp = displayResponse.headers()["content-security-policy"] ?? "";

    // 設計 §9.2の12ディレクティブを記載順・記載値のまま完全一致で確認する
    // (`toContain`だけだと`sandbox`へ`allow-scripts`等が追記されても検知できない)。
    expect(csp).toBe(
      [
        "default-src 'none'",
        "script-src 'none'",
        "connect-src 'none'",
        "frame-src 'none'",
        "object-src 'none'",
        "form-action 'none'",
        "base-uri 'none'",
        "style-src 'unsafe-inline'",
        "img-src data: blob:",
        "font-src data:",
        `frame-ancestors ${APP_ORIGIN}`,
        "sandbox allow-popups allow-popups-to-escape-sandbox",
      ].join("; "),
    );

    await context.close();
  });

  test("_topと_parentでアプリ画面を遷移できず、_blankは新しいタブで開く", async ({
    browser,
  }) => {
    const { context, page, persona } = await newPersonaPage(
      browser,
      "upload-sandbox",
    );
    await page.goto("/app");

    const targetHref = `${APP_ORIGIN}/health`;
    const title = `frame-nav-${persona.oid.slice(0, 8)}`;
    const result = await uploadHtmlViaUi(
      page,
      "frame-nav.html",
      frameNavigationHtml(title, targetHref),
    );
    if (!result.ok) {
      throw new Error("upload failed");
    }
    expect(
      result.body.warnings.map((warning) => warning.code),
    ).toContain("frame_navigation_disabled");

    await page.goto(result.body.documentUrl);
    const documentViewUrl = page.url();
    const frame = displayFrameLocator(page, result.body.documentId);

    // sandboxに`allow-top-navigation`を含まないため、_top/_parentのクリックは
    // トップ画面(このpage)を遷移させない(設計 §6.3, §9.2)。「起きないこと」の
    // 確認なので、クリックより前にnegative watcherを仕込んでから操作する。
    async function assertClickDoesNotNavigateTopFrame(
      locatorId: string,
    ): Promise<void> {
      const unexpectedNavigation = page
        .waitForURL((url) => url.toString() !== documentViewUrl, {
          timeout: 500,
        })
        .then(() => true)
        .catch(() => false);
      await frame.locator(locatorId).click();
      expect(await unexpectedNavigation).toBe(false);
      expect(page.url()).toBe(documentViewUrl);
    }

    await assertClickDoesNotNavigateTopFrame("#top-link");
    await assertClickDoesNotNavigateTopFrame("#parent-link");

    // `_blank`はallow-popupsにより新しいタブで開く(トップ画面は遷移しない)。
    // `#self-link`(target省略)のクリックはiframe自身の内容を書き換えてしまう
    // ため、iframeの元の内容を使うこのチェックより先に行う。
    const [popup] = await Promise.all([
      context.waitForEvent("page"),
      frame.locator("#blank-link").click(),
    ]);
    await popup.waitForLoadState("load").catch(() => {});
    expect(popup.url()).toBe(targetHref);
    await popup.close();
    expect(page.url()).toBe(documentViewUrl);

    // target省略のリンクは確認画面を経由せず、iframe自身(このsandbox内)が遷移する
    // (設計 §6.3「target省略時とtarget="_self"は同じiframe内で開く」「アプリ独自の
    // 確認画面…は設けない」)。
    const displayFrame = page.frame({
      name: `document-display-${result.body.documentId}`,
    });
    if (!displayFrame) {
      throw new Error("display frame not found");
    }
    const selfFrameNavigation = page.waitForEvent("framenavigated", {
      predicate: (navigatedFrame) => navigatedFrame === displayFrame,
      timeout: 5_000,
    });
    await frame.locator("#self-link").click();
    const navigatedFrame = await selfFrameNavigation;
    expect(navigatedFrame.url()).toBe(targetHref);
    // iframeの遷移であって、トップ画面は変わらない。
    expect(page.url()).toBe(documentViewUrl);

    await context.close();
  });
});

test.describe("アップロード拒否(設計 §6.2, §6.3, §10.2)", () => {
  const rejectionCases: Array<{ name: string; html: string; code: string }> = [
    { name: "data-scheme", html: htmlWithDataSchemeLink("data"), code: "forbidden_link_scheme" },
    { name: "file-scheme", html: htmlWithFileSchemeLink("file"), code: "forbidden_link_scheme" },
    { name: "custom-scheme", html: htmlWithCustomSchemeLink("custom"), code: "forbidden_link_scheme" },
    { name: "relative-link", html: htmlWithRelativeLink("relative"), code: "relative_link" },
    { name: "base-href", html: htmlWithBaseHref("base"), code: "base_href" },
  ];

  for (const testCase of rejectionCases) {
    test(`${testCase.name}を含むHTMLは拒否される(${testCase.code})`, async ({
      browser,
    }) => {
      // ケースごとに別ペルソナ(別oid)にする。1ペルソナへ集約すると
      // `UPLOAD_RATE_LIMIT_PER_MINUTE`(既定5)にちょうど張り付き、ケースを
      // 増やすと無関係な429で失敗するようになるため。
      const { context, page } = await newPersonaPage(
        browser,
        `upload-reject-${testCase.name}`,
      );
      await page.goto("/app");

      const result = await uploadHtmlViaUi(page, `${testCase.name}.html`, testCase.html);
      expect(result.ok).toBe(false);
      if (result.ok) {
        throw new Error("unexpected acceptance");
      }
      expect(result.status).toBe(400);
      const codes = (result.body.rejections ?? []).map((rejection) => rejection.code);
      expect(codes).toContain(testCase.code);

      await context.close();
    });
  }
});
