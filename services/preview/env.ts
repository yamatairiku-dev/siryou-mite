/**
 * Preview Job(プレビュー生成ワーカー)の環境変数スキーマ。
 *
 * 設計: docs/APPLICATION_DESIGN.md §6.1, §7.3, §7.5
 */
import { z } from "zod";
import {
  commonEnvShape,
  formatZodError,
  validateStorageConfig,
} from "../shared/env.js";

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

    if (
      value.QUEUE_MESSAGE_PROCESSING_TIMEOUT_SECONDS >
      value.QUEUE_VISIBILITY_TIMEOUT_SECONDS
    ) {
      context.addIssue({
        code: "custom",
        path: ["QUEUE_MESSAGE_PROCESSING_TIMEOUT_SECONDS"],
        message:
          "QUEUE_MESSAGE_PROCESSING_TIMEOUT_SECONDS は QUEUE_VISIBILITY_TIMEOUT_SECONDS 以下である必要があります",
      });
    }

    if (
      value.PREVIEW_JOB_MAX_RUNTIME_SECONDS <
      value.QUEUE_MESSAGE_PROCESSING_TIMEOUT_SECONDS
    ) {
      context.addIssue({
        code: "custom",
        path: ["PREVIEW_JOB_MAX_RUNTIME_SECONDS"],
        message:
          "PREVIEW_JOB_MAX_RUNTIME_SECONDS は QUEUE_MESSAGE_PROCESSING_TIMEOUT_SECONDS 以上である必要があります",
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
