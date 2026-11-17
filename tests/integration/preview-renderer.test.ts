import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  capturePreviewJpeg,
  PreviewTooLargeError,
} from "../../services/preview/capture.js";
import { capturePreviewRemote } from "../../services/preview/renderer-client.js";
import { createRendererServer } from "../../services/preview-renderer/server.js";

/**
 * 撮影サービスとPreview Jobのクライアントを、実際のChromiumでつないで確認する
 * (設計 §7.5)。dynamic sessionsの管理endpointの代わりに、撮影サービスを直接呼ぶ。
 */
let server: Server;
let endpoint: string;

beforeAll(async () => {
  server = createRendererServer({
    maxHtmlBytes: 1024 * 1024,
    renderTimeoutMs: 30_000,
    render: (html, { maxBytes, signal }) =>
      capturePreviewJpeg(html, { maxBytes, signal }),
    log: () => undefined,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("撮影サービス経由の撮影(実際のChromium)", () => {
  it(
    "HTMLを送り、上限byte数以下のJPEGを受け取る",
    async () => {
      const jpeg = await capturePreviewRemote(
        Buffer.from("<!doctype html><h1>撮影サービスの結合テスト</h1>"),
        AbortSignal.timeout(30_000),
        { endpoint, maxBytes: 1024 * 1024 },
      );

      expect(jpeg.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
      expect(jpeg.byteLength).toBeLessThanOrEqual(1024 * 1024);
    },
    60_000,
  );

  it(
    "上限byte数に収まらない場合はPreviewTooLargeErrorになる",
    async () => {
      await expect(
        capturePreviewRemote(
          Buffer.from("<!doctype html><h1>大きすぎる</h1>"),
          AbortSignal.timeout(30_000),
          { endpoint, maxBytes: 10 },
        ),
      ).rejects.toBeInstanceOf(PreviewTooLargeError);
    },
    60_000,
  );
});
