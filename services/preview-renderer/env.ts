/**
 * 撮影サービス(Preview Renderer)の環境変数スキーマ。
 *
 * 設計: docs/APPLICATION_DESIGN.md §6.1, §7.5
 *
 * 撮影サービスはDB・Storage・秘密値を持たないため、`commonEnvShape`を使わない。
 */
import { z } from "zod";
import { formatZodError } from "../shared/env.js";

const booleanFlag = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true");

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(8080),
  // 受け付けるHTMLの上限(設計 §6.1のアップロード上限と同じ値)。
  MAX_HTML_UPLOAD_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(10 * 1024 * 1024),
  // 1件の撮影の上限。Preview Jobの1メッセージの処理上限(既定30秒)より短くする。
  PREVIEW_RENDER_MAX_SECONDS: z.coerce.number().int().min(5).max(60).default(25),
  // dynamic sessionsでは1件撮影したら終了し、セッションを使い回さない(設計 §7.5)。
  RENDERER_EXIT_AFTER_RENDER: booleanFlag,
});

export type RendererEnvironment = z.infer<typeof schema>;

export function parseRendererEnvironment(
  input: NodeJS.ProcessEnv,
): RendererEnvironment {
  const result = schema.safeParse(input);

  if (!result.success) {
    throw new Error(
      `撮影サービスの環境変数が不正です:\n${formatZodError(result.error)}`,
    );
  }

  return result.data;
}
