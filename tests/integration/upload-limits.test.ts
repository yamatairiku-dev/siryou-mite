import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Client } from "pg";
import {
  createDocument,
  deleteDocumentAsOwner,
} from "~/lib/db/documents.server";
import { closePool, getPool, runInTransaction } from "~/lib/db/pool.server";
import {
  isLockWaitTimeoutError,
  auditErrorCategoryForRejection,
  releaseUploadSlot,
  reserveUploadSlotWithin,
  systemUploadLockKey,
  uploadLimitsFromEnv,
  type UploadLimitsInput,
  type UploadSlotDecision,
} from "~/lib/db/upload-limits.server";
import { dropSchema, migrateFreshSchema, newClient } from "./helpers/schema.js";

/**
 * T08 結合テスト: 件数・容量・頻度・同時実行の制限(設計 §6.1, §10.1(3), §18.2)。
 *
 * 実際のPostgreSQLへmigrationを適用し、repositoryのSQLとadvisory lockを
 * そのまま実行する。schemaはテスト専用のものを作り、`search_path`で切り替える。
 */

const schema = "t08_it_upload_limits";

let client: Client;

beforeAll(async () => {
  await migrateFreshSchema(schema);
  client = newClient();
  await client.connect();
  await client.query(`SET search_path TO "${schema}"`);
});

afterAll(async () => {
  await closePool();
  await client.end();
  await dropSchema(schema);
});

beforeEach(async () => {
  await client.query("TRUNCATE upload_attempts, audit_events, documents");
});

/**
 * `reserveUploadSlot`と同じ手順(Poolから借りた1接続の独立したトランザクション +
 * lock待ちtimeoutの拒否への変換)を、テスト専用schemaへ`search_path`を向けて実行する。
 */
async function reserve(
  input: { ownerSubjectId: string; byteSize: number },
  overrides: Partial<UploadLimitsInput> = {},
): Promise<UploadSlotDecision> {
  const limits = uploadLimitsFromEnv(overrides);
  const client = await getPool().connect();
  try {
    return await runInTransaction(client, async () => {
      await client.query(`SET LOCAL search_path TO "${schema}"`);
      return await reserveUploadSlotWithin(client, input, limits);
    });
  } catch (error) {
    if (isLockWaitTimeoutError(error)) {
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

async function addActiveDocument(ownerSubjectId: string, byteSize: number) {
  return createDocument(
    {
      ownerSubjectId,
      byteSize,
      originalFileName: "資料.html",
      title: "資料タイトル",
    },
    client,
  );
}

/** 進行中の枠を残さないよう、判定の直後に解放する(通常の成功時の流れ)。 */
async function reserveAndRelease(
  input: { ownerSubjectId: string; byteSize: number },
  overrides: Partial<UploadLimitsInput> = {},
): Promise<UploadSlotDecision> {
  const decision = await reserve(input, overrides);
  if (decision.allowed) {
    await releaseUploadSlot(
      { attemptId: decision.attemptId, ownerSubjectId: input.ownerSubjectId },
      client,
    );
  }
  return decision;
}

describe("件数上限(設計 §6.1「1ユーザーあたり最大100件」)", () => {
  const owner = "owner-count";

  it("上限-1件のときは受け付け、上限に達していると拒否する", async () => {
    const limits = { maxActiveDocumentsPerUser: 3 } satisfies Partial<UploadLimitsInput>;

    await addActiveDocument(owner, 10);
    await addActiveDocument(owner, 10);

    // 現在2件(上限-1)。この1件で上限ちょうどになるため受け付ける。
    const allowed = await reserveAndRelease({ ownerSubjectId: owner, byteSize: 10 }, limits);
    expect(allowed.allowed).toBe(true);

    await addActiveDocument(owner, 10);

    const rejected = await reserve({ ownerSubjectId: owner, byteSize: 10 }, limits);
    expect(rejected).toMatchObject({
      allowed: false,
      reason: "owner_document_count_exceeded",
      errorCategory: "quota_exceeded",
      retryAfterSeconds: null,
    });
  });

  it("削除済み資料は件数に数えない(設計 §6.1)", async () => {
    const limits = { maxActiveDocumentsPerUser: 2 } satisfies Partial<UploadLimitsInput>;

    const first = await addActiveDocument(owner, 10);
    const second = await addActiveDocument(owner, 10);
    expect(
      (await reserve({ ownerSubjectId: owner, byteSize: 10 }, limits)).allowed,
    ).toBe(false);

    await deleteDocumentAsOwner(
      { documentId: first.id, ownerSubjectId: owner },
      client,
    );
    await deleteDocumentAsOwner(
      { documentId: second.id, ownerSubjectId: owner },
      client,
    );
    await client.query("TRUNCATE upload_attempts");

    expect(
      (await reserve({ ownerSubjectId: owner, byteSize: 10 }, limits)).allowed,
    ).toBe(true);
  });

  it("進行中の試行も件数に数える(まだ登録されていない1件として扱う)", async () => {
    const limits = {
      maxActiveDocumentsPerUser: 2,
      maxConcurrentUploadsPerUser: 3,
    } satisfies Partial<UploadLimitsInput>;

    await addActiveDocument(owner, 10);
    expect(
      (await reserve({ ownerSubjectId: owner, byteSize: 10 }, limits)).allowed,
    ).toBe(true);

    // 登録済み1件 + 進行中1件 = 上限2件のため、次は拒否する。
    expect(
      await reserve({ ownerSubjectId: owner, byteSize: 10 }, limits),
    ).toMatchObject({
      allowed: false,
      reason: "owner_document_count_exceeded",
    });
  });

  it("他の利用者の資料は件数に数えない", async () => {
    const limits = { maxActiveDocumentsPerUser: 1 } satisfies Partial<UploadLimitsInput>;

    await addActiveDocument("owner-other", 10);

    expect(
      (await reserve({ ownerSubjectId: owner, byteSize: 10 }, limits)).allowed,
    ).toBe(true);
  });
});

describe("利用者の容量上限(設計 §6.1「1ユーザーあたり最大500MB」)", () => {
  const owner = "owner-bytes";
  const limits = { maxTotalBytesPerUser: 1_000 } satisfies Partial<UploadLimitsInput>;

  it("合計が上限ちょうどになるアップロードは受け付ける", async () => {
    await addActiveDocument(owner, 900);

    const decision = await reserveAndRelease(
      { ownerSubjectId: owner, byteSize: 100 },
      limits,
    );
    expect(decision.allowed).toBe(true);
  });

  it("合計が上限を1byte超えるアップロードは拒否する", async () => {
    await addActiveDocument(owner, 900);

    const decision = await reserve({ ownerSubjectId: owner, byteSize: 101 }, limits);
    expect(decision).toMatchObject({
      allowed: false,
      reason: "owner_total_bytes_exceeded",
      errorCategory: "quota_exceeded",
    });
  });

  it("進行中の試行が予約したbyte数も合計に数える(判定と登録は別トランザクション)", async () => {
    // 同時実行上限で先に拒否されないよう、この確認だけ2件まで許可する。
    const concurrent = {
      ...limits,
      maxConcurrentUploadsPerUser: 2,
    } satisfies Partial<UploadLimitsInput>;

    const reserved = await reserve(
      { ownerSubjectId: owner, byteSize: 900 },
      concurrent,
    );
    expect(reserved.allowed).toBe(true);

    // `documents`はまだ空だが、予約分900byteを加算して判定する。
    expect(
      await reserve({ ownerSubjectId: owner, byteSize: 101 }, concurrent),
    ).toMatchObject({
      allowed: false,
      reason: "owner_total_bytes_exceeded",
    });
    expect(
      (await reserve({ ownerSubjectId: owner, byteSize: 100 }, concurrent))
        .allowed,
    ).toBe(true);
  });

  it("削除済み資料のbyte数は合計に数えない(設計 §6.1)", async () => {
    const deleted = await addActiveDocument(owner, 900);
    await deleteDocumentAsOwner(
      { documentId: deleted.id, ownerSubjectId: owner },
      client,
    );

    const decision = await reserveAndRelease(
      { ownerSubjectId: owner, byteSize: 1_000 },
      limits,
    );
    expect(decision.allowed).toBe(true);
  });
});

describe("システム容量上限と警告閾値(設計 §6.1「50GB・40GBで警告」)", () => {
  const owner = "owner-system";
  const limits = {
    maxTotalBytesSystem: 1_000,
    systemBytesWarningThreshold: 800,
    // 利用者側の上限では拒否されないようにする。
    maxTotalBytesPerUser: 1_000_000,
  } satisfies Partial<UploadLimitsInput>;

  it("他の利用者の資料も合計し、上限ちょうどは受け付ける", async () => {
    await addActiveDocument("owner-system-other", 900);

    const decision = await reserveAndRelease(
      { ownerSubjectId: owner, byteSize: 100 },
      limits,
    );
    expect(decision).toMatchObject({ allowed: true, systemWarning: true });
  });

  it("上限を超えるアップロードは拒否する", async () => {
    await addActiveDocument("owner-system-other", 900);

    const decision = await reserve({ ownerSubjectId: owner, byteSize: 101 }, limits);
    expect(decision).toMatchObject({
      allowed: false,
      reason: "system_total_bytes_exceeded",
      errorCategory: "quota_exceeded",
    });
  });

  it("警告閾値未満では警告フラグを立てない", async () => {
    await addActiveDocument("owner-system-other", 600);

    const decision = await reserveAndRelease(
      { ownerSubjectId: owner, byteSize: 100 },
      limits,
    );
    expect(decision).toMatchObject({ allowed: true, systemWarning: false });
  });

  it("削除済み資料はシステム合計にも数えない(設計 §6.1)", async () => {
    const deleted = await addActiveDocument("owner-system-other", 900);
    await deleteDocumentAsOwner(
      { documentId: deleted.id, ownerSubjectId: "owner-system-other" },
      client,
    );

    const decision = await reserveAndRelease(
      { ownerSubjectId: owner, byteSize: 1_000 },
      limits,
    );
    expect(decision).toMatchObject({ allowed: true, systemWarning: true });
  });
});

describe("頻度制限(設計 §6.1「1ユーザー1分間に最大5回」)", () => {
  const owner = "owner-rate";
  const limits = {
    uploadRateLimitPerMinute: 3,
    // 同時実行では拒否されないようにする(解放済みの試行だけを数える)。
    maxConcurrentUploadsPerUser: 5,
  } satisfies Partial<UploadLimitsInput>;

  it("窓の中で上限回数まで受け付け、次を拒否する", async () => {
    for (let index = 0; index < 3; index += 1) {
      const decision = await reserveAndRelease(
        { ownerSubjectId: owner, byteSize: 10 },
        limits,
      );
      expect(decision.allowed).toBe(true);
    }

    const rejected = await reserve({ ownerSubjectId: owner, byteSize: 10 }, limits);
    expect(rejected).toMatchObject({
      allowed: false,
      reason: "rate_limit_exceeded",
      errorCategory: "rate_limited",
    });
    if (!rejected.allowed) {
      expect(rejected.retryAfterSeconds).toBeGreaterThan(0);
      expect(rejected.retryAfterSeconds).toBeLessThanOrEqual(60);
    }
  });

  it("窓より古い試行は数えない", async () => {
    for (let index = 0; index < 3; index += 1) {
      await reserveAndRelease({ ownerSubjectId: owner, byteSize: 10 }, limits);
    }
    await client.query(
      "UPDATE upload_attempts SET started_at = now() - interval '2 minutes', expires_at = now() - interval '1 minute'",
    );

    const decision = await reserveAndRelease(
      { ownerSubjectId: owner, byteSize: 10 },
      limits,
    );
    expect(decision.allowed).toBe(true);
  });

  it("他の利用者の試行は数えない", async () => {
    for (let index = 0; index < 3; index += 1) {
      await reserveAndRelease(
        { ownerSubjectId: "owner-rate-other", byteSize: 10 },
        limits,
      );
    }

    const decision = await reserveAndRelease(
      { ownerSubjectId: owner, byteSize: 10 },
      limits,
    );
    expect(decision.allowed).toBe(true);
  });
});

describe("同時実行制限(設計 §6.1「同時アップロードは1件まで」)", () => {
  const owner = "owner-concurrent";
  const limits = { maxConcurrentUploadsPerUser: 1 } satisfies Partial<UploadLimitsInput>;

  it("進行中の試行がある間は拒否し、解放すると再び受け付ける", async () => {
    const first = await reserve({ ownerSubjectId: owner, byteSize: 10 }, limits);
    expect(first.allowed).toBe(true);

    const second = await reserve({ ownerSubjectId: owner, byteSize: 10 }, limits);
    expect(second).toMatchObject({
      allowed: false,
      reason: "concurrent_upload_in_progress",
      errorCategory: "rate_limited",
    });

    if (first.allowed) {
      // 他人の試行IDとして解放しようとしても枠は空かない(IDOR防止)。
      expect(
        await releaseUploadSlot(
          { attemptId: first.attemptId, ownerSubjectId: "owner-other" },
          client,
        ),
      ).toBe(false);

      expect(
        await releaseUploadSlot(
          { attemptId: first.attemptId, ownerSubjectId: owner },
          client,
        ),
      ).toBe(true);
      // 解放は冪等(二重解放でも例外にしない)。
      expect(
        await releaseUploadSlot(
          { attemptId: first.attemptId, ownerSubjectId: owner },
          client,
        ),
      ).toBe(false);
    }

    const third = await reserve({ ownerSubjectId: owner, byteSize: 10 }, limits);
    expect(third.allowed).toBe(true);
  });

  it("解放されないまま失効した試行は進行中に数えない(異常終了でも永久にブロックしない)", async () => {
    const first = await reserve({ ownerSubjectId: owner, byteSize: 10 }, limits);
    expect(first.allowed).toBe(true);

    // 異常終了で`finished_at`が更新されないまま lease が切れた状態にする。
    await client.query(
      "UPDATE upload_attempts SET started_at = now() - interval '5 minutes', expires_at = now() - interval '1 second'",
    );

    const second = await reserve({ ownerSubjectId: owner, byteSize: 10 }, limits);
    expect(second.allowed).toBe(true);
  });

  it("不正な試行IDの解放は false を返す(例外にしない)", async () => {
    expect(
      await releaseUploadSlot(
        { attemptId: "not-a-uuid", ownerSubjectId: owner },
        client,
      ),
    ).toBe(false);
  });
});

describe("同時実行の競合(advisory lockで直列化する。設計 §10.1(3))", () => {
  it("同じ利用者の並行判定では同時実行上限を超えない", async () => {
    const owner = "owner-race-concurrency";
    const limits = {
      maxConcurrentUploadsPerUser: 1,
      uploadRateLimitPerMinute: 100,
    } satisfies Partial<UploadLimitsInput>;

    const decisions = await Promise.all(
      Array.from({ length: 8 }, () =>
        reserve({ ownerSubjectId: owner, byteSize: 10 }, limits),
      ),
    );

    expect(decisions.filter((decision) => decision.allowed)).toHaveLength(1);
    const inProgress = await client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM upload_attempts WHERE finished_at IS NULL AND expires_at > now()",
    );
    expect(inProgress.rows[0]?.count).toBe("1");
  });

  it("同じ利用者の並行判定では頻度上限を超えない", async () => {
    const owner = "owner-race-rate";
    const limits = {
      uploadRateLimitPerMinute: 3,
      maxConcurrentUploadsPerUser: 8,
    } satisfies Partial<UploadLimitsInput>;

    const decisions = await Promise.all(
      Array.from({ length: 8 }, () =>
        reserve({ ownerSubjectId: owner, byteSize: 10 }, limits),
      ),
    );

    expect(decisions.filter((decision) => decision.allowed)).toHaveLength(3);
  });

  it("利用者が異なる並行判定でもシステム容量上限を超えない(本番と同じ手順)", async () => {
    const limits = {
      maxTotalBytesSystem: 500,
      systemBytesWarningThreshold: 400,
      maxTotalBytesPerUser: 1_000_000,
    } satisfies Partial<UploadLimitsInput>;

    // 設計 §10.1の手順どおり、判定(独立したトランザクション)をまず並行に実行し、
    // 資料登録はその後の別トランザクションで行う。判定時点では`documents`に
    // まだ何も無いため、進行中の予約byte数を見ないと全件が許可されてしまう。
    const owners = Array.from(
      { length: 8 },
      (_unused, index) => `owner-race-system-${index}`,
    );
    const decisions = await Promise.all(
      owners.map((ownerSubjectId) =>
        reserve({ ownerSubjectId, byteSize: 100 }, limits),
      ),
    );

    expect(decisions.filter((decision) => decision.allowed)).toHaveLength(5);

    // 許可された分だけを、判定の後(advisory lock解放後)に登録して解放する。
    for (const [index, decision] of decisions.entries()) {
      if (!decision.allowed) {
        continue;
      }
      const ownerSubjectId = owners[index] ?? "";
      await addActiveDocument(ownerSubjectId, 100);
      await releaseUploadSlot(
        { attemptId: decision.attemptId, ownerSubjectId },
        client,
      );
    }

    const total = await client.query<{ total: string }>(
      "SELECT COALESCE(sum(byte_size), 0)::text AS total FROM documents WHERE status = 'active'",
    );
    expect(Number(total.rows[0]?.total)).toBe(500);

    // 登録済みの資料だけを見ても上限に達しているため、以降の判定は拒否される。
    const afterInsert = await reserve(
      { ownerSubjectId: "owner-race-system-late", byteSize: 1 },
      limits,
    );
    expect(afterInsert).toMatchObject({
      allowed: false,
      reason: "system_total_bytes_exceeded",
    });
  });
});

describe("advisory lockの待ち時間(Poolのstatement timeoutより短く打ち切る)", () => {
  it("システム全体のロックを取得できない場合は lock_wait_timeout として拒否する", async () => {
    // 別セッションがシステム全体のロックをsession単位で保持する。
    await client.query("SELECT pg_advisory_lock($1::int, $2::int)", [
      systemUploadLockKey.namespace,
      systemUploadLockKey.key,
    ]);

    try {
      const decision = await reserve(
        { ownerSubjectId: "owner-lock-timeout", byteSize: 10 },
        { lockWaitTimeoutMillis: 200 },
      );
      expect(decision).toMatchObject({
        allowed: false,
        reason: "lock_wait_timeout",
        errorCategory: "rate_limited",
      });
    } finally {
      await client.query("SELECT pg_advisory_unlock($1::int, $2::int)", [
        systemUploadLockKey.namespace,
        systemUploadLockKey.key,
      ]);
    }
  });
});
