/**
 * Migration Jobの環境変数スキーマ。
 *
 * 設計: docs/APPLICATION_DESIGN.md §7.4, §7.6
 */
import { z } from "zod";
import {
  databaseAuthSchema,
  databaseUrlSchema,
  formatZodError,
  nodeEnvSchema,
  validateDatabaseConfig,
} from "../shared/env.js";

const schema = z
  .object({
    NODE_ENV: nodeEnvSchema,
    DATABASE_URL: databaseUrlSchema,
    DATABASE_AUTH: databaseAuthSchema,
  })
  .superRefine(validateDatabaseConfig);

export type MigrateEnvironment = z.infer<typeof schema>;

export function parseMigrateEnvironment(
  input: NodeJS.ProcessEnv,
): MigrateEnvironment {
  const result = schema.safeParse(input);

  if (!result.success) {
    throw new Error(
      `Migration Job環境変数が不正です:\n${formatZodError(result.error)}`,
    );
  }

  return result.data;
}
