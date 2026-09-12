/**
 * `POST /documents`へ送る`X-File-Name`headerの符号化(設計 §7.1, §13)。
 *
 * ブラウザ側から呼ぶため`.server.ts`にはしない。サーバー側の復号
 * (`decodeFileNameHeader`、`~/lib/upload/upload-request.server.ts`)と対になる、
 * UTF-8ファイル名 → canonicalなbase64url文字列への変換だけを行う。
 */

/**
 * UTF-8のファイル名をcanonicalなbase64url文字列へ符号化する。
 * padding(`=`)を残さず、`+`・`/`は使わない(サーバー側が受け付ける形式)。
 */
export function encodeFileNameHeader(fileName: string): string {
  const bytes = new TextEncoder().encode(fileName);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  const base64 = btoa(binary);
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
