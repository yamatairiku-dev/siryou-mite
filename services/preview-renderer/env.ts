/**
 * 撮影サービス(Preview Renderer)の環境変数スキーマ。
 *
 * 設計: docs/APPLICATION_DESIGN.md §6.1, §7.5, §9.5
 *
 * 撮影サービスはDB・Storage・Managed Identityを持たないため、`commonEnvShape`を使わない。
 * 本番(`NODE_ENV=production`)ではTLSと共有トークンを必須にする。Preview Jobとの通信には
 * 利用者のHTMLが載るため、VNet内でも暗号化し(設計 §9.5)、呼び出し元をトークンで絞る。
 */
import { z } from "zod";
import { formatZodError } from "../shared/env.js";

/** 共有トークンの最小長。`infra/scripts/generate-renderer-tls.mjs`は43文字(32byte)を作る。 */
export const MIN_RENDERER_TOKEN_LENGTH = 32;

const optionalPem = (label: string) =>
  z
    .string()
    .trim()
    .optional()
    .transform((value) => (value === "" ? undefined : value))
    .refine((value) => value === undefined || value.includes(`-----BEGIN ${label}`), {
      message: `PEM形式(${label})である必要があります`,
    });

const schema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().positive().default(8080),
    // 受け付けるHTMLの上限(設計 §6.1のアップロード上限と同じ値)。
    MAX_HTML_UPLOAD_BYTES: z.coerce
      .number()
      .int()
      .positive()
      .default(10 * 1024 * 1024),
    // 1件の撮影の上限。Preview Jobの1メッセージの処理上限(既定30秒)より短くする。
    PREVIEW_RENDER_MAX_SECONDS: z.coerce.number().int().min(5).max(60).default(25),
    // TLSの証明書と秘密鍵(PEM)。両方を指定するとHTTPSで待ち受ける。
    RENDERER_TLS_CERT: optionalPem("CERTIFICATE"),
    RENDERER_TLS_KEY: optionalPem("PRIVATE KEY"),
    // Preview Jobとの共有トークン。指定すると`POST /render`に`Authorization: Bearer`を求める。
    RENDERER_AUTH_TOKEN: z
      .string()
      .optional()
      .transform((value) => (value === "" ? undefined : value))
      .refine(
        (value) => value === undefined || value.length >= MIN_RENDERER_TOKEN_LENGTH,
        { message: `${MIN_RENDERER_TOKEN_LENGTH}文字以上である必要があります` },
      ),
  })
  .superRefine((value, context) => {
    if ((value.RENDERER_TLS_CERT === undefined) !== (value.RENDERER_TLS_KEY === undefined)) {
      context.addIssue({
        code: "custom",
        path: ["RENDERER_TLS_KEY"],
        message: "RENDERER_TLS_CERT と RENDERER_TLS_KEY は両方を指定する必要があります",
      });
    }
    if (value.NODE_ENV === "production") {
      if (value.RENDERER_TLS_CERT === undefined) {
        context.addIssue({
          code: "custom",
          path: ["RENDERER_TLS_CERT"],
          message: "本番環境では RENDERER_TLS_CERT と RENDERER_TLS_KEY が必須です",
        });
      }
      if (value.RENDERER_AUTH_TOKEN === undefined) {
        context.addIssue({
          code: "custom",
          path: ["RENDERER_AUTH_TOKEN"],
          message: "本番環境では RENDERER_AUTH_TOKEN が必須です",
        });
      }
    }
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
