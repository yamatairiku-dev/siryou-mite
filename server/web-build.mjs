/**
 * Web(`react-router-serve`)へ渡すserver build。
 *
 * React Routerのbuild(`build/server/index.js`)をそのまま再exportし、CSRF検査で許可する
 * Originのhost(`allowedActionOrigins`)だけを、実行時の`APP_ORIGIN`から決めて上書きする。
 * `react-router.config.ts`の`allowedActionOrigins`はbuild時に固定されるため、環境ごとに
 * 異なる公開オリジンを同じimageで扱えない。理由は`services/shared/action-origins.ts`と
 * docs/ARCHITECTURE.md を参照。
 */
import { allowedActionOriginHosts } from "../build/services/shared/action-origins.js";

export * from "../build/server/index.js";

// 明示的なexportは`export *`より優先される。
export const allowedActionOrigins = allowedActionOriginHosts(process.env.APP_ORIGIN);
