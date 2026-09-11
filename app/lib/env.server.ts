// services/shared/env.ts と一部の検証ロジックが重複する。`services/`配下は`app/`を
// importしない方針(docs/ARCHITECTURE.md)のため、意図した重複として個別に保守する。
import { createPrivateKey } from "node:crypto";
import { z } from "zod";

const optionalNonEmptyString = z
  .string()
  .trim()
  .optional()
  .transform((value) => value || undefined);

/**
 * origin(scheme://host[:port])だけを許可し、パス・クエリ・フラグメントを含む値や
 * 末尾スラッシュを拒否する。Display・Web間のOrigin一致判定で事故らないよう、
 * 値は`URL#origin`で正規化する(設計 §7.2)。
 */
function originSchema() {
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
 * base64文字列として復号でき、かつ指定byte数以上であることを検証する。
 * 値そのものはエラーメッセージへ含めない(設計 §9.5 のログ非記録方針に合わせる)。
 */
function base64KeySchema(label: string, minBytes: number) {
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
 * PEM形式かつEd25519の秘密鍵であることをNode.jsの`crypto`で検証する。
 * 鍵の値そのものはエラーメッセージへ含めない。
 */
function ed25519PrivateKeyPemSchema(label: string) {
  return z.string().superRefine((value, context) => {
    if (!/-----BEGIN PRIVATE KEY-----/.test(value)) {
      context.addIssue({
        code: "custom",
        message: `${label} はPEM形式のEd25519秘密鍵(PRIVATE KEY)である必要があります`,
      });
      return;
    }

    try {
      const keyObject = createPrivateKey({ key: value, format: "pem" });
      if (keyObject.asymmetricKeyType !== "ed25519") {
        context.addIssue({
          code: "custom",
          message: `${label} はEd25519秘密鍵である必要があります`,
        });
      }
    } catch {
      context.addIssue({
        code: "custom",
        message: `${label} はPEM形式のEd25519秘密鍵である必要があります`,
      });
    }
  });
}

/**
 * 空文字("")は未設定として扱う。`.env`のplaceholder(`KEY=`)をそのまま使っても
 * 「未指定」と解釈できるようにするため(判定側は`Boolean(value)`で存在確認する)。
 */
function emptyStringToUndefined(value: unknown): unknown {
  return typeof value === "string" && value.trim() === "" ? undefined : value;
}

const storageAccountNameSchema = z.preprocess(
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

const storageConnectionStringSchema = z.preprocess(
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

const schema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    PORT: z.coerce.number().int().positive().default(3000),
    APP_NAME: z.string().trim().min(1).default("社内Webアプリ"),
    APP_ORIGIN: originSchema().default("http://localhost:3000"),
    AUTH_MODE: z.enum(["dev", "easyauth"]).default("dev"),
    SESSION_SECRET: z.string().min(32).optional(),
    SESSION_MAX_AGE_SECONDS: z.coerce
      .number()
      .int()
      .min(300)
      .max(86400)
      .default(28800),
    ENTRA_TENANT_ID: optionalNonEmptyString,

    // データベース(設計 §7.4)。Managed Identityのaccess tokenをpasswordとして
    // 使う場合でも、host・port・dbname・利用者名を含む接続文字列として扱う。
    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),

    // HTML表示サービスのオリジン(設計 §7.2)。hidden formのPOST先として使う。
    DISPLAY_ORIGIN: originSchema(),

    // Blob/Queueへの接続設定(設計 §7.3)。ローカル・開発は接続文字列、
    // 本番はManaged Identityでaccount URLを組み立てる(接続文字列は使わない)。
    AZURE_STORAGE_CONNECTION_STRING: storageConnectionStringSchema,
    AZURE_STORAGE_ACCOUNT_NAME: storageAccountNameSchema,
    AZURE_STORAGE_CONTAINER: z.string().trim().min(1).default("documents"),
    AZURE_STORAGE_QUEUE_NAME: z
      .string()
      .trim()
      .min(1)
      .default("preview-generation"),

    // 表示grant署名鍵(設計 §7.2, §9.5)。WebはEd25519秘密鍵と`keyId`だけを持つ。
    GRANT_SIGNING_KEY_ID: z.string().trim().min(1).max(100),
    GRANT_SIGNING_PRIVATE_KEY: ed25519PrivateKeyPemSchema(
      "GRANT_SIGNING_PRIVATE_KEY",
    ),
    // 設計 §7.2 はgrant有効期間を60秒固定と規定するため、変更の余地は狭く保つ。
    GRANT_TTL_SECONDS: z.coerce.number().int().min(1).max(120).default(60),

    // ログへ記録するID等を可逆でなくpseudonymize化するためのHMAC鍵(設計 §9.5)。
    LOG_HMAC_KEY: base64KeySchema("LOG_HMAC_KEY", 32),

    // アップロード制限値(設計 §6.1)。既定値は設計の規定値と一致させる。
    MAX_HTML_UPLOAD_BYTES: z.coerce
      .number()
      .int()
      .positive()
      .default(10 * 1024 * 1024),
    MAX_ACTIVE_DOCUMENTS_PER_USER: z.coerce
      .number()
      .int()
      .positive()
      .default(100),
    MAX_TOTAL_HTML_BYTES_PER_USER: z.coerce
      .number()
      .int()
      .positive()
      .default(500 * 1024 * 1024),
    MAX_TOTAL_HTML_BYTES_SYSTEM: z.coerce
      .number()
      .int()
      .positive()
      .default(50 * 1024 * 1024 * 1024),
    SYSTEM_HTML_BYTES_WARNING_THRESHOLD: z.coerce
      .number()
      .int()
      .positive()
      .default(40 * 1024 * 1024 * 1024),
    UPLOAD_RATE_LIMIT_PER_MINUTE: z.coerce
      .number()
      .int()
      .min(1)
      .max(1000)
      .default(5),
    MAX_CONCURRENT_UPLOADS_PER_USER: z.coerce
      .number()
      .int()
      .min(1)
      .max(10)
      .default(1),
  })
  .superRefine((value, context) => {
    if (value.NODE_ENV === "production" && value.AUTH_MODE !== "easyauth") {
      context.addIssue({
        code: "custom",
        path: ["AUTH_MODE"],
        message: "本番環境では AUTH_MODE=easyauth が必須です",
      });
    }

    if (value.AUTH_MODE === "easyauth" && !value.ENTRA_TENANT_ID) {
      context.addIssue({
        code: "custom",
        path: ["ENTRA_TENANT_ID"],
        message: "ENTRA_TENANT_ID は AUTH_MODE=easyauth のとき必須です",
      });
    }

    if (value.AUTH_MODE === "dev" && !value.SESSION_SECRET) {
      context.addIssue({
        code: "custom",
        path: ["SESSION_SECRET"],
        message: "SESSION_SECRET は AUTH_MODE=dev のとき必須です",
      });
    }

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

    if (
      value.SYSTEM_HTML_BYTES_WARNING_THRESHOLD >
      value.MAX_TOTAL_HTML_BYTES_SYSTEM
    ) {
      context.addIssue({
        code: "custom",
        path: ["SYSTEM_HTML_BYTES_WARNING_THRESHOLD"],
        message:
          "SYSTEM_HTML_BYTES_WARNING_THRESHOLD は MAX_TOTAL_HTML_BYTES_SYSTEM 以下である必要があります",
      });
    }
  });

export function parseEnvironment(input: NodeJS.ProcessEnv) {
  const result = schema.safeParse(input);

  if (!result.success) {
    const message = result.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`環境変数が不正です:\n${message}`);
  }

  return result.data;
}

export const env = parseEnvironment(process.env);
