/**
 * アップロード要求(`POST /documents`)の生bodyとheaderの検証(設計 §7.1, §10.1(4))。
 *
 * I/Oを持たない関数と、bodyのstreamを読む関数だけを置く。DB・Blob・環境変数へは
 * 触れず、上限値は引数で受け取る。値そのもの(ファイル名・HTML本文)は例外
 * メッセージにも含めない(設計 §9.5)。
 */
import { z } from "zod";

/** アップロードで受け付ける唯一の`Content-Type`(設計 §7.1)。 */
export const UPLOAD_CONTENT_TYPE = "application/octet-stream";

/**
 * `X-File-Name`のbase64url表現。padding(`=`)も`+`・`/`も許さず、
 * canonicalなbase64urlだけを受け付ける。
 *
 * 長さの上限は、表示用ファイル名の上限(255文字)がUTF-8で最大1020byte、
 * そのbase64urlが1360文字になることから余裕を見て2000文字とする。
 * 実際のファイル名の長さ・文字種はHTML受け入れ検査(`inspectHtmlUpload`)が
 * 表示用文字列として検証する(設計 §6.1)。
 */
const fileNameHeaderSchema = z
  .string()
  .min(1)
  .max(2000)
  .regex(/^[A-Za-z0-9_-]+$/);

export type FileNameHeaderResult =
  | { ok: true; fileName: string }
  | { ok: false };

/**
 * `Content-Type`が`application/octet-stream`かを判定する(設計 §7.1)。
 * `charset`などのパラメーターが付いていても本体だけで判定する。
 * 値は信用せず、内容の検査は別途行う(設計 §6.1)。
 */
export function isOctetStreamContentType(value: string | null): boolean {
  if (!value) {
    return false;
  }
  const mediaType = value.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType === UPLOAD_CONTENT_TYPE;
}

/**
 * `X-File-Name`(base64url)をUTF-8のファイル名へ復号する(設計 §7.1)。
 *
 * - canonicalなbase64urlでない値は拒否する(復号結果が元の値と往復しない値を弾く)。
 * - UTF-8として読めない値は拒否する(`TextDecoder`の`fatal`)。
 * - ここでは長さ・制御文字・拡張子を見ない(HTML受け入れ検査が表示用文字列として検証する)。
 */
export function decodeFileNameHeader(value: string | null): FileNameHeaderResult {
  if (value === null) {
    return { ok: false };
  }

  const parsed = fileNameHeaderSchema.safeParse(value.trim());
  if (!parsed.success) {
    return { ok: false };
  }

  const bytes = Buffer.from(parsed.data, "base64url");
  if (bytes.length === 0 || bytes.toString("base64url") !== parsed.data) {
    // `Buffer`は不正な文字を読み飛ばすため、往復で一致しない値は拒否する。
    return { ok: false };
  }

  let fileName: string;
  try {
    fileName = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { ok: false };
  }

  return { ok: true, fileName };
}

/**
 * 自己申告の`Content-Length`。事前検査にだけ使い、これを実サイズとして信用しない
 * (設計 §7.1)。数値として読めない場合は`null`を返す。
 */
export function declaredContentLength(request: Request): number | null {
  const raw = request.headers.get("Content-Length");
  if (raw === null) {
    return null;
  }
  const parsed = Number(raw.trim());
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

export type BodyReadResult =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; reason: "too_large" };

/**
 * request bodyを上限付きで読み切る(設計 §7.1「streaming中も10MBを超えた時点で中止」)。
 *
 * 全体を読み終えてから長さを見るのではなく、累計が上限を超えた時点で
 * streamをcancelして中断する。`Content-Length`のような自己申告値は使わない。
 */
export async function readBodyWithinLimit(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<BodyReadResult> {
  if (body === null) {
    return { ok: true, bytes: new Uint8Array(0) };
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value || value.byteLength === 0) {
        continue;
      }

      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        // 残りは受け取らずに中断する。読み込み済みのchunkも捨てる。
        await reader.cancel().catch(() => undefined);
        return { ok: false, reason: "too_large" };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes };
}
