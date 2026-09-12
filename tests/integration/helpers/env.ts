/**
 * 結合テスト用の環境変数(`vitest.integration.config.ts`の`setupFiles`)。
 *
 * `app/lib/env.server.ts`はimport時にZodで全項目を検証するため、DB以外の項目にも
 * テスト専用のダミー値を入れる。`DATABASE_URL`はdevcontainerのPostgreSQLを指す
 * 実際の値をそのまま使うので、ここでは設定しない(未設定ならテストが失敗する)。
 * ここで生成する鍵は使い捨てであり、実運用のsecretではない。
 */
import { generateKeyPairSync } from "node:crypto";

process.env.NODE_ENV = "test";
process.env.APP_NAME = "テストアプリ";
process.env.APP_ORIGIN = "http://localhost:3000";
process.env.AUTH_MODE = "dev";
process.env.SESSION_SECRET = "test-session-secret-at-least-32-characters";

process.env.DISPLAY_ORIGIN = "http://localhost:3100";
process.env.AZURE_STORAGE_CONNECTION_STRING = "UseDevelopmentStorage=true";
process.env.AZURE_STORAGE_CONTAINER = "documents";
process.env.AZURE_STORAGE_QUEUE_NAME = "preview-generation";

const { privateKey } = generateKeyPairSync("ed25519");
process.env.GRANT_SIGNING_KEY_ID = "test-key-1";
process.env.GRANT_SIGNING_PRIVATE_KEY = privateKey
  .export({ type: "pkcs8", format: "pem" })
  .toString();
process.env.GRANT_TTL_SECONDS = "60";

process.env.LOG_HMAC_KEY = Buffer.alloc(32, 7).toString("base64");
