/**
 * 撮影サービス(`services/preview-renderer`)を呼ぶクライアント。
 *
 * 設計: docs/APPLICATION_DESIGN.md §7.5, §8, §9.1, §9.5
 *
 * 本番・stagingでは、Azure Container Instances(VNet内のプライベートIP)で常駐する撮影サービスを
 * HTTPSで呼ぶ。撮影サービスの証明書は自己署名で、`caCert`に渡した証明書だけを信頼する
 * (公開の認証局は信頼しない)。証明書の名前は固定のDNS名(`RENDERER_TLS_SERVER_NAME`)で
 * 確かめる。ACIのプライベートIPは指定できず、作り直すと変わることがあるため、IPは証明書に入れない。
 * 呼び出し元は共有トークン(`Authorization: Bearer`)で示す。
 * ローカルでは常駐させた撮影サービスをHTTP・認証なしで呼ぶ。
 *
 * 応答の検証:
 *   - 200は`image/jpeg`かつ上限byte数以下のときだけ受け取る
 *   - 422(`too_large`)は`PreviewTooLargeError`(資料側の問題で、再試行しても変わらない)
 *   - それ以外は`PreviewRendererError`。理由は既知の固定値だけを受け取る
 * URL・token・HTML・応答本文はログへ出さない(設計 §9.5, §15.2)。
 */
import { request as httpsRequest } from "node:https";
import {
  CAPTURE_FAILURE_REASONS,
  PreviewRendererError,
  PreviewTooLargeError,
  type CaptureFailureReason,
} from "./capture.js";

export const MAX_PREVIEW_BYTES_HEADER = "X-Max-Preview-Bytes";

/**
 * 撮影サービスの証明書のSubject Alternative Name(DNS名)。接続先はIPのまま、TLSの検証だけ
 * この名前で行う(DNSには登録しない)。`infra/scripts/generate-renderer-tls.mjs`の値と一致させる。
 */
export const RENDERER_TLS_SERVER_NAME = "preview-renderer.siryou-mite.internal";

/** 撮影サービスの応答として読む最大byte数。プレビュー画像の上限(最大10MB)に余裕を足す。 */
const MAX_RESPONSE_BYTES = 11 * 1024 * 1024;

export type RendererClientOptions = {
  /** 撮影サービスのendpoint(例: `https://10.40.4.174:8443`)。 */
  endpoint: string;
  maxBytes: number;
  /** 共有トークン。省略時は認証なし(ローカル)。 */
  authToken?: string;
  /** 撮影サービスの証明書(PEM)。指定すると、この証明書だけを信頼してHTTPSで呼ぶ。 */
  caCert?: string;
  /** 単体テストで差し替える。 */
  fetchImpl?: typeof fetch;
};

/** 撮影サービスへHTMLを送り、JPEGを受け取る。 */
export async function capturePreviewRemote(
  html: Buffer,
  signal: AbortSignal,
  options: RendererClientOptions,
): Promise<Buffer> {
  signal.throwIfAborted();
  const fetchImpl =
    options.fetchImpl ??
    (options.caCert !== undefined ? createPinnedFetch(options.caCert) : fetch);
  const url = buildRenderUrl(options.endpoint);

  const headers: Record<string, string> = {
    "Content-Type": "text/html; charset=utf-8",
    [MAX_PREVIEW_BYTES_HEADER]: String(options.maxBytes),
  };
  if (options.authToken !== undefined) {
    headers.Authorization = `Bearer ${options.authToken}`;
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
    // 接続できない(NSG・停止中・証明書の不一致など)。原因の詳細は出さない。
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

/** `<endpoint>/render`を組み立てる。 */
export function buildRenderUrl(endpoint: string): URL {
  const base = endpoint.endsWith("/") ? endpoint : `${endpoint}/`;
  return new URL("render", base);
}

/**
 * 指定した証明書だけを信頼してHTTPSで呼ぶ`fetch`相当の関数。
 *
 * Node.jsの`fetch`は信頼する証明書を要求ごとに指定できないため、`node:https`で実装する。
 * `ca`を指定すると既定の認証局は使われず、この証明書で署名された相手だけに接続する。
 * 証明書のSubject Alternative Nameが`serverName`と一致しない場合も拒否する
 * (Node.jsは`servername`を指定すると、その名前で証明書を検証する)。
 */
export function createPinnedFetch(
  caCert: string,
  serverName: string = RENDERER_TLS_SERVER_NAME,
): typeof fetch {
  return ((input: URL | string, init: RequestInit = {}) =>
    new Promise<Response>((resolve, reject) => {
      const url = typeof input === "string" ? new URL(input) : input;
      if (url.protocol !== "https:") {
        reject(new Error("証明書を指定した撮影サービスはhttpsで呼ぶ必要があります"));
        return;
      }
      const body = init.body as Uint8Array | undefined;
      const request = httpsRequest(
        url,
        {
          method: init.method ?? "GET",
          headers: {
            ...(init.headers as Record<string, string> | undefined),
            ...(body ? { "Content-Length": String(body.byteLength) } : {}),
          },
          ca: caCert,
          servername: serverName,
          // 撮影のたびに接続し直す(接続を使い回さない)。
          agent: false,
          ...(init.signal ? { signal: init.signal } : {}),
        },
        (response) => {
          const chunks: Buffer[] = [];
          let total = 0;
          response.on("data", (chunk: Buffer) => {
            total += chunk.byteLength;
            if (total > MAX_RESPONSE_BYTES) {
              response.destroy(new Error("撮影サービスの応答が大きすぎます"));
              return;
            }
            chunks.push(chunk);
          });
          response.on("error", reject);
          response.on("end", () => {
            const status = response.statusCode ?? 0;
            if (status < 200 || status > 599 || status === 204 || status === 304) {
              reject(new Error("撮影サービスの応答のstatusが想定外です"));
              return;
            }
            const headers = new Headers();
            for (const [name, value] of Object.entries(response.headers)) {
              if (typeof value === "string") {
                headers.set(name, value);
              }
            }
            resolve(
              new Response(Buffer.concat(chunks), {
                status,
                headers,
              }),
            );
          });
        },
      );
      request.on("error", reject);
      request.end(body ? Buffer.from(body) : undefined);
    })) as typeof fetch;
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
