import { describe, expect, it } from "vitest";
import {
  findExistingDocumentIds,
  listBlobCleanupPendingDocuments,
  METADATA_RETENTION_INTERVAL,
  purgeExpiredAuditEvents,
  purgeExpiredDocuments,
  purgeOldUploadAttempts,
} from "../../../services/shared/db/maintenance";
import { createStubExecutor, lastCall } from "./stub-executor";

/**
 * T19 単体テスト: 定期保守Jobのrepository(設計 §7.7, §16)。
 * SQLの組み立てと入力検証だけを見る。実際のSQL実行は結合テストで確認する。
 */

const documentId = "11111111-2222-4333-8444-555555555555";
const otherDocumentId = "99999999-2222-4333-8444-555555555555";

describe("listBlobCleanupPendingDocuments", () => {
  it("先頭バッチはcursorを渡さず、削除済み・再試行対象だけを抽出する", async () => {
    // `timestamptz`のmicrosecond精度を落とさないよう、DBからは文字列で受け取る。
    const deletedAt = "2026-01-02 03:04:05.123456+00";
    const { executor, calls } = createStubExecutor([
      [{ id: documentId, deleted_at: deletedAt }],
    ]);

    const result = await listBlobCleanupPendingDocuments({ limit: 10 }, executor);

    expect(result).toEqual([{ documentId, deletedAt }]);
    const call = lastCall(calls);
    expect(call.text).toContain("deleted_at::text AS deleted_at");
    expect(call.text).toContain("blob_cleanup_pending = true");
    expect(call.text).toContain("status = 'deleted'");
    expect(call.text).toContain("ORDER BY deleted_at, id");
    expect(call.values).toEqual([null, null, 10]);
  });

  it("cursorを渡すと(deleted_at, id)の続きから抽出する", async () => {
    const { executor, calls } = createStubExecutor([[]]);
    const deletedAt = "2026-01-02 03:04:05.123456+00";

    await listBlobCleanupPendingDocuments(
      { limit: 5, after: { deletedAt, documentId } },
      executor,
    );

    expect(lastCall(calls).values).toEqual([deletedAt, documentId, 5]);
  });

  it("バッチ件数が範囲外の場合は拒否する", async () => {
    const { executor, calls } = createStubExecutor();

    await expect(
      listBlobCleanupPendingDocuments({ limit: 0 }, executor),
    ).rejects.toThrow();
    await expect(
      listBlobCleanupPendingDocuments({ limit: 100_000 }, executor),
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});

describe("purgeExpiredAuditEvents(設計 §16)", () => {
  it("retain_untilを過ぎた行だけをバッチで削除する", async () => {
    const { executor, calls } = createStubExecutor([[{ id: documentId }]]);

    const deleted = await purgeExpiredAuditEvents({ limit: 200 }, executor);

    expect(deleted).toBe(1);
    const call = lastCall(calls);
    expect(call.text).toContain("DELETE FROM audit_events");
    expect(call.text).toContain("retain_until <= now()");
    expect(call.text).toContain("LIMIT $1");
    expect(call.values).toEqual([200]);
  });
});

describe("purgeExpiredDocuments(設計 §7.7, §16)", () => {
  it("1年経過・Blob削除完了・監査なしの削除済み資料だけを削除する", async () => {
    const { executor, calls } = createStubExecutor([[]]);

    await purgeExpiredDocuments({ limit: 50 }, executor);

    const call = lastCall(calls);
    expect(call.text).toContain("DELETE FROM documents");
    expect(call.text).toContain("d.status = 'deleted'");
    // 設計 §7.7「Blob削除が完了していない資料メタデータはpurgeしない」。
    expect(call.text).toContain("d.blob_cleanup_pending = false");
    expect(call.text).toContain(
      `d.deleted_at <= now() - INTERVAL '${METADATA_RETENTION_INTERVAL}'`,
    );
    // FK(ON DELETE指定なし)のため、監査が残っている資料は対象にしない。
    expect(call.text).toContain("NOT EXISTS");
    expect(call.values).toEqual([50]);
  });

  it("保持期間は1年(設計 §16)", () => {
    expect(METADATA_RETENTION_INTERVAL).toBe("1 year");
  });
});

describe("purgeOldUploadAttempts(Q-011)", () => {
  it("expires_atとfinished_atの両方が保持期間より古い行だけを削除する", async () => {
    const { executor, calls } = createStubExecutor([[]]);

    await purgeOldUploadAttempts(
      { retentionSeconds: 7 * 24 * 3_600, limit: 100 },
      executor,
    );

    const call = lastCall(calls);
    expect(call.text).toContain("DELETE FROM upload_attempts");
    expect(call.text).toContain("expires_at < now() - make_interval(secs => $1)");
    expect(call.text).toContain("finished_at IS NULL");
    expect(call.values).toEqual([7 * 24 * 3_600, 100]);
  });

  it("頻度判定の窓・leaseより短い保持期間は拒否する(上限をすり抜けさせない)", async () => {
    const { executor, calls } = createStubExecutor();

    await expect(
      purgeOldUploadAttempts({ retentionSeconds: 60, limit: 100 }, executor),
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});

describe("findExistingDocumentIds(孤児Blob判定)", () => {
  it("UUIDでない値を除いて問い合わせ、存在する資料IDだけを返す", async () => {
    const { executor, calls } = createStubExecutor([[{ id: documentId }]]);

    const existing = await findExistingDocumentIds(
      [documentId, otherDocumentId, "not-a-uuid"],
      executor,
    );

    expect(existing).toEqual(new Set([documentId]));
    expect(lastCall(calls).values).toEqual([[documentId, otherDocumentId]]);
  });

  it("有効な資料IDが1件も無い場合はDBへ問い合わせない", async () => {
    const { executor, calls } = createStubExecutor();

    const existing = await findExistingDocumentIds(["not-a-uuid"], executor);

    expect(existing.size).toBe(0);
    expect(calls).toHaveLength(0);
  });
});
