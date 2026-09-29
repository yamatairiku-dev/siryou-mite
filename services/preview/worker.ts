/**
 * Preview Job(プレビュー生成ワーカー)の処理本体。
 *
 * 設計: docs/APPLICATION_DESIGN.md §7.5, §10.2, §15.1, §15.2
 *
 * 1実行で1メッセージだけを処理する(設計 §7.5)。外部I/O(Queue・DB・Blob・Chromium)は
 * すべて`PreviewWorkerDependencies`として受け取り、このmoduleは手順と判定だけを持つ。
 *
 * 手順:
 *   1. Queueから1メッセージ受信する(visibility timeout 60秒)
 *   2. 本文を検証する。検証できないメッセージは再試行しても結果が変わらないため削除する
 *   3. `dequeueCount`が上限を超えている場合は撮影せず`failed`にして削除する
 *   4. 資料が存在し`active`であることをDBで確認する。削除済み・未存在なら撮影せず削除する
 *   5. `preview_status`が`pending`でない場合(重複配信)は撮影せず削除する(冪等)
 *   6. HTMLを取得し、撮影し、Blobへ保存し、`ready`と監査を保存してからメッセージを削除する
 *   7. 失敗時は、`dequeueCount`が上限未満なら**メッセージを削除せず**再試行に回し、
 *      上限に達していれば`failed`と監査を保存してから削除する(設計 §7.5)
 *
 * 冪等性(設計 §7.5「同じメッセージを複数回受け取っても結果が壊れない」):
 *   - Blobキーは資料IDから決定的に導出するため、再撮影しても上書きになる
 *   - `preview_status`が`pending`でない資料は撮影し直さない
 *   - DB更新は`active`かつ`preview_status`が残っている資料だけを対象にする
 *   - メッセージ削除は既に削除済みでも成功する
 *
 * 処理上限(`processingTimeoutMs`、設計 §7.5)の扱い:
 *   - `withProcessingDeadline`が作る`AbortSignal`は`processMessage`の各段階と各依存
 *     呼び出しへ渡す。意味は「期限を過ぎてから**新しい撮影・業務処理を始めない**」。
 *   - 結果が確定したあとの書き込み(恒久失敗の`failed`更新と監査、メッセージ削除、
 *     孤児プレビューの削除)は、期限切れのsignalを使わず`PREVIEW_FINALIZE_TIMEOUT_MS`の
 *     独立したsignalで行う。ここまで中断すると資料が`pending`のまま残り、メッセージが
 *     再配信され続ける(設計 §7.5「3回目の失敗でDBを`failed`へ更新して監査を保存した後、
 *     メッセージを削除する」を満たせない)。
 *
 * ログには固定の`event`名・結果・エラー分類・相関ID・資料IDだけを出す。HTML本文、
 * ファイル名、プレビュー画像、Blobキー、メールアドレスは出さない(設計 §15.2)。
 */
import type { AuditErrorCategory } from "../shared/db/audit-events.js";
import type { PreviewStatus } from "../shared/db/documents.js";
import type { OperationLogger } from "../shared/log.js";
import type { ReceivedPreviewQueueEnvelope } from "../shared/storage.js";
import { PreviewTooLargeError } from "./capture.js";

/** 1実行の結果。Jobの終了コードと運用ログの判断に使う。 */
export type PreviewWorkerOutcome =
  /** 処理するメッセージが無かった。 */
  | "no_message"
  /** 撮影・保存・`ready`更新まで完了した。 */
  | "completed"
  /** 撮影せずメッセージを削除した(削除済み資料・処理済み資料)。 */
  | "skipped"
  /** 検証できないメッセージを破棄した。 */
  | "discarded"
  /** 失敗したがメッセージを残した(次の配信で再試行する)。 */
  | "retry_scheduled"
  /** 試行上限に達したため`failed`にしてメッセージを削除した。 */
  | "permanently_failed";

export type PreviewWorkerResult = {
  outcome: PreviewWorkerOutcome;
  /** 検証できないメッセージでは資料IDが分からないため`null`。 */
  documentId: string | null;
  errorCategory: AuditErrorCategory | null;
};

/** DBから読む資料の最小情報。 */
export type PreviewDocumentSnapshot = {
  isActive: boolean;
  /** 削除済み資料ではNULLへ消去される(設計 §12.1)。 */
  previewStatus: PreviewStatus | null;
};

export type RecordPreviewResultInput = {
  documentId: string;
  previewStatus: Extract<PreviewStatus, "ready" | "failed">;
  errorCategory: AuditErrorCategory | null;
  correlationId: string;
};

export type PreviewWorkerDependencies = {
  /** `dequeueCount`で判定する最大試行回数(設計 §7.5、既定3)。 */
  maxDequeueCount: number;
  /** 1メッセージの処理上限(ms、設計 §7.5、既定30秒)。 */
  processingTimeoutMs: number;
  logger: OperationLogger;
  /** 相関IDを発行する(UUID)。 */
  newCorrelationId(): string;
  /** Queueから1メッセージ受信する。無い場合は`null`。 */
  receiveMessage(): Promise<ReceivedPreviewQueueEnvelope | null>;
  /** 処理済みメッセージを削除する(冪等)。 */
  deleteMessage(
    envelope: { messageId: string; popReceipt: string },
    signal?: AbortSignal,
  ): Promise<void>;
  findDocument(
    documentId: string,
    signal: AbortSignal,
  ): Promise<PreviewDocumentSnapshot | null>;
  fetchHtml(documentId: string, signal: AbortSignal): Promise<Buffer>;
  capturePreview(html: Buffer, signal: AbortSignal): Promise<Buffer>;
  savePreview(
    documentId: string,
    jpeg: Buffer,
    signal: AbortSignal,
  ): Promise<void>;
  /** 撮影済みプレビューを破棄する(DB更新に間に合わなかった場合の後始末)。 */
  discardPreview(documentId: string, signal?: AbortSignal): Promise<void>;
  /**
   * プレビュー状態の更新と監査を同じトランザクションで保存する(設計 §15.1)。
   * 更新対象が無かった場合は`false`を返し、監査も残さない。資料が削除済みの場合と、
   * `failed`を書こうとしたが資料が既に`pending`でない(別の配信で`ready`・`failed`が
   * 確定済み)場合がある。
   */
  recordPreviewResult(
    input: RecordPreviewResultInput,
    signal: AbortSignal,
  ): Promise<boolean>;
};

/** 1メッセージの処理が処理上限を超えた場合(設計 §7.5)。 */
export class PreviewProcessingTimeoutError extends Error {
  constructor() {
    super("プレビュー生成が処理上限を超えました");
    this.name = "PreviewProcessingTimeoutError";
  }
}

/** 処理のどの段階で失敗したかを保持する内部エラー。 */
class PreviewStepError extends Error {
  readonly category: AuditErrorCategory;

  constructor(category: AuditErrorCategory, cause: unknown) {
    super("プレビュー生成に失敗しました");
    this.name = "PreviewStepError";
    this.category = category;
    this.cause = cause;
  }
}

/**
 * timeout・中止に相当するエラーかどうか。Playwrightの`TimeoutError`、
 * `AbortSignal.timeout`の`TimeoutError`、`abortSignal`中止時の`AbortError`を含む。
 */
export function isTimeoutLikeError(error: unknown): boolean {
  if (error instanceof PreviewProcessingTimeoutError) {
    return true;
  }
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const name = (error as { name?: unknown }).name;
  return name === "TimeoutError" || name === "AbortError";
}

/**
 * エラーを監査・運用ログのエラー分類へ変換する(設計 §12.2の固定enumだけを使う)。
 * timeoutはどの段階で起きても`preview_timeout`にする。
 */
export function classifyPreviewError(
  error: unknown,
  fallback: AuditErrorCategory,
): AuditErrorCategory {
  if (isTimeoutLikeError(error)) {
    return "preview_timeout";
  }
  return fallback;
}

/**
 * 再試行しても結果が変わらない失敗かどうか。
 *
 * 品質を下げても上限byte数に収まらないHTMLは、何回撮影しても同じ結果になるため
 * 試行回数を使い切らずに`failed`にする(設計 §7.5)。
 */
export function isDeterministicFailure(error: unknown): boolean {
  const cause = error instanceof PreviewStepError ? error.cause : error;
  return cause instanceof PreviewTooLargeError;
}

/**
 * 恒久失敗の記録と後始末に使う、処理上限とは別枠の上限(ms)。
 *
 * 処理上限(`processingTimeoutMs`)を使い切ったあとでも`failed`と監査を書き切る
 * 必要があるため、期限切れのsignalを流用せずこの値で新しいsignalを作る。
 * visibility timeout(既定60秒)の残り時間に収まる短い値にする。
 */
export const PREVIEW_FINALIZE_TIMEOUT_MS = 10_000;

/**
 * メッセージ削除の失敗で業務結果を巻き戻さない。
 *
 * 例えば`ready`への更新後に削除だけ失敗した場合、その失敗を処理全体の失敗として
 * 扱うと、試行上限に達していれば成功済みのプレビューを`failed`へ書き換えてしまう。
 * 削除に失敗したメッセージはvisibility timeout経過後に再配信され、`pending`以外の
 * 資料として撮影せずに削除される(冪等)。分類だけを運用ログへ残す。
 *
 * 処理上限のsignalは渡さない。削除は「新しい業務処理」ではなく、確定した結果に
 * 対する後始末であり、期限切れを理由に省くとメッセージが最大7日間再配信され続ける。
 * 待ち続けないよう`PREVIEW_FINALIZE_TIMEOUT_MS`の独立したsignalを使う。
 */
async function deleteMessageQuietly(
  dependencies: PreviewWorkerDependencies,
  envelope: { messageId: string; popReceipt: string },
  correlationId: string,
  documentId: string | null,
): Promise<void> {
  try {
    await dependencies.deleteMessage(
      envelope,
      AbortSignal.timeout(PREVIEW_FINALIZE_TIMEOUT_MS),
    );
  } catch (error) {
    dependencies.logger.logOperationEvent({
      event: "preview_message_delete_failed",
      correlationId,
      result: "failed",
      errorCategory: classifyPreviewError(error, "storage_failed"),
      documentId,
    });
  }
}

/**
 * 段階ごとのエラー分類を付けて実行する。
 *
 * 各段階を始める前に中断を確認し、処理上限(設計 §7.5)を過ぎてから**新しい外部
 * 書き込みを始めない**ようにする(`signal.throwIfAborted`が投げる`TimeoutError`/
 * `AbortError`は`classifyPreviewError`が`preview_timeout`へ寄せる)。
 */
async function step<T>(
  category: AuditErrorCategory,
  signal: AbortSignal,
  run: () => Promise<T>,
): Promise<T> {
  try {
    signal.throwIfAborted();
    return await run();
  } catch (error) {
    throw new PreviewStepError(classifyPreviewError(error, category), error);
  }
}

/**
 * 処理上限(既定30秒)を超えた時点で`PreviewProcessingTimeoutError`にする。
 *
 * 個々の外部呼び出し(Blob・DB・Chromium)にもそれぞれtimeoutがあるが、合計が
 * visibility timeout(60秒)を超えないよう、メッセージ単位でも打ち切る(設計 §7.5)。
 */
export async function withProcessingDeadline<T>(
  timeoutMs: number,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const signal = AbortSignal.timeout(timeoutMs);

  try {
    // 期限側だけを先に返す(`Promise.race`)ことはしない。中断を`run`へ伝えて
    // 実処理を止め、**その終了を待ってから**結果を決める。待たずに戻ると、
    // 打ち切ったはずの処理が裏で`ready`更新や監査INSERTまで完走し、恒久失敗側の
    // 書き込みと競合する(設計 §11.1の状態と §15.1の監査が食い違う)。
    return await run(signal);
  } catch (error) {
    if (signal.aborted && !(error instanceof PreviewStepError)) {
      throw new PreviewProcessingTimeoutError();
    }
    throw error;
  }
}

/**
 * Queueから1メッセージだけを取り出して処理する(設計 §7.5「1実行で1メッセージ」)。
 *
 * 例外は投げず、結果を`PreviewWorkerResult`として返す。呼び出し側(entrypoint)は
 * 結果に応じて終了コードを決める。
 */
export async function runPreviewWorkerOnce(
  dependencies: PreviewWorkerDependencies,
): Promise<PreviewWorkerResult> {
  const envelope = await dependencies.receiveMessage();

  if (!envelope) {
    dependencies.logger.logOperationEvent({
      event: "preview_message_absent",
      correlationId: dependencies.newCorrelationId(),
      result: "success",
    });
    return { outcome: "no_message", documentId: null, errorCategory: null };
  }

  const correlationId = dependencies.newCorrelationId();

  if (envelope.message === null) {
    // 資料IDが分からないため、DB更新も監査も行えない。再配信され続けないよう
    // 削除し、運用ログにだけ分類を残す(本文はログへ出さない)。
    await deleteMessageQuietly(dependencies, envelope, correlationId, null);
    dependencies.logger.logOperationEvent({
      event: "preview_message_rejected",
      correlationId,
      result: "failed",
      errorCategory: "validation_failed",
    });
    return {
      outcome: "discarded",
      documentId: null,
      errorCategory: "validation_failed",
    };
  }

  const documentId = envelope.message.documentId;

  // 前回の試行が`failed`更新の前に落ちた場合など、上限を超えた配信では撮影しない。
  // 既に`ready`・`failed`が確定している資料はここでも書き換えない(`failPermanently`が
  // 更新結果で判定する)。
  if (envelope.dequeueCount > dependencies.maxDequeueCount) {
    return failPermanently(dependencies, {
      envelope,
      documentId,
      correlationId,
      errorCategory: "preview_failed",
    });
  }

  try {
    return await withProcessingDeadline(
      dependencies.processingTimeoutMs,
      (signal) =>
        processMessage(
          dependencies,
          { envelope, documentId, correlationId },
          signal,
        ),
    );
  } catch (error) {
    const errorCategory =
      error instanceof PreviewStepError
        ? error.category
        : classifyPreviewError(error, "internal_error");

    const exhausted = envelope.dequeueCount >= dependencies.maxDequeueCount;

    if (exhausted || isDeterministicFailure(error)) {
      return failPermanently(dependencies, {
        envelope,
        documentId,
        correlationId,
        errorCategory,
      });
    }

    // メッセージを削除しない。visibility timeout経過後に再配信され、
    // `dequeueCount`が増えた状態で再試行される(設計 §7.5)。
    dependencies.logger.logOperationEvent({
      event: "preview_generation_retry_scheduled",
      correlationId,
      result: "failed",
      errorCategory,
      documentId,
    });
    return { outcome: "retry_scheduled", documentId, errorCategory };
  }
}

/**
 * 1メッセージ分の処理本体。
 *
 * `signal`は処理上限(設計 §7.5)のsignalで、各段階の開始前(`step`)と各依存呼び出しへ
 * そのまま渡す。期限を過ぎたら新しい外部呼び出しを始めず、進行中の撮影・Blob操作も
 * 中止する。期限切れ後でも必要な後始末(メッセージ削除・恒久失敗の記録)は、
 * このsignalを使わない経路(`deleteMessageQuietly`・`failPermanently`)で行う。
 */
async function processMessage(
  dependencies: PreviewWorkerDependencies,
  context: {
    envelope: ReceivedPreviewQueueEnvelope;
    documentId: string;
    correlationId: string;
  },
  signal: AbortSignal,
): Promise<PreviewWorkerResult> {
  const { envelope, documentId, correlationId } = context;

  const document = await step("database_failed", signal, () =>
    dependencies.findDocument(documentId, signal),
  );

  // 削除済み・未存在の資料のHTMLは取得しない(設計 §10.4)。再配信されても
  // 同じ判断になるため、メッセージは削除する。
  if (!document || !document.isActive || document.previewStatus === null) {
    await deleteMessageQuietly(dependencies, envelope, correlationId, documentId);
    dependencies.logger.logOperationEvent({
      event: "preview_generation_skipped",
      correlationId,
      result: "success",
      documentId,
    });
    return { outcome: "skipped", documentId, errorCategory: null };
  }

  // 重複配信。`ready`は撮影済み、`failed`は試行を使い切った資料のため、
  // どちらも撮影し直さず結果を書き換えない(設計 §7.5の冪等性、§10.2の再実行なし)。
  if (document.previewStatus !== "pending") {
    await deleteMessageQuietly(dependencies, envelope, correlationId, documentId);
    dependencies.logger.logOperationEvent({
      event: "preview_generation_skipped",
      correlationId,
      result: "success",
      documentId,
    });
    return { outcome: "skipped", documentId, errorCategory: null };
  }

  const html = await step("storage_failed", signal, () =>
    dependencies.fetchHtml(documentId, signal),
  );
  const jpeg = await step("preview_failed", signal, () =>
    dependencies.capturePreview(html, signal),
  );
  await step("storage_failed", signal, () =>
    dependencies.savePreview(documentId, jpeg, signal),
  );

  const stored = await step("database_failed", signal, () =>
    dependencies.recordPreviewResult(
      {
        documentId,
        previewStatus: "ready",
        errorCategory: null,
        correlationId,
      },
      signal,
    ),
  );

  if (!stored) {
    // 撮影中に資料が削除された。保存したプレビューは参照されないため後始末する
    // (削除処理のBlob削除は既に走った後の可能性がある。設計 §10.4)。
    // 結果が確定したあとの後始末のため、処理上限のsignalではなく独立した上限を使う。
    // 期限切れを理由に省くと、回収経路の無い孤児Blobがそのまま残る。
    const finalizeSignal = AbortSignal.timeout(PREVIEW_FINALIZE_TIMEOUT_MS);
    await step("storage_failed", finalizeSignal, () =>
      dependencies.discardPreview(documentId, finalizeSignal),
    );
    await deleteMessageQuietly(dependencies, envelope, correlationId, documentId);
    dependencies.logger.logOperationEvent({
      event: "preview_generation_skipped",
      correlationId,
      result: "success",
      documentId,
    });
    return { outcome: "skipped", documentId, errorCategory: null };
  }

  await deleteMessageQuietly(dependencies, envelope, correlationId, documentId);
  dependencies.logger.logOperationEvent({
    event: "preview_generation_succeeded",
    correlationId,
    result: "success",
    documentId,
  });
  return { outcome: "completed", documentId, errorCategory: null };
}

/**
 * 恒久失敗。`failed`と監査を保存してからメッセージを削除する(設計 §7.5)。
 * 専用の失敗キューは設けない。
 *
 * ここでは**処理上限のsignalを使わない**。処理上限(`processingTimeoutMs`)は
 * 「期限を過ぎてから新しい外部書き込みを始めない」ための仕組み(`processMessage`)
 * だが、恒久失敗の記録だけはその例外にする。期限切れのsignalを渡すと`failed`も
 * 監査も書けず、資料が`pending`のまま取り残されて表示が代替画像へ切り替わらない
 * (設計 §10.2)。代わりに`PREVIEW_FINALIZE_TIMEOUT_MS`の独立したsignalを張り、
 * 書き込みが visibility timeout を超えて滞留しないようにする。
 */
async function failPermanently(
  dependencies: PreviewWorkerDependencies,
  context: {
    envelope: ReceivedPreviewQueueEnvelope;
    documentId: string;
    correlationId: string;
    errorCategory: AuditErrorCategory;
  },
): Promise<PreviewWorkerResult> {
  const { envelope, documentId, correlationId, errorCategory } = context;
  let recorded: boolean;

  try {
    recorded = await dependencies.recordPreviewResult(
      {
        documentId,
        previewStatus: "failed",
        errorCategory,
        correlationId,
      },
      AbortSignal.timeout(PREVIEW_FINALIZE_TIMEOUT_MS),
    );
  } catch (error) {
    // 監査・DB更新に失敗した場合はメッセージを削除しない。再配信時は
    // `dequeueCount > maxDequeueCount`の経路で撮影せずに再度`failed`を試みる。
    const databaseCategory = classifyPreviewError(error, "database_failed");
    dependencies.logger.logOperationEvent({
      event: "preview_generation_retry_scheduled",
      correlationId,
      result: "failed",
      errorCategory: databaseCategory,
      documentId,
    });
    return {
      outcome: "retry_scheduled",
      documentId,
      errorCategory: databaseCategory,
    };
  }

  await deleteMessageQuietly(dependencies, envelope, correlationId, documentId);

  if (!recorded) {
    // 更新対象が無かった。資料が削除済みか、別の配信で既に`ready`・`failed`が
    // 確定している(`updateDocumentPreviewStatus`は`failed`を`pending`の資料にだけ
    // 書く)。撮影済みのプレビューを`failed`で塗り潰さないよう、状態も監査も
    // 変えずにメッセージだけ削除する(設計 §7.5の冪等性、§11.1)。
    dependencies.logger.logOperationEvent({
      event: "preview_generation_skipped",
      correlationId,
      result: "success",
      documentId,
    });
    return { outcome: "skipped", documentId, errorCategory: null };
  }

  dependencies.logger.logOperationEvent({
    event: "preview_generation_failed",
    correlationId,
    result: "failed",
    errorCategory,
    documentId,
  });
  return { outcome: "permanently_failed", documentId, errorCategory };
}
