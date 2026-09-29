/**
 * Preview Job(プレビュー生成ワーカー)の環境変数スキーマ。
 *
 * 設計: docs/APPLICATION_DESIGN.md §6.1, §7.3, §7.5
 */
import { z } from "zod";
import { poolSettings } from "../shared/db/pool.js";
import {
  commonEnvShape,
  formatZodError,
  validateStorageConfig,
} from "../shared/env.js";
import { PREVIEW_FINALIZE_TIMEOUT_MS } from "./worker.js";

/**
 * 処理上限を使い切った実行でも、恒久失敗(`failed`と監査)を書き切ってからJobを
 * 終える必要がある(設計 §7.5)。その書き込みに見込む秒数。
 *
 * DBへの書き込みは`AbortSignal`では中断できないため、実際の上限はpoolの
 * `query_timeout`(12秒)で、`PREVIEW_FINALIZE_TIMEOUT_MS`(10秒)が効くのはBlob・
 * Queue操作の側になる。安全側に倒して大きい方を採用する。後続のメッセージ削除は
 * 失敗しても再配信で冪等にやり直せるため、この見込みには含めない。
 */
export const PREVIEW_FINALIZE_BUDGET_SECONDS = Math.ceil(
  Math.max(PREVIEW_FINALIZE_TIMEOUT_MS, poolSettings.queryTimeoutMillis) / 1_000,
);

const schema = z
  .object({
    ...commonEnvShape,
    AZURE_STORAGE_QUEUE_NAME: z
      .string()
      .trim()
      .min(1)
      .default("preview-generation"),
    // Queueメッセージのvisibility timeout(設計 §7.5)。
    QUEUE_VISIBILITY_TIMEOUT_SECONDS: z.coerce
      .number()
      .int()
      .positive()
      .max(3600)
      .default(60),
    // 1メッセージの処理上限(設計 §7.5)。
    QUEUE_MESSAGE_PROCESSING_TIMEOUT_SECONDS: z.coerce
      .number()
      .int()
      .positive()
      .default(30),
    // Job実行上限(設計 §7.5)。1実行で1メッセージだけを処理する。
    PREVIEW_JOB_MAX_RUNTIME_SECONDS: z.coerce
      .number()
      .int()
      .positive()
      .default(45),
    // `dequeueCount`で判定する最大試行回数(設計 §7.5)。
    QUEUE_MAX_DEQUEUE_COUNT: z.coerce.number().int().min(1).max(10).default(3),
    // プレビュー画像1件あたりの上限(設計 §6.1)。超える場合は`failed`にする。
    MAX_PREVIEW_IMAGE_BYTES: z.coerce
      .number()
      .int()
      .positive()
      .default(1 * 1024 * 1024),
  })
  .superRefine((value, context) => {
    validateStorageConfig(value, context);

    // 処理上限そのものではなく、「処理上限 + 後始末」がvisibility timeoutと
    // Job実行上限に収まることを検証する(設計 §7.5)。等号を許して
    // 処理上限 = visibility timeout にすると、popReceiptが失効したあとに恒久失敗の
    // 書き込みが走り、同じメッセージが別の実行へ再配信される窓が開く。
    const requiredSeconds =
      value.QUEUE_MESSAGE_PROCESSING_TIMEOUT_SECONDS +
      PREVIEW_FINALIZE_BUDGET_SECONDS;

    if (requiredSeconds > value.QUEUE_VISIBILITY_TIMEOUT_SECONDS) {
      context.addIssue({
        code: "custom",
        path: ["QUEUE_MESSAGE_PROCESSING_TIMEOUT_SECONDS"],
        message: `QUEUE_MESSAGE_PROCESSING_TIMEOUT_SECONDS + ${PREVIEW_FINALIZE_BUDGET_SECONDS}秒(恒久失敗の記録)は QUEUE_VISIBILITY_TIMEOUT_SECONDS 以下である必要があります`,
      });
    }

    if (requiredSeconds > value.PREVIEW_JOB_MAX_RUNTIME_SECONDS) {
      context.addIssue({
        code: "custom",
        path: ["PREVIEW_JOB_MAX_RUNTIME_SECONDS"],
        message: `PREVIEW_JOB_MAX_RUNTIME_SECONDS は QUEUE_MESSAGE_PROCESSING_TIMEOUT_SECONDS + ${PREVIEW_FINALIZE_BUDGET_SECONDS}秒(恒久失敗の記録)以上である必要があります`,
      });
    }
  });

export type PreviewEnvironment = z.infer<typeof schema>;

export function parsePreviewEnvironment(
  input: NodeJS.ProcessEnv,
): PreviewEnvironment {
  const result = schema.safeParse(input);

  if (!result.success) {
    throw new Error(
      `Preview環境変数が不正です:\n${formatZodError(result.error)}`,
    );
  }

  return result.data;
}
