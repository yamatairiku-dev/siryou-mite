import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { runner } from "node-pg-migrate";

/**
 * 結合テスト共通ヘルパー(設計 §18.2)。
 *
 * ローカルPostgreSQLに対して、`migrations/`配下のmigrationを専用schemaへ適用する。
 * devcontainerの`postgres`serviceに接続する前提で、`DATABASE_URL`は
 * `.devcontainer/docker-compose.yml`のdev serviceが設定する値をそのまま使う。
 */
export function requireDatabaseUrl(): string {
  const value = process.env.DATABASE_URL;
  if (!value) {
    throw new Error(
      "DATABASE_URL is required to run integration tests. Run `npm run test:integration` inside the devcontainer (see docs/OPERATIONS.md), or set DATABASE_URL to a reachable PostgreSQL instance.",
    );
  }
  return value;
}

export const migrationsDir = fileURLToPath(
  new URL("../../../migrations", import.meta.url),
);

/**
 * `schemaName`を空の状態から作り直し、全migrationを適用する。
 * 繰り返し実行できるよう、適用前に同名schemaがあれば削除する。
 */
export async function migrateFreshSchema(schemaName: string): Promise<void> {
  const databaseUrl = requireDatabaseUrl();
  await dropSchema(schemaName);

  await runner({
    databaseUrl,
    dir: migrationsDir,
    direction: "up",
    migrationsTable: "pgmigrations",
    schema: schemaName,
    createSchema: true,
    log: () => {},
  });
}

export async function dropSchema(schemaName: string): Promise<void> {
  const client = new Client({ connectionString: requireDatabaseUrl() });
  await client.connect();
  try {
    await client.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
  } finally {
    await client.end();
  }
}

export function newClient(): Client {
  return new Client({ connectionString: requireDatabaseUrl() });
}
