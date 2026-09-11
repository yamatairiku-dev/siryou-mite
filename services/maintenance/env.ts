/**
 * Maintenance Job(定期保守ジョブ)の環境変数スキーマ。
 *
 * 設計: docs/APPLICATION_DESIGN.md §7.3, §7.4, §7.7
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
  })
  .superRefine(validateStorageConfig);

export type MaintenanceEnvironment = z.infer<typeof schema>;

export function parseMaintenanceEnvironment(
  input: NodeJS.ProcessEnv,
): MaintenanceEnvironment {
  const result = schema.safeParse(input);

  if (!result.success) {
    throw new Error(
      `Maintenance環境変数が不正です:\n${formatZodError(result.error)}`,
    );
  }

  return result.data;
}
