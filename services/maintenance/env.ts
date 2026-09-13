/**
 * Maintenance Job(定期保守ジョブ)の環境変数スキーマ。
 *
 * 設計: docs/APPLICATION_DESIGN.md §7.3, §7.4, §7.7, §16
 *
 * 保持期間(1年)そのものは環境変数にしない。設計 §16が定める値であり、監査側は
 * DBの`retain_until`が正本のため、環境変数で短くできると設計と食い違う
 * (`services/shared/db/maintenance.ts`の`METADATA_RETENTION_INTERVAL`を参照)。
 * ここで設定できるのは実行上限・バッチ件数・孤児Blobの猶予・`upload_attempts`の
 * 保持期間だけとする。
 *
 * DB接続(`DATABASE_URL`)は保守Job専用のDB role(`siryou_mite_maintenance`)で
 * 接続する前提。role・権限はmigration側で定義する
 * (migrations/1789280690379_add-maintenance-role-and-purge-support.sql)。
 */
import { z } from "zod";
import {
  commonEnvShape,
  formatZodError,
  validateStorageConfig,
} from "../shared/env.js";

/** 1日1回の実行で処理しきれる範囲に収めるためのJob実行上限の既定値(秒)。 */
export const DEFAULT_MAINTENANCE_JOB_MAX_RUNTIME_SECONDS = 900;

const schema = z
  .object({
    ...commonEnvShape,
    /**
     * Job全体の実行上限(秒)。超えた時点で新しいバッチを始めず、実行中の処理を
     * 終えてから終了する。残りは翌日の実行が続きから処理する(すべて冪等)。
     */
    MAINTENANCE_JOB_MAX_RUNTIME_SECONDS: z.coerce
      .number()
      .int()
      .positive()
      .max(6 * 3_600)
      .default(DEFAULT_MAINTENANCE_JOB_MAX_RUNTIME_SECONDS),
    /** DBの抽出・削除1回あたりの件数。大量データでもメモリを使い切らないため。 */
    MAINTENANCE_BATCH_SIZE: z.coerce
      .number()
      .int()
      .min(1)
      .max(5_000)
      .default(500),
    /** Blob一覧1ページあたりの件数。 */
    MAINTENANCE_BLOB_LIST_PAGE_SIZE: z.coerce
      .number()
      .int()
      .min(1)
      .max(1_000)
      .default(200),
    /**
     * 孤児Blobと判定するまでの猶予(時間)。
     *
     * アップロードはBlob保存→DB登録の順(設計 §10.1)のため、保存直後の一瞬は
     * 「DBに行が無いBlob」が正常に存在する。取り返しのつかない削除なので、
     * 最終更新から十分に時間が経ったBlobだけを対象にする(最小1時間)。
     */
    MAINTENANCE_ORPHAN_BLOB_GRACE_HOURS: z.coerce
      .number()
      .int()
      .min(1)
      .max(30 * 24)
      .default(24),
    /**
     * `upload_attempts`の保持期間(日)。頻度判定の窓(1分)・lease(120秒)より
     * 十分長い値にする(Q-011)。
     */
    MAINTENANCE_UPLOAD_ATTEMPT_RETENTION_DAYS: z.coerce
      .number()
      .int()
      .min(1)
      .max(365)
      .default(7),
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
