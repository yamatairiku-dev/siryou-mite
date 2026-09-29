/**
 * アップロード上限(件数・容量・頻度・同時実行)の判定(設計 §6.1, §10.1(3))。
 *
 * 判定はPostgreSQLだけで行い、Redisなどの外部stateは追加しない(設計 §6.1)。
 * 1つのトランザクションの中で、
 *   1. 利用者単位のadvisory lock(`pg_advisory_xact_lock`)
 *   2. 頻度・同時実行・件数・容量の集計
 *   3. システム全体のadvisory lock(upload判定を直列化する。設計 §10.1(3))
 *   4. システム容量の集計
 *   5. 「進行中」の試行行(`upload_attempts`)の登録
 * の順に実行し、commitして初めて枠を確保したことにする。advisory lockは
 * transaction有効期間(`_xact_`)で、commit・rollback・接続断のいずれでも必ず解放される。
 *
 * 「進行中」状態は`upload_attempts`の行で表し、明示的な解放(`releaseUploadSlot`)に
 * 加えて`expires_at`による時限失効を持たせる。処理が異常終了しても利用者が
 * 永久にブロックされない。
 *
 * 判定(このmodule)と資料登録(`documents`へのINSERT)は別トランザクションで、その間に
 * advisory lockは解放される(設計 §10.1: 判定 → HTML検査 → Blob保存 → DB登録)。
 * そのため容量・件数の判定では、`documents`(`status = 'active'`)の集計に加えて、
 * 進行中の試行が予約しているbyte数・件数を必ず加算する。加算しないと、並行する
 * アップロードが同じ集計値を見て全て許可され、システム全体50GB・利用者500MBを
 * 超過できてしまう(設計 §6.1, §10.1(3))。資料登録の後・解放の前は同じbyte数が
 * `documents`と予約の両方に現れるが、常に安全側(多め)へ倒れるため許容する。
 *
 * SQLはこのrepositoryの中だけに置き、値は必ずプレースホルダーで渡す。ログ出力は
 * 行わない(ファイル名・HTML本文・利用者識別子を扱う判定なので、記録は監査
 * (`audit_events`)と呼び出し側の運用ログに任せる)。
 */
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import type { AuditErrorCategory } from "~/lib/db/audit-events.server";
import {
  getOwnerUsage,
  getSystemUsage,
} from "~/lib/db/documents.server";
import {
  getPool,
  poolSettings,
  runInTransaction,
  type Queryable,
} from "~/lib/db/pool.server";
import { env } from "~/lib/env.server";

/** 拒否理由(設計 §6.1の各上限に1対1で対応する)。 */
export const uploadLimitRejectionReasons = [
  /** 同じ利用者のアップロードが既に進行中(設計 §6.1「同時アップロードは1件まで」)。 */
  "concurrent_upload_in_progress",
  /** 直近1分のアップロード回数が上限に達している(設計 §6.1「1分間に最大5回」)。 */
  "rate_limit_exceeded",
  /** 利用者の有効な資料件数が上限に達している(設計 §6.1「最大100件」)。 */
  "owner_document_count_exceeded",
  /** 利用者の有効なHTML合計容量が上限を超える(設計 §6.1「最大500MB」)。 */
  "owner_total_bytes_exceeded",
  /** システム全体の有効なHTML合計容量が上限を超える(設計 §6.1「最大50GB」)。 */
  "system_total_bytes_exceeded",
  /**
   * 判定用のadvisory lockを待ち時間内に取得できなかった(設計 §10.1(3)の直列化)。
   * 上限超過ではないが、待ち続けて統一timeoutを使い切るよりも、
   * 「しばらくしてからやり直す」案内で fail closed に返す。
   */
  "lock_wait_timeout",
] as const;
export type UploadLimitRejectionReason =
  (typeof uploadLimitRejectionReasons)[number];

/**
 * 監査の`error_category`(設計 §12.2)への対応。件数・容量は`quota_exceeded`、
 * 頻度・同時実行・直列化待ちは`rate_limited`とする(設計 §6.1, §10.1(3))。
 */
export function auditErrorCategoryForRejection(
  reason: UploadLimitRejectionReason,
): AuditErrorCategory {
  switch (reason) {
    case "owner_document_count_exceeded":
    case "owner_total_bytes_exceeded":
    case "system_total_bytes_exceeded":
      return "quota_exceeded";
    case "concurrent_upload_in_progress":
    case "rate_limit_exceeded":
    case "lock_wait_timeout":
      return "rate_limited";
  }
}

/**
 * 上限値。環境設定で変更できる値(設計 §6.1)は`uploadLimitsFromEnv()`が
 * `app/lib/env.server.ts`(Zod検証済み)から読む。ここでハードコードはしない。
 */
export const uploadLimitsSchema = z
  .object({
    maxActiveDocumentsPerUser: z.number().int().positive(),
    maxTotalBytesPerUser: z.number().int().positive(),
    maxTotalBytesSystem: z.number().int().positive(),
    systemBytesWarningThreshold: z.number().int().positive(),
    uploadRateLimitPerMinute: z.number().int().positive(),
    maxConcurrentUploadsPerUser: z.number().int().positive(),
    /**
     * 頻度判定の窓(秒)。設計 §6.1は「1分間」と固定で定めるため環境変数にはせず、
     * テストから短縮できるようにだけしておく。
     */
    rateLimitWindowSeconds: z.number().int().positive().max(3600).default(60),
    /**
     * 進行中leaseの有効期間(秒)。アップロード1件(最大10MB)のHTML検査・Blob保存・
     * DB登録・Queue送信が終わるまでの想定上限。経過後は自動的に枠が空く。
     */
    uploadLeaseSeconds: z.number().int().positive().max(3600).default(120),
    /**
     * advisory lockの最大待ち時間(ms)。Poolのstatement timeout(10秒)を超える待ちを
     * 作らないため上限を`poolSettings.statementTimeoutMillis`で制限する。
     */
    lockWaitTimeoutMillis: z
      .number()
      .int()
      .positive()
      .max(poolSettings.statementTimeoutMillis)
      .default(5_000),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.systemBytesWarningThreshold > value.maxTotalBytesSystem) {
      context.addIssue({
        code: "custom",
        path: ["systemBytesWarningThreshold"],
        message:
          "systemBytesWarningThreshold は maxTotalBytesSystem 以下である必要があります",
      });
    }
  });

export type UploadLimits = z.output<typeof uploadLimitsSchema>;
export type UploadLimitsInput = z.input<typeof uploadLimitsSchema>;

/** 環境設定(設計 §6.1「制限値は環境設定で変更可能とする」)から上限値を読む。 */
export function uploadLimitsFromEnv(
  overrides: Partial<UploadLimitsInput> = {},
): UploadLimits {
  return uploadLimitsSchema.parse({
    maxActiveDocumentsPerUser: env.MAX_ACTIVE_DOCUMENTS_PER_USER,
    maxTotalBytesPerUser: env.MAX_TOTAL_HTML_BYTES_PER_USER,
    maxTotalBytesSystem: env.MAX_TOTAL_HTML_BYTES_SYSTEM,
    systemBytesWarningThreshold: env.SYSTEM_HTML_BYTES_WARNING_THRESHOLD,
    uploadRateLimitPerMinute: env.UPLOAD_RATE_LIMIT_PER_MINUTE,
    maxConcurrentUploadsPerUser: env.MAX_CONCURRENT_UPLOADS_PER_USER,
    ...overrides,
  });
}

/** 判定に使う現在の使用状況(すべて削除済みを除いた有効分。設計 §6.1)。 */
export type UploadUsageSnapshot = {
  /** 利用者の`active`な資料件数。 */
  ownerDocumentCount: number;
  /** 利用者の`active`な資料のbyte合計。 */
  ownerTotalByteSize: number;
  /** 利用者の進行中の試行が予約しているbyte合計(まだ`documents`に無い分)。 */
  ownerReservedByteSize: number;
  /** システム全体の`active`な資料のbyte合計。 */
  systemTotalByteSize: number;
  /** システム全体の進行中の試行が予約しているbyte合計(まだ`documents`に無い分)。 */
  systemReservedByteSize: number;
  /** 直近`rateLimitWindowSeconds`に受け付けた試行数。 */
  ownerRecentAttemptCount: number;
  /** 未解放かつ未失効の試行数(進行中のアップロード)。 */
  ownerInProgressAttemptCount: number;
  /** 頻度制限が解ける見込みまでの秒数(0以上)。 */
  rateRetryAfterSeconds: number;
  /** 進行中の試行が失効するまでの秒数(0以上)。 */
  concurrencyRetryAfterSeconds: number;
};

export type UploadLimitEvaluation =
  | {
      allowed: true;
      /** システム容量が警告閾値(設計 §6.1の40GB相当)に達しているか。 */
      systemWarning: boolean;
    }
  | {
      allowed: false;
      reason: UploadLimitRejectionReason;
      /** 時間で解消する拒否のときだけ秒数。容量・件数上限では`null`。 */
      retryAfterSeconds: number | null;
    };

export type UploadSlotReservation = {
  allowed: true;
  /** 解放(`releaseUploadSlot`)に使う試行ID。 */
  attemptId: string;
  /** この試行の進行中leaseが自動失効する時刻。 */
  expiresAt: Date;
  systemWarning: boolean;
};

export type UploadSlotRejection = {
  allowed: false;
  reason: UploadLimitRejectionReason;
  retryAfterSeconds: number | null;
  /** 監査(設計 §12.2)へ渡すエラー分類。 */
  errorCategory: AuditErrorCategory;
};

export type UploadSlotDecision = UploadSlotReservation | UploadSlotRejection;

const subjectIdSchema = z.string().trim().min(1).max(200);

const reserveInputSchema = z
  .object({
    ownerSubjectId: subjectIdSchema,
    /** これから保存するHTMLのbyte数。容量上限の判定に加算する。 */
    byteSize: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

export type ReserveUploadSlotInput = z.input<typeof reserveInputSchema>;

/* ------------------------------------------------------------------ *
 * advisory lockキーの導出
 * ------------------------------------------------------------------ */

/**
 * advisory lockはDB cluster全体で共有される名前空間のため、他機能・他アプリと
 * 衝突しないよう、用途ごとに固定の文字列からnamespace(第1キー)を導出する。
 * 第2キーは利用者識別子のSHA-256から導出する(利用者識別子そのものを
 * キーに使わないことで、ログ・`pg_locks`から識別子が読めないようにする)。
 */
const advisoryLockNamespaceSeeds = {
  owner: "siryou-mite/upload-limits/owner",
  system: "siryou-mite/upload-limits/system",
} as const;

/** SHA-256の先頭4byteをPostgreSQLの`int4`(符号付き32bit)として読む。 */
function int32FromSha256(value: string): number {
  return createHash("sha256").update(value, "utf8").digest().readInt32BE(0);
}

export type AdvisoryLockKey = {
  /** `pg_advisory_xact_lock(key1, key2)`の第1キー(用途の名前空間)。 */
  namespace: number;
  /** 第2キー(対象)。 */
  key: number;
};

/** システム全体のupload判定を直列化するロック(設計 §10.1(3))。 */
export const systemUploadLockKey: AdvisoryLockKey = {
  namespace: int32FromSha256(advisoryLockNamespaceSeeds.system),
  // システム単位のロックは対象が1つしかないため、第2キーは0固定とする。
  key: 0,
};

/** 利用者単位の判定を直列化するロック(設計 §10.1(3))。 */
export function ownerUploadLockKey(ownerSubjectId: string): AdvisoryLockKey {
  const owner = subjectIdSchema.parse(ownerSubjectId);
  return {
    namespace: int32FromSha256(advisoryLockNamespaceSeeds.owner),
    key: int32FromSha256(owner),
  };
}

/* ------------------------------------------------------------------ *
 * 上限判定(純粋関数)
 * ------------------------------------------------------------------ */

/**
 * 使用状況と上限値から可否を決める。DBアクセスを含まないため、境界値の検証は
 * 単体テストで行い、SQLとロックの検証は結合テストで行う。
 *
 * 判定順は「時間で解消するもの(同時実行・頻度)→ 利用者の容量・件数 →
 * システム容量」とし、同時に複数の上限へ触れていても理由が一意に決まるようにする。
 * 件数・容量には、まだ`documents`へ登録されていない進行中の試行の予約分を加算する。
 */
export function evaluateUploadLimits(params: {
  byteSize: number;
  usage: UploadUsageSnapshot;
  limits: UploadLimits;
}): UploadLimitEvaluation {
  const { byteSize, usage, limits } = params;

  if (
    usage.ownerInProgressAttemptCount >= limits.maxConcurrentUploadsPerUser
  ) {
    return {
      allowed: false,
      reason: "concurrent_upload_in_progress",
      retryAfterSeconds: Math.max(0, usage.concurrencyRetryAfterSeconds),
    };
  }

  if (usage.ownerRecentAttemptCount >= limits.uploadRateLimitPerMinute) {
    return {
      allowed: false,
      reason: "rate_limit_exceeded",
      retryAfterSeconds: Math.max(0, usage.rateRetryAfterSeconds),
    };
  }

  // これから1件増えるため、現在件数が上限に達していれば受け付けない。
  // 進行中の試行は「まだ登録されていない1件」なので件数へ加算する。
  if (
    usage.ownerDocumentCount + usage.ownerInProgressAttemptCount >=
    limits.maxActiveDocumentsPerUser
  ) {
    return {
      allowed: false,
      reason: "owner_document_count_exceeded",
      retryAfterSeconds: null,
    };
  }

  if (
    usage.ownerTotalByteSize + usage.ownerReservedByteSize + byteSize >
    limits.maxTotalBytesPerUser
  ) {
    return {
      allowed: false,
      reason: "owner_total_bytes_exceeded",
      retryAfterSeconds: null,
    };
  }

  const systemTotalAfterUpload =
    usage.systemTotalByteSize + usage.systemReservedByteSize + byteSize;
  if (systemTotalAfterUpload > limits.maxTotalBytesSystem) {
    return {
      allowed: false,
      reason: "system_total_bytes_exceeded",
      retryAfterSeconds: null,
    };
  }

  return {
    allowed: true,
    systemWarning:
      systemTotalAfterUpload >= limits.systemBytesWarningThreshold,
  };
}

/* ------------------------------------------------------------------ *
 * DBアクセス
 * ------------------------------------------------------------------ */

/** lock待ちがtimeoutしたときのSQLSTATE(`lock_not_available`)。 */
const lockNotAvailableSqlState = "55P03";

/** advisory lock待ちのtimeoutかどうか(SQLSTATEだけで判定し、本文は読まない)。 */
export function isLockWaitTimeoutError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === lockNotAvailableSqlState
  );
}

type AttemptUsageRow = {
  recent_count: string;
  in_progress_count: string;
  reserved_byte_size: string;
  rate_retry_after_seconds: string;
  concurrency_retry_after_seconds: string;
};

/**
 * BIGINT・numericは`pg`が精度を落とさないよう文字列で返す。
 * 上限判定に使う値なので、安全な整数にならない場合は静かに丸めず失敗させる。
 */
function toCount(value: string | undefined): number {
  const parsed = Number(value ?? 0);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error("upload_attempts の集計値を数値として読めませんでした");
  }
  return parsed;
}

async function acquireAdvisoryLock(
  executor: Queryable,
  lock: AdvisoryLockKey,
): Promise<void> {
  await executor.query("SELECT pg_advisory_xact_lock($1::int, $2::int)", [
    lock.namespace,
    lock.key,
  ]);
}

/**
 * 利用者の試行(頻度・同時実行)を1クエリで集計する。
 * 進行中は「未解放(`finished_at IS NULL`)かつ未失効(`expires_at > now()`)」。
 */
async function getAttemptUsage(
  executor: Queryable,
  ownerSubjectId: string,
  windowSeconds: number,
): Promise<
  Pick<
    UploadUsageSnapshot,
    | "ownerRecentAttemptCount"
    | "ownerInProgressAttemptCount"
    | "ownerReservedByteSize"
    | "rateRetryAfterSeconds"
    | "concurrencyRetryAfterSeconds"
  >
> {
  const result = await executor.query<AttemptUsageRow>(
    `WITH window_bounds AS (
       SELECT now() - make_interval(secs => $2::double precision) AS window_start,
              make_interval(secs => $2::double precision) AS window_length
     )
     SELECT count(*) FILTER (WHERE a.started_at > b.window_start)::text
              AS recent_count,
            count(*) FILTER (WHERE a.finished_at IS NULL AND a.expires_at > now())::text
              AS in_progress_count,
            COALESCE(
              sum(a.byte_size) FILTER (WHERE a.finished_at IS NULL AND a.expires_at > now()),
              0)::text AS reserved_byte_size,
            COALESCE(
              ceil(extract(epoch FROM (
                min(a.started_at) FILTER (WHERE a.started_at > b.window_start)
                  + b.window_length - now()))),
              0)::text AS rate_retry_after_seconds,
            COALESCE(
              ceil(extract(epoch FROM (
                min(a.expires_at) FILTER (WHERE a.finished_at IS NULL AND a.expires_at > now())
                  - now()))),
              0)::text AS concurrency_retry_after_seconds
       FROM upload_attempts AS a
      CROSS JOIN window_bounds AS b
      WHERE a.owner_subject_id = $1
        AND (a.started_at > b.window_start
             OR (a.finished_at IS NULL AND a.expires_at > now()))
      GROUP BY b.window_length`,
    [ownerSubjectId, windowSeconds],
  );

  const row = result.rows[0];
  return {
    ownerRecentAttemptCount: toCount(row?.recent_count),
    ownerInProgressAttemptCount: toCount(row?.in_progress_count),
    ownerReservedByteSize: toCount(row?.reserved_byte_size),
    rateRetryAfterSeconds: toCount(row?.rate_retry_after_seconds),
    concurrencyRetryAfterSeconds: toCount(
      row?.concurrency_retry_after_seconds,
    ),
  };
}

/**
 * システム全体で進行中の試行が予約しているbyte数(利用者を問わない)。
 * システム全体のadvisory lockを取得した後にだけ呼ぶ(設計 §10.1(3))。
 */
async function getSystemReservedByteSize(
  executor: Queryable,
): Promise<number> {
  const result = await executor.query<{ reserved_byte_size: string }>(
    `SELECT COALESCE(sum(byte_size), 0)::text AS reserved_byte_size
       FROM upload_attempts
      WHERE finished_at IS NULL
        AND expires_at > now()`,
  );
  return toCount(result.rows[0]?.reserved_byte_size);
}

/** 進行中の試行を1件登録する(枠の確保)。commitで初めて他の判定から見える。 */
async function insertUploadAttempt(
  executor: Queryable,
  ownerSubjectId: string,
  byteSize: number,
  leaseSeconds: number,
): Promise<{ attemptId: string; expiresAt: Date }> {
  const result = await executor.query<{ id: string; expires_at: Date }>(
    `INSERT INTO upload_attempts (owner_subject_id, byte_size, expires_at)
     VALUES ($1, $2, now() + make_interval(secs => $3::double precision))
     RETURNING id, expires_at`,
    [ownerSubjectId, byteSize, leaseSeconds],
  );

  const row = result.rows[0];
  if (!row) {
    throw new Error("アップロード試行を登録できませんでした");
  }
  return { attemptId: row.id, expiresAt: row.expires_at };
}

/**
 * 既にトランザクションを開始している呼び出し向けの判定本体。
 *
 * 引数を`Queryable`ではなく`PoolClient`に限定している(`runInTransaction`と同じ理由)。
 * `Queryable`は`Pool`も満たすため、誤って`getPool()`を渡すと各SQLが別々の接続・別々の
 * トランザクションで実行され、`pg_advisory_xact_lock`が文ごとに解放されて上限判定が
 * 黙って無効化される。lock待ちのtimeout(SQLSTATE 55P03)はここでは握りつぶさず、
 * 呼び出し側(`reserveUploadSlot`)で拒否へ変換する。
 *
 * `byteSize`にはこれから保存するHTMLのbyte数を渡す。許可した分は進行中の予約として
 * 記録し、他の判定からも見えるようにする(設計 §6.1の容量上限)。
 */
export async function reserveUploadSlotWithin(
  executor: PoolClient,
  input: ReserveUploadSlotInput,
  limits: UploadLimits,
): Promise<UploadSlotDecision> {
  const { ownerSubjectId, byteSize } = reserveInputSchema.parse(input);

  // lock待ちでPoolのstatement timeout(10秒)を使い切らないよう、
  // このトランザクションの中だけ待ち時間を制限する(値はプレースホルダーで渡す)。
  await executor.query("SELECT set_config('lock_timeout', $1, true)", [
    `${limits.lockWaitTimeoutMillis}ms`,
  ]);

  // 利用者単位 → システム単位の順に取得する(全トランザクションで同じ順序のため
  // デッドロックしない)。どちらもtransaction有効期間のロックで、commit・rollback・
  // 接続断で必ず解放される。
  await acquireAdvisoryLock(executor, ownerUploadLockKey(ownerSubjectId));

  const attemptUsage = await getAttemptUsage(
    executor,
    ownerSubjectId,
    limits.rateLimitWindowSeconds,
  );
  const ownerUsage = await getOwnerUsage(ownerSubjectId, executor);

  // 設計 §10.1(3): システム全体のupload判定は直列化する。
  await acquireAdvisoryLock(executor, systemUploadLockKey);
  const systemUsage = await getSystemUsage(executor);
  const systemReservedByteSize = await getSystemReservedByteSize(executor);

  const evaluation = evaluateUploadLimits({
    byteSize,
    limits,
    usage: {
      ...attemptUsage,
      ownerDocumentCount: ownerUsage.documentCount,
      ownerTotalByteSize: ownerUsage.totalByteSize,
      systemTotalByteSize: systemUsage.totalByteSize,
      systemReservedByteSize,
    },
  });

  if (!evaluation.allowed) {
    return {
      allowed: false,
      reason: evaluation.reason,
      retryAfterSeconds: evaluation.retryAfterSeconds,
      errorCategory: auditErrorCategoryForRejection(evaluation.reason),
    };
  }

  const attempt = await insertUploadAttempt(
    executor,
    ownerSubjectId,
    byteSize,
    limits.uploadLeaseSeconds,
  );

  return {
    allowed: true,
    attemptId: attempt.attemptId,
    expiresAt: attempt.expiresAt,
    systemWarning: evaluation.systemWarning,
  };
}

/**
 * アップロード前の上限判定と枠の確保(設計 §10.1(3))。
 *
 * 判定用に独立したトランザクションを使い、commitした時点で「進行中」が
 * 他のリクエストから見えるようにする(資料登録・監査の保存はこの後の別
 * トランザクションで行う。設計 §15.1)。許可された場合、呼び出し側は成功・失敗に
 * かかわらず`releaseUploadSlot`で枠を解放する。資料登録(`documents`へのINSERT)を
 * commitした**後**に解放すること(先に解放すると、その資料のbyte数と件数が予約からも
 * `documents`からも見えない瞬間ができ、並行する判定が上限を超えて許可してしまう)。
 */
export async function reserveUploadSlot(
  input: ReserveUploadSlotInput,
  limits: UploadLimits = uploadLimitsFromEnv(),
): Promise<UploadSlotDecision> {
  // `withTransaction`はcallbackへ`Queryable`を渡すため、ここではPoolから
  // `PoolClient`を直接借りて、同じ接続で判定全体(advisory lockを含む)を実行する。
  const client = await getPool().connect();
  try {
    return await runInTransaction(client, () =>
      reserveUploadSlotWithin(client, input, limits),
    );
  } catch (error) {
    if (isLockWaitTimeoutError(error)) {
      // 直列化待ちが長すぎる場合は、待ち続けずに fail closed で拒否する。
      return {
        allowed: false,
        reason: "lock_wait_timeout",
        retryAfterSeconds: Math.ceil(limits.lockWaitTimeoutMillis / 1000),
        errorCategory: auditErrorCategoryForRejection("lock_wait_timeout"),
      };
    }
    throw error;
  } finally {
    client.release();
  }
}

/**
 * 確保した枠を明示的に解放する(成功・失敗のどちらでも呼ぶ)。
 *
 * 所有者IDを必須引数にして、他人の試行を解放できないようにする(試行IDが
 * 何らかの経路で外へ出ても、別の利用者の同時実行枠を空けられない)。
 * 解放し忘れ・異常終了に備えて`expires_at`による時限失効も併用するため、
 * この更新が失敗してもアップロードが永久にブロックされることはない。
 * 既に解放済み・存在しない・所有者が異なる場合は`false`を返す(冪等)。
 */
export async function releaseUploadSlot(
  params: { attemptId: string; ownerSubjectId: string },
  executor: Queryable = getPool(),
): Promise<boolean> {
  const ownerSubjectId = subjectIdSchema.parse(params.ownerSubjectId);
  if (!z.uuid().safeParse(params.attemptId).success) {
    return false;
  }

  const result = await executor.query<{ id: string }>(
    `UPDATE upload_attempts
        SET finished_at = now()
      WHERE id = $1
        AND owner_subject_id = $2
        AND finished_at IS NULL
     RETURNING id`,
    [params.attemptId, ownerSubjectId],
  );
  return result.rows.length > 0;
}
