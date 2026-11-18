/**
 * 撮影サービス(`services/preview-renderer`)を呼ぶクライアント。
 *
 * 設計: docs/APPLICATION_DESIGN.md §7.5, §8, §9.1
 *
 * 本番・stagingではContainer Appsのdynamic sessions(セッションプール)の管理endpointを
 * 呼ぶ。資料ごとに新しいセッション識別子(`identifier`)を付けるため、撮影のたびに
 * 別のセッション(Hyper-Vで分離された新しいコンテナ)が割り当てられ、別の資料の内容が
 * 残らない。認証はPreview JobのManaged Identityで取得したaccess token
 * (scope `https://dynamicsessions.io/.default`)。ローカルでは常駐させた撮影サービスを
 * 認証なしで呼ぶ。
 *
 * 応答の検証:
 *   - 200は`image/jpeg`かつ上限byte数以下のときだけ受け取る
 *   - 422(`too_large`)は`PreviewTooLargeError`(資料側の問題で、再試行しても変わらない)
 *   - それ以外は`PreviewRendererError`。理由は既知の固定値だけを受け取る
 * URL・token・HTML・応答本文はログへ出さない(設計 §9.5, §15.2)。
 */
import { randomUUID } from "node:crypto";
import {
  CAPTURE_FAILURE_REASONS,
  PreviewRendererError,
  PreviewTooLargeError,
  type CaptureFailureReason,
} from "./capture.js";

/** dynamic sessionsのaccess tokenを要求するscope。 */
export const DYNAMIC_SESSIONS_SCOPE = "https://dynamicsessions.io/.default";

export const MAX_PREVIEW_BYTES_HEADER = "X-Max-Preview-Bytes";

export type RendererClientOptions = {
  /** 撮影サービスのendpoint(セッションプールの管理endpoint、またはローカルのURL)。 */
  endpoint: string;
  maxBytes: number;
  /** 省略時は認証なし(ローカル)。 */
  getAccessToken?: () => Promise<string>;
  /** 単体テストで差し替える。 */
  fetchImpl?: typeof fetch;
  newSessionIdentifier?: () => string;
};

/** 撮影サービスへHTMLを送り、JPEGを受け取る。 */
export async function capturePreviewRemote(
  html: Buffer,
  signal: AbortSignal,
  options: RendererClientOptions,
): Promise<Buffer> {
  signal.throwIfAborted();
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = buildRenderUrl(
    options.endpoint,
    (options.newSessionIdentifier ?? randomUUID)(),
  );

  const headers: Record<string, string> = {
    "Content-Type": "text/html; charset=utf-8",
    [MAX_PREVIEW_BYTES_HEADER]: String(options.maxBytes),
  };
  if (options.getAccessToken) {
    headers.Authorization = `Bearer ${await options.getAccessToken()}`;
  }

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers,
      body: new Uint8Array(html),
      signal,
      redirect: "error",
    });
  } catch (error) {
    if (signal.aborted) {
      throw error;
    }
    // 接続できない(DNS・NSG・プール未作成など)。原因の詳細は出さない。
    throw new PreviewRendererError("renderer_unavailable", 0);
  }

  if (response.status === 200) {
    return readJpeg(response, options.maxBytes);
  }

  const reason = await readReason(response);
  if (response.status === 422 && reason === "too_large") {
    throw new PreviewTooLargeError();
  }
  throw new PreviewRendererError(
    reason ??
      (response.status === 401 || response.status === 403 || response.status >= 502
        ? "renderer_unavailable"
        : "other"),
    response.status,
  );
}

/** `<endpoint>/render?identifier=<セッション識別子>`を組み立てる。 */
export function buildRenderUrl(endpoint: string, identifier: string): URL {
  const base = endpoint.endsWith("/") ? endpoint : `${endpoint}/`;
  const url = new URL("render", base);
  url.searchParams.set("identifier", identifier);
  return url;
}

async function readJpeg(response: Response, maxBytes: number): Promise<Buffer> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!/^image\/jpeg\b/i.test(contentType)) {
    await response.body?.cancel().catch(() => undefined);
    throw new PreviewRendererError("other", response.status);
  }
  const jpeg = Buffer.from(await response.arrayBuffer());
  if (jpeg.byteLength === 0 || jpeg.byteLength > maxBytes) {
    throw new PreviewRendererError("other", response.status);
  }
  return jpeg;
}

/** 失敗応答の`{"reason": ...}`を読む。既知の値でなければ`null`。 */
async function readReason(response: Response): Promise<CaptureFailureReason | null> {
  try {
    const text = await response.text();
    if (text.length > 1024) {
      return null;
    }
    const parsed = JSON.parse(text) as { reason?: unknown };
    const reason = parsed.reason;
    return typeof reason === "string" &&
      (CAPTURE_FAILURE_REASONS as readonly string[]).includes(reason)
      ? (reason as CaptureFailureReason)
      : null;
  } catch {
    return null;
  }
}
