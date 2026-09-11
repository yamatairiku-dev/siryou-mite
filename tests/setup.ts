import { generateKeyPairSync } from "node:crypto";

process.env.NODE_ENV = "test";
process.env.APP_NAME = "テストアプリ";
process.env.APP_ORIGIN = "http://localhost:3000";
process.env.AUTH_MODE = "dev";
process.env.SESSION_SECRET = "test-session-secret-at-least-32-characters";
process.env.SESSION_MAX_AGE_SECONDS = "28800";

process.env.DATABASE_URL = "postgres://test:test@localhost:5432/siryou_mite_test";
process.env.DISPLAY_ORIGIN = "http://localhost:3100";
process.env.AZURE_STORAGE_CONNECTION_STRING = "UseDevelopmentStorage=true";
process.env.AZURE_STORAGE_CONTAINER = "documents";
process.env.AZURE_STORAGE_QUEUE_NAME = "preview-generation";

// テストだけで使う使い捨てのEd25519鍵。実運用のsecretではない。
const { privateKey } = generateKeyPairSync("ed25519");
process.env.GRANT_SIGNING_KEY_ID = "test-key-1";
process.env.GRANT_SIGNING_PRIVATE_KEY = privateKey
  .export({ type: "pkcs8", format: "pem" })
  .toString();
process.env.GRANT_TTL_SECONDS = "60";

process.env.LOG_HMAC_KEY = Buffer.alloc(32, 7).toString("base64");
