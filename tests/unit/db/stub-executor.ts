import type { Queryable } from "~/lib/db/pool.server";

export type QueryCall = { text: string; values: unknown[] };

/**
 * repositoryのSQL組み立てを、DBへ接続せずに検証するためのstub。
 * 実際のSQL実行は結合テスト(`tests/integration`)で確認する。
 */
export function createStubExecutor(rowsPerCall: unknown[][] = []) {
  const calls: QueryCall[] = [];
  const queue = [...rowsPerCall];

  const executor = {
    query: async (text: string, values?: ReadonlyArray<unknown>) => {
      calls.push({ text, values: values ? [...values] : [] });
      const rows = queue.shift() ?? [];
      return { rows, rowCount: rows.length, command: "SELECT", oid: 0, fields: [] };
    },
  } as unknown as Queryable;

  return { executor, calls };
}

/** 直近の呼び出しを取得する(未呼び出しならテストを失敗させる)。 */
export function lastCall(calls: QueryCall[]): QueryCall {
  const call = calls[calls.length - 1];
  if (!call) {
    throw new Error("SQLが1件も実行されていません");
  }
  return call;
}
