export function assertSameOrigin(request: Request): void {
  const origin = request.headers.get("Origin");
  const expectedOrigin = new URL(request.url).origin;

  if (!origin || origin !== expectedOrigin) {
    throw new Response("不正なリクエストです", { status: 403 });
  }
}

export function securityHeaders(): HeadersInit {
  return {
    "Cache-Control": "no-store",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  };
}

/** Easy AuthがリダイレクトするEntra IDのサインイン・サインアウトのオリジン。 */
const ENTRA_LOGIN_ORIGIN = "https://login.microsoftonline.com";

/**
 * HTML文書応答のCSP(`app/entry.server.tsx`が付ける)。resource routeの応答には付けない。
 *
 * - スクリプトは同一オリジンのbundleと、React Routerが出力するインラインスクリプト
 *   (要求ごとのnonce付き)だけを許可する。
 * - 資料本文は表示サービス(別オリジン)のiframe内に出すため、grantを送るhidden formの
 *   送信先(`form-action`)に表示サービスのオリジンを足す(設計 §7.2)。
 * - `form-action`はフォーム送信後のリダイレクト先にも効く。hydration前のログイン・
 *   ログアウトは通常のフォーム送信になり、`/.auth/*`経由でEntra IDへリダイレクトするため
 *   `https://login.microsoftonline.com`も許可する。
 * - `frame-src`はiframe内の遷移先にも効く。資料内のtarget省略リンクは同じiframe内で
 *   任意の`https:`/`http:`へ遷移できる仕様(設計 §6.3)のため、この2つも許可する。
 *   iframe自体はsandbox付きで、資料側の制限は表示サービスのCSPとsandboxが担う。
 * - アプリ画面自体の埋め込みは`X-Frame-Options: DENY`と同じく拒否する。
 */
export function documentContentSecurityPolicy(options: {
  nonce: string;
  displayOrigin: string;
}): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${options.nonce}'`,
    "style-src 'self'",
    "img-src 'self'",
    "font-src 'self'",
    "connect-src 'self'",
    `frame-src ${options.displayOrigin} https: http:`,
    `form-action 'self' ${options.displayOrigin} ${ENTRA_LOGIN_ORIGIN}`,
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "object-src 'none'",
  ].join("; ");
}

