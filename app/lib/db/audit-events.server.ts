/**
 * `audit_events`テーブルのrepository(設計 §12.2, §15.1)。
 *
 * 監査イベントは**追記専用**とする。このmoduleはINSERTだけを公開し、
 * UPDATE・DELETEを行う関数を意図的に持たない(DB側でもtriggerとrole権限で
 * 禁止している。migrations/1789169486387_create-audit-events-table.sql)。
 *
 * 保存してよい項目は設計 §12.2の表だけとし、入力はZodのstrict objectで検証する。
 * HTML本文、質問・回答全文、token、表示grant、Cookie、`X-MS-CLIENT-PRINCIPAL`
 * 全文、ファイル名、IPアドレスは、型にも実装にも存在しないため保存できない。
 */
import { z } from "zod";
import type { Queryable } from "~/lib/db/pool.server";

/** 記録対象の操作(設計 §12.2、migrationのCHECK制約と一致させる)。 */
export const auditActions = [
  "upload",
  "view",
  "delete",
  "admin_operation",
] as const;
export type AuditAction = (typeof auditActions)[number];

/** 操作結果(設計 §15.1)。 */
export const auditResults = ["success", "denied", "failed"] as const;
export type AuditResult = (typeof auditResults)[number];

/**
 * エラー分類(設計 §14, §12.2「秘密情報を含まない分類」)。
 *
 * DBのカラムは自由記述TEXTだが、エラーメッセージや外部サービス応答がそのまま
 * 混入しないよう、repository側で固定の分類だけに閉じる。分類を追加する場合は
 * この配列へ追加する(値そのものに秘密情報・個人情報を含めないこと)。
 */
export const auditErrorCategories = [
  /** 拡張子・サイズ・UTF-8・空ファイル・パラメーター検証の失敗(設計 §10.1(4))。 */
  "validation_failed",
  /** HTML解析・安全性検査による拒否(設計 §6, §10.1(5))。 */
  "html_inspection_failed",
  /** 件数・容量上限の超過(設計 §6.1)。 */
  "quota_exceeded",
  /** 頻度・同時実行制限(設計 §6.1, §10.1(3))。 */
  "rate_limited",
  /** 未認証、principal検証失敗、tenant不一致(設計 §7.1)。 */
  "not_authenticated",
  /** App Role・所属・owner/admin条件の不足(設計 §4)。 */
  "not_authorized",
  /** 資料が存在しない、または削除済み(設計 §14)。 */
  "document_not_found",
  /** 表示grantの署名・対象・利用者の不一致(設計 §10.3)。 */
  "grant_invalid",
  /** 表示grantの期限切れ(設計 §7.2)。 */
  "grant_expired",
  /** Blobの保存・取得・削除の失敗(設計 §10.2, §10.4)。 */
  "storage_failed",
  /** Storage Queue送信の失敗(設計 §10.1(9))。 */
  "queue_failed",
  /** プレビュー生成のtimeout(設計 §7.5)。 */
  "preview_timeout",
  /** プレビュー生成の恒久失敗(設計 §7.5)。 */
  "preview_failed",
  /** DB操作の失敗(設計 §17)。 */
  "database_failed",
  /** 上記に当てはまらない想定外のエラー。 */
  "internal_error",
] as const;
export type AuditErrorCategory = (typeof auditErrorCategories)[number];

/**
 * 監査イベントの入力。`.strict()`により、設計 §12.2に無い項目
 * (ファイル名、HTML本文、token、grant、Cookie、principal header、IPアドレスなど)
 * を渡すと検証エラーになる。
 */
export const auditEventInputSchema = z
  .object({
    action: z.enum(auditActions),
    result: z.enum(auditResults),
    /** 資料を作る前に失敗した操作は資料IDを持たない(設計 §11.1)。 */
    documentId: z.uuid().nullable().default(null),
    actorSubjectId: z.string().trim().min(1).max(200),
    actorTenantId: z.string().trim().min(1).max(200),
    actorEmailAtEvent: z.email().max(320).nullable().default(null),
    actorGroupValues: z
      .array(z.string().min(1).max(200))
      .max(200)
      .nullable()
      .default(null),
    actorRoles: z
      .array(z.string().min(1).max(200))
      .max(50)
      .nullable()
      .default(null),
    correlationId: z.uuid(),
    errorCategory: z.enum(auditErrorCategories).nullable().default(null),
  })
  .strict();

export type AuditEventInput = z.input<typeof auditEventInputSchema>;

/** 保存された監査イベントのうち、呼び出し側が必要とする最小項目。 */
export type AuditEventRecord = {
  id: string;
  occurredAt: Date;
  /** 1年後の削除予定日時(設計 §16)。DBのtriggerが`occurred_at`から計算する。 */
  retainUntil: Date;
};

type AuditEventRow = {
  id: string;
  occurred_at: Date;
  retain_until: Date;
};

/**
 * 監査イベントを1件追記する。
 *
 * 業務更新と同じトランザクションで保存するため、`executor`には
 * `withTransaction`が渡す`tx`を指定する(設計 §15.1「監査保存に失敗した操作は
 * 成功させない」)。`occurred_at`はDBの`now()`だけを使い、呼び出し側から
 * 指定できないようにして、発生日時の偽装と保持期間の引き延ばしを防ぐ。
 *
 * `executor`に既定値を持たせない。既定値があると、呼び出し側が`tx`を渡し
 * 忘れても`getPool()`で動いてしまい、業務更新と監査が別トランザクションに
 * なることに気づけないため、渡し忘れを型エラーにする。
 */
export async function insertAuditEvent(
  input: AuditEventInput,
  executor: Queryable,
): Promise<AuditEventRecord> {
  const values = auditEventInputSchema.parse(input);

  const result = await executor.query<AuditEventRow>(
    `INSERT INTO audit_events (action,
                               result,
                               document_id,
                               actor_subject_id,
                               actor_tenant_id,
                               actor_email_at_event,
                               actor_group_values,
                               actor_roles,
                               correlation_id,
                               error_category,
                               occurred_at,
                               retain_until)
     -- retain_untilはBEFORE INSERT triggerが occurred_at + 1年 で上書きするため、
     -- ここではNOT NULLを満たす仮の値を渡す(設計 §16)。
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now(), now())
     RETURNING id, occurred_at, retain_until`,
    [
      values.action,
      values.result,
      values.documentId,
      values.actorSubjectId,
      values.actorTenantId,
      values.actorEmailAtEvent,
      values.actorGroupValues,
      values.actorRoles,
      values.correlationId,
      values.errorCategory,
    ],
  );

  const row = result.rows[0];
  if (!row) {
    throw new Error("監査イベントを保存できませんでした");
  }
  return {
    id: row.id,
    occurredAt: row.occurred_at,
    retainUntil: row.retain_until,
  };
}
