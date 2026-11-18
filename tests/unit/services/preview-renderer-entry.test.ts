import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseRendererEnvironment } from "../../../services/preview-renderer/env";
import { startRenderer } from "../../../services/preview-renderer/index";

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

afterEach(() => {
  vi.restoreAllMocks();
});

async function listening(server: ReturnType<typeof startRenderer>): Promise<string> {
  if (!server.listening) {
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  }
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function renderRequest(origin: string): Promise<Response> {
  return fetch(`${origin}/render?identifier=x`, {
    method: "POST",
    headers: { "X-Max-Preview-Bytes": "1024" },
    body: "<h1>x</h1>",
  });
}

describe("startRenderer(設計 §7.5)", () => {
  it("セッションでは1件撮影したら終了する(RENDERER_EXIT_AFTER_RENDER=true)", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const exit = vi.fn();
    const server = startRenderer({
      env: { ...parseRendererEnvironment({ RENDERER_EXIT_AFTER_RENDER: "true" }), PORT: 0 },
      render: async () => jpeg,
      exit,
    });
    const origin = await listening(server);

    const response = await renderRequest(origin);
    expect(response.status).toBe(200);
    await response.arrayBuffer();

    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(server.listening).toBe(false);
    const events = logSpy.mock.calls.map(([line]) => JSON.parse(String(line)).event);
    expect(events).toContain("preview_renderer_started");
    expect(events).toContain("preview_renderer_exiting");
  });

  it("ローカル(既定)では撮影後も常駐し、終了要求で止まる", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const exit = vi.fn();
    const server = startRenderer({
      env: { ...parseRendererEnvironment({}), PORT: 0 },
      render: async () => jpeg,
      exit,
    });
    const origin = await listening(server);

    await (await renderRequest(origin)).arrayBuffer();
    expect((await fetch(`${origin}/health`)).status).toBe(200);
    expect(exit).not.toHaveBeenCalled();

    process.emit("SIGTERM");
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
  });
});
