/**
 * プレビュー画像の撮影(Playwright + Chromium)。
 *
 * 設計: docs/APPLICATION_DESIGN.md §7.5, §8
 *
 * 撮影時の必須条件(設計 §7.5):
 *   - Chromium sandbox有効(`--no-sandbox`を既定にしない)
 *   - JavaScript無効、service worker無効
 *   - 外部ネットワーク接続なし
 *   - 1280x720 viewport、白背景、animation無効、viewport範囲だけをJPEGで撮影
 *   - 描画timeoutは10秒。品質を下げても上限byte数以下にならない場合は失敗にする
 *   - 1回の撮影ごとにbrowserを起動・破棄する(処理ごとに破棄できる構成)
 *
 * 外部ネットワーク接続の遮断は多重に行う。
 *   1. HTMLはBlobから取得した文字列を`page.setContent`で流し込む。ページの取得自体に
 *      ネットワークもfilesystemも使わない(`file://`も開かない)。
 *   2. context単位で`route("**\/*", abort)`を登録し、`<img src="https://...">`や
 *      CSSの`url()`などのsubresource要求をすべて中止する。
 *   3. contextを`offline: true`にして、routeを通らない経路(service worker、
 *      prefetch等)からの通信も遮断する。
 *   4. JavaScriptを無効にして、`fetch`・`XMLHttpRequest`・`WebSocket`などの
 *      スクリプト経由の通信自体を発生させない。
 *   5. browser起動引数でtelemetry・component update・Safe Browsingなど、Chromium
 *      自身が行う背景通信を止める。
 * 本番ではさらにネットワーク側でもegressを禁止する(設計 §8)。
 *
 * このmoduleは環境変数を読まず、値はすべて引数で受け取る。`playwright-core`は
 * 既定のlauncherを使うときだけ動的importするため、launcherを注入する単体テストは
 * Chromiumを必要としない。
 */
import type {
  Browser,
  BrowserContext,
  BrowserContextOptions,
  LaunchOptions,
  Page,
} from "playwright-core";

/** 撮影viewport(設計 §7.5)。 */
export const PREVIEW_VIEWPORT = { width: 1280, height: 720 } as const;

/** 描画timeout(ms、設計 §7.5「描画timeoutは10秒」)。 */
export const PREVIEW_RENDER_TIMEOUT_MS = 10_000;

/** browser起動のtimeout(ms)。起動できない場合に待ち続けない(設計 §14)。 */
export const PREVIEW_BROWSER_LAUNCH_TIMEOUT_MS = 15_000;

/**
 * JPEG品質の段階。上限byte数(既定1MB、設計 §6.1)に収まるまで順に下げる。
 * 最後の品質でも収まらない場合は`PreviewTooLargeError`にする(設計 §7.5)。
 */
export const PREVIEW_JPEG_QUALITY_STEPS = [80, 60, 40] as const;

/**
 * Chromiumの起動引数。
 *
 * **`--no-sandbox`・`--disable-setuid-sandbox`・`--disable-dev-shm-usage`のような
 * sandboxを弱める引数は入れない**(設計 §7.5「sandbox無効でしか起動できない構成は
 * 採用しない」)。ここに並べるのは、Chromium自身が行う背景通信を止める引数と、
 * 撮影結果を安定させる引数だけにする。
 */
export const PREVIEW_BROWSER_ARGS = [
  // Chromium自身の背景通信(telemetry、component update、Safe Browsing等)を止める。
  "--disable-background-networking",
  "--disable-component-update",
  "--disable-client-side-phishing-detection",
  "--disable-domain-reliability",
  "--disable-sync",
  "--no-default-browser-check",
  "--no-first-run",
  "--metrics-recording-only",
  // 撮影結果を安定させる。
  "--force-color-profile=srgb",
  "--hide-scrollbars",
  "--mute-audio",
] as const;

/** sandboxを弱める引数(混入していないことを検証するために公開する)。 */
export const SANDBOX_WEAKENING_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-seccomp-filter-sandbox",
  "--disable-gpu-sandbox",
  "--no-zygote",
] as const;

/** 品質を下げても上限byte数に収まらなかった場合(設計 §7.5)。 */
export class PreviewTooLargeError extends Error {
  constructor() {
    super("プレビュー画像が上限byte数を超えています");
    this.name = "PreviewTooLargeError";
  }
}

/** 起動引数にsandboxを弱める値が混入していた場合(fail closed)。 */
export class InsecureBrowserArgumentsError extends Error {
  constructor() {
    super("Chromium sandboxを無効にする起動引数は使用できません");
    this.name = "InsecureBrowserArgumentsError";
  }
}

/**
 * `chromium`(`playwright-core`の`BrowserType`)が満たす最小のインターフェース。
 * 単体テストでは偽のlauncherを注入し、Chromiumを起動せずに設定値を検証する。
 */
export type PreviewBrowserLauncher = {
  launch(options: LaunchOptions): Promise<Browser>;
};

/**
 * browser起動オプション。Chromium sandboxを**明示的に有効**にする。
 *
 * Playwrightの`chromiumSandbox`の既定値は`false`(内部で`--no-sandbox`相当)のため、
 * 指定を省略するとsandbox無効で動いてしまう。設計 §7.5 の必須条件であり、
 * ここでは必ず`true`を渡す。
 */
export function createPreviewBrowserLaunchOptions(): LaunchOptions {
  const args = [...PREVIEW_BROWSER_ARGS];
  assertSandboxArguments(args);

  return {
    headless: true,
    chromiumSandbox: true,
    args,
    timeout: PREVIEW_BROWSER_LAUNCH_TIMEOUT_MS,
    // SIGINT・SIGTERM・SIGHUPでbrowserを閉じるPlaywrightの既定動作はそのまま使う
    // (Jobが停止要求を受けたときにChromiumのプロセスを残さないため)。
  };
}

/** sandboxを弱める起動引数が含まれていないことを確認する。 */
export function assertSandboxArguments(args: readonly string[]): void {
  const weakening = new Set<string>(SANDBOX_WEAKENING_ARGS);
  for (const arg of args) {
    // `--disable-features=...`のような値付き引数も名前部分で判定する。
    const name = arg.split("=")[0] ?? arg;
    if (weakening.has(name)) {
      throw new InsecureBrowserArgumentsError();
    }
  }
}

/**
 * context作成オプション(設計 §7.5)。
 *
 * - `javaScriptEnabled: false`: ページのJavaScriptを実行しない
 * - `serviceWorkers: "block"`: service workerを登録させない
 * - `offline: true`: routeを通らない経路も含めて外部通信を遮断する
 * - `reducedMotion: "reduce"`・`colorScheme: "light"`: 描画を安定させる
 */
export function createPreviewContextOptions(): BrowserContextOptions {
  return {
    viewport: { ...PREVIEW_VIEWPORT },
    deviceScaleFactor: 1,
    javaScriptEnabled: false,
    serviceWorkers: "block",
    offline: true,
    colorScheme: "light",
    forcedColors: "none",
    reducedMotion: "reduce",
    acceptDownloads: false,
    // 利用者のHTMLがCSPを持つ場合もそのまま適用する(迂回しない)。
    bypassCSP: false,
    ignoreHTTPSErrors: false,
    permissions: [],
    locale: "ja-JP",
    timezoneId: "Asia/Tokyo",
  };
}

/**
 * screenshotオプション(設計 §7.5)。
 *
 * - `fullPage: false`: viewport範囲だけを撮影する
 * - `omitBackground: false`: 透明部分を白で塗る(白背景)
 * - `animations: "disabled"`: CSS animation/transitionを止める
 */
export function createPreviewScreenshotOptions(
  quality: number,
  renderTimeoutMs: number,
): Parameters<Page["screenshot"]>[0] {
  return {
    type: "jpeg",
    quality,
    fullPage: false,
    omitBackground: false,
    animations: "disabled",
    caret: "hide",
    scale: "css",
    timeout: renderTimeoutMs,
  };
}

export type CapturePreviewOptions = {
  /** プレビュー画像1件あたりの上限byte数(設計 §6.1)。 */
  maxBytes: number;
  /** 省略時は`PREVIEW_RENDER_TIMEOUT_MS`(10秒)。 */
  renderTimeoutMs?: number;
  /** 省略時は`playwright-core`のChromium。単体テストでは偽のlauncherを渡す。 */
  launcher?: PreviewBrowserLauncher;
  /** 省略時は`PREVIEW_JPEG_QUALITY_STEPS`。 */
  qualitySteps?: readonly number[];
  /**
   * 呼び出し側の中断signal(任意)。1メッセージの処理上限(設計 §7.5)を超えたときに
   * browserを閉じて撮影を打ち切るために使う。中断済みの状態で呼ばれた場合は
   * browserを起動しない。
   */
  signal?: AbortSignal;
};

/**
 * HTML文字列から1280x720のJPEGプレビューを撮影する。
 *
 * 1回の呼び出しごとにbrowserを起動し、必ず閉じる(設計 §7.5「処理ごとに破棄できる
 * 構成」)。例外時もcontext・browserを閉じるため、Chromiumのプロセスが残らない。
 */
export async function capturePreviewJpeg(
  html: string,
  options: CapturePreviewOptions,
): Promise<Buffer> {
  const renderTimeoutMs = options.renderTimeoutMs ?? PREVIEW_RENDER_TIMEOUT_MS;
  const qualitySteps = options.qualitySteps ?? PREVIEW_JPEG_QUALITY_STEPS;
  // 中断済みならChromiumを起動しない(期限超過後に新しい処理を始めない)。
  options.signal?.throwIfAborted();
  const launcher = options.launcher ?? (await loadChromiumLauncher());

  const browser: Browser = await launcher.launch(
    createPreviewBrowserLaunchOptions(),
  );

  // 中断されたらbrowserを閉じ、進行中の描画・撮影を失敗させる。`finally`の
  // `browser.close()`は冪等に呼べる。
  const abortBrowser = (): void => {
    void Promise.resolve(browser.close()).catch(() => undefined);
  };
  options.signal?.addEventListener("abort", abortBrowser, { once: true });

  try {
    const context: BrowserContext = await browser.newContext(
      createPreviewContextOptions(),
    );

    try {
      context.setDefaultTimeout(renderTimeoutMs);
      context.setDefaultNavigationTimeout(renderTimeoutMs);
      await blockAllRequests(context);

      const page: Page = await context.newPage();
      options.signal?.throwIfAborted();
      await page.setContent(html, {
        waitUntil: "load",
        timeout: renderTimeoutMs,
      });
      options.signal?.throwIfAborted();

      return await screenshotWithinLimit(page, {
        maxBytes: options.maxBytes,
        qualitySteps,
        renderTimeoutMs,
      });
    } finally {
      await context.close().catch(() => undefined);
    }
  } finally {
    options.signal?.removeEventListener("abort", abortBrowser);
    await browser.close();
  }
}

/**
 * contextのすべての要求を中止する(設計 §7.5「外部ネットワーク接続なし」)。
 *
 * `page.setContent`で流し込むHTML自体はネットワーク要求を伴わないため、ここで
 * 中止されるのはHTMLが参照するsubresource(画像、CSS、フォント、iframeなど)だけ。
 * 中止する要求のURLはログへ出さない(設計 §15.2「リンクの完全なURLを記録しない」)。
 */
export async function blockAllRequests(context: BrowserContext): Promise<void> {
  await context.route("**/*", (route) => {
    void route.abort("blockedbyclient");
  });
}

/**
 * 上限byte数に収まるまでJPEG品質を下げて撮影する。最後の品質でも収まらない場合は
 * `PreviewTooLargeError`(設計 §7.5「品質を下げても1MB以下にならない場合は`failed`」)。
 */
async function screenshotWithinLimit(
  page: Page,
  options: {
    maxBytes: number;
    qualitySteps: readonly number[];
    renderTimeoutMs: number;
  },
): Promise<Buffer> {
  for (const quality of options.qualitySteps) {
    const screenshot = await page.screenshot(
      createPreviewScreenshotOptions(quality, options.renderTimeoutMs),
    );
    const jpeg = Buffer.from(screenshot);
    if (jpeg.byteLength <= options.maxBytes) {
      return jpeg;
    }
  }

  throw new PreviewTooLargeError();
}

/**
 * Chromiumのlauncherを読み込む。
 *
 * `playwright-core`は撮影を実行するときだけ読み込む。browser binaryはPreview専用
 * image(`Dockerfile.preview`のPlaywright公式image)が持つ(設計 §7.5, §7.6)。
 */
async function loadChromiumLauncher(): Promise<PreviewBrowserLauncher> {
  const { chromium } = await import("playwright-core");
  return chromium;
}
