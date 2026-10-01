import { describe, expect, it, vi } from "vitest";
import {
  createEntraPasswordProvider,
  databasePasswordOption,
  DatabaseTokenError,
  POSTGRES_ENTRA_SCOPE,
  type AccessTokenSource,
} from "../../../services/shared/db/entra-auth";
import { createDatabasePool } from "../../../services/shared/db/pool";

/**
 * Managed IdentityでPostgreSQLへ接続するpassword供給(設計 §7.4)。
 */

const HOUR = 60 * 60_000;

function credentialReturning(
  ...tokens: Array<{ token: string; expiresOnTimestamp: number } | null | Error>
): AccessTokenSource & { getToken: ReturnType<typeof vi.fn> } {
  const getToken = vi.fn(async () => {
    const next = tokens.shift();
    if (next instanceof Error) {
      throw next;
    }
    return next ?? null;
  });
  return { getToken };
}

describe("createEntraPasswordProvider", () => {
  it("PostgreSQL用のscopeでtokenを取得し、timeout付きのsignalを渡す", async () => {
    const credential = credentialReturning({ token: "t1", expiresOnTimestamp: HOUR });
    const password = createEntraPasswordProvider(credential, { now: () => 0 });

    await expect(password()).resolves.toBe("t1");
    expect(credential.getToken).toHaveBeenCalledWith(POSTGRES_ENTRA_SCOPE, {
      abortSignal: expect.any(AbortSignal),
    });
    expect(POSTGRES_ENTRA_SCOPE).toBe(
      "https://ossrdbms-aad.database.windows.net/.default",
    );
  });

  it("有効期限の手前までは同じtokenを使い回し、手前を過ぎたら取り直す", async () => {
    let now = 0;
    const credential = credentialReturning(
      { token: "t1", expiresOnTimestamp: HOUR },
      { token: "t2", expiresOnTimestamp: 2 * HOUR },
    );
    const password = createEntraPasswordProvider(credential, {
      now: () => now,
      refreshMarginMs: 5 * 60_000,
    });

    await expect(password()).resolves.toBe("t1");
    now = HOUR - 5 * 60_000 - 1;
    await expect(password()).resolves.toBe("t1");
    expect(credential.getToken).toHaveBeenCalledTimes(1);

    now = HOUR - 5 * 60_000;
    await expect(password()).resolves.toBe("t2");
    expect(credential.getToken).toHaveBeenCalledTimes(2);
  });

  it("同時に複数の接続が張られてもtoken取得は1回にまとめる", async () => {
    const credential = credentialReturning({ token: "t1", expiresOnTimestamp: HOUR });
    const password = createEntraPasswordProvider(credential, { now: () => 0 });

    const results = await Promise.all([password(), password(), password()]);

    expect(results).toEqual(["t1", "t1", "t1"]);
    expect(credential.getToken).toHaveBeenCalledTimes(1);
  });

  it("取得に失敗した場合は原因を含まない例外にし、次の呼び出しで取り直す", async () => {
    const credential = credentialReturning(
      new Error("ManagedIdentityCredential: endpoint http://169.254.169.254 unreachable"),
      { token: "t2", expiresOnTimestamp: HOUR },
    );
    const password = createEntraPasswordProvider(credential, { now: () => 0 });

    const failure = await password().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DatabaseTokenError);
    expect((failure as Error).message).not.toContain("169.254");

    await expect(password()).resolves.toBe("t2");
  });

  it("tokenが返らない場合も失敗にする(空のpasswordで接続しない)", async () => {
    const password = createEntraPasswordProvider(
      credentialReturning(null, { token: "", expiresOnTimestamp: HOUR }),
      { now: () => 0 },
    );

    await expect(password()).rejects.toBeInstanceOf(DatabaseTokenError);
    await expect(password()).rejects.toBeInstanceOf(DatabaseTokenError);
  });
});

describe("databasePasswordOption", () => {
  it("entraのときだけpassword関数を返す", () => {
    expect(databasePasswordOption("password")).toEqual({});
    expect(typeof databasePasswordOption("entra").password).toBe("function");
  });

  it("createDatabasePoolはpassword関数をそのままpgへ渡す", async () => {
    const password = vi.fn(async () => "token");
    const pool = createDatabasePool({
      connectionString: "postgres://id-siryou-mite@db.example.com:5432/siryou_mite",
      applicationName: "test",
      requireTls: true,
      password,
    });

    expect(pool.options.password).toBe(password);
    expect(pool.options.ssl).toEqual({ rejectUnauthorized: true });
    await pool.end();
  });

  it("password関数を渡さない場合は接続文字列のpasswordを使う(pgへpasswordを設定しない)", async () => {
    const pool = createDatabasePool({
      connectionString: "postgres://user:pass@localhost:5432/siryou_mite",
      applicationName: "test",
      requireTls: false,
    });

    expect(pool.options.password).toBeUndefined();
    await pool.end();
  });
});
