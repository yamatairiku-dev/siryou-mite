/**
 * DB初期設定(Managed IdentityのDB role作成と最小権限の付与)の手順。
 *
 * 設計: docs/APPLICATION_DESIGN.md §7.4, §12.2, §16
 *
 * Web・Display・Preview・Maintenance・Migrationは別々のManaged Identityで接続し、
 * DB roleは用途別に最小権限にする(設計 §7.4)。テーブル単位の権限はmigrationが
 * `siryou_mite_runtime`・`siryou_mite_maintenance`へ与える(roleが存在する場合だけ)。
 * このJobはその前提となる次を、PostgreSQLのEntra管理者として冪等に用意する。
 *
 * 1. 各Managed IdentityのEntra principal(PostgreSQL role)を作る
 * 2. 権限のまとめ役となるNOLOGIN role(runtime・maintenance)を作り、
 *    各principalをmemberにする
 * 3. 業務DBが無ければ作る(このJobのidentityが所有者になり、`public` schemaへの
 *    権限を付与できる)
 * 4. Migration Jobのidentityへ`public` schemaのUSAGE・CREATEを与える
 *    (runtime identityにはDDL権限を与えない)
 *
 * migrationより先に実行する。roleが無い状態でmigrationを適用すると、GRANTが
 * 飛ばされたまま記録される(forward-onlyのため再適用されない)。その状態を検出した
 * 場合は失敗として止める。
 */
import { escapeIdentifier } from "pg";
import type { Queryable } from "../shared/db/pool.js";
import type { BootstrapPrincipal, PrincipalRole } from "./env.js";

/** migrationがGRANT先として参照するrole名(migrations/*.sql)。 */
export const GROUP_ROLE_FOR: Record<Exclude<PrincipalRole, "migration">, string> = {
  runtime: "siryou_mite_runtime",
  maintenance: "siryou_mite_maintenance",
};

export type DbBootstrapDependencies = {
  /** Entra principalを作る管理用DB(`postgres`)への接続。 */
  admin: Queryable;
  /** 業務DBへの接続を開く。DBを作った後に呼ぶ。 */
  openTarget: () => Promise<{ db: Queryable; close: () => Promise<void> }>;
  log: (event: string, details?: Record<string, unknown>) => void;
};

export type DbBootstrapConfig = {
  databaseName: string;
  principals: readonly BootstrapPrincipal[];
};

export class MigrationsAppliedBeforeRolesError extends Error {
  constructor() {
    super(
      "migrationが適用済みのDBに後からroleを作成しました。テーブル権限が付与されていません",
    );
    this.name = "MigrationsAppliedBeforeRolesError";
  }
}

async function roleExists(db: Queryable, name: string): Promise<boolean> {
  const result = await db.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [name]);
  return (result.rowCount ?? 0) > 0;
}

export async function runDbBootstrap(
  deps: DbBootstrapDependencies,
  config: DbBootstrapConfig,
): Promise<void> {
  const { admin } = deps;

  // 1. Managed IdentityのEntra principal。object IDで作り、名前の付け替えに影響されない。
  for (const principal of config.principals) {
    if (await roleExists(admin, principal.name)) {
      continue;
    }
    await admin.query(
      "SELECT * FROM pgaadauth_create_principal_with_oid($1, $2, 'service', false, false)",
      [principal.name, principal.objectId],
    );
    deps.log("db_bootstrap_principal_created", { role: principal.role });
  }

  // 2. 権限のまとめ役のrole(login不可)とmembership。GRANTは再実行しても同じ結果になる。
  const createdGroupRoles: string[] = [];
  for (const groupRole of Object.values(GROUP_ROLE_FOR)) {
    if (!(await roleExists(admin, groupRole))) {
      await admin.query(`CREATE ROLE ${escapeIdentifier(groupRole)} NOLOGIN`);
      createdGroupRoles.push(groupRole);
    }
  }
  for (const principal of config.principals) {
    if (principal.role === "migration") {
      continue;
    }
    await admin.query(
      `GRANT ${escapeIdentifier(GROUP_ROLE_FOR[principal.role])} TO ${escapeIdentifier(principal.name)}`,
    );
  }

  // 3. 業務DB。CREATE DATABASEはトランザクション外で実行する必要がある。
  const existing = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [
    config.databaseName,
  ]);
  if ((existing.rowCount ?? 0) === 0) {
    await admin.query(`CREATE DATABASE ${escapeIdentifier(config.databaseName)}`);
    deps.log("db_bootstrap_database_created");
  }

  // 4. 業務DB内のschema権限。
  const target = await deps.openTarget();
  try {
    const migrator = config.principals.find((principal) => principal.role === "migration");
    if (migrator) {
      await target.db.query(
        `GRANT USAGE, CREATE ON SCHEMA public TO ${escapeIdentifier(migrator.name)}`,
      );
    }
    await target.db.query(
      `GRANT USAGE ON SCHEMA public TO ${Object.values(GROUP_ROLE_FOR)
        .map(escapeIdentifier)
        .join(", ")}`,
    );

    if (createdGroupRoles.length > 0) {
      const migrated = await target.db.query(
        "SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'pgmigrations'",
      );
      if ((migrated.rowCount ?? 0) > 0) {
        throw new MigrationsAppliedBeforeRolesError();
      }
    }
  } finally {
    await target.close();
  }

  deps.log("db_bootstrap_completed", { principals: config.principals.length });
}
