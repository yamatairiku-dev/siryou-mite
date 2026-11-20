/**
 * 撮影サービス(Preview Renderer)のHTTP処理。
 *
 * 設計: docs/APPLICATION_DESIGN.md §7.5, §7.6, §8
 *
 * Azure Container Instances(VNet内、プライベートIPだけ)で常駐し、Preview Jobから
 * 受け取ったHTMLを撮影してJPEGを返すだけを担う。Queue・DB・Blob・Managed Identityを
 * 一切持たず、外向きの通信もできない(NSGですべて拒否)。利用者のHTMLを描画する
 * Chromiumを、資料・監査の保存先へ届かない場所に閉じ込めるための分離である(Q-066)。
 *
 * - `GET /health`: 起動確認(認証なし。ACIのliveness probeが使う)
 * - `POST /render`: 本文のHTML(UTF-8)を撮影し、`image/jpeg`を返す
 *   - 共有トークンを設定した場合は`Authorization: Bearer <token>`が必要(違えば401)
 *   - `X-Max-Preview-Bytes`: プレビュー画像の上限byte数(Preview Jobの設定値)
 *   - 上限を超えるHTMLは413、上限byte数に収まらない画像は422、撮影の失敗は500
 *     (失敗理由は`{"reason": "<固定の値>"}`で返す。例外のmessageは返さない)
 *   - 同時に撮影するのは1件だけ。撮影中の要求には503を返す
 * - 撮影要求の接続が切れたら、Chromiumを閉じて撮影を打ち切る
 *
 * ログには固定のevent名と結果・理由だけを出す。HTML・画像・要求元の情報は出さない
 * (設計 §15.2)。
 */
import { createHash, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type RequestListener,
  type Server,
  type ServerResponse,
} from "node:http";
import { createServer as createHttpsServer } from "node:https";
import {
  classifyCaptureFailure,
  type CaptureFailureReason,
} from "../preview/capture.js";

/** プレビュー画像の上限byte数として受け付ける最大値(10MB)。 */
export const MAX_ACCEPTED_PREVIEW_BYTES = 10 * 1024 * 1024;

export const MAX_PREVIEW_BYTES_HEADER = "x-max-preview-bytes";

export type RenderHtml = (
  html: string,
  options: { maxBytes: number; signal: AbortSignal },
) => Promise<Buffer>;

export type RendererServerOptions = {
  /** 受け付けるHTMLの上限byte数(設計 §6.1のアップロード上限と同じ値)。 */
  maxHtmlBytes: number;
  /** 1件の撮影の上限(ms)。超えたらChromiumを閉じて500(`timeout`)を返す。 */
  renderTimeoutMs: number;
  render: RenderHtml;
  /** 指定すると`POST /render`に`Authorization: Bearer <token>`を求める。 */
  authToken?: string;
  /** 指定するとHTTPSで待ち受ける(PEM)。 */
  tls?: { cert: string; key: string };
  log?: (event: string, details: Record<string, string>) => void;
};

function defaultLog(event: string, details: Record<string, string>): void {
  console.log(JSON.stringify({ time: new Date().toISOString(), event, ...details }));
}

/** 共有トークンを比較する。長さの違いも含めて、比較にかかる時間から推測できないようにする。 */
export function isAuthorized(
  header: string | undefined,
  expectedToken: string,
): boolean {
  const match = /^Bearer (\S+)$/.exec(header ?? "");
  if (!match) {
    return false;
  }
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(match[1]!), digest(expectedToken));
}

export function createRendererServer(options: RendererServerOptions): Server {
  const log = options.log ?? defaultLog;
  let busy = false;

  const listener: RequestListener = (request, response) => {
    const path = (request.url ?? "").split("?")[0];

    if (request.method === "GET" && path === "/health") {
      sendText(response, 200, "ok");
      return;
    }

    if (path !== "/render") {
      sendText(response, 404, "not found");
      return;
    }

    if (request.method !== "POST") {
      response.setHeader("Allow", "POST");
      sendText(response, 405, "method not allowed");
      return;
    }

    // 本文を読む前に呼び出し元を確かめる。トークンの値はログへ出さない。
    if (
      options.authToken !== undefined &&
      !isAuthorized(request.headers.authorization, options.authToken)
    ) {
      log("preview_render_rejected", { result: "failed", reason: "unauthorized" });
      sendText(response, 401, "unauthorized");
      request.resume();
      return;
    }

    const maxBytes = parseMaxPreviewBytes(
      request.headers[MAX_PREVIEW_BYTES_HEADER],
    );
    if (maxBytes === null) {
      sendText(response, 400, "bad request");
      request.resume();
      return;
    }

    if (busy) {
      sendReason(response, 503, "renderer_busy");
      request.resume();
      return;
    }
    busy = true;

    void handleRender(request, response, maxBytes, options, log).finally(() => {
      busy = false;
    });
  };

  return options.tls
    ? createHttpsServer({ cert: options.tls.cert, key: options.tls.key }, listener)
    : createServer(listener);
}

async function handleRender(
  request: IncomingMessage,
  response: ServerResponse,
  maxBytes: number,
  options: RendererServerOptions,
  log: (event: string, details: Record<string, string>) => void,
): Promise<void> {
  // 要求元が接続を切った場合と、撮影の上限を超えた場合に撮影を打ち切る。
  const controller = new AbortController();
  const abortOnClose = (): void => {
    if (!response.writableFinished) {
      controller.abort();
    }
  };
  response.on("close", abortOnClose);
  const timer = setTimeout(() => controller.abort(), options.renderTimeoutMs);
  timer.unref();

  try {
    const body = await readBody(request, options.maxHtmlBytes);
    if (body === null) {
      log("preview_render_rejected", { result: "failed", reason: "html_too_large" });
      sendText(response, 413, "payload too large");
      return;
    }

    let jpeg: Buffer;
    try {
      jpeg = await options.render(body.toString("utf8"), {
        maxBytes,
        signal: controller.signal,
      });
    } catch (error) {
      const reason: CaptureFailureReason = controller.signal.aborted
        ? "timeout"
        : classifyCaptureFailure(error);
      log("preview_render_failed", { result: "failed", reason });
      sendReason(response, reason === "too_large" ? 422 : 500, reason);
      return;
    }

    log("preview_render_finished", { result: "success" });
    response.writeHead(200, {
      "Content-Type": "image/jpeg",
      "Content-Length": String(jpeg.byteLength),
      "Cache-Control": "no-store",
    });
    response.end(jpeg);
  } catch {
    // 本文の読み取り中に接続が切れた場合など。
    if (!response.headersSent) {
      sendReason(response, 500, "other");
    }
  } finally {
    clearTimeout(timer);
    response.off("close", abortOnClose);
  }
}

/** `X-Max-Preview-Bytes`を検証する。不正なら`null`。 */
export function parseMaxPreviewBytes(
  value: string | string[] | undefined,
): number | null {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,8}$/.test(value)) {
    return null;
  }
  const bytes = Number(value);
  return bytes <= MAX_ACCEPTED_PREVIEW_BYTES ? bytes : null;
}

/** 本文を上限byte数まで読む。超えたら読み捨てて`null`を返す。 */
async function readBody(
  request: IncomingMessage,
  maxBytes: number,
): Promise<Buffer | null> {
  const declared = Number(request.headers["content-length"]);
  if (Number.isFinite(declared) && declared > maxBytes) {
    request.resume();
    return null;
  }

  const chunks: Buffer[] = [];
  let total = 0;
  let tooLarge = false;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    total += buffer.byteLength;
    if (total > maxBytes) {
      tooLarge = true;
      continue;
    }
    chunks.push(buffer);
  }
  return tooLarge ? null : Buffer.concat(chunks);
}

function sendText(response: ServerResponse, status: number, text: string): void {
  response.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(text);
}

function sendReason(
  response: ServerResponse,
  status: number,
  reason: CaptureFailureReason,
): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify({ reason }));
}
