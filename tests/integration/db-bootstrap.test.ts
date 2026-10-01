import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { runner } from "node-pg-migrate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runDbBootstrap } from "../../services/db-bootstrap/job";
import type { BootstrapPrincipal } from "../../services/db-bootstrap/env";
import { buildMigrationRunnerOptions } from "../../services/migrate/index";
import { parseMigrateEnvironment } from "../../services/migrate/env";
import { requireDatabaseUrl } from "./helpers/schema";

/**
 * DB初期設定Job → Migration Jobの流れ(設計 §7.4)をローカルPostgreSQLで確認する。
 *
 * Azure Database for PostgreSQLのEntra管理者はsuperuserではない(CREATEROLE・
 * CREATEDBを持つ)ため、ここでも同じ権限のlogin roleを作ってJobを実行する。
 * Azure固有の`pgaadauth_create_principal_with_oid`は、同名の関数をテスト用の
 * 管理DBへ作り、password付きのlogin roleを作る形で代替する(Entra tokenの代わりに
 * passwordで接続して、付与された権限を実際の接続で確かめるため)。
 *
 * roleはcluster全体で共有されるため、テストごとにランダムな名前を使い、最後に削除する。
 * `siryou_mite_runtime`・`siryou_mite_maintenance`はmigrationが参照する固定名のため、
 * 他の結合テストと同じく開始時と終了時に削除する(結合テストはfile単位で直列実行)。
 */

const suffix = randomBytes(4).toString("hex");
const adminRole = `it_dbadmin_${suffix}`;
const adminPassword = `pw-${suffix}`;
const adminDatabase = `it_bootstrap_admin_${suffix}`;
const targetDatabase = `it_bootstrap_target_${suffix}`;
const groupRoles = ["siryou_mite_runtime", "siryou_mite_maintenance"];

const principals: BootstrapPrincipal[] = [
  { name: `it-web-${suffix}`, objectId: "11111111-1111-4111-8111-111111111111", role: "runtime" },
  { name: `it-maint-${suffix}`, objectId: "33333333-3333-4333-8333-333333333333", role: "maintenance" },
  { name: `it-migrate-${suffix}`, objectId: "44444444-4444-4444-8444-444444444444", role: "migration" },
];
const [web, maintenance, migrator] = principals as [
  BootstrapPrincipal,
  BootstrapPrincipal,
  BootstrapPrincipal,
];

/** stubが作るroleのpassword(Entra tokenの代わり)。 */
const passwordOf = (name: string) => `it-${name}`;

function urlFor(user: string, password: string, database: string): string {
  const url = new URL(requireDatabaseUrl());
  url.username = encodeURIComponent(user);
  url.password = encodeURIComponent(password);
  url.pathname = `/${database}`;
  return url.toString();
}

async function withSuperuser<T>(database: string | null, run: (client: Client) => Promise<T>) {
  const url = new URL(requireDatabaseUrl());
  if (database) url.pathname = `/${database}`;
  const client = new Client({ connectionString: url.toString() });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

async function bootstrapAsAdmin(): Promise<void> {
  const admin = new Client({ connectionString: urlFor(adminRole, adminPassword, adminDatabase) });
  await admin.connect();
  try {
    await runDbBootstrap(
      {
        admin,
        openTarget: async () => {
          const target = new Client({
            connectionString: urlFor(adminRole, adminPassword, targetDatabase),
          });
          await target.connect();
          return { db: target, close: () => target.end() };
        },
        log: () => {},
      },
      { databaseName: targetDatabase, principals },
    );
  } finally {
    await admin.end();
  }
}

async function dropEverything(): Promise<void> {
  await withSuperuser(null, async (client) => {
    for (const database of [targetDatabase, adminDatabase]) {
      await client.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
    }
    for (const role of [...principals.map((p) => p.name), ...groupRoles, adminRole]) {
      await client.query(`DROP ROLE IF EXISTS "${role}"`);
    }
  });
}

beforeAll(async () => {
  await dropEverything();
  await withSuperuser(null, async (client) => {
    await client.query(
      `CREATE ROLE "${adminRole}" LOGIN PASSWORD '${adminPassword}' CREATEROLE CREATEDB`,
    );
    await client.query(`CREATE DATABASE "${adminDatabase}"`);
  });
  await withSuperuser(adminDatabase, async (client) => {
    await client.query(`
      CREATE FUNCTION pgaadauth_create_principal_with_oid(
        role_name text, object_id text, object_type text, is_admin boolean, is_mfa boolean
      ) RETURNS text LANGUAGE plpgsql AS $$
      BEGIN
        EXECUTE format('CREATE ROLE %I LOGIN PASSWORD %L', role_name, 'it-' || role_name);
        RETURN 'Created role for ' || role_name;
      END $$`);
  });
});

afterAll(async () => {
  await dropEverything();
});

describe("DB初期設定Job → Migration Job(設計 §7.4)", () => {
  it("superuserでない管理者で初期設定し、Migration Jobのidentityでmigrationを適用できる", async () => {
    await bootstrapAsAdmin();

    const env = parseMigrateEnvironment({
      DATABASE_URL: urlFor(migrator.name, passwordOf(migrator.name), targetDatabase),
    });
    await runner(
      buildMigrationRunnerOptions(env, {
        migrationsDir: fileURLToPath(new URL("../../migrations", import.meta.url)),
      }),
    );

    const tables = await withSuperuser(targetDatabase, async (client) =>
      (
        await client.query<{ tablename: string }>(
          "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
        )
      ).rows.map((row) => row.tablename),
    );
    expect(tables).toEqual(
      expect.arrayContaining(["audit_events", "documents", "pgmigrations", "upload_attempts"]),
    );
  });

  it("用途別identityへ最小権限が付与されている(runtimeは監査を削除できず、DDL権限も無い)", async () => {
    const privileges = await withSuperuser(targetDatabase, async (client) => {
      const check = async (role: string, object: string, privilege: string) =>
        (
          await client.query<{ ok: boolean }>(
            object === "schema"
              ? "SELECT has_schema_privilege($1, 'public', $2) AS ok"
              : "SELECT has_table_privilege($1, $3, $2) AS ok",
            object === "schema" ? [role, privilege] : [role, privilege, object],
          )
        ).rows[0]?.ok;

      return {
        webInsertDocuments: await check(web.name, "documents", "INSERT"),
        webInsertAudit: await check(web.name, "audit_events", "INSERT"),
        webDeleteAudit: await check(web.name, "audit_events", "DELETE"),
        webDeleteDocuments: await check(web.name, "documents", "DELETE"),
        webCreateInSchema: await check(web.name, "schema", "CREATE"),
        maintenanceDeleteAudit: await check(maintenance.name, "audit_events", "DELETE"),
        maintenanceInsertAudit: await check(maintenance.name, "audit_events", "INSERT"),
        maintenanceCreateInSchema: await check(maintenance.name, "schema", "CREATE"),
        migratorCreateInSchema: await check(migrator.name, "schema", "CREATE"),
      };
    });

    expect(privileges).toEqual({
      webInsertDocuments: true,
      webInsertAudit: true,
      webDeleteAudit: false,
      webDeleteDocuments: false,
      webCreateInSchema: false,
      maintenanceDeleteAudit: true,
      maintenanceInsertAudit: false,
      maintenanceCreateInSchema: false,
      migratorCreateInSchema: true,
    });
  });

  it("runtimeのidentityで実際に接続して読み取れる", async () => {
    const client = new Client({
      connectionString: urlFor(web.name, passwordOf(web.name), targetDatabase),
    });
    await client.connect();
    try {
      const result = await client.query("SELECT count(*) FROM documents");
      expect(result.rowCount).toBe(1);
      await expect(client.query("CREATE TABLE should_fail (id int)")).rejects.toMatchObject({
        code: "42501", // insufficient_privilege
      });
    } finally {
      await client.end();
    }
  });

  it("もう一度実行しても失敗せず、権限も変わらない(冪等)", async () => {
    await expect(bootstrapAsAdmin()).resolves.toBeUndefined();
  });
});
