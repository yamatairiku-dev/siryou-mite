/**
 * React RouterのCSRF検査へ渡す「許可するOriginのhost」(設計 §7.1.1, §9)。
 *
 * React Routerはroute actionへのmutationで、`Origin` headerと`request.url`のoriginを
 * 比較し、一致しなければ`400 Bad Request`を返す。AzureではingressがTLSを終端し、Webには
 * `http://`で届くため、`request.url`のscheme(`http`)がブラウザの送る`Origin`(`https`)と
 * 一致せず、ログインを含むすべてのmutationが拒否される(stagingへの初回デプロイで判明)。
 *
 * `request.url`を信用せず、設定済みの公開オリジン(`APP_ORIGIN`)のhostだけを許可する。
 * 値は`server/web-build.mjs`がserver buildの`allowedActionOrigins`として渡す。
 * アプリ自身の検査(`app/lib/security.server.ts`の`assertSameOrigin`)も`APP_ORIGIN`と
 * 完全一致で比較する。
 */
export function allowedActionOriginHosts(appOrigin: string | undefined): string[] {
  if (appOrigin === undefined || appOrigin === "") {
    // 未設定の場合は追加の許可をしない(React Routerは`request.url`との一致だけを認める)。
    return [];
  }
  // 形式不正はここで例外になり、Webが起動しない(fail closed)。
  return [new URL(appOrigin).host];
}
