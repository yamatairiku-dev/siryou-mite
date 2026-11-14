import { afterAll, describe, expect, it } from "vitest";
import { closePool, getPool, poolSettings, withTransaction } from "~/lib/db/pool.server";
import { createDatabasePool } from "../../services/shared/db/pool";

/**
 * T04 結合テスト: `pg` Poolの接続設定(設計 §7.4, §18.2)。
 * ローカルPostgreSQLへ実際に接続し、timeout設定が効いていることを確認する。
 */

afterAll(async () => {
  await closePool();
});

describe("getPool", () => {
  it("プロセス内で共有するPoolから実際にクエリを実行できる", async () => {
    const result = await getPool().query("SELECT 1 AS value");

    expect(result.rows[0]).toEqual({ value: 1 });
  });

  it("サーバー側のstatement timeoutを設定している", async () => {
    const result = await getPool().query<{ statement_timeout: string }>(
      "SHOW statement_timeout",
    );

    expect(result.rows[0]?.statement_timeout).toBe(
      `${poolSettings.statementTimeoutMillis / 1000}s`,
    );
  });

  it("長すぎるクエリはstatement timeoutで打ち切られる", async () => {
    await expect(
      getPool().query(
        `SET LOCAL statement_timeout = 50; SELECT pg_sleep(1)`,
      ),
    ).rejects.toThrow(/statement timeout|canceling statement/i);
  });
});

describe("withTransaction", () => {
  it("commitとrollbackを接続の返却込みで実行できる", async () => {
    const committed = await withTransaction(async (tx) => {
      await tx.query("CREATE TEMP TABLE t04_pool_check (value integer)");
      await tx.query("INSERT INTO t04_pool_check (value) VALUES (1)");
      const result = await tx.query<{ value: number }>(
        "SELECT value FROM t04_pool_check",
      );
      return result.rows[0]?.value;
    });
    expect(committed).toBe(1);

    await expect(
      withTransaction(async (tx) => {
        await tx.query("SELECT 1");
        throw new Error("業務エラー");
      }),
    ).rejects.toThrow("業務エラー");

    // rollback後も接続がPoolへ返却され、続けて利用できる。
    const after = await getPool().query("SELECT 2 AS value");
    expect(after.rows[0]).toEqual({ value: 2 });
  });
});

/**
 * Managed Identityで接続する場合と同じ形(passwordを含まない接続文字列 + password関数)で、
 * 実際のPostgreSQLへ接続できることを確認する(設計 §7.4)。
 *
 * `pg`は`connectionString`とpassword関数を併用すると関数を捨て、passwordなしで接続する。
 * stagingで認証エラー(SQLSTATE 28P01)になった不具合の再発防止。
 */
describe("createDatabasePool(password関数)", () => {
  function connectWith(password: () => Promise<string>) {
    const url = new URL(process.env.DATABASE_URL ?? "");
    url.password = "";
    return createDatabasePool({
      connectionString: url.toString(),
      applicationName: "siryou-mite-test-password-function",
      requireTls: false,
      password,
    });
  }

  const realPassword = () =>
    decodeURIComponent(new URL(process.env.DATABASE_URL ?? "").password);

  it("接続文字列にpasswordが無くても、password関数の値で接続できる", async () => {
    let calls = 0;
    const pool = connectWith(async () => {
      calls += 1;
      return realPassword();
    });

    try {
      const result = await pool.query<{ current_user: string }>("SELECT current_user");

      expect(result.rows[0]?.current_user).toBe(
        decodeURIComponent(new URL(process.env.DATABASE_URL ?? "").username),
      );
      expect(calls).toBeGreaterThan(0);
    } finally {
      await pool.end();
    }
  });

  it("password関数が誤った値を返すと認証で拒否される(関数の値が実際に使われている)", async () => {
    const pool = connectWith(async () => `${realPassword()}-wrong`);

    try {
      await expect(pool.query("SELECT 1")).rejects.toMatchObject({ code: "28P01" });
    } finally {
      await pool.end();
    }
  });
});
