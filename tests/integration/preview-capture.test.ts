import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium } from "playwright-core";
import {
  capturePreviewJpeg,
  createPreviewBrowserLaunchOptions,
  createPreviewContextOptions,
  PREVIEW_VIEWPORT,
  PreviewTooLargeError,
} from "../../services/preview/capture.js";

/**
 * T18 結合テスト: 実際のChromiumでの撮影(設計 §7.5)。
 *
 * 単体テスト(`tests/unit/services/preview-capture.test.ts`)は設定値の検証までで、
 * ここでは実際のChromium(Playwright公式browser)を起動して次を確認する。
 *   - Chromium sandbox有効のまま起動できること(`--no-sandbox`を使わない)
 *   - HTMLが参照する外部URLへ実際に接続しないこと(ローカルHTTPサーバーで観測する)
 *   - JavaScriptが実行されないこと
 *   - 1280x720 viewport範囲のJPEGになること
 *   - 品質を下げても上限byte数に収まらない場合は失敗になること
 */

/** 外部通信の観測用サーバー。受けた要求数だけを数える(内容は記録しない)。 */
let server: Server;
let requestCount = 0;
let serverOrigin: string;

beforeAll(async () => {
  server = createServer((_request, response) => {
    requestCount += 1;
    response.writeHead(200, { "Content-Type": "image/png" });
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  serverOrigin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
});

/** JPEGのSOFマーカーから画素サイズを読む(画像デコーダーを追加しないため)。 */
function readJpegSize(jpeg: Buffer): { width: number; height: number } {
  let offset = 2;
  while (offset + 9 < jpeg.byteLength) {
    if (jpeg[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = jpeg[offset + 1] ?? 0;
    const isStartOfFrame =
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc;
    if (isStartOfFrame) {
      return {
        height: jpeg.readUInt16BE(offset + 5),
        width: jpeg.readUInt16BE(offset + 7),
      };
    }
    offset += 2 + jpeg.readUInt16BE(offset + 2);
  }
  throw new Error("JPEGのサイズを読み取れませんでした");
}

describe("capturePreviewJpeg(実際のChromium)", () => {
  it(
    "Chromium sandbox有効のまま1280x720のJPEGを撮影する(設計 §7.5)",
    async () => {
      const jpeg = await capturePreviewJpeg(
        "<!doctype html><html><body><h1>結合テスト資料</h1></body></html>",
        { maxBytes: 1024 * 1024 },
      );

      // JPEGのSOIマーカー。
      expect(jpeg.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
      expect(jpeg.byteLength).toBeLessThanOrEqual(1024 * 1024);
      expect(readJpegSize(jpeg)).toEqual({
        width: PREVIEW_VIEWPORT.width,
        height: PREVIEW_VIEWPORT.height,
      });
      // 起動オプションにsandboxを無効にする値が入っていないこと。
      expect(createPreviewBrowserLaunchOptions().chromiumSandbox).toBe(true);
    },
    60_000,
  );

  it(
    "HTMLが参照する外部URLへ接続しない(設計 §7.5「外部ネットワーク接続なし」)",
    async () => {
      // まずサーバー自体が到達可能であることを確かめる(遮断の観測が有効な前提)。
      const probe = await fetch(`${serverOrigin}/probe.png`);
      expect(probe.status).toBe(200);
      const countAfterProbe = requestCount;
      expect(countAfterProbe).toBeGreaterThan(0);

      const html = `<!doctype html><html><head>
        <link rel="stylesheet" href="${serverOrigin}/style.css">
        <style>body { background-image: url("${serverOrigin}/bg.png"); }</style>
        </head><body>
        <img src="${serverOrigin}/tracker.png" alt="">
        <iframe src="${serverOrigin}/frame.html"></iframe>
        </body></html>`;

      const jpeg = await capturePreviewJpeg(html, { maxBytes: 1024 * 1024 });

      expect(jpeg.byteLength).toBeGreaterThan(0);
      // 撮影中にサーバーは1件も要求を受けていない。
      expect(requestCount).toBe(countAfterProbe);
    },
    60_000,
  );

  it(
    "品質を下げても上限byte数に収まらない場合は失敗にする(設計 §7.5)",
    async () => {
      await expect(
        capturePreviewJpeg(
          `<!doctype html><html><body style="margin:0">
             <div style="width:1280px;height:720px;background:linear-gradient(45deg,#f00,#0f0,#00f,#ff0,#0ff)"></div>
           </body></html>`,
          { maxBytes: 512 },
        ),
      ).rejects.toThrow(PreviewTooLargeError);
    },
    60_000,
  );
});

describe("context設定(実際のChromium)", () => {
  it(
    "JavaScriptを実行しない(設計 §7.5)",
    async () => {
      const browser = await chromium.launch(createPreviewBrowserLaunchOptions());

      try {
        const context = await browser.newContext(createPreviewContextOptions());
        const page = await context.newPage();

        await page.setContent(
          `<!doctype html><html><head><title>元のタイトル</title></head>
           <body><p id="text">本文</p>
           <script>
             document.title = "スクリプトが実行された";
             document.getElementById("text").textContent = "スクリプトが実行された";
           </script></body></html>`,
          { waitUntil: "load" },
        );

        // Playwright自身の評価は動くが、ページのスクリプトは実行されていない。
        expect(await page.title()).toBe("元のタイトル");
        expect(await page.locator("#text").innerText()).toBe("本文");

        await context.close();
      } finally {
        await browser.close();
      }
    },
    60_000,
  );
});
