import { describe, expect, it, vi } from "vitest";
import type { Queryable } from "../../../services/shared/db/pool";
import {
  connectionStringForDatabase,
  databaseNameOf,
} from "../../../services/db-bootstrap/index";
import { parseDbBootstrapEnvironment } from "../../../services/db-bootstrap/env";
import {
  GROUP_ROLE_FOR,
  MigrationsAppliedBeforeRolesError,
  runDbBootstrap,
} from "../../../services/db-bootstrap/job";
import type { BootstrapPrincipal } from "../../../services/db-bootstrap/env";

/**
 * DB初期設定Job(設計 §7.4)。SQLの実行結果は結合テスト
 * (`tests/integration/db-bootstrap.test.ts`)で確認し、ここでは手順と冪等性を確認する。
 */

const principals: BootstrapPrincipal[] = [
  { name: "id-siryou-mite-web", objectId: "11111111-1111-4111-8111-111111111111", role: "runtime" },
  { name: "id-siryou-mite-display", objectId: "22222222-2222-4222-8222-222222222222", role: "runtime" },
  { name: "id-siryou-mite-maintenance", objectId: "33333333-3333-4333-8333-333333333333", role: "maintenance" },
  { name: "id-siryou-mite-migrate", objectId: "44444444-4444-4444-8444-444444444444", role: "migration" },
];

/** pg_roles・pg_database・pg_tablesの状態だけを持つ偽のPostgreSQL。 */
function fakeServer(initial: { roles?: string[]; databases?: string[]; migrated?: boolean } = {}) {
  const roles = new Set(initial.roles ?? []);
  const databases = new Set(initial.databases ?? []);
  const adminSql: string[] = [];
  const targetSql: string[] = [];

  function respond(sql: string, values: ReadonlyArray<unknown> = []) {
    const rows = (present: boolean) => ({ rows: present ? [{}] : [], rowCount: present ? 1 : 0 });
    if (sql.startsWith("SELECT 1 FROM pg_roles")) return rows(roles.has(String(values[0])));
    if (sql.startsWith("SELECT 1 FROM pg_database")) return rows(databases.has(String(values[0])));
    if (sql.includes("pgmigrations")) return rows(initial.migrated ?? false);
    if (sql.startsWith("SELECT * FROM pgaadauth_create_principal_with_oid")) {
      roles.add(String(values[0]));
    }
    const created = /^CREATE ROLE "([^"]+)"/.exec(sql);
    if (created?.[1]) roles.add(created[1]);
    const createdDb = /^CREATE DATABASE "([^"]+)"/.exec(sql);
    if (createdDb?.[1]) databases.add(createdDb[1]);
    return rows(false);
  }

  const queryable = (log: string[]) =>
    ({
      query: async (sql: string, values?: ReadonlyArray<unknown>) => {
        log.push(sql);
        return respond(sql, values);
      },
    }) as unknown as Queryable;

  const close = vi.fn(async () => {});
  return {
    roles,
    adminSql,
    targetSql,
    close,
    deps: {
      admin: queryable(adminSql),
      openTarget: async () => ({ db: queryable(targetSql), close }),
      log: vi.fn(),
    },
  };
}

describe("runDbBootstrap", () => {
  it("principal・まとめ役role・membership・DB・schema権限を順に用意する", async () => {
    const server = fakeServer();

    await runDbBootstrap(server.deps, { databaseName: "siryou_mite", principals });

    // Managed Identityはobject IDでprincipalを作る(名前の付け替えに影響されない)。
    expect(
      server.adminSql.filter((sql) => sql.includes("pgaadauth_create_principal_with_oid")),
    ).toHaveLength(4);
    expect(server.adminSql).toContain('CREATE ROLE "siryou_mite_runtime" NOLOGIN');
    expect(server.adminSql).toContain('CREATE ROLE "siryou_mite_maintenance" NOLOGIN');
    expect(server.adminSql).toContain('GRANT "siryou_mite_runtime" TO "id-siryou-mite-web"');
    expect(server.adminSql).toContain('GRANT "siryou_mite_runtime" TO "id-siryou-mite-display"');
    expect(server.adminSql).toContain(
      'GRANT "siryou_mite_maintenance" TO "id-siryou-mite-maintenance"',
    );
    expect(server.adminSql).toContain('CREATE DATABASE "siryou_mite"');

    // DDL権限はMigration Jobのidentityだけ。runtime・maintenanceはUSAGEだけ。
    expect(server.targetSql).toContain(
      'GRANT USAGE, CREATE ON SCHEMA public TO "id-siryou-mite-migrate"',
    );
    expect(server.targetSql).toContain(
      'GRANT USAGE ON SCHEMA public TO "siryou_mite_runtime", "siryou_mite_maintenance"',
    );
    expect(server.adminSql.join("\n")).not.toMatch(/GRANT "siryou_mite_\w+" TO "id-siryou-mite-migrate"/);
    expect(server.close).toHaveBeenCalledTimes(1);
  });

  it("2回目の実行では作成済みのprincipal・role・DBを作り直さない(冪等)", async () => {
    const server = fakeServer({
      roles: [...principals.map((p) => p.name), ...Object.values(GROUP_ROLE_FOR)],
      databases: ["siryou_mite"],
      migrated: true,
    });

    await runDbBootstrap(server.deps, { databaseName: "siryou_mite", principals });

    expect(server.adminSql.join("\n")).not.toMatch(/pgaadauth_create_principal|CREATE ROLE|CREATE DATABASE/);
    // 既にmigration済みでも、roleを新しく作っていなければ正常に終わる。
    expect(server.deps.log).toHaveBeenCalledWith("db_bootstrap_completed", { principals: 4 });
  });

  it("migration適用後にまとめ役roleを作った場合は、権限が欠けているため失敗にする", async () => {
    const server = fakeServer({ databases: ["siryou_mite"], migrated: true });

    await expect(
      runDbBootstrap(server.deps, { databaseName: "siryou_mite", principals }),
    ).rejects.toBeInstanceOf(MigrationsAppliedBeforeRolesError);
    expect(server.close).toHaveBeenCalledTimes(1);
  });

  it("ログにはobject ID・名前を出さず、役割と件数だけを出す", async () => {
    const server = fakeServer();

    await runDbBootstrap(server.deps, { databaseName: "siryou_mite", principals });

    const logged = JSON.stringify(server.deps.log.mock.calls);
    expect(logged).not.toContain("11111111");
    expect(logged).not.toContain("id-siryou-mite-web");
    expect(logged).toContain("runtime");
  });
});

describe("parseDbBootstrapEnvironment", () => {
  const base = {
    NODE_ENV: "production",
    DATABASE_URL: "postgres://id-siryou-mite-dbadmin@db.example.com:5432/siryou_mite",
    DATABASE_AUTH: "entra",
    DB_BOOTSTRAP_PRINCIPALS: JSON.stringify(principals),
  };

  it("本番設定を受け付け、管理用DBの既定値はpostgres", () => {
    const env = parseDbBootstrapEnvironment(base);

    expect(env.DB_BOOTSTRAP_ADMIN_DATABASE).toBe("postgres");
    expect(env.DB_BOOTSTRAP_PRINCIPALS).toHaveLength(4);
  });

  it.each([
    ["SQLへ埋め込めない名前", [{ ...principals[3], name: 'x"; DROP ROLE y; --' }]],
    ["object IDがUUIDでない", [{ ...principals[3], objectId: "not-a-uuid" }]],
    ["migrationが無い", principals.slice(0, 3)],
    ["migrationが2つ", [...principals, { ...principals[3], name: "id-other-migrate" }]],
    ["名前の重複", [...principals, { ...principals[0], objectId: "55555555-5555-4555-8555-555555555555" }]],
  ])("%sは拒否する", (_label, value) => {
    expect(() =>
      parseDbBootstrapEnvironment({ ...base, DB_BOOTSTRAP_PRINCIPALS: JSON.stringify(value) }),
    ).toThrow("DB_BOOTSTRAP_PRINCIPALS");
  });

  it("本番はDATABASE_AUTH=entraを必須にする", () => {
    expect(() =>
      parseDbBootstrapEnvironment({ ...base, DATABASE_AUTH: "password" }),
    ).toThrow("DATABASE_AUTH=entra");
  });

  it("DB名がSQLへ埋め込めない形式の場合は拒否する", () => {
    expect(() =>
      parseDbBootstrapEnvironment({
        ...base,
        DATABASE_URL: "postgres://id@db.example.com:5432/bad%22name",
      }),
    ).toThrow("DATABASE_URL のDB名が不正です");
  });
});

describe("接続先DBの切り替え", () => {
  it("DATABASE_URLのDB名だけを差し替え、利用者名・host・optionは保つ", () => {
    const url = "postgres://id-admin@db.example.com:5432/siryou_mite?sslmode=require";

    expect(databaseNameOf(url)).toBe("siryou_mite");
    expect(connectionStringForDatabase(url, "postgres")).toBe(
      "postgres://id-admin@db.example.com:5432/postgres?sslmode=require",
    );
  });
});
