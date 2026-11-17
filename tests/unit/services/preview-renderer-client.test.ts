import { describe, expect, it, vi } from "vitest";
import {
  classifyCaptureFailure,
  PreviewRendererError,
  PreviewTooLargeError,
} from "../../../services/preview/capture";
import {
  buildRenderUrl,
  capturePreviewRemote,
  type RendererClientOptions,
} from "../../../services/preview/renderer-client";

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const endpoint = "https://sp-renderer.example.japaneast.azurecontainerapps.io";

function options(
  fetchImpl: typeof fetch,
  overrides: Partial<RendererClientOptions> = {},
): RendererClientOptions {
  return {
    endpoint,
    maxBytes: 1024,
    fetchImpl,
    newSessionIdentifier: () => "session-1",
    ...overrides,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("capturePreviewRemote(設計 §7.5)", () => {
  it("資料ごとに新しいセッション識別子を付け、tokenとHTMLを送ってJPEGを受け取る", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(jpeg, { status: 200, headers: { "Content-Type": "image/jpeg" } }),
    );

    const result = await capturePreviewRemote(
      Buffer.from("<h1>資料</h1>"),
      new AbortController().signal,
      options(fetchImpl as unknown as typeof fetch, {
        getAccessToken: async () => "token-value",
      }),
    );

    expect(result).toEqual(jpeg);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.toString()).toBe(`${endpoint}/render?identifier=session-1`);
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
    expect(init.headers).toMatchObject({
      Authorization: "Bearer token-value",
      "X-Max-Preview-Bytes": "1024",
      "Content-Type": "text/html; charset=utf-8",
    });
    expect(Buffer.from(init.body as Uint8Array).toString("utf8")).toBe("<h1>資料</h1>");
  });

  it("認証なし(ローカル)ではAuthorizationを付けない", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(jpeg, { status: 200, headers: { "Content-Type": "image/jpeg" } }),
    );

    await capturePreviewRemote(
      Buffer.from("x"),
      new AbortController().signal,
      options(fetchImpl as unknown as typeof fetch),
    );

    const [, init] = fetchImpl.mock.calls[0] as unknown as [URL, RequestInit];
    expect(init.headers).not.toHaveProperty("Authorization");
  });

  it("422(too_large)はPreviewTooLargeErrorにする(再試行しても変わらない)", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(422, { reason: "too_large" }));

    await expect(
      capturePreviewRemote(
        Buffer.from("x"),
        new AbortController().signal,
        options(fetchImpl as unknown as typeof fetch),
      ),
    ).rejects.toBeInstanceOf(PreviewTooLargeError);
  });

  it("失敗の理由は既知の値だけを受け取る", async () => {
    const known = vi.fn(async () => jsonResponse(500, { reason: "sandbox_unavailable" }));
    const error = await capturePreviewRemote(
      Buffer.from("x"),
      new AbortController().signal,
      options(known as unknown as typeof fetch),
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PreviewRendererError);
    expect(classifyCaptureFailure(error)).toBe("sandbox_unavailable");
    expect((error as PreviewRendererError).statusCode).toBe(500);

    const unknownReason = vi.fn(async () => jsonResponse(500, { reason: "<script>" }));
    const other = await capturePreviewRemote(
      Buffer.from("x"),
      new AbortController().signal,
      options(unknownReason as unknown as typeof fetch),
    ).catch((caught: unknown) => caught);
    expect(classifyCaptureFailure(other)).toBe("other");
  });

  it.each([401, 403, 502, 503])(
    "理由の無い%dはrenderer_unavailable(権限・プールの問題)",
    async (status) => {
      const fetchImpl = vi.fn(async () => new Response("denied", { status }));
      const error = await capturePreviewRemote(
        Buffer.from("x"),
        new AbortController().signal,
        options(fetchImpl as unknown as typeof fetch),
      ).catch((caught: unknown) => caught);
      expect(classifyCaptureFailure(error)).toBe("renderer_unavailable");
    },
  );

  it("接続できない場合はrenderer_unavailableにし、原因の詳細を含めない", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed: getaddrinfo ENOTFOUND secret-host");
    });
    const error = await capturePreviewRemote(
      Buffer.from("x"),
      new AbortController().signal,
      options(fetchImpl as unknown as typeof fetch),
    ).catch((caught: unknown) => caught);
    expect(classifyCaptureFailure(error)).toBe("renderer_unavailable");
    expect((error as Error).message).not.toContain("secret-host");
  });

  it("中断された場合は中断の例外をそのまま投げる", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async () => {
      controller.abort();
      throw new DOMException("aborted", "AbortError");
    });
    const error = await capturePreviewRemote(
      Buffer.from("x"),
      controller.signal,
      options(fetchImpl as unknown as typeof fetch),
    ).catch((caught: unknown) => caught);
    expect((error as Error).name).toBe("AbortError");
  });

  it("中断済みなら呼び出さない", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = vi.fn();
    await expect(
      capturePreviewRemote(
        Buffer.from("x"),
        controller.signal,
        options(fetchImpl as unknown as typeof fetch),
      ),
    ).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ["JPEG以外", new Response("<html>", { status: 200, headers: { "Content-Type": "text/html" } })],
    ["上限超過", new Response(Buffer.alloc(2048), { status: 200, headers: { "Content-Type": "image/jpeg" } })],
    ["空", new Response(new Uint8Array(0), { status: 200, headers: { "Content-Type": "image/jpeg" } })],
  ])("200でも%sの応答は受け取らない", async (_label, response) => {
    const fetchImpl = vi.fn(async () => response);
    await expect(
      capturePreviewRemote(
        Buffer.from("x"),
        new AbortController().signal,
        options(fetchImpl as unknown as typeof fetch),
      ),
    ).rejects.toBeInstanceOf(PreviewRendererError);
  });
});

describe("buildRenderUrl", () => {
  it("末尾の/の有無に関わらず<endpoint>/render?identifier=を組み立てる", () => {
    expect(buildRenderUrl(`${endpoint}/`, "a b").toString()).toBe(
      `${endpoint}/render?identifier=a+b`,
    );
    expect(buildRenderUrl("http://127.0.0.1:8090", "x").toString()).toBe(
      "http://127.0.0.1:8090/render?identifier=x",
    );
  });
});
