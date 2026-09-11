/**
 * Display / Preview / Maintenance が共有する環境変数のZodヘルパー。
 *
 * 設計: docs/APPLICATION_DESIGN.md §6.1, §7.3, §7.4, §9.5
 *
 * `services/` 配下は `app/` をimportしない方針(docs/ARCHITECTURE.md)のため、
 * Web用の `app/lib/env.server.ts` とは独立してここへ検証ロジックを定義する。
 * 各サービスの `env.ts` はここから必要な部品を読み込んで固有のschemaを組み立てる。
 * `app/lib/env.server.ts` にも同種の検証ロジックが重複しているが、`app/` をimport
 * できない制約(`tsconfig.services.json` の `rootDir: services`)による意図した重複。
 */
import { createPublicKey } from "node:crypto";
import { z } from "zod";

export const nodeEnvSchema = z
  .enum(["development", "test", "production"])
  .default("development");

export type NodeEnvValue = z.infer<typeof nodeEnvSchema>;

/**
 * base64文字列として復号でき、かつ指定byte数以上であることを検証する。
 * 値そのものはエラーメッセージへ含めない(設計 §9.5 のログ非記録方針に合わせる)。
 */
export function base64KeySchema(label: string, minBytes: number) {
  return z.string().superRefine((value, context) => {
    const trimmed = value.trim();

    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed) || trimmed.length === 0) {
      context.addIssue({
        code: "custom",
        message: `${label} はbase64形式で指定してください`,
      });
      return;
    }

    if (Buffer.from(trimmed, "base64").length < minBytes) {
      context.addIssue({
        code: "custom",
        message: `${label} はbase64で${minBytes}byte以上である必要があります`,
      });
    }
  });
}

/**
 * PEM形式かつEd25519の公開鍵であることをNode.jsの`crypto`で検証する。
 * Displayはgrant検証用の公開鍵だけを持つ(設計 §9.5)。
 *
 * Node.jsの`createPublicKey`は秘密鍵PEMを渡しても対応する公開鍵を導出して
 * 成功してしまうため、秘密鍵の誤設定を検知できるようPEMヘッダーも検証する。
 */
export function ed25519PublicKeyPemSchema(label: string) {
  return z.string().superRefine((value, context) => {
    if (!/-----BEGIN PUBLIC KEY-----/.test(value)) {
      context.addIssue({
        code: "custom",
        message: `${label} はPEM形式のEd25519公開鍵(PUBLIC KEY)である必要があります`,
      });
      return;
    }

    try {
      const keyObject = createPublicKey({ key: value, format: "pem" });
      if (keyObject.asymmetricKeyType !== "ed25519") {
        context.addIssue({
          code: "custom",
          message: `${label} はEd25519公開鍵である必要があります`,
        });
      }
    } catch {
      context.addIssue({
        code: "custom",
        message: `${label} はPEM形式のEd25519公開鍵である必要があります`,
      });
    }
  });
}

export const databaseUrlSchema = z.url({ protocol: /^postgres(ql)?$/ });

/**
 * origin(scheme://host[:port])だけを許可し、パス・クエリ・フラグメントを含む値や
 * 末尾スラッシュを拒否する。Displayの`APP_ORIGIN`(許可Origin)一致判定で
 * 事故らないよう、値は`URL#origin`で正規化する(設計 §7.2)。
 */
export function originSchema() {
  return z
    .string()
    .superRefine((value, context) => {
      let url: URL;

      try {
        url = new URL(value);
      } catch {
        context.addIssue({
          code: "custom",
          message: "originはscheme://host[:port]形式のURLで指定してください",
        });
        return;
      }

      if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
        context.addIssue({
          code: "custom",
          message:
            "originにはscheme・host・port以外(パス・クエリ・フラグメント)を含めないでください",
        });
      }
    })
    .transform((value) => new URL(value).origin);
}

/**
 * 空文字("")は未設定として扱う。`.env`のplaceholder(`KEY=`)をそのまま使っても
 * 「未指定」と解釈できるようにするため(判定側は`Boolean(value)`で存在確認する)。
 */
function emptyStringToUndefined(value: unknown): unknown {
  return typeof value === "string" && value.trim() === "" ? undefined : value;
}

export const storageAccountNameSchema = z.preprocess(
  emptyStringToUndefined,
  z
    .string()
    .trim()
    .regex(/^[a-z0-9]{3,24}$/, {
      message:
        "AZURE_STORAGE_ACCOUNT_NAME は小文字英数字3〜24文字である必要があります",
    })
    .optional(),
);

export const storageConnectionStringSchema = z.preprocess(
  emptyStringToUndefined,
  z
    .string()
    .trim()
    .min(1)
    .refine(
      (value) =>
        /AccountName=/.test(value) ||
        /UseDevelopmentStorage=true/i.test(value),
      {
        message: "AZURE_STORAGE_CONNECTION_STRING の形式が不正です",
      },
    )
    .optional(),
);

const storageContainerSchema = z
  .string()
  .trim()
  .min(1)
  .default("documents");

/**
 * Blob Storageへの接続設定(設計 §7.3)。ローカル・開発は接続文字列、
 * 本番はManaged Identityでaccount URLを組み立てるため接続文字列を禁止する。
 * `commonEnvShape` を使う各サービスのschemaは、この関数を`superRefine`から呼ぶ。
 */
export function validateStorageConfig(
  value: {
    NODE_ENV: NodeEnvValue;
    AZURE_STORAGE_CONNECTION_STRING?: string | undefined;
    AZURE_STORAGE_ACCOUNT_NAME?: string | undefined;
  },
  context: z.RefinementCtx,
): void {
  const hasConnectionString = Boolean(value.AZURE_STORAGE_CONNECTION_STRING);
  const hasAccountName = Boolean(value.AZURE_STORAGE_ACCOUNT_NAME);

  if (hasConnectionString && hasAccountName) {
    context.addIssue({
      code: "custom",
      path: ["AZURE_STORAGE_ACCOUNT_NAME"],
      message:
        "AZURE_STORAGE_CONNECTION_STRING と AZURE_STORAGE_ACCOUNT_NAME は同時に指定できません",
    });
  } else if (!hasConnectionString && !hasAccountName) {
    context.addIssue({
      code: "custom",
      path: ["AZURE_STORAGE_ACCOUNT_NAME"],
      message:
        "AZURE_STORAGE_CONNECTION_STRING または AZURE_STORAGE_ACCOUNT_NAME が必要です",
    });
  }

  if (value.NODE_ENV === "production" && hasConnectionString) {
    context.addIssue({
      code: "custom",
      path: ["AZURE_STORAGE_CONNECTION_STRING"],
      message:
        "本番環境では AZURE_STORAGE_CONNECTION_STRING を使用できません(Managed Identityを使用してください)",
    });
  }
}

/**
 * Display / Preview / Maintenance が共通で必要とする環境変数のshape。
 * `z.object({ ...commonEnvShape, ... })` で各サービス固有の項目と合成する。
 */
export const commonEnvShape = {
  NODE_ENV: nodeEnvSchema,
  DATABASE_URL: databaseUrlSchema,
  AZURE_STORAGE_CONNECTION_STRING: storageConnectionStringSchema,
  AZURE_STORAGE_ACCOUNT_NAME: storageAccountNameSchema,
  AZURE_STORAGE_CONTAINER: storageContainerSchema,
  LOG_HMAC_KEY: base64KeySchema("LOG_HMAC_KEY", 32),
};

export function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    .join("\n");
}
