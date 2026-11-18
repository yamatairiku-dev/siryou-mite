import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PreviewTooLargeError } from "../../../services/preview/capture";
import { parseRendererEnvironment } from "../../../services/preview-renderer/env";
import {
  createRendererServer,
  parseMaxPreviewBytes,
  type RendererServerOptions,
} from "../../../services/preview-renderer/server";

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

let server: Server | undefined;

async function start(
  overrides: Partial<RendererServerOptions> = {},
): Promise<{ origin: string; logs: Array<[string, Record<string, string>]> }> {
  const logs: Array<[string, Record<string, string>]> = [];
  server = createRendererServer({
    maxHtmlBytes: 1024,
    renderTimeoutMs: 5_000,
    render: async () => jpeg,
    log: (event, details) => logs.push([event, details]),
    ...overrides,
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${port}`, logs };
}

afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});

function render(
  origin: string,
  body: string,
  headers: Record<string, string> = { "X-Max-Preview-Bytes": "1048576" },
): Promise<Response> {
  return fetch(`${origin}/render?identifier=abc`, {
    method: "POST",
    headers: { "Content-Type": "text/html; charset=utf-8", ...headers },
    body,
  });
}

describe("撮影サービスの経路(設計 §7.5)", () => {
  it("GET /health に応答する", async () => {
    const { origin } = await start();
    const response = await fetch(`${origin}/health`);
    expect(response.status).toBe(200);
  });

  it("GET /render は405、その他の経路は404", async () => {
    const { origin } = await start();
    expect((await fetch(`${origin}/render`)).status).toBe(405);
    expect((await fetch(`${origin}/`)).status).toBe(404);
    expect((await fetch(`${origin}/.env`)).status).toBe(404);
  });

  it("HTMLをUTF-8で撮影し、JPEGを返す(クエリのidentifierは無視する)", async () => {
    const renderSpy = vi.fn(async () => jpeg);
    const { origin, logs } = await start({ render: renderSpy });

    const response = await render(origin, "<h1>資料</h1>");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(jpeg);
    expect(renderSpy).toHaveBeenCalledWith(
      "<h1>資料</h1>",
      expect.objectContaining({ maxBytes: 1048576 }),
    );
    expect(logs).toEqual([["preview_render_finished", { result: "success" }]]);
  });

  it.each([undefined, "0", "-1", "abc", "1e6", String(10 * 1024 * 1024 + 1)])(
    "不正なX-Max-Preview-Bytes(%s)は撮影せず400",
    async (value) => {
      const renderSpy = vi.fn(async () => jpeg);
      const { origin } = await start({ render: renderSpy });
      const response = await render(
        origin,
        "<h1>x</h1>",
        value === undefined ? {} : { "X-Max-Preview-Bytes": value },
      );
      expect(response.status).toBe(400);
      expect(renderSpy).not.toHaveBeenCalled();
    },
  );

  it("上限を超えるHTMLは撮影せず413", async () => {
    const renderSpy = vi.fn(async () => jpeg);
    const { origin, logs } = await start({ render: renderSpy, maxHtmlBytes: 16 });

    const response = await render(origin, "x".repeat(17));

    expect(response.status).toBe(413);
    expect(renderSpy).not.toHaveBeenCalled();
    expect(logs[0]?.[1]).toEqual({ result: "failed", reason: "html_too_large" });
  });

  it("上限byte数に収まらない画像は422(too_large)", async () => {
    const { origin } = await start({
      render: async () => {
        throw new PreviewTooLargeError();
      },
    });

    const response = await render(origin, "<h1>x</h1>");

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ reason: "too_large" });
  });

  it("撮影の失敗は固定の理由だけを返し、例外のmessageを返さない", async () => {
    const { origin, logs } = await start({
      render: async () => {
        throw new Error("No usable sandbox! /secret/path --flag");
      },
    });

    const response = await render(origin, "<h1>x</h1>");
    const text = await response.text();

    expect(response.status).toBe(500);
    expect(JSON.parse(text)).toEqual({ reason: "sandbox_unavailable" });
    expect(text).not.toContain("/secret/path");
    expect(JSON.stringify(logs)).not.toContain("/secret/path");
  });

  it("撮影の上限を超えたらsignalで打ち切り、500(timeout)を返す", async () => {
    const { origin } = await start({
      renderTimeoutMs: 50,
      render: (_html, { signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("closed")));
        }),
    });

    const response = await render(origin, "<h1>x</h1>");

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ reason: "timeout" });
  });

  it("撮影中の要求は503(renderer_busy)で断る", async () => {
    let release: (value: Buffer) => void = () => undefined;
    const { origin } = await start({
      render: () =>
        new Promise<Buffer>((resolve) => {
          release = resolve;
        }),
    });

    const first = render(origin, "<h1>1</h1>");
    await vi.waitFor(() => expect(release).not.toBe(undefined));
    // 1件目が撮影中になるまで待つ。
    await new Promise((resolve) => setTimeout(resolve, 50));
    const second = await render(origin, "<h1>2</h1>");
    expect(second.status).toBe(503);
    expect(await second.json()).toEqual({ reason: "renderer_busy" });

    release(jpeg);
    expect((await first).status).toBe(200);
  });

  it("撮影の応答を返し終えたら1回だけonRenderFinishedを呼ぶ(セッションの使い回しを防ぐ)", async () => {
    const onRenderFinished = vi.fn();
    const { origin } = await start({ onRenderFinished });

    const response = await render(origin, "<h1>x</h1>");
    await response.arrayBuffer();

    await vi.waitFor(() => expect(onRenderFinished).toHaveBeenCalledTimes(1));
    // health checkでは呼ばない。
    await fetch(`${origin}/health`);
    expect(onRenderFinished).toHaveBeenCalledTimes(1);
  });

  it("撮影に失敗した場合もonRenderFinishedを呼ぶ", async () => {
    const onRenderFinished = vi.fn();
    const { origin } = await start({
      onRenderFinished,
      render: async () => {
        throw new Error("boom");
      },
    });

    await (await render(origin, "<h1>x</h1>")).text();

    await vi.waitFor(() => expect(onRenderFinished).toHaveBeenCalledTimes(1));
  });
});

describe("parseMaxPreviewBytes", () => {
  it("1から10MBまでの整数だけを受け付ける", () => {
    expect(parseMaxPreviewBytes("1")).toBe(1);
    expect(parseMaxPreviewBytes(String(10 * 1024 * 1024))).toBe(10 * 1024 * 1024);
    expect(parseMaxPreviewBytes(["1", "2"])).toBeNull();
    expect(parseMaxPreviewBytes("01")).toBeNull();
  });
});

describe("parseRendererEnvironment", () => {
  it("既定値は常駐(ローカル)で、1件の撮影上限は25秒", () => {
    const env = parseRendererEnvironment({});
    expect(env.PORT).toBe(8080);
    expect(env.RENDERER_EXIT_AFTER_RENDER).toBe(false);
    expect(env.PREVIEW_RENDER_MAX_SECONDS).toBe(25);
    expect(env.MAX_HTML_UPLOAD_BYTES).toBe(10 * 1024 * 1024);
  });

  it("RENDERER_EXIT_AFTER_RENDERはtrue/falseだけを受け付ける", () => {
    expect(
      parseRendererEnvironment({ RENDERER_EXIT_AFTER_RENDER: "true" })
        .RENDERER_EXIT_AFTER_RENDER,
    ).toBe(true);
    expect(() =>
      parseRendererEnvironment({ RENDERER_EXIT_AFTER_RENDER: "yes" }),
    ).toThrow("RENDERER_EXIT_AFTER_RENDER");
  });
});
