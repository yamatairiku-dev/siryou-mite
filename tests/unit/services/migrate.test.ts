import { describe, expect, it } from "vitest";
import {
  buildMigrationRunnerOptions,
  MIGRATE_APPLICATION_NAME,
} from "../../../services/migrate/index";
import { parseMigrateEnvironment } from "../../../services/migrate/env";
import { describeFailure } from "../../../services/shared/log";

/**
 * Migration Job(設計 §7.4)。実際のmigration適用は結合テスト
 * (`tests/integration/db-bootstrap.test.ts`)で確認する。
 */

describe("buildMigrationRunnerOptions", () => {
  it("ローカルの`node-pg-migrate up`(CLI既定値)と同じ条件でforward-onlyに適用する", () => {
    const env = parseMigrateEnvironment({
      DATABASE_URL: "postgres://user:pass@localhost:5432/siryou_mite",
    });

    const options = buildMigrationRunnerOptions(env, { migrationsDir: "/app/migrations" });

    expect(options).toMatchObject({
      dir: "/app/migrations",
      direction: "up",
      migrationsTable: "pgmigrations",
      checkOrder: true,
      singleTransaction: true,
      noLock: false,
    });
    expect(options.databaseUrl).toEqual({
      connectionString: "postgres://user:pass@localhost:5432/siryou_mite",
      application_name: MIGRATE_APPLICATION_NAME,
    });
  });

  it("本番はTLS(証明書検証あり)とManaged Identityのpassword関数で接続する", () => {
    const env = parseMigrateEnvironment({
      NODE_ENV: "production",
      DATABASE_URL: "postgres://id-siryou-mite-migrate@db.example.com:5432/siryou_mite",
      DATABASE_AUTH: "entra",
    });
    const password = async () => "token";

    const options = buildMigrationRunnerOptions(env, {
      migrationsDir: "/app/migrations",
      password,
    });

    expect(options.databaseUrl).toMatchObject({
      ssl: { rejectUnauthorized: true },
      password,
    });
  });

  it("本番でDATABASE_AUTH=entra以外は起動前に拒否する", () => {
    expect(() =>
      parseMigrateEnvironment({
        NODE_ENV: "production",
        DATABASE_URL: "postgres://user:pass@db.example.com:5432/siryou_mite",
      }),
    ).toThrow("DATABASE_AUTH=entra");
  });
});

describe("describeFailure", () => {
  it("例外の種類とSQLSTATEだけを返し、messageは含めない", () => {
    const error = Object.assign(new Error('relation "secret_table" does not exist'), {
      code: "42P01",
    });

    expect(describeFailure(error)).toEqual({ errorName: "Error", errorCode: "42P01" });
    expect(JSON.stringify(describeFailure(error))).not.toContain("secret_table");
  });

  it("codeが想定外の形式なら出さない", () => {
    expect(
      describeFailure(Object.assign(new Error("x"), { code: "postgres://user:pw@host" })),
    ).toEqual({ errorName: "Error" });
    expect(describeFailure("string error")).toEqual({ errorName: "unknown" });
  });
});
