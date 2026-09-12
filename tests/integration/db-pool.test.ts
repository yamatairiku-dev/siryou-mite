import { afterAll, describe, expect, it } from "vitest";
import { closePool, getPool, poolSettings, withTransaction } from "~/lib/db/pool.server";

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
