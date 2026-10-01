/**
 * Migration Job(DBマイグレーション)のエントリーポイント。
 *
 * 設計: docs/APPLICATION_DESIGN.md §7.4, §7.6
 *
 * 専用Managed IdentityのMigration Jobがdeploy前に1回実行する(設計 §7.4)。
 * Managed IdentityのEntra ID access tokenは約1時間で失効し、固定の接続文字列へ
 * 入れられないため、`node-pg-migrate`のCLIではなくrunnerを直接呼び、接続ごとに
 * tokenを返すpassword関数を渡す。オプションはローカルの`npm run db:migrate`
 * (CLIの既定値)と同じにし、forward-only(`up`だけ)で実行する。
 *
 * Web・Display・Maintenanceと同じNode.js用Docker imageから、このentryだけを
 * 異なるcommandで起動する(設計 §7.6)。imageには`migrations/`を含める。
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runner, type RunnerOption } from "node-pg-migrate";
import type { ClientConfig } from "pg";
import { databasePasswordOption } from "../shared/db/entra-auth.js";
import { describeFailure } from "../shared/log.js";
import { parseMigrateEnvironment, type MigrateEnvironment } from "./env.js";

export const SERVICE_NAME = "migrate" as const;

/** Migration Jobの接続をDB側で識別するための`application_name`。 */
export const MIGRATE_APPLICATION_NAME = "siryou-mite-migrate";

export function describeService(): string {
  return `${SERVICE_NAME} job: applies pending forward-only migrations once per run`;
}

/**
 * runnerのオプション。`node-pg-migrate up`(CLIの既定値)と同じ結果になるようにする:
 * `migrations/`ディレクトリ、`public` schema、`pgmigrations`テーブル、順序検査あり、
 * 全migrationを1トランザクション、advisory lockあり。
 */
export function buildMigrationRunnerOptions(
  env: MigrateEnvironment,
  options: {
    migrationsDir: string;
    password?: () => Promise<string>;
    log?: (message: string) => void;
  },
): RunnerOption & { databaseUrl: ClientConfig } {
  return {
    databaseUrl: {
      connectionString: env.DATABASE_URL,
      application_name: MIGRATE_APPLICATION_NAME,
      // 本番(Azure Database for PostgreSQL)はTLS必須。証明書検証は無効化しない。
      ...(env.NODE_ENV === "production"
        ? { ssl: { rejectUnauthorized: true } }
        : {}),
      ...(options.password ? { password: options.password } : {}),
    },
    dir: options.migrationsDir,
    direction: "up",
    migrationsTable: "pgmigrations",
    checkOrder: true,
    singleTransaction: true,
    noLock: false,
    log: options.log ?? (() => {}),
  };
}

/** 起動・終了ログ。接続先・migrationのSQL・秘密情報は含めない(設計 §9.5, §15.2)。 */
function logJobEvent(
  event: string,
  result: "success" | "failed",
  extra: Record<string, unknown> = {},
): void {
  console.log(
    JSON.stringify({ time: new Date().toISOString(), event, result, ...extra }),
  );
}

async function runMigrateJob(): Promise<number> {
  // 不正な環境変数はここで例外になり、Jobが動かない(fail closed)。
  const env = parseMigrateEnvironment(process.env);
  const applied = await runner(
    buildMigrationRunnerOptions(env, {
      // Docker imageのWORKDIR(/app)直下の`migrations/`を使う。
      migrationsDir: resolve(process.cwd(), "migrations"),
      ...databasePasswordOption(env.DATABASE_AUTH),
    }),
  );
  logJobEvent("migrate_job_applied", "success", { appliedCount: applied.length });
  return 0;
}

function main(): void {
  runMigrateJob()
    .then((exitCode) => {
      logJobEvent("migrate_job_finished", exitCode === 0 ? "success" : "failed");
      process.exit(exitCode);
    })
    .catch((error: unknown) => {
      // 例外の内容(接続文字列・SQLを含み得る)はログへ出さず、調査の手がかりとして
      // 例外の種類とPostgreSQLのエラーコード(SQLSTATE)だけを残す。
      logJobEvent("migrate_job_failed", "failed", describeFailure(error));
      process.exit(1);
    });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
