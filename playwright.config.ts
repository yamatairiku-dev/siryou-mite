import { generateKeyPairSync } from "node:crypto";
import { defineConfig, devices } from "@playwright/test";
import {
  APP_ORIGIN,
  DISPLAY_ORIGIN,
  ENTRA_TENANT_ID,
  STORAGE_CONTAINER,
  STORAGE_QUEUE_NAME,
  WEB_PORT,
  DISPLAY_PORT,
  resolveDatabaseUrl,
  resolveStorageConnectionString,
} from "./tests/e2e/helpers/constants.js";

/**
 * E2E(設計 §18.3)。Easy Authが付加する`X-MS-CLIENT-PRINCIPAL`headerをfixture
 * (`tests/e2e/helpers/principal.ts`)で再現し、Web(react-router-serve)と
 * Display(HTML表示サービス)を実際に起動して結合的に確認する。
 * productionで有効になり得る認証bypassやテスト専用ログインrouteは作らない
 * (`AUTH_MODE=easyauth`を使い、`app/`・`services/`には手を入れない)。
 *
 * Web・Displayはgrant署名鍵(Ed25519)を共有する必要があるため、Playwrightの
 * configをロードするこのプロセス内で1回だけ鍵ペアを生成し、Webには秘密鍵、
 * Displayには公開鍵だけを渡す(設計 §9.5「Displayは公開鍵だけを持つ」)。
 * `webServer`の各エントリは順番に(直列に)起動するため(Playwrightの実装上、
 * pluginのsetup taskは配列順にawaitされる)、Web用commandに`build:services`まで
 * 含めておけば、Display用commandが動く時点でビルド成果物が揃っている。
 */

const GRANT_SIGNING_KEY_ID = "e2e-key-1";
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const grantSigningPrivateKeyPem = privateKey
  .export({ type: "pkcs8", format: "pem" })
  .toString();
const grantVerificationPublicKeyPem = publicKey
  .export({ type: "spki", format: "pem" })
  .toString();

// ログの可逆化不能pseudonymize用HMAC鍵(設計 §9.5)。使い捨てで実運用のsecretではない。
const LOG_HMAC_KEY = Buffer.alloc(32, 13).toString("base64");

const DATABASE_URL = resolveDatabaseUrl();
const AZURE_STORAGE_CONNECTION_STRING = resolveStorageConnectionString();

const commonServiceEnv = {
  DATABASE_URL,
  AZURE_STORAGE_CONNECTION_STRING,
  AZURE_STORAGE_CONTAINER: STORAGE_CONTAINER,
  LOG_HMAC_KEY,
};

const webEnv = {
  ...commonServiceEnv,
  // 本番はAUTH_MODE=easyauthかつ接続文字列禁止(Managed Identity必須)のため、
  // ローカルAzuriteの接続文字列を使うにはNODE_ENVをproduction以外にする必要がある
  // (`app/lib/env.server.ts`のsuperRefine)。
  NODE_ENV: "test",
  PORT: String(WEB_PORT),
  APP_NAME: "資料みて！",
  APP_ORIGIN,
  AUTH_MODE: "easyauth",
  ENTRA_TENANT_ID,
  DISPLAY_ORIGIN,
  AZURE_STORAGE_QUEUE_NAME: STORAGE_QUEUE_NAME,
  GRANT_SIGNING_KEY_ID,
  GRANT_SIGNING_PRIVATE_KEY: grantSigningPrivateKeyPem,
  GRANT_TTL_SECONDS: "60",
};

const displayEnv = {
  ...commonServiceEnv,
  NODE_ENV: "test",
  PORT: String(DISPLAY_PORT),
  APP_ORIGIN,
  GRANT_VERIFICATION_KEYS: JSON.stringify([
    { keyId: GRANT_SIGNING_KEY_ID, publicKey: grantVerificationPublicKeyPem },
  ]),
  GRANT_MAX_AGE_SECONDS: "60",
  DISPLAY_MAX_POST_BODY_BYTES: "8192",
};

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  // DBとBrowserを共有するため、複数workerでの並列実行はしない(設計 §18.3の指示。
  // `oid`をテストごとにユニークにする分離とあわせて直列実行で十分)。
  workers: 1,
  retries: process.env.CI ? 2 : 0,
  reporter: [["html", { open: "never" }], ["list"]],
  globalSetup: "./tests/e2e/global-setup.ts",
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? APP_ORIGIN,
    trace: "on-first-retry",
  },
  webServer: [
    {
      command: "npm run build && npm run build:services && npm run start",
      url: `${APP_ORIGIN}/health`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: webEnv,
    },
    {
      command: "node build/services/display/index.js",
      url: `${DISPLAY_ORIGIN}/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: displayEnv,
    },
  ],
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
