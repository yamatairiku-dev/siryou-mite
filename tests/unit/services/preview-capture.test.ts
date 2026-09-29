import { describe, expect, it, vi } from "vitest";
import type { Browser, BrowserContext, Page, Route } from "playwright-core";
import {
  assertSandboxArguments,
  blockAllRequests,
  capturePreviewJpeg,
  createPreviewBrowserLaunchOptions,
  createPreviewContextOptions,
  createPreviewScreenshotOptions,
  InsecureBrowserArgumentsError,
  PREVIEW_BROWSER_ARGS,
  PREVIEW_JPEG_QUALITY_STEPS,
  PREVIEW_RENDER_TIMEOUT_MS,
  PREVIEW_VIEWPORT,
  PreviewTooLargeError,
  SANDBOX_WEAKENING_ARGS,
  type PreviewBrowserLauncher,
} from "../../../services/preview/capture";

/**
 * T18 単体テスト: プレビュー撮影の安全設定(設計 §7.5)。
 *
 * Chromiumを起動せずに検証できる範囲(起動オプション・context設定・要求の遮断・
 * 品質の段階的な引き下げ・後始末)をここで確認する。実際のChromiumでの確認は
 * `tests/integration/preview-capture.test.ts`(Playwright公式browserを使用)で行う。
 */

type FakeBrowser = {
  browser: Browser;
  context: FakeContext;
  closed: () => boolean;
  /** `newContext`が呼ばれた回数(中断後に処理を進めていないことの確認に使う)。 */
  newContextCalls: () => number;
};

type FakeContext = {
  routePatterns: string[];
  routeHandlers: Array<(route: Route) => unknown>;
  setContentCalls: Array<{ html: string; options: unknown }>;
  screenshotCalls: unknown[];
  closed: () => boolean;
  defaultTimeouts: number[];
};

/**
 * 偽のbrowser。`screenshotSizes`は`page.screenshot`が返すbyte数を順に決める
 * (品質を下げる挙動の検証に使う)。
 */
function createFakeBrowser(options: {
  screenshotSizes: number[];
  screenshotError?: Error;
  /** `page.screenshot`の先頭で実行する(撮影中の中断を再現する)。 */
  onScreenshot?: () => void;
}): FakeBrowser {
  let browserClosed = false;
  let contextClosed = false;
  let newContextCalls = 0;
  const routePatterns: string[] = [];
  const routeHandlers: Array<(route: Route) => unknown> = [];
  const setContentCalls: Array<{ html: string; options: unknown }> = [];
  const screenshotCalls: unknown[] = [];
  const defaultTimeouts: number[] = [];
  let screenshotIndex = 0;

  const page = {
    async setContent(html: string, pageOptions: unknown) {
      setContentCalls.push({ html, options: pageOptions });
    },
    async screenshot(screenshotOptions: unknown) {
      screenshotCalls.push(screenshotOptions);
      options.onScreenshot?.();
      if (options.screenshotError) {
        throw options.screenshotError;
      }
      const size =
        options.screenshotSizes[screenshotIndex] ??
        options.screenshotSizes[options.screenshotSizes.length - 1] ??
        0;
      screenshotIndex += 1;
      return Buffer.alloc(size, 0x41);
    },
  } as unknown as Page;

  const context = {
    setDefaultTimeout(timeout: number) {
      defaultTimeouts.push(timeout);
    },
    setDefaultNavigationTimeout(timeout: number) {
      defaultTimeouts.push(timeout);
    },
    async route(pattern: string, handler: (route: Route) => unknown) {
      routePatterns.push(pattern);
      routeHandlers.push(handler);
    },
    async newPage() {
      return page;
    },
    async close() {
      contextClosed = true;
    },
  } as unknown as BrowserContext;

  const browser = {
    async newContext() {
      newContextCalls += 1;
      return context;
    },
    async close() {
      browserClosed = true;
    },
  } as unknown as Browser;

  return {
    browser,
    context: {
      routePatterns,
      routeHandlers,
      setContentCalls,
      screenshotCalls,
      defaultTimeouts,
      closed: () => contextClosed,
    },
    closed: () => browserClosed,
    newContextCalls: () => newContextCalls,
  };
}

function createLauncher(fake: FakeBrowser): {
  launcher: PreviewBrowserLauncher;
  launchOptions: unknown[];
} {
  const launchOptions: unknown[] = [];
  return {
    launcher: {
      async launch(options) {
        launchOptions.push(options);
        return fake.browser;
      },
    },
    launchOptions,
  };
}

describe("Chromium起動オプション(設計 §7.5)", () => {
  it("Chromium sandboxを明示的に有効にする", () => {
    const options = createPreviewBrowserLaunchOptions();

    // Playwrightの`chromiumSandbox`の既定は`false`のため、明示が必須。
    expect(options.chromiumSandbox).toBe(true);
    expect(options.headless).toBe(true);
    expect(options.timeout).toBeGreaterThan(0);
  });

  it("sandboxを無効にする起動引数を含まない", () => {
    const args = createPreviewBrowserLaunchOptions().args ?? [];

    for (const weakening of SANDBOX_WEAKENING_ARGS) {
      expect(args).not.toContain(weakening);
    }
    expect(() => assertSandboxArguments(args)).not.toThrow();
  });

  it("Chromium自身の背景通信を止める引数を含む(設計 §8の外部通信禁止)", () => {
    expect(PREVIEW_BROWSER_ARGS).toContain("--disable-background-networking");
    expect(PREVIEW_BROWSER_ARGS).toContain("--disable-component-update");
    expect(PREVIEW_BROWSER_ARGS).toContain(
      "--disable-client-side-phishing-detection",
    );
  });

  it("sandboxを弱める引数が混入した場合は例外にする(fail closed)", () => {
    expect(() => assertSandboxArguments(["--no-sandbox"])).toThrow(
      InsecureBrowserArgumentsError,
    );
    expect(() =>
      assertSandboxArguments(["--disable-setuid-sandbox=1"]),
    ).toThrow(InsecureBrowserArgumentsError);
  });
});

describe("context設定(設計 §7.5)", () => {
  it("JavaScript無効・service worker無効・offlineで作る", () => {
    const options = createPreviewContextOptions();

    expect(options.javaScriptEnabled).toBe(false);
    expect(options.serviceWorkers).toBe("block");
    expect(options.offline).toBe(true);
    expect(options.bypassCSP).toBe(false);
    expect(options.ignoreHTTPSErrors).toBe(false);
  });

  it("1280x720 viewportを使う", () => {
    expect(createPreviewContextOptions().viewport).toEqual({
      width: 1280,
      height: 720,
    });
    expect(PREVIEW_VIEWPORT).toEqual({ width: 1280, height: 720 });
  });
});

describe("screenshot設定(設計 §7.5)", () => {
  it("viewport範囲だけをJPEGで撮影し、animationを無効にし、白背景にする", () => {
    const options = createPreviewScreenshotOptions(80, PREVIEW_RENDER_TIMEOUT_MS);

    expect(options).toMatchObject({
      type: "jpeg",
      quality: 80,
      fullPage: false,
      animations: "disabled",
      // `omitBackground: false`で透明部分が白になる。
      omitBackground: false,
      timeout: PREVIEW_RENDER_TIMEOUT_MS,
    });
  });
});

describe("capturePreviewJpeg", () => {
  it("すべての要求を中止してから描画する(外部ネットワーク接続なし)", async () => {
    const fake = createFakeBrowser({ screenshotSizes: [1_000] });
    const { launcher, launchOptions } = createLauncher(fake);

    await capturePreviewJpeg("<p>資料</p>", {
      maxBytes: 1024 * 1024,
      launcher,
    });

    expect(fake.context.routePatterns).toEqual(["**/*"]);
    const abort = vi.fn();
    const handler = fake.context.routeHandlers[0];
    expect(handler).toBeDefined();
    handler?.({ abort } as unknown as Route);
    expect(abort).toHaveBeenCalledWith("blockedbyclient");

    // 起動オプションはsandbox有効のものがそのまま渡る。
    expect(launchOptions[0]).toMatchObject({ chromiumSandbox: true });
  });

  it("HTMLをsetContentで流し込み、描画timeoutを設定する(ネットワーク取得しない)", async () => {
    const fake = createFakeBrowser({ screenshotSizes: [1_000] });
    const { launcher } = createLauncher(fake);

    await capturePreviewJpeg("<p>資料</p>", {
      maxBytes: 1024 * 1024,
      launcher,
    });

    expect(fake.context.setContentCalls).toEqual([
      {
        html: "<p>資料</p>",
        options: { waitUntil: "load", timeout: PREVIEW_RENDER_TIMEOUT_MS },
      },
    ]);
    expect(fake.context.defaultTimeouts).toEqual([
      PREVIEW_RENDER_TIMEOUT_MS,
      PREVIEW_RENDER_TIMEOUT_MS,
    ]);
  });

  it("上限byte数に収まるまでJPEG品質を下げる", async () => {
    const fake = createFakeBrowser({ screenshotSizes: [2_000, 1_500, 900] });
    const { launcher } = createLauncher(fake);

    const jpeg = await capturePreviewJpeg("<p>資料</p>", {
      maxBytes: 1_000,
      launcher,
    });

    expect(jpeg.byteLength).toBe(900);
    expect(fake.context.screenshotCalls).toHaveLength(3);
    expect(fake.context.screenshotCalls.map((call) => (call as { quality: number }).quality)).toEqual([
      ...PREVIEW_JPEG_QUALITY_STEPS,
    ]);
  });

  it("最低品質でも上限byte数を超える場合は失敗にする(設計 §7.5)", async () => {
    const fake = createFakeBrowser({ screenshotSizes: [5_000, 4_000, 3_000] });
    const { launcher } = createLauncher(fake);

    await expect(
      capturePreviewJpeg("<p>資料</p>", { maxBytes: 1_000, launcher }),
    ).rejects.toThrow(PreviewTooLargeError);

    // 失敗しても後始末する(Chromiumのプロセスを残さない)。
    expect(fake.context.closed()).toBe(true);
    expect(fake.closed()).toBe(true);
  });

  it("撮影が例外になってもcontextとbrowserを閉じる", async () => {
    const fake = createFakeBrowser({
      screenshotSizes: [],
      screenshotError: new Error("描画に失敗"),
    });
    const { launcher } = createLauncher(fake);

    await expect(
      capturePreviewJpeg("<p>資料</p>", { maxBytes: 1024 * 1024, launcher }),
    ).rejects.toThrow("描画に失敗");

    expect(fake.context.closed()).toBe(true);
    expect(fake.closed()).toBe(true);
  });

  it("成功時もcontextとbrowserを閉じる(処理ごとに破棄できる構成)", async () => {
    const fake = createFakeBrowser({ screenshotSizes: [100] });
    const { launcher } = createLauncher(fake);

    await capturePreviewJpeg("<p>資料</p>", {
      maxBytes: 1024 * 1024,
      launcher,
    });

    expect(fake.context.closed()).toBe(true);
    expect(fake.closed()).toBe(true);
  });
});

describe("撮影の中断(設計 §7.5「1メッセージの処理上限は30秒」)", () => {
  /** rejectされたエラーをそのまま受け取る(DOMExceptionの`name`を確認するため)。 */
  async function captureError(run: Promise<unknown>): Promise<Error> {
    return (await run.then(
      () => new Error("中断されませんでした"),
      (error: unknown) => error as Error,
    )) as Error;
  }

  it("中断済みsignalではbrowserを起動しない", async () => {
    const fake = createFakeBrowser({ screenshotSizes: [100] });
    const { launcher, launchOptions } = createLauncher(fake);

    const error = await captureError(
      capturePreviewJpeg("<p>資料</p>", {
        maxBytes: 1024 * 1024,
        launcher,
        signal: AbortSignal.abort(),
      }),
    );

    // 期限を過ぎてからChromiumを起動しない(設計 §7.5)。
    expect(error.name).toBe("AbortError");
    expect(launchOptions).toHaveLength(0);
    expect(fake.newContextCalls()).toBe(0);
  });

  it("browser起動中に中断された場合は起動したbrowserを閉じて撮影を始めない", async () => {
    const fake = createFakeBrowser({ screenshotSizes: [100] });
    const controller = new AbortController();
    const launcher: PreviewBrowserLauncher = {
      // 起動には最大15秒かかる。その途中で処理上限が切れた状況を再現する。
      async launch() {
        controller.abort();
        await Promise.resolve();
        return fake.browser;
      },
    };

    const error = await captureError(
      capturePreviewJpeg("<p>資料</p>", {
        maxBytes: 1024 * 1024,
        launcher,
        signal: controller.signal,
      }),
    );

    expect(error.name).toBe("AbortError");
    // 起動してしまったbrowserは必ず閉じ、contextも作らない。
    expect(fake.closed()).toBe(true);
    expect(fake.newContextCalls()).toBe(0);
    expect(fake.context.setContentCalls).toEqual([]);
  });

  it("撮影中の中断でbrowserを閉じて撮影を打ち切る", async () => {
    const controller = new AbortController();
    let closedDuringScreenshot = false;
    const fake: FakeBrowser = createFakeBrowser({
      screenshotSizes: [100],
      onScreenshot: () => {
        controller.abort();
        // 中断と同時にbrowserが閉じられる(実際のChromiumでは撮影が失敗する)。
        closedDuringScreenshot = fake.closed();
        throw new Error("Target page, context or browser has been closed");
      },
    });
    const { launcher } = createLauncher(fake);

    const error = await captureError(
      capturePreviewJpeg("<p>資料</p>", {
        maxBytes: 1024 * 1024,
        launcher,
        signal: controller.signal,
      }),
    );

    expect(closedDuringScreenshot).toBe(true);
    expect(error.message).toContain("closed");
    // 中断経路でもcontext・browserを必ず閉じる(Chromiumのプロセスを残さない)。
    expect(fake.context.closed()).toBe(true);
    expect(fake.closed()).toBe(true);
  });

  it("中断されなければsignal付きでも通常どおり撮影する", async () => {
    const fake = createFakeBrowser({ screenshotSizes: [100] });
    const { launcher } = createLauncher(fake);
    const controller = new AbortController();

    const jpeg = await capturePreviewJpeg("<p>資料</p>", {
      maxBytes: 1024 * 1024,
      launcher,
      signal: controller.signal,
    });

    expect(jpeg.byteLength).toBe(100);
    expect(fake.closed()).toBe(true);
    // 撮影後にlistenerを外すため、あとから中断されても何も起きない。
    controller.abort();
  });
});

describe("blockAllRequests", () => {
  it("contextの全要求を中止する", async () => {
    const routes: Array<[string, (route: Route) => unknown]> = [];
    const context = {
      async route(pattern: string, handler: (route: Route) => unknown) {
        routes.push([pattern, handler]);
      },
    } as unknown as BrowserContext;

    await blockAllRequests(context);

    expect(routes).toHaveLength(1);
    expect(routes[0]?.[0]).toBe("**/*");
  });
});
