import type { Server } from "node:http";
import { request as httpsRequest } from "node:https";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PreviewTooLargeError } from "../../../services/preview/capture";
import { parseRendererEnvironment } from "../../../services/preview-renderer/env";
import {
  createRendererServer,
  isAuthorized,
  parseMaxPreviewBytes,
  type RendererServerOptions,
} from "../../../services/preview-renderer/server";
import { createSelfSignedTls } from "../../support/self-signed-tls";

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
  return fetch(`${origin}/render`, {
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

  it("HTMLをUTF-8で撮影し、JPEGを返す", async () => {
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

});

const TOKEN = "t".repeat(43);

describe("共有トークン(設計 §9.5, Q-066)", () => {
  it("トークンが一致しない要求は撮影せず401にし、トークンの値をログへ出さない", async () => {
    const renderSpy = vi.fn(async () => jpeg);
    const { origin, logs } = await start({ render: renderSpy, authToken: TOKEN });

    for (const authorization of [undefined, `Bearer ${"x".repeat(43)}`, `Basic ${TOKEN}`, TOKEN]) {
      const response = await render(origin, "<h1>x</h1>", {
        "X-Max-Preview-Bytes": "1024",
        ...(authorization ? { Authorization: authorization } : {}),
      });
      expect(response.status).toBe(401);
    }
    expect(renderSpy).not.toHaveBeenCalled();
    expect(logs[0]).toEqual([
      "preview_render_rejected",
      { result: "failed", reason: "unauthorized" },
    ]);
    expect(JSON.stringify(logs)).not.toContain(TOKEN);
  });

  it("トークンが一致すれば撮影する。health checkには認証を求めない", async () => {
    const { origin } = await start({ authToken: TOKEN });

    const response = await render(origin, "<h1>x</h1>", {
      "X-Max-Preview-Bytes": "1024",
      Authorization: `Bearer ${TOKEN}`,
    });
    expect(response.status).toBe(200);
    expect((await fetch(`${origin}/health`)).status).toBe(200);
  });

  it("isAuthorizedはBearer形式で値が完全に一致する場合だけtrue", () => {
    expect(isAuthorized(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(isAuthorized(`Bearer ${TOKEN}x`, TOKEN)).toBe(false);
    expect(isAuthorized(`Bearer ${TOKEN.slice(1)}`, TOKEN)).toBe(false);
    expect(isAuthorized(`bearer ${TOKEN}`, TOKEN)).toBe(false);
    expect(isAuthorized(undefined, TOKEN)).toBe(false);
  });
});

describe("TLS(設計 §9.5)", () => {
  it("証明書を渡すとHTTPSで待ち受け、その証明書を信頼する相手だけが接続できる", async () => {
    const tls = createSelfSignedTls();
    server = createRendererServer({
      maxHtmlBytes: 1024,
      renderTimeoutMs: 5_000,
      render: async () => jpeg,
      log: () => undefined,
      tls,
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;

    const status = await new Promise<number>((resolve, reject) => {
      const request = httpsRequest(
        { host: "127.0.0.1", port, path: "/health", ca: tls.cert, agent: false },
        (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        },
      );
      request.on("error", reject);
      request.end();
    });
    expect(status).toBe(200);

    // 既定の認証局しか信頼しない相手は接続できない(自己署名のため)。
    await expect(fetch(`https://127.0.0.1:${port}/health`)).rejects.toThrow();
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
  it("既定値はHTTP・認証なし(ローカル)で、1件の撮影上限は25秒", () => {
    const env = parseRendererEnvironment({});
    expect(env.PORT).toBe(8080);
    expect(env.PREVIEW_RENDER_MAX_SECONDS).toBe(25);
    expect(env.MAX_HTML_UPLOAD_BYTES).toBe(10 * 1024 * 1024);
    expect(env.RENDERER_TLS_CERT).toBeUndefined();
    expect(env.RENDERER_AUTH_TOKEN).toBeUndefined();
  });

  it("本番ではTLSと共有トークンを必須にする", () => {
    const tls = createSelfSignedTls();
    expect(() => parseRendererEnvironment({ NODE_ENV: "production" })).toThrow(
      "RENDERER_TLS_CERT",
    );
    expect(() =>
      parseRendererEnvironment({
        NODE_ENV: "production",
        RENDERER_TLS_CERT: tls.cert,
        RENDERER_TLS_KEY: tls.key,
      }),
    ).toThrow("RENDERER_AUTH_TOKEN");
    expect(
      parseRendererEnvironment({
        NODE_ENV: "production",
        RENDERER_TLS_CERT: tls.cert,
        RENDERER_TLS_KEY: tls.key,
        RENDERER_AUTH_TOKEN: TOKEN,
      }).RENDERER_AUTH_TOKEN,
    ).toBe(TOKEN);
  });

  it("証明書と秘密鍵の片方だけ・短いトークン・PEMでない値を拒否し、値をメッセージへ含めない", () => {
    const tls = createSelfSignedTls();
    expect(() => parseRendererEnvironment({ RENDERER_TLS_CERT: tls.cert })).toThrow(
      "両方を指定",
    );
    const shortToken = "short-secret-token";
    let message = "";
    try {
      parseRendererEnvironment({ RENDERER_AUTH_TOKEN: shortToken });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("RENDERER_AUTH_TOKEN");
    expect(message).not.toContain(shortToken);
    expect(() =>
      parseRendererEnvironment({ RENDERER_TLS_CERT: "x", RENDERER_TLS_KEY: "y" }),
    ).toThrow("PEM");
  });
});
