import type { PoolClient } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  closePool,
  getPool,
  poolSettings,
  runInTransaction,
} from "~/lib/db/pool.server";
import { createStubExecutor, type QueryCall } from "./stub-executor";

afterEach(async () => {
  await closePool();
  vi.restoreAllMocks();
});

describe("getPool", () => {
  it("設計 §7.4の接続設定でPoolを1つだけ作る", () => {
    const pool = getPool();

    expect(getPool()).toBe(pool);
    expect(pool.options.max).toBe(poolSettings.maxConnections);
    expect(pool.options.connectionTimeoutMillis).toBe(
      poolSettings.connectionTimeoutMillis,
    );
    expect(pool.options.idleTimeoutMillis).toBe(poolSettings.idleTimeoutMillis);
    expect(pool.options.statement_timeout).toBe(
      poolSettings.statementTimeoutMillis,
    );
    expect(pool.options.query_timeout).toBe(poolSettings.queryTimeoutMillis);
  });

  it("closePool後は新しいPoolを作る", async () => {
    const pool = getPool();
    await closePool();

    expect(getPool()).not.toBe(pool);
  });

  it("idle接続のエラーで異常終了せず、接続情報を含まない分類だけを記録する", () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const pool = getPool();

    pool.emit("error", Object.assign(new Error("connection terminated"), {
      code: "57P01",
    }));

    const logged = String(errorLog.mock.calls[0]?.[0] ?? "");
    expect(JSON.parse(logged)).toEqual({
      event: "db_pool_idle_client_error",
      errorCode: "57P01",
    });
    expect(logged).not.toContain("connection terminated");
    expect(logged).not.toContain("postgres");
  });
});

describe("runInTransaction", () => {
  function texts(calls: QueryCall[]): string[] {
    return calls.map((call) => call.text);
  }

  it("成功した場合はCOMMITする", async () => {
    const { executor, calls } = createStubExecutor();

    const result = await runInTransaction(
      executor as unknown as PoolClient,
      async (tx) => {
        await tx.query("SELECT 1");
        return "ok";
      },
    );

    expect(result).toBe("ok");
    expect(texts(calls)).toEqual(["BEGIN", "SELECT 1", "COMMIT"]);
  });

  it("失敗した場合はROLLBACKして元のエラーを投げる", async () => {
    const { executor, calls } = createStubExecutor();

    await expect(
      runInTransaction(executor as unknown as PoolClient, async () => {
        throw new Error("監査保存に失敗");
      }),
    ).rejects.toThrow("監査保存に失敗");
    expect(texts(calls)).toEqual(["BEGIN", "ROLLBACK"]);
  });

  it("ROLLBACK自体が失敗しても元のエラーを隠さない", async () => {
    const failingExecutor = {
      query: async (text: string) => {
        if (text === "ROLLBACK") {
          throw new Error("接続が切断されました");
        }
        return { rows: [], rowCount: 0, command: text, oid: 0, fields: [] };
      },
    } as unknown as PoolClient;

    await expect(
      runInTransaction(failingExecutor, async () => {
        throw new Error("業務更新に失敗");
      }),
    ).rejects.toThrow("業務更新に失敗");
  });

  it("型チェック: Poolを直接渡すことはできない(getPool()を渡すとBEGIN/COMMITが別接続になり、トランザクションが成立しない)", () => {
    // @ts-expect-error runInTransactionはPoolClientだけを受け付ける。
    const shouldNotCompile = () => runInTransaction(getPool(), async () => undefined);
    expect(typeof shouldNotCompile).toBe("function");
  });
});
