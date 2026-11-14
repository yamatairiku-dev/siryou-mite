/**
 * DB初期設定Job(db-bootstrap)のエントリーポイント。
 *
 * 設計: docs/APPLICATION_DESIGN.md §7.4, §7.6
 *
 * PostgreSQLのEntra管理者に設定した専用Managed Identityで、環境の構築時と
 * Managed Identityを追加・作り直したときに実行する(冪等)。Migration Jobより先に
 * 実行する。手順は`job.ts`、環境変数schemaは`env.ts`にある。
 *
 * PostgreSQLはprivate endpointだけで公開するため、手元のPCからではなくVNet内の
 * Container Apps Jobとして実行する。Web・Display・Migration・Maintenanceと同じ
 * Node.js用Docker imageから、このentryだけを異なるcommandで起動する。
 */
import { fileURLToPath } from "node:url";
import { Client, type ClientConfig } from "pg";
import { connectionTarget } from "../shared/db/connection.js";
import { databasePasswordOption } from "../shared/db/entra-auth.js";
import { describeFailure } from "../shared/log.js";
import { parseDbBootstrapEnvironment, type DbBootstrapEnvironment } from "./env.js";
import { runDbBootstrap } from "./job.js";

export const SERVICE_NAME = "db-bootstrap" as const;

/** DB初期設定Jobの接続をDB側で識別するための`application_name`。 */
export const DB_BOOTSTRAP_APPLICATION_NAME = "siryou-mite-db-bootstrap";

export function describeService(): string {
  return `${SERVICE_NAME} job: creates managed identity database roles and grants least privileges idempotently`;
}

/** `DATABASE_URL`のDB名を差し替えた接続文字列を返す。 */
export function connectionStringForDatabase(
  databaseUrl: string,
  databaseName: string,
): string {
  const url = new URL(databaseUrl);
  url.pathname = `/${encodeURIComponent(databaseName)}`;
  return url.toString();
}

export function databaseNameOf(databaseUrl: string): string {
  return decodeURIComponent(new URL(databaseUrl).pathname.slice(1));
}

function logEvent(
  event: string,
  result: "success" | "failed",
  details: Record<string, unknown> = {},
): void {
  // 接続先・object ID・SQLは含めない(設計 §9.5, §15.2)。
  console.log(
    JSON.stringify({ time: new Date().toISOString(), event, result, ...details }),
  );
}

/**
 * 指定したDBへ接続する`pg`の設定。password関数は`connectionString`と併用できないため、
 * `connectionTarget`で接続先を組み立てる(`services/shared/db/connection.ts`)。
 */
export function buildClientConfig(
  env: DbBootstrapEnvironment,
  databaseName: string,
  password?: () => Promise<string>,
): ClientConfig {
  return {
    ...connectionTarget(
      connectionStringForDatabase(env.DATABASE_URL, databaseName),
      password,
    ),
    application_name: DB_BOOTSTRAP_APPLICATION_NAME,
    // 本番(Azure Database for PostgreSQL)はTLS必須。証明書検証は無効化しない。
    ...(env.NODE_ENV === "production" ? { ssl: { rejectUnauthorized: true } } : {}),
    connectionTimeoutMillis: 10_000,
    statement_timeout: 30_000,
  };
}

function newClient(env: DbBootstrapEnvironment, databaseName: string): Client {
  return new Client(
    buildClientConfig(
      env,
      databaseName,
      databasePasswordOption(env.DATABASE_AUTH).password,
    ),
  );
}

async function runDbBootstrapJob(): Promise<void> {
  // 不正な環境変数はここで例外になり、Jobが動かない(fail closed)。
  const env = parseDbBootstrapEnvironment(process.env);
  const databaseName = databaseNameOf(env.DATABASE_URL);

  const admin = newClient(env, env.DB_BOOTSTRAP_ADMIN_DATABASE);
  await admin.connect();
  try {
    await runDbBootstrap(
      {
        admin,
        openTarget: async () => {
          const target = newClient(env, databaseName);
          await target.connect();
          return { db: target, close: () => target.end() };
        },
        log: (event, details) => logEvent(event, "success", details),
      },
      { databaseName, principals: env.DB_BOOTSTRAP_PRINCIPALS },
    );
  } finally {
    await admin.end().catch(() => undefined);
  }
}

function main(): void {
  runDbBootstrapJob()
    .then(() => process.exit(0))
    .catch((error: unknown) => {
      // 例外の内容(接続文字列・SQLを含み得る)はログへ出さず、分類だけを残す。
      logEvent("db_bootstrap_failed", "failed", describeFailure(error));
      process.exit(1);
    });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
