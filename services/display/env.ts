/**
 * Display(HTML表示サービス)の環境変数スキーマ。
 *
 * 設計: docs/APPLICATION_DESIGN.md §7.2, §7.3, §9.5
 */
import { z } from "zod";
import {
  commonEnvShape,
  ed25519PublicKeyPemSchema,
  formatZodError,
  originSchema,
  validateStorageConfig,
} from "../shared/env.js";

const grantVerificationKeySchema = z.object({
  keyId: z.string().trim().min(1).max(100),
  publicKey: ed25519PublicKeyPemSchema("GRANT_VERIFICATION_KEYS[].publicKey"),
});

/**
 * grant署名鍵のrotationに対応するため、`keyId`付きの公開鍵をJSON配列で受け取る
 * (設計 §9.5: 新旧鍵を`keyId`で併用する)。Displayは公開鍵だけを持つ。
 */
const grantVerificationKeysSchema = z
  .string()
  .transform((value, context) => {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      context.addIssue({
        code: "custom",
        message: "GRANT_VERIFICATION_KEYS はJSON配列である必要があります",
      });
      return z.NEVER;
    }
  })
  .pipe(z.array(grantVerificationKeySchema).min(1))
  .refine(
    (keys) => new Set(keys.map((key) => key.keyId)).size === keys.length,
    { message: "GRANT_VERIFICATION_KEYS の keyId は重複できません" },
  );

const schema = z
  .object({
    ...commonEnvShape,
    PORT: z.coerce.number().int().positive().default(8080),
    // hidden formのPOSTを受け付ける唯一の許可Origin(設計 §7.2)。
    APP_ORIGIN: originSchema(),
    GRANT_VERIFICATION_KEYS: grantVerificationKeysSchema,
    // 設計 §7.2 はgrant有効期間を60秒固定と規定するため、変更の余地は狭く保つ。
    GRANT_MAX_AGE_SECONDS: z.coerce.number().int().min(1).max(120).default(60),
    // 設計 §7.2 はPOST bodyを最大8KBと規定するため、変更の余地は狭く保つ。
    DISPLAY_MAX_POST_BODY_BYTES: z.coerce
      .number()
      .int()
      .positive()
      .max(16 * 1024)
      .default(8 * 1024),
  })
  .superRefine(validateStorageConfig);

export type DisplayEnvironment = z.infer<typeof schema>;

export function parseDisplayEnvironment(
  input: NodeJS.ProcessEnv,
): DisplayEnvironment {
  const result = schema.safeParse(input);

  if (!result.success) {
    throw new Error(
      `Display環境変数が不正です:\n${formatZodError(result.error)}`,
    );
  }

  return result.data;
}
