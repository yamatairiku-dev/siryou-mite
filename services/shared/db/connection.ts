/**
 * `pg`へ渡す接続先の設定(設計 §7.4)。
 *
 * `pg`は`connectionString`を受け取ると、そこから読み取った値で、個別に指定した値を
 * 上書きする。passwordを含まない接続文字列も「空のpassword」として読み取られるため、
 * `connectionString`とpassword関数(Managed Identityのaccess token)を併用すると
 * 関数が捨てられ、passwordなしで接続して認証に失敗する(SQLSTATE 28P01)。
 * password関数を使う場合は、接続文字列をここで分解し、個別の値として渡す。
 *
 * 分解するのは利用者名・host・port・DB名だけで、クエリ文字列は読まない。
 * `DATABASE_AUTH=entra`でクエリ文字列を含む`DATABASE_URL`は、環境変数の検証
 * (`services/shared/env.ts`の`validateDatabaseConfig`)が起動前に拒否する。
 */

/** `pg`の`Client`・`Pool`の設定へ展開する接続先。 */
export type ConnectionTarget =
  | { connectionString: string }
  | {
      host: string;
      port: number;
      user: string;
      database: string;
      password: () => Promise<string>;
    };

const defaultPostgresPort = 5432;

/**
 * 接続文字列と、任意のpassword関数から接続先の設定を作る。
 * password関数が無い場合(ローカル・CI)は接続文字列をそのまま使う。
 */
export function connectionTarget(
  connectionString: string,
  password?: () => Promise<string>,
): ConnectionTarget {
  if (!password) {
    return { connectionString };
  }

  const url = new URL(connectionString);
  return {
    // IPv6アドレスは`[::1]`の形で得られる。`pg`には角括弧なしで渡す。
    host: url.hostname.replace(/^\[(.*)\]$/, "$1"),
    port: url.port === "" ? defaultPostgresPort : Number(url.port),
    user: decodeURIComponent(url.username),
    database: decodeURIComponent(url.pathname.slice(1)),
    password,
  };
}
