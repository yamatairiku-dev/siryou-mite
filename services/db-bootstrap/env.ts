/**
 * DB初期設定Job(db-bootstrap)の環境変数スキーマ。
 *
 * 設計: docs/APPLICATION_DESIGN.md §7.4
 */
import { z } from "zod";
import {
  databaseAuthSchema,
  databaseUrlSchema,
  formatZodError,
  nodeEnvSchema,
  validateDatabaseConfig,
} from "../shared/env.js";

/** PostgreSQLの識別子として扱うManaged Identity名・DB名の許容文字(SQLへ埋め込む前の制限)。 */
const identifierNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/, "使用できない文字を含む名前です");

export const principalRoles = ["runtime", "maintenance", "migration"] as const;

export type PrincipalRole = (typeof principalRoles)[number];

const principalSchema = z.object({
  /** PostgreSQL上のrole名。Managed Identityのリソース名と一致させる。 */
  name: identifierNameSchema,
  /** Managed Identityのprincipal(object) ID。 */
  objectId: z.uuid(),
  role: z.enum(principalRoles),
});

export type BootstrapPrincipal = z.infer<typeof principalSchema>;

const principalsSchema = z
  .string()
  .transform((value, context) => {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      context.addIssue({
        code: "custom",
        message: "DB_BOOTSTRAP_PRINCIPALS はJSON配列である必要があります",
      });
      return z.NEVER;
    }
  })
  .pipe(z.array(principalSchema).min(1))
  .refine(
    (principals) =>
      new Set(principals.map((principal) => principal.name)).size ===
      principals.length,
    { message: "DB_BOOTSTRAP_PRINCIPALS の name は重複できません" },
  )
  .refine(
    (principals) =>
      principals.filter((principal) => principal.role === "migration").length === 1,
    { message: "DB_BOOTSTRAP_PRINCIPALS には role=migration がちょうど1つ必要です" },
  );

const schema = z
  .object({
    NODE_ENV: nodeEnvSchema,
    /** 業務DBへの接続文字列。利用者名はPostgreSQLのEntra管理者(このJobのManaged Identity)。 */
    DATABASE_URL: databaseUrlSchema,
    DATABASE_AUTH: databaseAuthSchema,
    /** Entra principalを作る管理用DB。Azure Database for PostgreSQLでは`postgres`。 */
    DB_BOOTSTRAP_ADMIN_DATABASE: identifierNameSchema.default("postgres"),
    DB_BOOTSTRAP_PRINCIPALS: principalsSchema,
  })
  .superRefine((value, context) => {
    validateDatabaseConfig(value, context);

    let databaseName = "";
    try {
      databaseName = decodeURIComponent(new URL(value.DATABASE_URL).pathname.slice(1));
    } catch {
      return; // 形式不正は`databaseUrlSchema`が報告する。
    }
    if (!identifierNameSchema.safeParse(databaseName).success) {
      context.addIssue({
        code: "custom",
        path: ["DATABASE_URL"],
        message: "DATABASE_URL のDB名が不正です",
      });
    }
  });

export type DbBootstrapEnvironment = z.infer<typeof schema>;

export function parseDbBootstrapEnvironment(
  input: NodeJS.ProcessEnv,
): DbBootstrapEnvironment {
  const result = schema.safeParse(input);

  if (!result.success) {
    throw new Error(
      `DB初期設定Job環境変数が不正です:\n${formatZodError(result.error)}`,
    );
  }

  return result.data;
}
