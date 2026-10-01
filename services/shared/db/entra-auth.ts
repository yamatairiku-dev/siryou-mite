/**
 * Azure Database for PostgreSQLへManaged Identityで接続するためのpassword供給(設計 §7.4)。
 *
 * Entra IDのaccess tokenを`pg`のpasswordとして使う。tokenは約1時間で失効するため、
 * 固定の接続文字列には入れず、`pg`が新しい接続を張るたびに呼ぶ関数として渡す。
 * 有効期限の手前までは同じtokenを使い回し、同時に複数の接続が張られる場合も
 * token取得は1回にまとめる。tokenとエラーの詳細はログへ出さない(設計 §9.5)。
 */
import { DefaultAzureCredential } from "@azure/identity";

/** Azure Database for PostgreSQLのaccess tokenを要求するscope。 */
export const POSTGRES_ENTRA_SCOPE =
  "https://ossrdbms-aad.database.windows.net/.default";

/** `@azure/identity`の`TokenCredential`のうち、ここで使う部分だけ。 */
export interface AccessTokenSource {
  getToken(
    scope: string,
    options?: { abortSignal?: AbortSignal },
  ): Promise<{ token: string; expiresOnTimestamp: number } | null>;
}

export type EntraPasswordProviderOptions = {
  /** 有効期限のこの時間(ms)前になったら取り直す。 */
  refreshMarginMs?: number;
  /** token取得のtimeout(ms)。取得できない場合は待ち続けず接続を失敗させる(設計 §14)。 */
  timeoutMs?: number;
  now?: () => number;
};

export class DatabaseTokenError extends Error {
  constructor() {
    // 原因(credentialの種類、tenant、endpoint等)は含めない。
    super("PostgreSQLのaccess tokenを取得できませんでした");
    this.name = "DatabaseTokenError";
  }
}

/**
 * `pg`の`password`へ渡す関数を作る。`credential`を省略した場合は
 * `DefaultAzureCredential`(user-assigned Managed Identityは`AZURE_CLIENT_ID`で指定)を使う。
 */
export function createEntraPasswordProvider(
  credential: AccessTokenSource = new DefaultAzureCredential(),
  options: EntraPasswordProviderOptions = {},
): () => Promise<string> {
  const refreshMarginMs = options.refreshMarginMs ?? 5 * 60_000;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const now = options.now ?? Date.now;

  let cached: { token: string; expiresOnTimestamp: number } | undefined;
  let inflight: Promise<string> | undefined;

  async function fetchToken(): Promise<string> {
    let result: Awaited<ReturnType<AccessTokenSource["getToken"]>>;
    try {
      result = await credential.getToken(POSTGRES_ENTRA_SCOPE, {
        abortSignal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new DatabaseTokenError();
    }
    if (!result || result.token === "") {
      throw new DatabaseTokenError();
    }
    cached = { token: result.token, expiresOnTimestamp: result.expiresOnTimestamp };
    return result.token;
  }

  return async () => {
    if (cached && now() < cached.expiresOnTimestamp - refreshMarginMs) {
      return cached.token;
    }
    if (!inflight) {
      inflight = fetchToken().finally(() => {
        inflight = undefined;
      });
    }
    return inflight;
  };
}

/**
 * `createDatabasePool`へ展開する認証設定。`entra`のときだけpassword関数を渡す
 * (`password`のときは接続文字列のpasswordを使う)。
 */
export function databasePasswordOption(
  auth: "password" | "entra",
): { password?: () => Promise<string> } {
  return auth === "entra" ? { password: createEntraPasswordProvider() } : {};
}
