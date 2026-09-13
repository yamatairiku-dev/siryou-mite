import { beforeEach, describe, expect, it, vi } from "vitest";
import { PreviewTooLargeError } from "../../../services/preview/capture";
import {
  classifyPreviewError,
  isDeterministicFailure,
  isTimeoutLikeError,
  PreviewProcessingTimeoutError,
  runPreviewWorkerOnce,
  withProcessingDeadline,
  type PreviewDocumentSnapshot,
  type PreviewWorkerDependencies,
} from "../../../services/preview/worker";
import type { OperationLogEvent } from "../../../services/shared/log";
import type { ReceivedPreviewQueueEnvelope } from "../../../services/shared/storage";

/**
 * T18 単体テスト: プレビュー生成ワーカーの手順と判定(設計 §7.5, §10.2, §15.1)。
 *
 * 外部I/Oはすべて偽の依存に差し替え、`dequeueCount`の判定、冪等性、
 * 失敗時の再試行・恒久失敗の分岐を検証する。
 */

const documentId = "11111111-2222-4333-8444-555555555555";
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

type Harness = {
  dependencies: PreviewWorkerDependencies;
  logged: OperationLogEvent[];
  deleted: Array<{ messageId: string }>;
  recorded: Array<{ previewStatus: string; errorCategory: string | null }>;
  savedPreviews: string[];
  discarded: string[];
  captureCalls: number;
};

function envelope(
  overrides: Partial<ReceivedPreviewQueueEnvelope> = {},
): ReceivedPreviewQueueEnvelope {
  return {
    messageId: "message-1",
    popReceipt: "receipt-1",
    dequeueCount: 1,
    message: { schemaVersion: 1, documentId },
    ...overrides,
  };
}

function createHarness(options: {
  envelope?: ReceivedPreviewQueueEnvelope | null;
  document?: PreviewDocumentSnapshot | null;
  capture?: () => Promise<Buffer>;
  fetchHtml?: () => Promise<Buffer>;
  savePreview?: () => Promise<void>;
  recordPreviewResult?: () => Promise<boolean>;
  deleteMessage?: () => Promise<void>;
  maxDequeueCount?: number;
} = {}): Harness {
  const logged: OperationLogEvent[] = [];
  const deleted: Array<{ messageId: string }> = [];
  const recorded: Array<{ previewStatus: string; errorCategory: string | null }> =
    [];
  const savedPreviews: string[] = [];
  const discarded: string[] = [];
  const harness: Harness = {
    logged,
    deleted,
    recorded,
    savedPreviews,
    discarded,
    captureCalls: 0,
    dependencies: {
      maxDequeueCount: options.maxDequeueCount ?? 3,
      processingTimeoutMs: 30_000,
      logger: {
        pseudonymizeSubjectId: (value) => `hmac:${value}`,
        logOperationEvent: (event) => logged.push(event),
      },
      newCorrelationId: () => "00000000-0000-4000-8000-000000000000",
      receiveMessage: async () =>
        options.envelope === undefined ? envelope() : options.envelope,
      deleteMessage: async (target) => {
        if (options.deleteMessage) {
          await options.deleteMessage();
        }
        deleted.push({ messageId: target.messageId });
      },
      findDocument: async () =>
        options.document === undefined
          ? { isActive: true, previewStatus: "pending" }
          : options.document,
      fetchHtml:
        options.fetchHtml ?? (async () => Buffer.from("<p>資料</p>", "utf8")),
      capturePreview: async () => {
        harness.captureCalls += 1;
        return options.capture ? options.capture() : jpeg;
      },
      savePreview: async (id) => {
        if (options.savePreview) {
          await options.savePreview();
        }
        savedPreviews.push(id);
      },
      discardPreview: async (id) => {
        discarded.push(id);
      },
      recordPreviewResult: async (input) => {
        recorded.push({
          previewStatus: input.previewStatus,
          errorCategory: input.errorCategory,
        });
        return options.recordPreviewResult
          ? options.recordPreviewResult()
          : true;
      },
    },
  };

  return harness;
}

describe("runPreviewWorkerOnce の正常系", () => {
  it("撮影・保存・ready更新のあとにメッセージを削除する", async () => {
    const harness = createHarness();

    const result = await runPreviewWorkerOnce(harness.dependencies);

    expect(result).toEqual({
      outcome: "completed",
      documentId,
      errorCategory: null,
    });
    expect(harness.captureCalls).toBe(1);
    expect(harness.savedPreviews).toEqual([documentId]);
    expect(harness.recorded).toEqual([
      { previewStatus: "ready", errorCategory: null },
    ]);
    expect(harness.deleted).toEqual([{ messageId: "message-1" }]);
    expect(harness.logged.at(-1)).toMatchObject({
      event: "preview_generation_succeeded",
      result: "success",
      documentId,
    });
  });

  it("メッセージが無い場合は何もしない", async () => {
    const harness = createHarness({ envelope: null });

    const result = await runPreviewWorkerOnce(harness.dependencies);

    expect(result.outcome).toBe("no_message");
    expect(harness.captureCalls).toBe(0);
    expect(harness.deleted).toEqual([]);
  });
});

describe("メッセージ検証(設計 §7.5)", () => {
  it("検証できないメッセージは撮影せず破棄する", async () => {
    const harness = createHarness({ envelope: envelope({ message: null }) });

    const result = await runPreviewWorkerOnce(harness.dependencies);

    expect(result).toEqual({
      outcome: "discarded",
      documentId: null,
      errorCategory: "validation_failed",
    });
    expect(harness.captureCalls).toBe(0);
    expect(harness.recorded).toEqual([]);
    expect(harness.deleted).toEqual([{ messageId: "message-1" }]);
    expect(harness.logged.at(-1)).toMatchObject({
      event: "preview_message_rejected",
      result: "failed",
      errorCategory: "validation_failed",
    });
  });
});

describe("資料の状態による分岐", () => {
  it("未存在の資料は撮影せずメッセージを削除する", async () => {
    const harness = createHarness({ document: null });

    const result = await runPreviewWorkerOnce(harness.dependencies);

    expect(result.outcome).toBe("skipped");
    expect(harness.captureCalls).toBe(0);
    expect(harness.deleted).toHaveLength(1);
  });

  it("削除済みの資料はHTMLを取得せずメッセージを削除する(設計 §10.4)", async () => {
    const harness = createHarness({
      document: { isActive: false, previewStatus: null },
    });

    const result = await runPreviewWorkerOnce(harness.dependencies);

    expect(result.outcome).toBe("skipped");
    expect(harness.captureCalls).toBe(0);
    expect(harness.recorded).toEqual([]);
    expect(harness.deleted).toHaveLength(1);
  });

  it("既にreadyの資料は撮影し直さない(重複配信への冪等性)", async () => {
    const harness = createHarness({
      document: { isActive: true, previewStatus: "ready" },
    });

    const result = await runPreviewWorkerOnce(harness.dependencies);

    expect(result.outcome).toBe("skipped");
    expect(harness.captureCalls).toBe(0);
    expect(harness.recorded).toEqual([]);
    expect(harness.deleted).toHaveLength(1);
  });

  it("既にfailedの資料は再実行しない(設計 §10.2「手動再実行は設けない」)", async () => {
    const harness = createHarness({
      document: { isActive: true, previewStatus: "failed" },
    });

    const result = await runPreviewWorkerOnce(harness.dependencies);

    expect(result.outcome).toBe("skipped");
    expect(harness.captureCalls).toBe(0);
  });

  it("撮影中に資料が削除された場合は保存済みプレビューを後始末する", async () => {
    const harness = createHarness({ recordPreviewResult: async () => false });

    const result = await runPreviewWorkerOnce(harness.dependencies);

    expect(result.outcome).toBe("skipped");
    expect(harness.savedPreviews).toEqual([documentId]);
    expect(harness.discarded).toEqual([documentId]);
    expect(harness.deleted).toHaveLength(1);
  });
});

describe("dequeueCountによる再試行判定(設計 §7.5)", () => {
  it.each([1, 2])(
    "dequeueCount=%s の失敗はメッセージを残して再試行に回す",
    async (dequeueCount) => {
      const harness = createHarness({
        envelope: envelope({ dequeueCount }),
        capture: async () => {
          throw new Error("撮影に失敗");
        },
      });

      const result = await runPreviewWorkerOnce(harness.dependencies);

      expect(result).toEqual({
        outcome: "retry_scheduled",
        documentId,
        errorCategory: "preview_failed",
      });
      // メッセージを削除せず、DBの状態も変えない。
      expect(harness.deleted).toEqual([]);
      expect(harness.recorded).toEqual([]);
      expect(harness.logged.at(-1)).toMatchObject({
        event: "preview_generation_retry_scheduled",
        result: "failed",
        errorCategory: "preview_failed",
      });
    },
  );

  it("3回目(上限)の失敗でfailedと監査を保存してからメッセージを削除する", async () => {
    const harness = createHarness({
      envelope: envelope({ dequeueCount: 3 }),
      capture: async () => {
        throw new Error("撮影に失敗");
      },
    });

    const result = await runPreviewWorkerOnce(harness.dependencies);

    expect(result).toEqual({
      outcome: "permanently_failed",
      documentId,
      errorCategory: "preview_failed",
    });
    expect(harness.recorded).toEqual([
      { previewStatus: "failed", errorCategory: "preview_failed" },
    ]);
    expect(harness.deleted).toEqual([{ messageId: "message-1" }]);
    expect(harness.logged.at(-1)).toMatchObject({
      event: "preview_generation_failed",
      result: "failed",
      errorCategory: "preview_failed",
      documentId,
    });
  });

  it("上限を超えた配信では撮影せずfailedにして削除する", async () => {
    const harness = createHarness({ envelope: envelope({ dequeueCount: 4 }) });

    const result = await runPreviewWorkerOnce(harness.dependencies);

    expect(result.outcome).toBe("permanently_failed");
    expect(harness.captureCalls).toBe(0);
    expect(harness.recorded).toEqual([
      { previewStatus: "failed", errorCategory: "preview_failed" },
    ]);
    expect(harness.deleted).toHaveLength(1);
  });

  it("failed更新に失敗した場合はメッセージを削除しない", async () => {
    const harness = createHarness({
      envelope: envelope({ dequeueCount: 3 }),
      capture: async () => {
        throw new Error("撮影に失敗");
      },
      recordPreviewResult: async () => {
        throw new Error("DBに接続できません");
      },
    });

    const result = await runPreviewWorkerOnce(harness.dependencies);

    expect(result).toEqual({
      outcome: "retry_scheduled",
      documentId,
      errorCategory: "database_failed",
    });
    expect(harness.deleted).toEqual([]);
  });

  it("上限byte数を超えるHTMLは試行回数を使い切らずfailedにする", async () => {
    const harness = createHarness({
      envelope: envelope({ dequeueCount: 1 }),
      capture: async () => {
        throw new PreviewTooLargeError();
      },
    });

    const result = await runPreviewWorkerOnce(harness.dependencies);

    expect(result.outcome).toBe("permanently_failed");
    expect(result.errorCategory).toBe("preview_failed");
    expect(harness.recorded).toEqual([
      { previewStatus: "failed", errorCategory: "preview_failed" },
    ]);
  });
});

describe("メッセージ削除の失敗", () => {
  it("ready更新後に削除だけ失敗しても結果をfailedへ書き換えない", async () => {
    const harness = createHarness({
      // 試行上限の配信でも、削除失敗で`failed`にしてはいけない。
      envelope: envelope({ dequeueCount: 3 }),
      deleteMessage: async () => {
        throw new Error("Queueに接続できません");
      },
    });

    const result = await runPreviewWorkerOnce(harness.dependencies);

    expect(result.outcome).toBe("completed");
    expect(harness.recorded).toEqual([
      { previewStatus: "ready", errorCategory: null },
    ]);
    expect(harness.logged.map((event) => event.event)).toContain(
      "preview_message_delete_failed",
    );
  });
});

describe("エラー分類(設計 §12.2の固定enum)", () => {
  it("HTML取得の失敗はstorage_failedにする", async () => {
    const harness = createHarness({
      envelope: envelope({ dequeueCount: 3 }),
      fetchHtml: async () => {
        throw new Error("Blobを取得できません");
      },
    });

    const result = await runPreviewWorkerOnce(harness.dependencies);

    expect(result.errorCategory).toBe("storage_failed");
  });

  it("プレビュー保存の失敗はstorage_failedにする", async () => {
    const harness = createHarness({
      envelope: envelope({ dequeueCount: 3 }),
      savePreview: async () => {
        throw new Error("Blobを保存できません");
      },
    });

    const result = await runPreviewWorkerOnce(harness.dependencies);

    expect(result.errorCategory).toBe("storage_failed");
  });

  it("描画timeoutはpreview_timeoutにする", async () => {
    const timeoutError = new Error("Timeout 10000ms exceeded.");
    timeoutError.name = "TimeoutError";
    const harness = createHarness({
      envelope: envelope({ dequeueCount: 3 }),
      capture: async () => {
        throw timeoutError;
      },
    });

    const result = await runPreviewWorkerOnce(harness.dependencies);

    expect(result.errorCategory).toBe("preview_timeout");
    expect(harness.recorded).toEqual([
      { previewStatus: "failed", errorCategory: "preview_timeout" },
    ]);
  });

  it("分類関数はtimeout・中止をpreview_timeoutへ寄せる", () => {
    const abortError = new Error("aborted");
    abortError.name = "AbortError";

    expect(isTimeoutLikeError(abortError)).toBe(true);
    expect(isTimeoutLikeError(new PreviewProcessingTimeoutError())).toBe(true);
    expect(isTimeoutLikeError(new Error("その他"))).toBe(false);
    expect(classifyPreviewError(abortError, "storage_failed")).toBe(
      "preview_timeout",
    );
    expect(classifyPreviewError(new Error("その他"), "storage_failed")).toBe(
      "storage_failed",
    );
    expect(isDeterministicFailure(new PreviewTooLargeError())).toBe(true);
    expect(isDeterministicFailure(new Error("一時障害"))).toBe(false);
  });
});

describe("1メッセージの処理上限(設計 §7.5)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("処理上限を超えた場合はPreviewProcessingTimeoutErrorになる", async () => {
    const timeoutSpy = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValue(AbortSignal.abort());

    try {
      await expect(
        withProcessingDeadline(30_000, () => new Promise(() => {})),
      ).rejects.toThrow(PreviewProcessingTimeoutError);
      expect(timeoutSpy).toHaveBeenCalledWith(30_000);
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it("期限内に終わった処理はそのまま結果を返す", async () => {
    await expect(
      withProcessingDeadline(30_000, async () => "完了"),
    ).resolves.toBe("完了");
  });

  it("処理上限の超過はpreview_timeoutとして扱う", async () => {
    const harness = createHarness({ envelope: envelope({ dequeueCount: 3 }) });
    const timeoutSpy = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValue(AbortSignal.abort());

    try {
      const result = await runPreviewWorkerOnce(harness.dependencies);

      expect(timeoutSpy).toHaveBeenCalledWith(30_000);
      expect(result.errorCategory).toBe("preview_timeout");
      expect(result.outcome).toBe("permanently_failed");
    } finally {
      timeoutSpy.mockRestore();
    }
  });
});
