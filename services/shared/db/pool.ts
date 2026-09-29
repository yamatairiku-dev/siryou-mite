/**
 * PostgreSQL接続の実処理(設計 §7.4)。
 *
 * `services/` 配下は `app/` を一切importしない方針(docs/ARCHITECTURE.md, T04 Q-005)
 * だが、逆方向(`app/` → `services/shared/`)の依存はこの制約に反しない。DBアクセスは
 * Web・Display・Preview・Maintenanceが共有する実処理であり、SQLとZod schemaを
 * 二重に持つと契約が食い違うため、実装は`services/shared/db/`へ集約する。Web側は
 * `app/lib/db/*.server.ts`から本モジュールを再importする薄いラッパーにする。
 *
 * このモジュールは環境変数を読まない。接続設定は呼び出し側(Webは
 * `app/lib/env.server.ts`、Displayなどは`services/<name>/env.ts`)がZod検証済みの
 * 値から`createDatabasePool`へ渡す。接続文字列やエラーの詳細はログへ出さない
 * (設計 §9.5, §15.2)。
 */
import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from "pg";

/**
 * repositoryがクエリ実行に使う最小のインターフェース。
 * `Pool`(自動commit)と、`withTransaction`が渡すtransaction中の`PoolClient`の
 * どちらも満たすため、同じrepository関数をトランザクションの内外から呼べる
 * (設計 §15.1「業務更新と監査を同じDBトランザクションで保存する」)。
 */
export interface Queryable {
  query<Row extends QueryResultRow>(
    queryText: string,
    values?: ReadonlyArray<unknown>,
  ): Promise<QueryResult<Row>>;
}

/**
 * Pool設定(設計 §7.4)。
 *
 * production DBは2 vCoreで、Web・Display・Preview・Maintenanceが同じサーバーへ
 * 接続するため、1プロセスあたりの接続数は控えめに固定する。環境変数では変更
 * できないようにして、環境ごとの設定ミスで接続数が枯渇することを防ぐ。
 * statement/query timeoutは「外部サービスにはtimeoutを設定する」(設計 §14)を
 * DB接続にも適用したもので、すべての実行単位で共通に効かせる。
 */
export const poolSettings = {
  /** 1プロセスが同時に保持する接続の上限。 */
  maxConnections: 10,
  /** 使われていない接続を閉じるまでの時間(ms)。 */
  idleTimeoutMillis: 30_000,
  /** 接続取得のtimeout(ms)。接続できない場合は待ち続けず失敗させる(設計 §14)。 */
  connectionTimeoutMillis: 5_000,
  /** サーバー側で1文を打ち切るtimeout(ms)。 */
  statementTimeoutMillis: 10_000,
  /** クライアント側で応答を待つtimeout(ms)。サーバー側より少しだけ長くする。 */
  queryTimeoutMillis: 12_000,
} as const;

export type DatabasePoolConfig = {
  /** host・port・dbname・利用者名を含む接続文字列。値はログへ出さない。 */
  connectionString: string;
  /** `pg`の`application_name`。実行単位ごとに別の値を使い、DB側で識別できるようにする。 */
  applicationName: string;
  /**
   * TLSを要求するか。本番(Azure Database for PostgreSQL)は必須。
   * 証明書検証は無効化しない(docs/SECURITY.md「TLS証明書検証を無効化しない」)。
   * ローカル・CIのPostgreSQLはTLSを持たないため`false`にする。
   */
  requireTls: boolean;
};

/**
 * Poolを1つ作る。生成自体では接続しないため、接続先が無い環境でも失敗しない。
 * プロセス内で使い回すキャッシュは呼び出し側(Web・各service)が持つ。
 */
export function createDatabasePool(config: DatabasePoolConfig): Pool {
  const pool = new Pool({
    connectionString: config.connectionString,
    max: poolSettings.maxConnections,
    idleTimeoutMillis: poolSettings.idleTimeoutMillis,
    connectionTimeoutMillis: poolSettings.connectionTimeoutMillis,
    statement_timeout: poolSettings.statementTimeoutMillis,
    query_timeout: poolSettings.queryTimeoutMillis,
    application_name: config.applicationName,
    ...(config.requireTls ? { ssl: { rejectUnauthorized: true } } : {}),
  });

  // idle接続がサーバー側都合で切断された場合、listenerが無いとprocessごと
  // 落ちる。接続文字列・資格情報を含み得る詳細は出さず、分類だけを記録する。
  pool.on("error", (error: unknown) => {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { code?: unknown }).code)
        : "unknown";
    console.error(
      JSON.stringify({ event: "db_pool_idle_client_error", errorCode: code }),
    );
  });

  return pool;
}

/**
 * 取得済みclient上で`BEGIN`〜`COMMIT`を実行する。失敗時は必ずrollbackする。
 * 監査保存に失敗した操作を成功させないため(設計 §15.1)、業務更新と監査の
 * repository呼び出しは同じ`tx`を使う。
 *
 * 引数を`Queryable`ではなく`PoolClient`に限定している。`Queryable`は`Pool`も
 * 満たすため、誤って`Pool`を渡すと`BEGIN`・本処理・`COMMIT`が別々の接続で
 * 実行され、トランザクションが成立しないまま成功してしまう(設計 §15.1)。
 */
export async function runInTransaction<T>(
  client: PoolClient,
  run: (tx: Queryable) => Promise<T>,
): Promise<T> {
  await client.query("BEGIN");
  try {
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    // rollback自体の失敗で元のエラーを隠さない(接続断時などに起こり得る)。
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

/** Poolから接続を1つ借りてトランザクションを実行し、必ず返却する。 */
export async function withTransactionOn<T>(
  pool: Pool,
  run: (tx: Queryable) => Promise<T>,
): Promise<T> {
  const client: PoolClient = await pool.connect();
  try {
    return await runInTransaction(client, run);
  } finally {
    client.release();
  }
}
