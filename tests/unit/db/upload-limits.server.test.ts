import { describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import { poolSettings } from "~/lib/db/pool.server";
import {
  auditErrorCategoryForRejection,
  evaluateUploadLimits,
  isLockWaitTimeoutError,
  ownerUploadLockKey,
  releaseUploadSlot,
  reserveUploadSlotWithin,
  systemUploadLockKey,
  uploadLimitRejectionReasons,
  uploadLimitsFromEnv,
  uploadLimitsSchema,
  type UploadLimits,
  type UploadUsageSnapshot,
} from "~/lib/db/upload-limits.server";
import { createStubExecutor, lastCall } from "./stub-executor";

/**
 * `reserveUploadSlotWithin`は誤用(`getPool()`を渡すこと)を防ぐため`PoolClient`を
 * 要求する。単体テストではSQLの組み立てだけを見るため、`query`だけを持つstubを
 * `PoolClient`として渡す。
 */
function asPoolClient(executor: unknown): PoolClient {
  return executor as PoolClient;
}

/**
 * T08 単体テスト: 上限判定の分岐とadvisory lockキーの導出(設計 §6.1, §10.1(3))。
 * SQLの実行結果とロックの効果は結合テスト(`tests/integration/upload-limits.test.ts`)で検証する。
 */

const limits: UploadLimits = uploadLimitsSchema.parse({
  maxActiveDocumentsPerUser: 100,
  maxTotalBytesPerUser: 1_000,
  maxTotalBytesSystem: 10_000,
  systemBytesWarningThreshold: 8_000,
  uploadRateLimitPerMinute: 5,
  maxConcurrentUploadsPerUser: 1,
});

const emptyUsage: UploadUsageSnapshot = {
  ownerDocumentCount: 0,
  ownerTotalByteSize: 0,
  ownerReservedByteSize: 0,
  systemTotalByteSize: 0,
  systemReservedByteSize: 0,
  ownerRecentAttemptCount: 0,
  ownerInProgressAttemptCount: 0,
  rateRetryAfterSeconds: 0,
  concurrencyRetryAfterSeconds: 0,
};

function evaluate(
  usage: Partial<UploadUsageSnapshot>,
  byteSize = 100,
  overrides: Partial<UploadLimits> = {},
) {
  return evaluateUploadLimits({
    byteSize,
    limits: { ...limits, ...overrides },
    usage: { ...emptyUsage, ...usage },
  });
}

describe("evaluateUploadLimits(設計 §6.1の各上限)", () => {
  it("上限に触れていなければ受け付ける", () => {
    expect(evaluate({})).toEqual({ allowed: true, systemWarning: false });
  });

  it("件数は上限-1なら受け付け、上限に達していると拒否する", () => {
    expect(evaluate({ ownerDocumentCount: 99 }).allowed).toBe(true);
    expect(evaluate({ ownerDocumentCount: 100 })).toEqual({
      allowed: false,
      reason: "owner_document_count_exceeded",
      retryAfterSeconds: null,
    });
  });

  it("利用者容量は合計が上限ちょうどまで受け付ける", () => {
    expect(evaluate({ ownerTotalByteSize: 900 }, 100).allowed).toBe(true);
    expect(evaluate({ ownerTotalByteSize: 900 }, 101)).toEqual({
      allowed: false,
      reason: "owner_total_bytes_exceeded",
      retryAfterSeconds: null,
    });
  });

  it("進行中の試行が予約したbyte数を利用者・システムの合計へ加算する", () => {
    // `documents`が空でも、予約分だけで上限に達していれば拒否する。
    expect(
      evaluate({ ownerReservedByteSize: 900 }, 101, {
        maxConcurrentUploadsPerUser: 5,
      }),
    ).toMatchObject({ reason: "owner_total_bytes_exceeded" });
    expect(
      evaluate({ systemReservedByteSize: 9_900 }, 101, {
        maxTotalBytesPerUser: 1_000_000,
        maxConcurrentUploadsPerUser: 5,
      }),
    ).toMatchObject({ reason: "system_total_bytes_exceeded" });
  });

  it("進行中の試行を件数へ加算する(まだ登録されていない1件として扱う)", () => {
    expect(
      evaluate({ ownerDocumentCount: 99, ownerInProgressAttemptCount: 1 }, 1, {
        maxConcurrentUploadsPerUser: 5,
      }),
    ).toMatchObject({ reason: "owner_document_count_exceeded" });
  });

  it("システム容量は合計が上限ちょうどまで受け付ける", () => {
    expect(
      evaluate({ systemTotalByteSize: 9_900 }, 100, {
        maxTotalBytesPerUser: 1_000_000,
      }),
    ).toEqual({ allowed: true, systemWarning: true });
    expect(
      evaluate({ systemTotalByteSize: 9_900 }, 101, {
        maxTotalBytesPerUser: 1_000_000,
      }),
    ).toEqual({
      allowed: false,
      reason: "system_total_bytes_exceeded",
      retryAfterSeconds: null,
    });
  });

  it("警告閾値はアップロード後の合計で判定する(設計 §6.1の40GB相当)", () => {
    expect(
      evaluate({ systemTotalByteSize: 7_899 }, 100, {
        maxTotalBytesPerUser: 1_000_000,
      }),
    ).toEqual({ allowed: true, systemWarning: false });
    expect(
      evaluate({ systemTotalByteSize: 7_900 }, 100, {
        maxTotalBytesPerUser: 1_000_000,
      }),
    ).toEqual({ allowed: true, systemWarning: true });
  });

  it("頻度は上限-1回なら受け付け、上限回数に達していると拒否する", () => {
    expect(evaluate({ ownerRecentAttemptCount: 4 }).allowed).toBe(true);
    expect(
      evaluate({ ownerRecentAttemptCount: 5, rateRetryAfterSeconds: 42 }),
    ).toEqual({
      allowed: false,
      reason: "rate_limit_exceeded",
      retryAfterSeconds: 42,
    });
  });

  it("進行中の試行が上限に達していると拒否する", () => {
    expect(
      evaluate({
        ownerInProgressAttemptCount: 1,
        concurrencyRetryAfterSeconds: 30,
      }),
    ).toEqual({
      allowed: false,
      reason: "concurrent_upload_in_progress",
      retryAfterSeconds: 30,
    });
  });

  it("負のretryAfterSecondsは0へ丸める", () => {
    expect(
      evaluate({
        ownerInProgressAttemptCount: 1,
        concurrencyRetryAfterSeconds: -5,
      }),
    ).toMatchObject({ retryAfterSeconds: 0 });
  });

  it("複数の上限へ同時に触れている場合は時間で解消する理由を優先する", () => {
    const decision = evaluate({
      ownerInProgressAttemptCount: 1,
      ownerRecentAttemptCount: 5,
      ownerDocumentCount: 100,
      ownerTotalByteSize: 1_000,
      systemTotalByteSize: 10_000,
    });
    expect(decision).toMatchObject({ reason: "concurrent_upload_in_progress" });

    expect(
      evaluate({
        ownerRecentAttemptCount: 5,
        ownerDocumentCount: 100,
        ownerTotalByteSize: 1_000,
      }),
    ).toMatchObject({ reason: "rate_limit_exceeded" });

    expect(
      evaluate({ ownerDocumentCount: 100, ownerTotalByteSize: 1_000 }),
    ).toMatchObject({ reason: "owner_document_count_exceeded" });
  });
});

describe("auditErrorCategoryForRejection(設計 §12.2のerror_category)", () => {
  it("件数・容量は quota_exceeded、頻度・同時実行・直列化待ちは rate_limited", () => {
    expect(auditErrorCategoryForRejection("owner_document_count_exceeded")).toBe(
      "quota_exceeded",
    );
    expect(auditErrorCategoryForRejection("owner_total_bytes_exceeded")).toBe(
      "quota_exceeded",
    );
    expect(auditErrorCategoryForRejection("system_total_bytes_exceeded")).toBe(
      "quota_exceeded",
    );
    expect(auditErrorCategoryForRejection("rate_limit_exceeded")).toBe(
      "rate_limited",
    );
    expect(
      auditErrorCategoryForRejection("concurrent_upload_in_progress"),
    ).toBe("rate_limited");
    expect(auditErrorCategoryForRejection("lock_wait_timeout")).toBe(
      "rate_limited",
    );
  });

  it("すべての拒否理由が分類を持つ", () => {
    for (const reason of uploadLimitRejectionReasons) {
      expect(["quota_exceeded", "rate_limited"]).toContain(
        auditErrorCategoryForRejection(reason),
      );
    }
  });
});

describe("advisory lockキーの導出", () => {
  it("同じ利用者は常に同じキー、別の利用者は別のキーになる", () => {
    const first = ownerUploadLockKey("owner-oid-001");
    expect(first).toEqual(ownerUploadLockKey("owner-oid-001"));
    expect(first.key).not.toBe(ownerUploadLockKey("owner-oid-002").key);
  });

  it("利用者用とシステム用でnamespaceを分ける", () => {
    expect(ownerUploadLockKey("owner-oid-001").namespace).not.toBe(
      systemUploadLockKey.namespace,
    );
    expect(systemUploadLockKey.key).toBe(0);
  });

  it("PostgreSQLのint4に収まる", () => {
    for (const key of [
      ownerUploadLockKey("owner-oid-001"),
      ownerUploadLockKey("あ".repeat(200)),
      systemUploadLockKey,
    ]) {
      for (const value of [key.namespace, key.key]) {
        expect(Number.isSafeInteger(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(-(2 ** 31));
        expect(value).toBeLessThanOrEqual(2 ** 31 - 1);
      }
    }
  });

  it("利用者識別子が空・長すぎる場合は例外にする(fail closed)", () => {
    expect(() => ownerUploadLockKey("")).toThrow();
    expect(() => ownerUploadLockKey("x".repeat(201))).toThrow();
  });
});

describe("uploadLimits(設計 §6.1「制限値は環境設定で変更可能」)", () => {
  it("環境変数の値を使い、引数で上書きできる", () => {
    const fromEnv = uploadLimitsFromEnv();
    expect(fromEnv.maxActiveDocumentsPerUser).toBe(100);
    expect(fromEnv.maxTotalBytesPerUser).toBe(500 * 1024 * 1024);
    expect(fromEnv.maxTotalBytesSystem).toBe(50 * 1024 * 1024 * 1024);
    expect(fromEnv.systemBytesWarningThreshold).toBe(40 * 1024 * 1024 * 1024);
    expect(fromEnv.uploadRateLimitPerMinute).toBe(5);
    expect(fromEnv.maxConcurrentUploadsPerUser).toBe(1);
    expect(fromEnv.rateLimitWindowSeconds).toBe(60);

    expect(
      uploadLimitsFromEnv({ maxActiveDocumentsPerUser: 3 })
        .maxActiveDocumentsPerUser,
    ).toBe(3);
  });

  it("警告閾値がシステム上限を超える設定を拒否する", () => {
    expect(() =>
      uploadLimitsFromEnv({
        maxTotalBytesSystem: 100,
        systemBytesWarningThreshold: 101,
      }),
    ).toThrow();
  });

  it("lock待ちはPoolのstatement timeoutを超えられない(Q-004)", () => {
    expect(() =>
      uploadLimitsFromEnv({
        lockWaitTimeoutMillis: poolSettings.statementTimeoutMillis + 1,
      }),
    ).toThrow();
    expect(uploadLimitsFromEnv().lockWaitTimeoutMillis).toBeLessThanOrEqual(
      poolSettings.statementTimeoutMillis,
    );
  });

  it("0以下の上限値と未知の項目を拒否する", () => {
    expect(() => uploadLimitsFromEnv({ maxActiveDocumentsPerUser: 0 })).toThrow();
    expect(() =>
      uploadLimitsFromEnv({
        maxConcurrentUploadsPerUser: -1,
      }),
    ).toThrow();
    expect(() =>
      uploadLimitsSchema.parse({
        ...limits,
        unknownLimit: 1,
      }),
    ).toThrow();
  });
});

describe("isLockWaitTimeoutError", () => {
  it("SQLSTATE 55P03 だけをlock待ちtimeoutとして扱う", () => {
    expect(isLockWaitTimeoutError({ code: "55P03" })).toBe(true);
    expect(isLockWaitTimeoutError({ code: "57014" })).toBe(false);
    expect(isLockWaitTimeoutError(new Error("lock"))).toBe(false);
    expect(isLockWaitTimeoutError(null)).toBe(false);
  });
});

function usageRows(options: {
  recent?: number;
  inProgress?: number;
  ownerCount?: number;
  ownerBytes?: number;
  systemBytes?: number;
}) {
  return [
    // set_config
    [],
    // 利用者のadvisory lock
    [],
    // upload_attemptsの集計
    [
      {
        recent_count: String(options.recent ?? 0),
        in_progress_count: String(options.inProgress ?? 0),
        reserved_byte_size: "0",
        rate_retry_after_seconds: "7",
        concurrency_retry_after_seconds: "9",
      },
    ],
    // getOwnerUsage
    [
      {
        document_count: String(options.ownerCount ?? 0),
        total_byte_size: String(options.ownerBytes ?? 0),
      },
    ],
    // システム全体のadvisory lock
    [],
    // getSystemUsage
    [
      {
        document_count: "0",
        total_byte_size: String(options.systemBytes ?? 0),
      },
    ],
    // システム全体の予約byte数
    [{ reserved_byte_size: "0" }],
    // upload_attemptsへのINSERT
    [
      {
        id: "11111111-2222-4333-8444-555555555555",
        expires_at: new Date("2026-01-02T03:04:05.000Z"),
      },
    ],
  ];
}

describe("reserveUploadSlotWithin(SQLの組み立て)", () => {
  const owner = "owner-oid-001";

  it("lock待ち時間の設定→利用者ロック→集計→システムロックの順に実行する", async () => {
    const { executor, calls } = createStubExecutor(usageRows({}));

    const decision = await reserveUploadSlotWithin(
      asPoolClient(executor),
      { ownerSubjectId: owner, byteSize: 100 },
      limits,
    );

    expect(decision).toMatchObject({
      allowed: true,
      attemptId: "11111111-2222-4333-8444-555555555555",
      systemWarning: false,
    });

    expect(calls[0]?.text).toContain("set_config('lock_timeout', $1, true)");
    expect(calls[0]?.values).toEqual([`${limits.lockWaitTimeoutMillis}ms`]);

    expect(calls[1]?.text).toContain("pg_advisory_xact_lock");
    const ownerLock = ownerUploadLockKey(owner);
    expect(calls[1]?.values).toEqual([ownerLock.namespace, ownerLock.key]);

    expect(calls[2]?.text).toContain("FROM upload_attempts");
    expect(calls[2]?.values).toEqual([owner, limits.rateLimitWindowSeconds]);

    expect(calls[3]?.text).toContain("FROM documents");
    expect(calls[3]?.text).toContain("status = 'active'");

    expect(calls[4]?.text).toContain("pg_advisory_xact_lock");
    expect(calls[4]?.values).toEqual([
      systemUploadLockKey.namespace,
      systemUploadLockKey.key,
    ]);

    const insert = lastCall(calls);
    expect(insert.text).toContain("INSERT INTO upload_attempts");
    expect(insert.values).toEqual([owner, 100, limits.uploadLeaseSeconds]);
  });

  it("拒否する場合は試行を登録しない", async () => {
    const { executor, calls } = createStubExecutor(
      usageRows({ inProgress: 1 }),
    );

    const decision = await reserveUploadSlotWithin(
      asPoolClient(executor),
      { ownerSubjectId: owner, byteSize: 100 },
      limits,
    );

    expect(decision).toEqual({
      allowed: false,
      reason: "concurrent_upload_in_progress",
      retryAfterSeconds: 9,
      errorCategory: "rate_limited",
    });
    expect(
      calls.some((call) => call.text.includes("INSERT INTO upload_attempts")),
    ).toBe(false);
  });

  it("利用者識別子とbyte数をZodで検証する", async () => {
    const { executor } = createStubExecutor(usageRows({}));

    await expect(
      reserveUploadSlotWithin(
        asPoolClient(executor),
        { ownerSubjectId: "", byteSize: 1 },
        limits,
      ),
    ).rejects.toThrow();
    await expect(
      reserveUploadSlotWithin(
        asPoolClient(executor),
        { ownerSubjectId: owner, byteSize: -1 },
        limits,
      ),
    ).rejects.toThrow();
    await expect(
      reserveUploadSlotWithin(
        asPoolClient(executor),
        { ownerSubjectId: owner, byteSize: 1.5 },
        limits,
      ),
    ).rejects.toThrow();
  });
});

describe("releaseUploadSlot", () => {
  it("未解放の試行だけを解放する", async () => {
    const { executor, calls } = createStubExecutor([[{ id: "x" }]]);

    const released = await releaseUploadSlot(
      {
        attemptId: "11111111-2222-4333-8444-555555555555",
        ownerSubjectId: "owner-oid-001",
      },
      executor,
    );

    expect(released).toBe(true);
    const call = lastCall(calls);
    expect(call.text).toContain("UPDATE upload_attempts");
    expect(call.text).toContain("finished_at IS NULL");
    // 他人の試行を解放できないよう所有者で絞り込む。
    expect(call.text).toContain("owner_subject_id = $2");
    expect(call.values).toEqual([
      "11111111-2222-4333-8444-555555555555",
      "owner-oid-001",
    ]);
  });

  it("試行IDがUUIDでない場合はSQLを実行せず false を返す", async () => {
    const { executor, calls } = createStubExecutor([]);

    expect(
      await releaseUploadSlot(
        { attemptId: "not-a-uuid", ownerSubjectId: "owner-oid-001" },
        executor,
      ),
    ).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe("reserveUploadSlot(独立したトランザクションで判定する)", () => {
  /**
   * Poolから借りたclient上でトランザクションを実行する部分だけを差し替え、
   * DBへ接続せずにエラー処理を確認する。実際のロック挙動は結合テストで検証する。
   */
  async function importWithFailingTransaction(error: unknown) {
    const release = vi.fn();
    vi.resetModules();
    vi.doMock("~/lib/db/pool.server", async (importOriginal) => {
      const actual =
        await importOriginal<typeof import("~/lib/db/pool.server")>();
      return {
        ...actual,
        getPool: () => ({ connect: async () => ({ release }) }),
        runInTransaction: async () => {
          throw error;
        },
      };
    });
    return { module: await import("~/lib/db/upload-limits.server"), release };
  }

  it("lock待ちtimeout(55P03)は lock_wait_timeout として拒否し、接続を返す", async () => {
    const { module, release } = await importWithFailingTransaction(
      Object.assign(new Error("canceling statement"), { code: "55P03" }),
    );

    const decision = await module.reserveUploadSlot(
      { ownerSubjectId: "owner-oid-001", byteSize: 100 },
      module.uploadLimitsFromEnv({ lockWaitTimeoutMillis: 3_000 }),
    );

    expect(decision).toEqual({
      allowed: false,
      reason: "lock_wait_timeout",
      retryAfterSeconds: 3,
      errorCategory: "rate_limited",
    });
    expect(release).toHaveBeenCalledTimes(1);

    vi.doUnmock("~/lib/db/pool.server");
    vi.resetModules();
  });

  it("lock待ち以外のエラーは握りつぶさず、接続を返す", async () => {
    const { module, release } = await importWithFailingTransaction(
      Object.assign(new Error("connection lost"), { code: "08006" }),
    );

    await expect(
      module.reserveUploadSlot({
        ownerSubjectId: "owner-oid-001",
        byteSize: 100,
      }),
    ).rejects.toThrow();
    expect(release).toHaveBeenCalledTimes(1);

    vi.doUnmock("~/lib/db/pool.server");
    vi.resetModules();
  });
});
