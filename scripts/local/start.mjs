#!/usr/bin/env node
/**
 * ローカル(devcontainer)で Web・Display・Preview Job を1コマンドで起動する。
 *
 *   npm run local
 *
 * - devcontainerのPostgreSQL・Azuriteだけを使い、Azureには接続しない
 * - 認証は`AUTH_MODE=dev`(開発ユーザーでログイン)。`NODE_ENV=development`固定で、
 *   本番設定(`NODE_ENV=production`)では`AUTH_MODE=dev`が起動時に拒否される
 * - 表示grant署名鍵・ログHMAC鍵・セッション秘密は起動のたびに使い捨てで生成し、
 *   子プロセスの環境変数としてだけ渡す(`.env`は読まず、ファイルにも書かない)
 * - Preview Jobは本番ではQueue駆動のJob(1実行1メッセージ)。ここでは同じ
 *   エントリーポイントを数秒おきに起動して代用する
 */
import { spawn, spawnSync } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import http from "node:http";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL("../..", import.meta.url));
const WEB_PORT = Number(process.env.LOCAL_WEB_PORT ?? 3000);
const DISPLAY_PORT = Number(process.env.LOCAL_DISPLAY_PORT ?? 3100);
// Web本体はコンテナ内だけで使うportで動かし、WEB_PORTにはこのスクリプトの中継を置く。
const WEB_INTERNAL_PORT = WEB_PORT + 80;
const DISPLAY_ORIGIN = `http://localhost:${DISPLAY_PORT}`;
const PREVIEW_INTERVAL_MS = 3_000;
const STORAGE_CONTAINER = "documents";
const STORAGE_QUEUE_NAME = "preview-generation";

const allowedHosts = new Set(["postgres", "azurite", "localhost", "127.0.0.1"]);

function fail(message) {
  console.error(`[local] ${message}`);
  process.exit(1);
}

const DATABASE_URL = process.env.DATABASE_URL;
const AZURE_STORAGE_CONNECTION_STRING =
  process.env.AZURE_STORAGE_CONNECTION_STRING;
if (!DATABASE_URL || !AZURE_STORAGE_CONNECTION_STRING) {
  fail(
    "DATABASE_URL と AZURE_STORAGE_CONNECTION_STRING が必要です(devcontainer内で実行してください)",
  );
}

// migrationとBlob/Queue作成を伴うため、ローカル以外の接続先では動かさない。
const storageHosts = [
  ...AZURE_STORAGE_CONNECTION_STRING.matchAll(
    /(?:Blob|Queue)Endpoint=(https?:\/\/[^;]+)/gi,
  ),
].map((match) => new URL(match[1]).hostname);
if (
  !allowedHosts.has(new URL(DATABASE_URL).hostname) ||
  storageHosts.length === 0 ||
  storageHosts.some((host) => !allowedHosts.has(host))
) {
  fail("ローカルのPostgreSQL・Azurite以外へは接続しません");
}

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    env,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    fail(`${command} ${args.join(" ")} が失敗しました`);
  }
}

// `npm run build`は`build/`を作り直すため、Web・servicesの両方が揃っているときだけ省く。
const hasBuild =
  existsSync(`${rootDir}build/server/index.js`) &&
  existsSync(`${rootDir}build/services/display/index.js`);
if (process.env.LOCAL_SKIP_BUILD !== "1" || !hasBuild) {
  console.log("[local] build中...");
  run("npm", ["run", "build"]);
  run("npm", ["run", "build:services"]);
}

console.log("[local] DB migrationを適用中...");
run("npm", ["run", "db:migrate"]);

const storage = await import(
  new URL("../../build/services/shared/storage.js", import.meta.url).href
);
const storageConfig = storage.resolveStorageConnectionConfig({
  AZURE_STORAGE_CONNECTION_STRING,
});
await storage
  .getDocumentsContainerClient(
    storage.createBlobServiceClient(storageConfig),
    STORAGE_CONTAINER,
  )
  .createIfNotExists();
await storage
  .getPreviewQueueClient(
    storage.createQueueServiceClient(storageConfig),
    STORAGE_QUEUE_NAME,
  )
  .createIfNotExists();

const GRANT_SIGNING_KEY_ID = "local-key-1";
const { privateKey, publicKey } = generateKeyPairSync("ed25519");

const commonEnv = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  NODE_ENV: "development",
  DATABASE_URL,
  DATABASE_AUTH: "password",
  AZURE_STORAGE_CONNECTION_STRING,
  AZURE_STORAGE_CONTAINER: STORAGE_CONTAINER,
  LOG_HMAC_KEY: randomBytes(32).toString("base64"),
};

const webEnv = {
  ...commonEnv,
  PORT: String(WEB_INTERNAL_PORT),
  DISPLAY_ORIGIN,
  AUTH_MODE: "dev",
  SESSION_SECRET: randomBytes(48).toString("base64"),
  AZURE_STORAGE_QUEUE_NAME: STORAGE_QUEUE_NAME,
  GRANT_SIGNING_KEY_ID,
  GRANT_SIGNING_PRIVATE_KEY: privateKey
    .export({ type: "pkcs8", format: "pem" })
    .toString(),
};

const displayBaseEnv = {
  ...commonEnv,
  PORT: String(DISPLAY_PORT),
  GRANT_VERIFICATION_KEYS: JSON.stringify([
    {
      keyId: GRANT_SIGNING_KEY_ID,
      publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
    },
  ]),
};

const previewEnv = {
  ...commonEnv,
  AZURE_STORAGE_QUEUE_NAME: STORAGE_QUEUE_NAME,
  ...(process.env.PLAYWRIGHT_BROWSERS_PATH
    ? { PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH }
    : {}),
};

const children = new Set();
let stopping = false;
let proxy = null;

function stop(exitCode) {
  if (stopping) return;
  stopping = true;
  proxy?.close();
  for (const child of children) child.kill("SIGTERM");
  setTimeout(() => process.exit(exitCode), 500);
}

function startServer(label, args, env) {
  const child = spawn(process.execPath, args, {
    cwd: rootDir,
    env,
    stdio: "inherit",
  });
  children.add(child);
  child.on("exit", (code) => {
    children.delete(child);
    if (!stopping && !child.replaced) {
      console.error(`[local] ${label} が終了しました(code=${code})`);
      stop(1);
    }
  });
  return child;
}

async function waitForHealth(port) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch {
      // 起動待ち
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  fail(`port ${port} の起動を確認できませんでした`);
}

startServer(
  "Web",
  ["node_modules/@react-router/serve/bin.cjs", "build/server/index.js"],
  webEnv,
);
await waitForHealth(WEB_INTERNAL_PORT);

/**
 * DisplayはWebのオリジン(`APP_ORIGIN`)と完全一致するOriginからの要求だけを受け付ける
 * (設計 §7.2)。ローカルではport転送の仕方によってブラウザから見たWebのオリジンが
 * 変わる(`localhost:3000`、composeが公開する`localhost:3001`、`127.0.0.1`など)ため、
 * ブラウザが実際に使ったHostに合わせてDisplayを起動し直す。Displayの検証そのものは
 * 緩めない。
 */
let displayChild = null;
let displayAppOrigin = null;
let displaySwitch = Promise.resolve();

function ensureDisplayFor(appOrigin) {
  displaySwitch = displaySwitch.then(async () => {
    if (appOrigin === displayAppOrigin) return;
    if (displayChild) {
      const previous = displayChild;
      previous.replaced = true;
      const exited = new Promise((resolve) => previous.once("exit", resolve));
      previous.kill("SIGTERM");
      await exited;
    }
    displayAppOrigin = appOrigin;
    displayChild = startServer("Display", ["build/services/display/index.js"], {
      ...displayBaseEnv,
      APP_ORIGIN: appOrigin,
    });
    await waitForHealth(DISPLAY_PORT);
    console.log(`[local] Displayが受け付けるWebのオリジン: ${appOrigin}`);
  });
  return displaySwitch;
}

const localHostPattern = /^(localhost|127\.0\.0\.1)(:\d{1,5})?$/;

proxy = http.createServer(async (request, response) => {
  const host = request.headers.host ?? "";
  if (!localHostPattern.test(host)) {
    response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("localhost または 127.0.0.1 で開いてください");
    return;
  }
  if (request.url !== "/health") {
    await ensureDisplayFor(`http://${host}`);
  }
  const upstream = http.request(
    {
      host: "127.0.0.1",
      port: WEB_INTERNAL_PORT,
      method: request.method,
      path: request.url,
      headers: request.headers,
    },
    (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    },
  );
  upstream.on("error", () => {
    if (!response.headersSent) response.writeHead(502);
    response.end();
  });
  request.pipe(upstream);
});
proxy.listen(WEB_PORT);
await ensureDisplayFor(`http://localhost:${WEB_PORT}`);

// Preview Job: 1実行1メッセージ。Queueが空なら何もせず終わるので、出力は捨てる。
function runPreviewOnce() {
  if (stopping) return;
  const child = spawn(process.execPath, ["build/services/preview/index.js"], {
    cwd: rootDir,
    env: previewEnv,
    stdio: "ignore",
  });
  children.add(child);
  child.on("exit", () => {
    children.delete(child);
    setTimeout(runPreviewOnce, PREVIEW_INTERVAL_MS);
  });
}
runPreviewOnce();

process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));

console.log(`
[local] 起動しました(Ctrl+C で停止)
  Web     : http://localhost:${WEB_PORT}
            (composeが公開するport経由の http://localhost:3001 などでも開けます)
  Display : ${DISPLAY_ORIGIN}
  Preview : ${PREVIEW_INTERVAL_MS / 1000}秒おきにQueueを1件処理
`);
