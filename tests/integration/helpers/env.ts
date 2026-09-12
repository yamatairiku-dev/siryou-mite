/**
 * 結合テスト用の環境変数(`vitest.integration.config.ts`の`setupFiles`)。
 *
 * `app/lib/env.server.ts`はimport時にZodで全項目を検証するため、DB・Storage以外の
 * 項目にもテスト専用のダミー値を入れる。`DATABASE_URL`と
 * `AZURE_STORAGE_CONNECTION_STRING`はdevcontainerのPostgreSQL・Azuriteを指す
 * 実際の値をそのまま使うので、ここでは設定しない(未設定ならテストが失敗する)。
 * Blob/Queue結合テスト(設計 §18.2)は実際のAzuriteエンドポイント
 * (`BlobEndpoint=http://azurite:10000/...`)へ接続する必要があり、ここで
 * `UseDevelopmentStorage=true`(既定は`127.0.0.1`宛て)へ上書きするとdevcontainerの
 * ネットワーク構成(Azuriteはhost名`azurite`で疎通する)と食い違って接続できない。
 * ここで生成する鍵は使い捨てであり、実運用のsecretではない。
 */
import { generateKeyPairSync } from "node:crypto";

process.env.NODE_ENV = "test";
process.env.APP_NAME = "テストアプリ";
process.env.APP_ORIGIN = "http://localhost:3000";
process.env.AUTH_MODE = "dev";
process.env.SESSION_SECRET = "test-session-secret-at-least-32-characters";

process.env.DISPLAY_ORIGIN = "http://localhost:3100";

const { privateKey } = generateKeyPairSync("ed25519");
process.env.GRANT_SIGNING_KEY_ID = "test-key-1";
process.env.GRANT_SIGNING_PRIVATE_KEY = privateKey
  .export({ type: "pkcs8", format: "pem" })
  .toString();
process.env.GRANT_TTL_SECONDS = "60";

process.env.LOG_HMAC_KEY = Buffer.alloc(32, 7).toString("base64");
