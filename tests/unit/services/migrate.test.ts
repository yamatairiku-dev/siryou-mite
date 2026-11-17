import { Client } from "pg";
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

    expect(options.databaseUrl).toEqual({
      host: "db.example.com",
      port: 5432,
      user: "id-siryou-mite-migrate",
      database: "siryou_mite",
      password,
      application_name: MIGRATE_APPLICATION_NAME,
      ssl: { rejectUnauthorized: true },
    });
  });

  it("password関数はconnectionStringと併用せず、pgのClientへ渡る", () => {
    // `pg`は`connectionString`とpassword関数を併用すると関数を捨て、passwordなしで
    // 接続する(stagingで認証エラー28P01になった不具合の再発防止)。
    const env = parseMigrateEnvironment({
      NODE_ENV: "production",
      DATABASE_URL: "postgres://id-siryou-mite-migrate@db.example.com:5432/siryou_mite",
      DATABASE_AUTH: "entra",
    });
    const password = async () => "token";

    const { databaseUrl } = buildMigrationRunnerOptions(env, {
      migrationsDir: "/app/migrations",
      password,
    });
    const client = new Client(databaseUrl);

    expect(databaseUrl).not.toHaveProperty("connectionString");
    expect(client.password).toBe(password);
    expect(client.user).toBe("id-siryou-mite-migrate");
    expect(client.database).toBe("siryou_mite");
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

  it("Node.jsとAzure SDKのエラーコード、HTTP statusを返す(messageは含めない)", () => {
    expect(
      describeFailure(
        Object.assign(new Error("getaddrinfo ENOTFOUND secret-host.example"), {
          code: "ENOTFOUND",
        }),
      ),
    ).toEqual({ errorName: "Error", errorCode: "ENOTFOUND" });

    const restError = Object.assign(new Error("https://account.queue.example/q?sig=secret"), {
      name: "RestError",
      code: "AuthorizationFailure",
      statusCode: 403,
    });
    expect(describeFailure(restError)).toEqual({
      errorName: "RestError",
      errorCode: "AuthorizationFailure",
      statusCode: 403,
    });
    expect(JSON.stringify(describeFailure(restError))).not.toContain("secret");
  });

  it("statusCodeがHTTP statusの範囲に無い値・数値以外なら出さない", () => {
    for (const statusCode of [0, 99, 600, 403.5, "403", null]) {
      expect(
        describeFailure(Object.assign(new Error("x"), { statusCode })),
      ).toEqual({ errorName: "Error" });
    }
  });
});
