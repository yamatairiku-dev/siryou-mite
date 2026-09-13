import { describe, expect, it, vi } from "vitest";
import {
  classifyMaintenanceError,
  maintenanceTasks,
  runMaintenanceJobOnce,
  type MaintenanceJobDependencies,
  type MaintenanceTaskName,
  type MaintenanceTaskReport,
} from "../../../services/maintenance/job";
import type { BlobCleanupCandidate } from "../../../services/shared/db/maintenance";
import type { OperationLogger } from "../../../services/shared/log";
import type { StoredBlobPage } from "../../../services/shared/storage";

/**
 * T19 単体テスト: 定期保守Jobの処理本体(設計 §7.7, §16)。
 *
 * 外部I/O(DB・Blob)はすべて差し替え、手順と判定だけを検証する。
 */

const documentIdA = "11111111-1111-4111-8111-111111111111";
const documentIdB = "22222222-2222-4222-8222-222222222222";
const documentIdC = "33333333-3333-4333-8333-333333333333";
const hour = 3_600_000;

type LoggedEvent = {
  event: string;
  result: string;
  errorCategory?: string | null;
  documentId?: string | null;
};

function createLogger(): { logger: OperationLogger; events: LoggedEvent[] } {
  const events: LoggedEvent[] = [];
  return {
    events,
    logger: {
      pseudonymizeSubjectId: (subjectId: string) => `hmac:${subjectId}`,
      logOperationEvent: (event) => {
        events.push({
          event: event.event,
          result: event.result,
          errorCategory: event.errorCategory ?? null,
          documentId: event.documentId ?? null,
        });
      },
    },
  };
}

type Harness = {
  dependencies: MaintenanceJobDependencies;
  events: LoggedEvent[];
  summaries: Array<MaintenanceTaskReport & { correlationId: string }>;
};

function createHarness(
  overrides: Partial<MaintenanceJobDependencies> = {},
): Harness {
  const { logger, events } = createLogger();
  const summaries: Array<MaintenanceTaskReport & { correlationId: string }> = [];

  const dependencies: MaintenanceJobDependencies = {
    logger,
    logTaskSummary: (summary) => summaries.push(summary),
    newCorrelationId: () => "00000000-0000-4000-8000-000000000001",
    batchSize: 2,
    blobListPageSize: 2,
    orphanBlobGraceMs: 24 * hour,
    uploadAttemptRetentionSeconds: 7 * 24 * 3_600,
    listBlobCleanupPendingDocuments: async () => [],
    deleteDocumentBlobs: async () => undefined,
    completeBlobCleanup: async () => true,
    purgeExpiredAuditEvents: async () => 0,
    purgeExpiredDocuments: async () => 0,
    purgeOldUploadAttempts: async () => 0,
    listDocumentBlobs: async () => ({ blobs: [], continuationToken: null }),
    findExistingDocumentIds: async () => new Set<string>(),
    deleteOrphanBlob: async () => undefined,
    ...overrides,
  };

  return { dependencies, events, summaries };
}

function reportFor(
  summaries: Array<MaintenanceTaskReport & { correlationId: string }>,
  task: MaintenanceTaskName,
): MaintenanceTaskReport {
  const report = summaries.find((summary) => summary.task === task);
  if (!report) {
    throw new Error(`report for ${task} not found`);
  }
  return report;
}

function candidate(documentId: string, minutesAgo: number): BlobCleanupCandidate {
  return {
    documentId,
    // 実装と同じく、DBが返す文字列のまま扱う(microsecond精度を落とさない)。
    deletedAt: new Date(Date.now() - minutesAgo * 60_000)
      .toISOString()
      .replace("T", " ")
      .replace("Z", "123+00"),
  };
}

describe("runMaintenanceJobOnce(設計 §7.7)", () => {
  it("対象が無い場合でも5つの処理をすべて実行し、成功として報告する", async () => {
    const { dependencies, summaries } = createHarness();

    const result = await runMaintenanceJobOnce(
      dependencies,
      new AbortController().signal,
    );

    expect(result.hasFailure).toBe(false);
    expect(summaries.map((summary) => summary.task)).toEqual([
      ...maintenanceTasks,
    ]);
    // 監査のpurgeは資料メタデータのpurgeより先(FKのため)。
    expect(summaries.findIndex((s) => s.task === "expired_audit_purge")).toBeLessThan(
      summaries.findIndex((s) => s.task === "expired_document_purge"),
    );
    for (const summary of summaries) {
      expect(summary.result).toBe("success");
      expect(summary.examined).toBe(0);
    }
  });
});

describe("blob_cleanup_pending の再試行(設計 §7.7, §10.4(5))", () => {
  it("両Blobを削除してからフラグを下ろす", async () => {
    const deleteDocumentBlobs = vi.fn(async () => undefined);
    const completeBlobCleanup = vi.fn(async () => true);
    const listBlobCleanupPendingDocuments = vi
      .fn<MaintenanceJobDependencies["listBlobCleanupPendingDocuments"]>()
      .mockResolvedValueOnce([candidate(documentIdA, 10)])
      .mockResolvedValue([]);

    const { dependencies, summaries, events } = createHarness({
      listBlobCleanupPendingDocuments,
      deleteDocumentBlobs,
      completeBlobCleanup,
    });

    await runMaintenanceJobOnce(dependencies, new AbortController().signal);

    expect(deleteDocumentBlobs).toHaveBeenCalledTimes(1);
    expect(completeBlobCleanup).toHaveBeenCalledWith(documentIdA);
    // Blob削除が先、フラグ解除が後(削除できていない資料のフラグを下ろさない)。
    expect(deleteDocumentBlobs.mock.invocationCallOrder[0]).toBeLessThan(
      completeBlobCleanup.mock.invocationCallOrder[0] as number,
    );
    expect(reportFor(summaries, "blob_cleanup_retry")).toMatchObject({
      result: "success",
      examined: 1,
      succeeded: 1,
      failed: 0,
    });
    expect(events).toContainEqual({
      event: "maintenance_blob_cleanup_retry",
      result: "success",
      errorCategory: null,
      documentId: documentIdA,
    });
  });

  it("Blob削除に失敗した資料のフラグは下ろさず、他の資料の処理は続ける", async () => {
    const deleteDocumentBlobs = vi.fn(async (documentId: string) => {
      if (documentId === documentIdA) {
        throw new Error("blob delete failed");
      }
    });
    const completeBlobCleanup = vi.fn(async () => true);
    const listBlobCleanupPendingDocuments = vi
      .fn<MaintenanceJobDependencies["listBlobCleanupPendingDocuments"]>()
      .mockResolvedValueOnce([candidate(documentIdA, 10), candidate(documentIdB, 9)])
      .mockResolvedValue([]);

    const { dependencies, summaries, events } = createHarness({
      listBlobCleanupPendingDocuments,
      deleteDocumentBlobs,
      completeBlobCleanup,
    });

    const result = await runMaintenanceJobOnce(
      dependencies,
      new AbortController().signal,
    );

    expect(completeBlobCleanup).toHaveBeenCalledTimes(1);
    expect(completeBlobCleanup).toHaveBeenCalledWith(documentIdB);
    expect(reportFor(summaries, "blob_cleanup_retry")).toMatchObject({
      result: "failed",
      examined: 2,
      succeeded: 1,
      failed: 1,
    });
    // 失敗しても他の処理(purge)は実行され、Job全体としては失敗を報告する。
    expect(result.tasks).toHaveLength(maintenanceTasks.length);
    expect(result.hasFailure).toBe(true);
    expect(events).toContainEqual({
      event: "maintenance_blob_cleanup_retry",
      result: "failed",
      errorCategory: "internal_error",
      documentId: documentIdA,
    });
  });

  it("バッチが埋まっている場合はkeyset cursorで次のバッチへ進む", async () => {
    const first = [candidate(documentIdA, 30), candidate(documentIdB, 20)];
    const listBlobCleanupPendingDocuments = vi
      .fn<MaintenanceJobDependencies["listBlobCleanupPendingDocuments"]>()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce([candidate(documentIdC, 10)])
      .mockResolvedValue([]);

    const { dependencies, summaries } = createHarness({
      listBlobCleanupPendingDocuments,
    });

    await runMaintenanceJobOnce(dependencies, new AbortController().signal);

    expect(listBlobCleanupPendingDocuments).toHaveBeenCalledTimes(2);
    expect(listBlobCleanupPendingDocuments.mock.calls[0]?.[0]).toBeNull();
    // 2回目は1バッチ目の最後の資料を起点にする(失敗した資料を掴み続けない)。
    expect(listBlobCleanupPendingDocuments.mock.calls[1]?.[0]).toEqual({
      deletedAt: first[1]?.deletedAt,
      documentId: documentIdB,
    });
    expect(reportFor(summaries, "blob_cleanup_retry").examined).toBe(3);
  });

  it("Job実行上限に達したら新しい資料の処理を始めない", async () => {
    const controller = new AbortController();
    const deleteDocumentBlobs = vi.fn(async () => {
      controller.abort();
    });
    const listBlobCleanupPendingDocuments = vi
      .fn<MaintenanceJobDependencies["listBlobCleanupPendingDocuments"]>()
      .mockResolvedValue([candidate(documentIdA, 30), candidate(documentIdB, 20)]);

    const { dependencies, summaries } = createHarness({
      listBlobCleanupPendingDocuments,
      deleteDocumentBlobs,
    });

    await runMaintenanceJobOnce(dependencies, controller.signal);

    expect(deleteDocumentBlobs).toHaveBeenCalledTimes(1);
    expect(reportFor(summaries, "blob_cleanup_retry")).toMatchObject({
      examined: 1,
      truncated: true,
    });
  });

  it("フラグを下ろせなかった資料は別のeventで観測できるようにする", async () => {
    const listBlobCleanupPendingDocuments = vi
      .fn<MaintenanceJobDependencies["listBlobCleanupPendingDocuments"]>()
      .mockResolvedValueOnce([candidate(documentIdA, 10)])
      .mockResolvedValue([]);

    const { dependencies, summaries, events } = createHarness({
      listBlobCleanupPendingDocuments,
      // 更新0行(既にフラグが下りている・行が変わったなど)。
      completeBlobCleanup: async () => false,
    });

    await runMaintenanceJobOnce(dependencies, new AbortController().signal);

    // Blob削除自体は完了しているため件数は成功として数える。
    expect(reportFor(summaries, "blob_cleanup_retry")).toMatchObject({
      result: "success",
      examined: 1,
      succeeded: 1,
      failed: 0,
    });
    expect(events).toContainEqual({
      event: "maintenance_blob_cleanup_flag_unchanged",
      result: "failed",
      errorCategory: "database_failed",
      documentId: documentIdA,
    });
    expect(
      events.some((event) => event.event === "maintenance_blob_cleanup_retry"),
    ).toBe(false);
  });

  it("途中で例外になっても、そこまでに完了した件数を報告に残す", async () => {
    const listBlobCleanupPendingDocuments = vi
      .fn<MaintenanceJobDependencies["listBlobCleanupPendingDocuments"]>()
      // 1バッチ目(batchSize=2)は完了し、2バッチ目の抽出で失敗する。
      .mockResolvedValueOnce([candidate(documentIdA, 30), candidate(documentIdB, 20)])
      .mockRejectedValue(new Error("db down"));

    const { dependencies, summaries } = createHarness({
      listBlobCleanupPendingDocuments,
    });

    await runMaintenanceJobOnce(dependencies, new AbortController().signal);

    expect(reportFor(summaries, "blob_cleanup_retry")).toMatchObject({
      result: "failed",
      examined: 2,
      succeeded: 2,
      failed: 1,
    });
  });

  it("抽出そのものが失敗しても他の処理を止めない", async () => {
    const purgeExpiredAuditEvents = vi.fn(async () => 0);
    const { dependencies, summaries, events } = createHarness({
      listBlobCleanupPendingDocuments: async () => {
        throw new Error("db down");
      },
      purgeExpiredAuditEvents,
    });

    const result = await runMaintenanceJobOnce(
      dependencies,
      new AbortController().signal,
    );

    expect(result.hasFailure).toBe(true);
    expect(reportFor(summaries, "blob_cleanup_retry")).toMatchObject({
      result: "failed",
      failed: 1,
    });
    expect(purgeExpiredAuditEvents).toHaveBeenCalled();
    // 例外の内容は出さず、分類だけを残す。
    expect(events).toContainEqual({
      event: "maintenance_blob_cleanup_retry",
      result: "failed",
      errorCategory: "internal_error",
      documentId: null,
    });
  });
});

describe("保持期間経過分のpurge(設計 §16)", () => {
  it("削除件数がバッチ未満になるまで繰り返す", async () => {
    const purgeExpiredAuditEvents = vi
      .fn<MaintenanceJobDependencies["purgeExpiredAuditEvents"]>()
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(1);

    const { dependencies, summaries } = createHarness({
      purgeExpiredAuditEvents,
    });

    await runMaintenanceJobOnce(dependencies, new AbortController().signal);

    expect(purgeExpiredAuditEvents).toHaveBeenCalledTimes(3);
    expect(purgeExpiredAuditEvents).toHaveBeenCalledWith(2);
    expect(reportFor(summaries, "expired_audit_purge")).toMatchObject({
      result: "success",
      succeeded: 5,
    });
  });

  it("upload_attemptsのpurgeは保持期間を渡す(Q-011)", async () => {
    const purgeOldUploadAttempts = vi
      .fn<MaintenanceJobDependencies["purgeOldUploadAttempts"]>()
      .mockResolvedValue(0);

    const { dependencies } = createHarness({ purgeOldUploadAttempts });

    await runMaintenanceJobOnce(dependencies, new AbortController().signal);

    expect(purgeOldUploadAttempts).toHaveBeenCalledWith(7 * 24 * 3_600, 2);
  });

  it("途中のバッチで例外になっても、削除済み件数を報告に残す", async () => {
    const purgeExpiredAuditEvents = vi
      .fn<MaintenanceJobDependencies["purgeExpiredAuditEvents"]>()
      .mockResolvedValueOnce(2)
      .mockRejectedValue(new Error("db down"));

    const { dependencies, summaries } = createHarness({
      purgeExpiredAuditEvents,
    });

    await runMaintenanceJobOnce(dependencies, new AbortController().signal);

    expect(reportFor(summaries, "expired_audit_purge")).toMatchObject({
      result: "failed",
      examined: 2,
      succeeded: 2,
      failed: 1,
    });
  });

  it("Job実行上限に達したら次のバッチを始めない", async () => {
    const controller = new AbortController();
    const purgeExpiredDocuments = vi.fn(async () => {
      controller.abort();
      return 2;
    });

    const { dependencies, summaries } = createHarness({
      purgeExpiredDocuments,
    });

    await runMaintenanceJobOnce(dependencies, controller.signal);

    expect(purgeExpiredDocuments).toHaveBeenCalledTimes(1);
    expect(reportFor(summaries, "expired_document_purge")).toMatchObject({
      succeeded: 2,
      truncated: true,
    });
  });
});

describe("孤児Blobの掃除(設計 §7.7)", () => {
  function pageFor(
    keys: Array<{ key: string; lastModified: Date | null }>,
    continuationToken: string | null = null,
  ): StoredBlobPage {
    return { blobs: keys, continuationToken };
  }

  const oldEnough = () => new Date(Date.now() - 48 * hour);

  it("DBに行が無く猶予を過ぎたBlobだけを削除する", async () => {
    const deleteOrphanBlob = vi
      .fn<MaintenanceJobDependencies["deleteOrphanBlob"]>()
      .mockResolvedValue(undefined);
    const listDocumentBlobs = vi
      .fn<MaintenanceJobDependencies["listDocumentBlobs"]>()
      .mockImplementation(async (prefix) =>
        prefix === "html/"
          ? pageFor([
              { key: `html/${documentIdA}/document.html`, lastModified: oldEnough() },
              { key: `html/${documentIdB}/document.html`, lastModified: oldEnough() },
            ])
          : pageFor([
              {
                key: `preview/${documentIdA}/preview.jpg`,
                lastModified: oldEnough(),
              },
            ]),
      );

    const { dependencies, summaries, events } = createHarness({
      listDocumentBlobs,
      // documentIdBだけDBに行が残っている。
      findExistingDocumentIds: async () => new Set([documentIdB]),
      deleteOrphanBlob,
    });

    await runMaintenanceJobOnce(dependencies, new AbortController().signal);

    expect(deleteOrphanBlob.mock.calls.map(([blob]) => blob)).toEqual([
      { kind: "html", documentId: documentIdA },
      { kind: "preview", documentId: documentIdA },
    ]);
    expect(reportFor(summaries, "orphan_blob_cleanup")).toMatchObject({
      result: "success",
      examined: 2,
      succeeded: 2,
    });
    expect(events).toContainEqual({
      event: "maintenance_orphan_blob_deleted",
      result: "success",
      errorCategory: null,
      documentId: documentIdA,
    });
  });

  it("猶予内の新しいBlob・最終更新日時が不明なBlob・想定外のキーは削除しない", async () => {
    const deleteOrphanBlob = vi.fn(async () => undefined);
    const findExistingDocumentIds = vi.fn(async () => new Set<string>());
    const listDocumentBlobs = vi
      .fn<MaintenanceJobDependencies["listDocumentBlobs"]>()
      .mockImplementation(async (prefix) =>
        prefix === "html/"
          ? pageFor([
              {
                key: `html/${documentIdA}/document.html`,
                // 猶予(24時間)内に保存されたBlob。
                lastModified: new Date(Date.now() - hour),
              },
              {
                key: `html/${documentIdB}/document.html`,
                lastModified: null,
              },
              { key: "html/not-a-uuid/document.html", lastModified: oldEnough() },
              { key: "unexpected/object.bin", lastModified: oldEnough() },
            ])
          : pageFor([]),
      );

    const { dependencies, summaries } = createHarness({
      listDocumentBlobs,
      findExistingDocumentIds,
      deleteOrphanBlob,
    });

    await runMaintenanceJobOnce(dependencies, new AbortController().signal);

    expect(deleteOrphanBlob).not.toHaveBeenCalled();
    // 候補が無ければDBへも問い合わせない。
    expect(findExistingDocumentIds).not.toHaveBeenCalled();
    expect(reportFor(summaries, "orphan_blob_cleanup")).toMatchObject({
      result: "success",
      examined: 0,
    });
  });

  it("continuationTokenで全ページを走査し、同じ資料IDは1回だけ問い合わせる", async () => {
    const findExistingDocumentIds = vi
      .fn<MaintenanceJobDependencies["findExistingDocumentIds"]>()
      .mockResolvedValue(new Set<string>());
    const listDocumentBlobs = vi
      .fn<MaintenanceJobDependencies["listDocumentBlobs"]>()
      .mockImplementation(async (prefix, continuationToken) => {
        if (prefix !== "html/") {
          return pageFor([]);
        }
        return continuationToken === null
          ? pageFor(
              [
                {
                  key: `html/${documentIdA}/document.html`,
                  lastModified: oldEnough(),
                },
              ],
              "page-2",
            )
          : pageFor([
              {
                key: `html/${documentIdB}/document.html`,
                lastModified: oldEnough(),
              },
            ]);
      });

    const { dependencies, summaries } = createHarness({
      listDocumentBlobs,
      findExistingDocumentIds,
    });

    await runMaintenanceJobOnce(dependencies, new AbortController().signal);

    expect(listDocumentBlobs).toHaveBeenCalledTimes(3);
    expect(findExistingDocumentIds.mock.calls.map(([ids]) => ids)).toEqual([
      [documentIdA],
      [documentIdB],
    ]);
    expect(reportFor(summaries, "orphan_blob_cleanup").succeeded).toBe(2);
  });

  it("ページ取得が途中で失敗しても、削除済みの孤児Blob件数を報告に残す", async () => {
    const listDocumentBlobs = vi
      .fn<MaintenanceJobDependencies["listDocumentBlobs"]>()
      .mockResolvedValueOnce(
        pageFor(
          [
            {
              key: `html/${documentIdA}/document.html`,
              lastModified: oldEnough(),
            },
          ],
          "page-2",
        ),
      )
      .mockRejectedValue(new Error("storage down"));

    const { dependencies, summaries } = createHarness({ listDocumentBlobs });

    await runMaintenanceJobOnce(dependencies, new AbortController().signal);

    expect(reportFor(summaries, "orphan_blob_cleanup")).toMatchObject({
      result: "failed",
      examined: 1,
      succeeded: 1,
      failed: 1,
    });
  });

  it("1件の削除失敗で走査を止めない", async () => {
    const deleteOrphanBlob = vi.fn(async (blob: { documentId: string }) => {
      if (blob.documentId === documentIdA) {
        throw Object.assign(new Error("aborted"), { name: "AbortError" });
      }
    });
    const listDocumentBlobs = vi
      .fn<MaintenanceJobDependencies["listDocumentBlobs"]>()
      .mockImplementation(async (prefix) =>
        prefix === "html/"
          ? pageFor([
              { key: `html/${documentIdA}/document.html`, lastModified: oldEnough() },
              { key: `html/${documentIdB}/document.html`, lastModified: oldEnough() },
            ])
          : pageFor([]),
      );

    const { dependencies, summaries, events } = createHarness({
      listDocumentBlobs,
      deleteOrphanBlob,
    });

    const result = await runMaintenanceJobOnce(
      dependencies,
      new AbortController().signal,
    );

    expect(deleteOrphanBlob).toHaveBeenCalledTimes(2);
    expect(result.hasFailure).toBe(true);
    expect(reportFor(summaries, "orphan_blob_cleanup")).toMatchObject({
      result: "failed",
      examined: 2,
      succeeded: 1,
      failed: 1,
    });
    expect(events).toContainEqual({
      event: "maintenance_orphan_blob_deleted",
      result: "failed",
      errorCategory: "storage_failed",
      documentId: documentIdA,
    });
  });

  it("Job実行上限に達したら新しいページを読まない", async () => {
    const controller = new AbortController();
    const listDocumentBlobs = vi
      .fn<MaintenanceJobDependencies["listDocumentBlobs"]>()
      .mockImplementation(async () => {
        controller.abort();
        return pageFor([], "page-2");
      });

    const { dependencies, summaries } = createHarness({ listDocumentBlobs });

    await runMaintenanceJobOnce(dependencies, controller.signal);

    expect(listDocumentBlobs).toHaveBeenCalledTimes(1);
    expect(reportFor(summaries, "orphan_blob_cleanup").truncated).toBe(true);
  });
});

describe("classifyMaintenanceError", () => {
  it("中断・timeoutはstorage_failed、それ以外はinternal_errorにする", () => {
    expect(
      classifyMaintenanceError(
        Object.assign(new Error("x"), { name: "TimeoutError" }),
      ),
    ).toBe("storage_failed");
    expect(
      classifyMaintenanceError(
        Object.assign(new Error("x"), { name: "AbortError" }),
      ),
    ).toBe("storage_failed");
    expect(classifyMaintenanceError(new Error("x"))).toBe("internal_error");
    expect(classifyMaintenanceError("文字列")).toBe("internal_error");
  });
});
