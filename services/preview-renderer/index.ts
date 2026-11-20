/**
 * 撮影サービス(Preview Renderer)のエントリーポイント。
 *
 * 設計: docs/APPLICATION_DESIGN.md §7.5, §7.6
 *
 * 本番・stagingではAzure Container Instancesで常駐し、Preview JobからHTTPS・共有トークンで
 * 呼ばれる(Q-066)。撮影のたびにChromiumを起動し直し、撮影が終わったら閉じる。
 * ローカルではHTTP・認証なしで常駐する。
 *
 * HTTP処理は`server.ts`、撮影は`../preview/capture.ts`にある。Chromiumを含む専用image
 * (`Dockerfile.preview`)で、非root・Chromium sandbox有効で実行する。
 */
import type { Server } from "node:http";
import { fileURLToPath } from "node:url";
import { capturePreviewJpeg } from "../preview/capture.js";
import { parseRendererEnvironment, type RendererEnvironment } from "./env.js";
import { createRendererServer, type RenderHtml } from "./server.js";

export const SERVICE_NAME = "preview-renderer" as const;

export function describeService(): string {
  return `${SERVICE_NAME} service: GET /health and POST /render only`;
}

/** 終了時に処理中の撮影を待つ猶予(ms)。 */
const SHUTDOWN_TIMEOUT_MS = 10_000;

function logEvent(event: string, result: "success" | "failed"): void {
  console.log(JSON.stringify({ time: new Date().toISOString(), event, result }));
}

export type StartRendererOptions = {
  env: RendererEnvironment;
  /** 省略時はPlaywright + Chromium。単体テストでは偽の撮影を渡す。 */
  render?: RenderHtml;
  /** 省略時は`process.exit`。 */
  exit?: (code: number) => void;
};

/** 撮影サービスを起動する。終了要求(SIGTERM・SIGINT)もここで扱う。 */
export function startRenderer(options: StartRendererOptions): Server {
  const { env } = options;
  const exit = options.exit ?? ((code: number) => process.exit(code));

  let shuttingDown = false;
  const shutdown = (exitCode: number): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    const timer = setTimeout(() => exit(exitCode), SHUTDOWN_TIMEOUT_MS);
    timer.unref();
    server.close(() => {
      clearTimeout(timer);
      exit(exitCode);
    });
    server.closeIdleConnections();
  };

  const server = createRendererServer({
    maxHtmlBytes: env.MAX_HTML_UPLOAD_BYTES,
    renderTimeoutMs: env.PREVIEW_RENDER_MAX_SECONDS * 1_000,
    render:
      options.render ??
      ((html, { maxBytes, signal }) => capturePreviewJpeg(html, { maxBytes, signal })),
    ...(env.RENDERER_AUTH_TOKEN !== undefined ? { authToken: env.RENDERER_AUTH_TOKEN } : {}),
    ...(env.RENDERER_TLS_CERT !== undefined && env.RENDERER_TLS_KEY !== undefined
      ? { tls: { cert: env.RENDERER_TLS_CERT, key: env.RENDERER_TLS_KEY } }
      : {}),
  });

  const onSignal = (): void => shutdown(0);
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);
  server.once("close", () => {
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
  });

  server.listen(env.PORT, () => {
    // 起動ログには設定値を含めない(設計 §9.5)。
    logEvent("preview_renderer_started", "success");
  });
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // 不正な環境変数はここで例外になり、プロセスが起動しない(fail closed)。
  startRenderer({ env: parseRendererEnvironment(process.env) });
}
