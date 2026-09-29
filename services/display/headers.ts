/**
 * HTML表示サービスのレスポンスヘッダー(設計 §9.2, §9.4)。
 *
 * 設計 §9.2 が示すCSPをそのまま組み立てる。値を変える場合は設計 §9.2 を先に
 * 更新すること(最新版Edgeでの結合テストで最終値を確定する、という設計の前提が
 * あるため、変更理由と確認結果を残す)。
 *
 * - 表示用レスポンスは`frame-ancestors`でアプリオリジンだけを許可する。
 *   アプリ本体用の`X-Frame-Options: DENY`は流用しない(設計 §9.2)。
 * - `sandbox`はCSPヘッダー側にも付け、アプリ側`iframe`のsandbox属性と同じ
 *   `allow-popups`・`allow-popups-to-escape-sandbox`だけを許可する。script、form、
 *   download、same-origin、`target="_top"`・`target="_parent"`は許可しない。
 * - 表示以外のレスポンス(health、許可外method・path、Origin不正)は
 *   `frame-ancestors 'none'`とし、アプリオリジン以外のページから埋め込んで
 *   内容を観測できないようにする(設計 §7.2「アプリオリジン以外からの埋め込みを拒否」)。
 * - `Referrer-Policy: no-referrer`はgrant漏えい対策(設計 §9.4)。
 */

/** CSPの`sandbox`ディレクティブ(設計 §9.2)。アプリ側iframeのsandbox属性と一致させる。 */
export const DISPLAY_SANDBOX_DIRECTIVE =
  "sandbox allow-popups allow-popups-to-escape-sandbox";

/** `frame-ancestors`以外の共通ディレクティブ(設計 §9.2の記載順)。 */
const baseDirectives = [
  "default-src 'none'",
  "script-src 'none'",
  "connect-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
] as const;

function buildPolicy(frameAncestors: string): string {
  return [
    ...baseDirectives,
    `frame-ancestors ${frameAncestors}`,
    DISPLAY_SANDBOX_DIRECTIVE,
  ].join("; ");
}

/**
 * 資料HTMLと、アプリのiframe内へ表示する短いエラー画面に付けるCSP(設計 §9.2)。
 * `appOrigin`は環境変数のZod検証(`originSchema`)で`scheme://host[:port]`へ
 * 正規化済みのため、ヘッダーへ改行や区切り文字が混入することはない。
 */
export function displayContentSecurityPolicy(appOrigin: string): string {
  return buildPolicy(appOrigin);
}

/**
 * health、許可外method・path、Origin不正のレスポンスに付けるCSP。
 * どのページからも埋め込めないようにする。
 */
export const NON_FRAMABLE_CONTENT_SECURITY_POLICY = buildPolicy("'none'");

/** すべてのレスポンスに付ける共通ヘッダー(CSPは呼び出し側が足す)。 */
export function commonSecurityHeaders(): Record<string, string> {
  return {
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  };
}
