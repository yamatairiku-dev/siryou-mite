/**
 * Playwright globalSetup(設計 §18.3)。
 *
 * `webServer`(Web・Display)は既にこの前段で起動・healthcheck済みだが、DBの
 * migrationとBlob/Queueの作成はここでまとめて行う(実際のテスト実行より前に
 * 完了させれば十分で、サーバー起動そのものには不要なため)。
 *
 * - `npm run db:migrate`はforward-onlyかつ既存migrationへ再適用しても
 *   安全(`node-pg-migrate`が適用済みを記録する)ため、devcontainerの共有DBに
 *   対して毎回実行してよい。
 * - Blob container・Queueは本番同様に事前作成が前提のため、E2E専用の名前
 *   (`documents-e2e`・`preview-generation-e2e`)をここで`createIfNotExists`する。
 * - 本番Azure resourceには接続しない(設計 §18.2の方針をE2Eにも適用する)。
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  createBlobServiceClient,
  createQueueServiceClient,
  getDocumentsContainerClient,
  getPreviewQueueClient,
  resolveStorageConnectionConfig,
} from "../../services/shared/storage.js";
import {
  resolveDatabaseUrl,
  resolveStorageConnectionString,
  STORAGE_CONTAINER,
  STORAGE_QUEUE_NAME,
} from "./helpers/constants.js";

const allowedDatabaseHosts = new Set([
  "postgres",
  "localhost",
  "127.0.0.1",
  "::1",
  "[::1]",
]);
const allowedStorageHosts = new Set([
  "azurite",
  "localhost",
  "127.0.0.1",
  "::1",
  "[::1]",
]);

/**
 * migrationはschemaを変更する破壊力を持つため、devcontainerのローカルPostgreSQL
 * 以外へは向けない(設計 §18.2「本番Azure resourceには接続しない」と同じ方針)。
 */
function assertLocalDatabaseHost(databaseUrl: string): void {
  const host = new URL(databaseUrl).hostname;
  if (!allowedDatabaseHosts.has(host)) {
    throw new Error(
      "E2E globalSetup only runs migrations against a local PostgreSQL (postgres / localhost / 127.0.0.1).",
    );
  }
}

function assertLocalStorageHost(connectionString: string): void {
  const hosts = new Set<string>();
  for (const match of connectionString.matchAll(
    /(?:Blob|Queue)Endpoint=(https?:\/\/[^;]+)/gi,
  )) {
    const endpoint = match[1];
    if (endpoint) {
      hosts.add(new URL(endpoint).hostname);
    }
  }
  for (const host of hosts) {
    if (!allowedStorageHosts.has(host)) {
      throw new Error(
        "E2E globalSetup only creates containers/queues on a local Azurite emulator.",
      );
    }
  }
}

export default async function globalSetup(): Promise<void> {
  const databaseUrl = resolveDatabaseUrl();
  assertLocalDatabaseHost(databaseUrl);

  const migrateBin = fileURLToPath(
    new URL("../../node_modules/.bin/node-pg-migrate", import.meta.url),
  );
  try {
    execFileSync(migrateBin, ["up"], {
      cwd: fileURLToPath(new URL("../..", import.meta.url)),
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: "pipe",
    });
  } catch (error) {
    // `DATABASE_URL`(利用者名・パスワードを含み得る)はメッセージへ含めない
    // (設計 §9.5)。`node-pg-migrate`の標準エラー出力だけを添えて原因を分かりやすくする。
    const stderr =
      error && typeof error === "object" && "stderr" in error
        ? String((error as { stderr?: unknown }).stderr ?? "")
        : "";
    throw new Error(
      `db:migrate failed during E2E globalSetup.${stderr ? `\n${stderr}` : ""}`,
    );
  }

  const storageConnectionString = resolveStorageConnectionString();
  assertLocalStorageHost(storageConnectionString);

  const storageConfig = resolveStorageConnectionConfig({
    AZURE_STORAGE_CONNECTION_STRING: storageConnectionString,
  });

  const containerClient = getDocumentsContainerClient(
    createBlobServiceClient(storageConfig),
    STORAGE_CONTAINER,
  );
  await containerClient.createIfNotExists();

  const queueClient = getPreviewQueueClient(
    createQueueServiceClient(storageConfig),
    STORAGE_QUEUE_NAME,
  );
  await queueClient.createIfNotExists();
}
