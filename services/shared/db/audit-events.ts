/**
 * `audit_events`テーブルのrepository(設計 §12.2, §15.1)。
 *
 * Web(`app/lib/db/audit-events.server.ts`)・Display(閲覧監査)・Preview・
 * Maintenanceが同じ列と同じZod schemaで追記するため、実処理は
 * `services/shared/db/`へ集約する(docs/ARCHITECTURE.md)。
 *
 * 監査イベントは**追記専用**とする。このmoduleはINSERTと、監査履歴画面
 * (設計 §5.7の`/admin/audit`)が使うSELECTだけを公開し、UPDATE・DELETEを行う
 * 関数を意図的に持たない(DB側でもtriggerとrole権限で禁止している。
 * migrations/1789169486387_create-audit-events-table.sql)。
 *
 * 保存してよい項目は設計 §12.2の表だけとし、入力はZodのstrict objectで検証する。
 * HTML本文、質問・回答全文、token、表示grant、Cookie、`X-MS-CLIENT-PRINCIPAL`
 * 全文、ファイル名、IPアドレスは、型にも実装にも存在しないため保存できない。
 */
import { z } from "zod";
// `LIKE`エスケープは資料検索(設計 §5.6)と同じ実装を使う。エスケープ規則を
// 二重に持つと片方だけ直され、全件一致パターンの取りこぼしが起きるため。
import { escapeLikePattern } from "./documents.js";
import type { Queryable } from "./pool.js";

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

/**
 * 監査履歴画面(設計 §5.7, §13の`/admin/audit`)の検索。
 *
 * ここで追加するのは**SELECTだけ**で、追記専用の性質は変わらない
 * (UPDATE・DELETEを行う関数はこのmoduleに存在せず、DB側でもtriggerとrole権限で
 * 禁止している)。
 */

/** 保存済みの監査イベント1行(設計 §12.2の列と1対1に対応する)。 */
export type AuditEventSearchRecord = {
  id: string;
  occurredAt: Date;
  action: AuditAction;
  result: AuditResult;
  documentId: string | null;
  actorSubjectId: string;
  actorTenantId: string;
  /** 監査時点のメールアドレス(個人データ。管理者以外へ返さない。設計 §4.2, §12.2)。 */
  actorEmailAtEvent: string | null;
  actorGroupValues: string[] | null;
  actorRoles: string[] | null;
  correlationId: string;
  errorCategory: string | null;
};

export type AuditEventPage = {
  events: AuditEventSearchRecord[];
  /** 次ページがある場合だけ文字列。無い場合は`null`。 */
  nextCursor: string | null;
};

/** 監査履歴のcursorが壊れている・改ざんされている場合に投げる。 */
export class InvalidAuditCursorError extends Error {
  constructor() {
    super("監査履歴の続きを取得できませんでした");
    this.name = "InvalidAuditCursorError";
  }
}

const auditCursorPayloadSchema = z
  .object({
    occurredAt: z.iso.datetime({ offset: true }),
    id: z.uuid(),
  })
  .strict();

/**
 * keyset paginationのcursor。`(occurred_at, id)`だけを持ち、署名しない。
 *
 * cursorは並び順の中の位置を指すだけで、検索条件にも認可にも影響しない。
 * 監査履歴を読めるのは`requireAdmin`を通ったloaderだけで、cursorを改ざんしても
 * 認可条件(管理者であること)を迂回できない。壊れた値はZodで拒否する。
 *
 * `occurredAt`には文字列も渡せる。`timestamptz`はマイクロ秒まで保持するのに対し
 * JavaScriptの`Date`はミリ秒までしか持てず、`Date`から作ったcursorでは同じ
 * ミリ秒に発生した監査イベントを取りこぼす。そのため検索は
 * DBが返すマイクロ秒精度の文字列(`occurred_at_iso`)をそのまま使う。
 */
export function encodeAuditEventCursor(event: {
  occurredAt: Date | string;
  id: string;
}): string {
  const payload = JSON.stringify({
    occurredAt:
      event.occurredAt instanceof Date
        ? event.occurredAt.toISOString()
        : event.occurredAt,
    id: event.id,
  });
  return Buffer.from(payload, "utf8").toString("base64url");
}

export function decodeAuditEventCursor(value: string): {
  occurredAt: string;
  id: string;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new InvalidAuditCursorError();
  }

  const result = auditCursorPayloadSchema.safeParse(parsed);
  if (!result.success) {
    throw new InvalidAuditCursorError();
  }
  return result.data;
}

/**
 * 監査履歴の検索条件(設計 §5.7「日時、利用者、資料ID、操作、結果」)。
 * すべて任意で、未指定(`null`・空文字)の項目では絞り込まない。
 *
 * `action`・`result`は自由入力を受け付けず、INSERT時と同じenumだけを許す
 * (enum外の値はDBへ渡さない)。
 */
const auditSearchOptionsSchema = z
  .object({
    /** 発生日時の下限(この日時を含む)。UTCのISO日時文字列。 */
    occurredFrom: z.iso.datetime({ offset: true }).nullable().default(null),
    /** 発生日時の上限(この日時を**含まない**)。UTCのISO日時文字列。 */
    occurredTo: z.iso.datetime({ offset: true }).nullable().default(null),
    /** 利用者の内部識別子(Entraの`oid`)。完全一致。 */
    actorSubjectId: optionalAuditSearchText(200),
    /** 監査時点のメールアドレスの部分一致(大文字小文字を区別しない)。 */
    actorEmail: optionalAuditSearchText(320),
    /** 資料IDは完全一致。UUIDでない値はDBへ渡す前に弾く。 */
    documentId: z.uuid().nullable().default(null),
    action: z.enum(auditActions).nullable().default(null),
    result: z.enum(auditResults).nullable().default(null),
    /** 1ページの最大件数。全件は返さない(設計 §5.2の20件に合わせる)。 */
    limit: z.number().int().min(1).max(100).default(20),
    cursor: z.string().max(500).nullable().default(null),
  })
  .strict();

export type SearchAuditEventsOptions = z.input<typeof auditSearchOptionsSchema>;

/**
 * 検索文字列の共通スキーマ。前後の空白を除き、空文字は「未指定」として`null`へ
 * 寄せる(空文字で`%%`のような全件一致パターンを作らないため)。
 */
function optionalAuditSearchText(maxLength: number) {
  return z
    .string()
    .trim()
    .max(maxLength)
    .nullable()
    .default(null)
    .transform((value) => (value === null || value === "" ? null : value));
}

/**
 * SELECTで取得するカラム。固定文字列だけを組み立て、利用者入力は含めない。
 *
 * `occurred_at_iso`はcursor専用のマイクロ秒精度の値(`pg`が返す`Date`はミリ秒
 * までしか保持できず、同じミリ秒の監査イベントを取りこぼすため)。
 */
const auditEventColumns = `id,
       occurred_at,
       to_char(occurred_at AT TIME ZONE 'UTC',
               'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occurred_at_iso,
       action,
       result,
       document_id,
       actor_subject_id,
       actor_tenant_id,
       actor_email_at_event,
       actor_group_values,
       actor_roles,
       correlation_id,
       error_category`;

type AuditEventSearchRow = {
  id: string;
  occurred_at: Date;
  /** cursor用のマイクロ秒精度のUTC ISO日時。表示には`occurred_at`を使う。 */
  occurred_at_iso: string;
  action: string;
  result: string;
  document_id: string | null;
  actor_subject_id: string;
  actor_tenant_id: string;
  actor_email_at_event: string | null;
  actor_group_values: string[] | null;
  actor_roles: string[] | null;
  correlation_id: string;
  error_category: string | null;
};

function toAuditEventSearchRecord(
  row: AuditEventSearchRow,
): AuditEventSearchRecord {
  return {
    id: row.id,
    occurredAt: row.occurred_at,
    action: row.action as AuditAction,
    result: row.result as AuditResult,
    documentId: row.document_id,
    actorSubjectId: row.actor_subject_id,
    actorTenantId: row.actor_tenant_id,
    actorEmailAtEvent: row.actor_email_at_event,
    actorGroupValues: row.actor_group_values,
    actorRoles: row.actor_roles,
    correlationId: row.correlation_id,
    errorCategory: row.error_category,
  };
}

/**
 * 監査履歴を検索する(設計 §5.7, §4.2「監査履歴の検索・閲覧: 管理者のみ」)。
 *
 * - 認可はこの関数では行わない。呼び出し側が`requireAdmin`で`Admin`を確認済み
 *   であること(この関数は監査イベントを利用者で絞らずに返すため)。
 * - 値は必ずプレースホルダー(`$1`, `$2`, ...)で渡し、利用者入力をSQLへ連結しない。
 *   プレースホルダー番号はこの関数が採番する固定文字列である。
 * - 並び順とページングは`(occurred_at DESC, id DESC)`のkeyset paginationで、
 *   `audit_events_occurred_at_id_idx`をそのまま辿れる。
 */
export async function searchAuditEvents(
  options: SearchAuditEventsOptions,
  executor: Queryable,
): Promise<AuditEventPage> {
  const criteria = auditSearchOptionsSchema.parse(options);
  // 次ページの有無を判定するため1件多く取得する。
  const fetchLimit = criteria.limit + 1;

  const values: unknown[] = [];
  const placeholder = (value: unknown): string => {
    values.push(value);
    return `$${values.length}`;
  };

  const conditions: string[] = [];

  if (criteria.occurredFrom !== null) {
    conditions.push(
      `occurred_at >= ${placeholder(criteria.occurredFrom)}::timestamptz`,
    );
  }
  if (criteria.occurredTo !== null) {
    conditions.push(
      `occurred_at < ${placeholder(criteria.occurredTo)}::timestamptz`,
    );
  }
  if (criteria.actorSubjectId !== null) {
    conditions.push(`actor_subject_id = ${placeholder(criteria.actorSubjectId)}`);
  }
  if (criteria.actorEmail !== null) {
    conditions.push(
      `actor_email_at_event ILIKE ${placeholder(
        `%${escapeLikePattern(criteria.actorEmail)}%`,
      )} ESCAPE '\\'`,
    );
  }
  if (criteria.documentId !== null) {
    conditions.push(`document_id = ${placeholder(criteria.documentId)}::uuid`);
  }
  if (criteria.action !== null) {
    conditions.push(`action = ${placeholder(criteria.action)}`);
  }
  if (criteria.result !== null) {
    conditions.push(`result = ${placeholder(criteria.result)}`);
  }
  if (criteria.cursor !== null) {
    const position = decodeAuditEventCursor(criteria.cursor);
    conditions.push(
      `(occurred_at, id) < (${placeholder(
        position.occurredAt,
      )}::timestamptz, ${placeholder(position.id)}::uuid)`,
    );
  }

  const where =
    conditions.length === 0
      ? ""
      : `\n      WHERE ${conditions.join("\n        AND ")}`;

  const result = await executor.query<AuditEventSearchRow>(
    `SELECT ${auditEventColumns}
       FROM audit_events${where}
      ORDER BY occurred_at DESC, id DESC
      LIMIT ${placeholder(fetchLimit)}`,
    values,
  );

  const rows = result.rows.slice(0, criteria.limit);
  const hasNext = result.rows.length > criteria.limit;
  const last = rows[rows.length - 1];

  return {
    events: rows.map(toAuditEventSearchRecord),
    nextCursor:
      hasNext && last
        ? encodeAuditEventCursor({
            occurredAt: last.occurred_at_iso,
            id: last.id,
          })
        : null,
  };
}
