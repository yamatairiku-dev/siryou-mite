/**
 * PostgreSQL接続のWeb向け薄いラッパー(設計 §7.4)。
 *
 * 実処理は`services/shared/db/pool.ts`に実装する(Web・Display・Preview・
 * Maintenanceで接続設定とtimeoutを重複させないため)。`services/`配下は`app/`を
 * importしない方針(docs/ARCHITECTURE.md、T04 Q-005)だが、逆方向
 * (`app/` → `services/shared/`)はこの制約に反しない。
 *
 * このファイルはWeb固有の関心事、すなわち`app/lib/env.server.ts`(Zod検証済み
 * 環境変数)からPoolを組み立ててプロセス内で使い回す部分だけを持つ。
 * repository(`*.server.ts`)からはこのmoduleの`getPool()`・`withTransaction()`
 * 経由で使う。ORMは導入しない。接続文字列やエラーの詳細はログへ出さない
 * (設計 §15.2)。
 */
import type { Pool } from "pg";
import { env } from "~/lib/env.server";
import {
  createDatabasePool,
  withTransactionOn,
  type Queryable,
} from "../../../services/shared/db/pool";

export { poolSettings, runInTransaction } from "../../../services/shared/db/pool";
export type { DatabasePoolConfig, Queryable } from "../../../services/shared/db/pool";

/** Web(App Service)の接続をDB側で識別するための`application_name`。 */
export const WEB_APPLICATION_NAME = "siryou-mite-web";

let pool: Pool | undefined;

/**
 * プロセス内で共有するPoolを返す。最初の呼び出しで生成し、以後は使い回す。
 * Poolの生成自体では接続しないため、接続先が無い環境でも読み込みは失敗しない。
 */
export function getPool(): Pool {
  if (!pool) {
    pool = createDatabasePool({
      connectionString: env.DATABASE_URL,
      applicationName: WEB_APPLICATION_NAME,
      // 本番(Azure Database for PostgreSQL)はTLS必須。ローカル・CIのPostgreSQLは
      // TLSを持たないためTLSを要求しない。
      requireTls: env.NODE_ENV === "production",
    });
  }
  return pool;
}

/** Poolから接続を1つ借りてトランザクションを実行し、必ず返却する。 */
export async function withTransaction<T>(
  run: (tx: Queryable) => Promise<T>,
): Promise<T> {
  return withTransactionOn(getPool(), run);
}

/** プロセス終了時とテストの後片付けで使う。 */
export async function closePool(): Promise<void> {
  const current = pool;
  pool = undefined;
  if (current) {
    await current.end();
  }
}
