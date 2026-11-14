import { Client, Pool } from "pg";
import { describe, expect, it } from "vitest";
import { connectionTarget } from "../../../services/shared/db/connection";
import { createDatabasePool } from "../../../services/shared/db/pool";

/**
 * `pg`へ渡す接続先(設計 §7.4)。
 *
 * `pg`は`connectionString`とpassword関数を併用すると関数を捨てる。stagingで
 * Managed Identityの接続が認証エラー(SQLSTATE 28P01)になった不具合の再発防止として、
 * 実際の`pg`の`Client`にpassword関数が残ることを確認する(接続はしない)。
 */

const entraUrl =
  "postgres://id-siryou-mite-web@db.example.com:5432/siryou_mite";

describe("connectionTarget", () => {
  it("password関数が無い場合は接続文字列をそのまま使う", () => {
    const url = "postgres://user:pass@localhost:5432/siryou_mite";

    expect(connectionTarget(url)).toEqual({ connectionString: url });
  });

  it("password関数がある場合は接続文字列を分解し、connectionStringを渡さない", () => {
    const password = async () => "token";

    expect(connectionTarget(entraUrl, password)).toEqual({
      host: "db.example.com",
      port: 5432,
      user: "id-siryou-mite-web",
      database: "siryou_mite",
      password,
    });
  });

  it("利用者名・DB名のpercent encodingを戻し、port省略時は5432にする", () => {
    const target = connectionTarget(
      "postgres://id%2Dweb%40example@db.example.com/siryou%5Fmite",
      async () => "token",
    );

    expect(target).toMatchObject({
      host: "db.example.com",
      port: 5432,
      user: "id-web@example",
      database: "siryou_mite",
    });
  });

  it("IPv6のhostは角括弧を外して渡す", () => {
    const target = connectionTarget(
      "postgres://id-web@[::1]:6432/siryou_mite",
      async () => "token",
    );

    expect(target).toMatchObject({ host: "::1", port: 6432 });
  });

  it("分解した設定で作ったpgのClientにpassword関数が残る", () => {
    const password = async () => "token";

    const client = new Client(connectionTarget(entraUrl, password));

    expect(client.password).toBe(password);
    expect(client.user).toBe("id-siryou-mite-web");
    expect(client.host).toBe("db.example.com");
    expect(client.port).toBe(5432);
    expect(client.database).toBe("siryou_mite");
  });
});

describe("createDatabasePool(password関数)", () => {
  it("Poolが作るClientにpassword関数が渡る", async () => {
    const password = async () => "token";
    const pool: Pool = createDatabasePool({
      connectionString: entraUrl,
      applicationName: "siryou-mite-test",
      requireTls: true,
      password,
    });

    try {
      // Poolは接続のたびに`new Client(pool.options)`を実行する。
      const client = new Client(pool.options);

      expect(client.password).toBe(password);
      expect(client.user).toBe("id-siryou-mite-web");
      expect(client.host).toBe("db.example.com");
      expect(client.database).toBe("siryou_mite");
      expect(pool.options.ssl).toEqual({ rejectUnauthorized: true });
    } finally {
      await pool.end();
    }
  });
});
