import { describe, expect, it } from "vitest";
import { assertLocalDatabaseHost } from "./helpers/schema.js";

/**
 * 結合テストの接続先ガード(設計 §18.2「本番Azure resourceには接続しない」)。
 *
 * 結合テストはschemaやテスト用roleをDROPするため、ローカル以外のPostgreSQLを
 * 指した`DATABASE_URL`では実行できないようにしている。
 */

describe("assertLocalDatabaseHost", () => {
  it.each([
    "postgresql://user:password@postgres:5432/siryou_mite",
    "postgres://user:password@localhost:5432/siryou_mite",
    "postgres://user:password@127.0.0.1:5432/siryou_mite",
  ])("ローカルのPostgreSQL(%s)を許可する", (databaseUrl) => {
    expect(() => assertLocalDatabaseHost(databaseUrl)).not.toThrow();
  });

  it.each([
    "postgresql://user:password@siryou-mite.postgres.database.azure.com:5432/siryou_mite",
    "postgresql://user:password@10.0.0.4:5432/siryou_mite",
    "not-a-url",
  ])("ローカル以外(%s)を拒否する", (databaseUrl) => {
    expect(() => assertLocalDatabaseHost(databaseUrl)).toThrow();
  });

  it("エラーメッセージへ接続文字列(利用者名・パスワード)を含めない", () => {
    const databaseUrl =
      "postgresql://appuser:sup3r-secret@siryou-mite.postgres.database.azure.com:5432/siryou_mite";

    expect(() => assertLocalDatabaseHost(databaseUrl)).toThrow(
      expect.objectContaining({
        message: expect.not.stringContaining("sup3r-secret"),
      }),
    );
  });
});
