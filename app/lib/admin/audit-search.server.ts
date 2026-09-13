/**
 * 監査履歴の検索(設計 §5.7, §4.2, §13の`/admin/audit`)。
 *
 * - 認可はこのserver側でだけ決まる。`requireAdmin`で`Admin`ロールを確認してから
 *   でないと監査履歴のSELECTを1回も実行しない(UIの非表示を認可にしない。
 *   設計 §4.2、AGENTS.md 5項)。監査履歴には他人のメールアドレス・所属・ロールが
 *   含まれるため、一般利用者の要求はDBへ届かせない。
 * - 検索条件(日時・利用者・資料ID・操作・結果)はすべて任意で、Zodで検証してから
 *   repositoryへ渡す(AGENTS.md 6項)。`action`・`result`は監査保存時と同じenumに
 *   限り、enum外の値はDBへ渡さず400で拒否する。
 * - 日時の入力は画面と同じ日本時間(設計 §5.2)として解釈し、UTCのISO日時へ
 *   変換してからrepositoryへ渡す(DBはUTC)。
 * - **監査履歴の閲覧自体を監査する**(設計 §5.7, §15.1「管理者による監査履歴閲覧も
 *   記録」)。検索と監査保存は同じDBトランザクションで行い、監査保存に失敗した
 *   検索結果は画面へ返さない(設計 §15.1)。
 * - 検索条件・検索結果(メールアドレス、所属、ロール)は運用ログへ出さない
 *   (設計 §15.2)。画面へ返すのは`Admin`確認済みの応答だけ。
 * - CSV出力・詳細分析機能は設けない(設計 §5.7)。このmoduleは1ページ分の
 *   読み取りだけを公開し、全件取得の関数を持たない。
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  jstMinuteSchema,
  jstMinuteToUtcIso,
  optionalCriterion,
  readSearchCriteria,
} from "~/lib/admin/search-criteria.server";
import { requireAdmin } from "~/lib/auth/authorization.server";
import {
  auditActions,
  auditResults,
  insertAuditEvent,
  InvalidAuditCursorError,
  searchAuditEvents,
  type AuditAction,
  type AuditEventInput,
  type AuditEventPage,
  type AuditResult,
  type SearchAuditEventsOptions,
} from "~/lib/db/audit-events.server";
import { withTransaction, type Queryable } from "~/lib/db/pool.server";
import { logOperationEvent } from "~/lib/log.server";
import { securityHeaders } from "~/lib/security.server";

/**
 * 監査の`action`(設計 §12.2)。監査履歴画面での検索・閲覧は管理操作として
 * `admin_operation`で記録する(QUESTIONS Q-034。`admin_operation`は管理画面の
 * 検索と監査履歴閲覧を指す)。
 */
const AUDIT_SEARCH_AUDIT_ACTION: AuditAction = "admin_operation";

/** ログの処理名(設計 §15.2)。固定文字列だけを使う。 */
const AUDIT_SEARCH_LOG_EVENT = "admin_audit_search";

/** 1ページの件数。全件は返さない(設計 §5.2・T16の管理画面と同じ20件)。 */
export const AUDIT_SEARCH_PAGE_SIZE = 20;

/** 画面から受け取る検索条件の名前(schemaのkeyと一致させる)。 */
const criteriaNames = [
  "occurredFrom",
  "occurredTo",
  "actorSubjectId",
  "actorEmail",
  "documentId",
  "action",
  "result",
  "cursor",
] as const;

/**
 * URLのクエリ文字列から受け取る検索条件。すべて任意で、空文字は「絞り込まない」。
 * 長すぎる値・UUIDでない資料ID・不正な日時・enum外の操作/結果はここで弾き、
 * DBへ渡さない。
 */
const searchCriteriaSchema = z
  .object({
    occurredFrom: optionalCriterion(jstMinuteSchema),
    occurredTo: optionalCriterion(jstMinuteSchema),
    /** 利用者の内部識別子(Entraの`oid`)。完全一致。 */
    actorSubjectId: optionalCriterion(z.string().min(1).max(200)),
    /** 監査時点のメールアドレスの部分一致。 */
    actorEmail: optionalCriterion(z.string().min(1).max(320)),
    documentId: optionalCriterion(z.uuid()),
    action: optionalCriterion(z.enum(auditActions)),
    result: optionalCriterion(z.enum(auditResults)),
    cursor: optionalCriterion(z.string().min(1).max(500)),
  })
  .strict();

/** 画面へ返す検索条件(入力欄の再表示に使う。管理者自身が入力した値)。 */
export type AdminAuditSearchCriteria = z.infer<typeof searchCriteriaSchema>;

/**
 * 監査履歴の1行の表示用DTO(設計 §12.2の列)。
 *
 * メールアドレス・所属・ロールは個人データだが、監査履歴画面は管理者だけが
 * 使えるため表示してよい(設計 §4.2, §5.7)。運用ログ(stdout)へは出さない
 * (設計 §15.2)。
 */
export type AdminAuditEventRow = {
  id: string;
  occurredAt: Date;
  action: AuditAction;
  result: AuditResult;
  documentId: string | null;
  actorSubjectId: string;
  actorEmail: string | null;
  actorGroupValues: string[];
  actorRoles: string[];
  correlationId: string;
  errorCategory: string | null;
};

export type AdminAuditSearchData = {
  criteria: AdminAuditSearchCriteria;
  page: { events: AdminAuditEventRow[]; nextCursor: string | null };
};

/**
 * 外部への依存。既定は実装本体で、テストからだけ差し替える
 * (トランザクション境界と検索条件の受け渡しをそのまま検証できるようにするため)。
 */
export type AdminAuditSearchDependencies = {
  withTransaction<T>(run: (tx: Queryable) => Promise<T>): Promise<T>;
  searchAuditEvents(
    options: SearchAuditEventsOptions,
    tx: Queryable,
  ): Promise<AuditEventPage>;
  insertAuditEvent(input: AuditEventInput, tx: Queryable): Promise<unknown>;
};

export const defaultAdminAuditSearchDependencies: AdminAuditSearchDependencies =
  {
    withTransaction: (run) => withTransaction(run),
    searchAuditEvents: (options, tx) => searchAuditEvents(options, tx),
    insertAuditEvent,
  };

/** メールアドレス形式でないclaim(UPNなど)は保存しない(QUESTIONS Q-016, Q-020)。 */
function normalizeEmail(value: string): string | null {
  const result = z.email().max(320).safeParse(value.trim());
  return result.success ? result.data : null;
}

/**
 * 監査へ残す資料ID。資料IDで絞り込み、その資料の監査行が実際に見つかったときだけ
 * 残す(`audit_events.document_id`は`documents`へのFKで、未存在のIDは保存できない。
 * QUESTIONS Q-027と同じ方針)。
 */
function auditedDocumentId(
  criteria: AdminAuditSearchCriteria,
  page: AuditEventPage,
): string | null {
  if (criteria.documentId === "") {
    return null;
  }
  const found = page.events.some(
    (event) => event.documentId === criteria.documentId,
  );
  return found ? criteria.documentId : null;
}

/** 監査履歴の1行を画面向けDTOへ変換する。 */
function toAuditEventRow(
  event: AuditEventPage["events"][number],
): AdminAuditEventRow {
  return {
    id: event.id,
    occurredAt: event.occurredAt,
    action: event.action,
    result: event.result,
    documentId: event.documentId,
    actorSubjectId: event.actorSubjectId,
    actorEmail: event.actorEmailAtEvent,
    actorGroupValues: event.actorGroupValues ?? [],
    actorRoles: event.actorRoles ?? [],
    correlationId: event.correlationId,
    errorCategory: event.errorCategory,
  };
}

/**
 * 監査履歴画面の検索loaderの本体。
 *
 * 未認証はログイン画面へのredirect、`Admin`以外は403を`requireAdmin`がthrowする。
 * この行より後ろでしか監査履歴のSELECTを実行しないため、一般利用者の要求はDBへ
 * 届かない。
 */
export async function handleAdminAuditSearch(
  request: Request,
  overrides: Partial<AdminAuditSearchDependencies> = {},
): Promise<AdminAuditSearchData> {
  const deps = { ...defaultAdminAuditSearchDependencies, ...overrides };
  // 相関IDはserver側でUUIDとして発行し、応答・ログ・監査へ同じ値を使う(設計 §15.2)。
  const correlationId = randomUUID();

  let user;
  try {
    user = await requireAdmin(request);
  } catch (error) {
    // 権限不足(403)だけを運用ログへ残す。未認証(ログイン画面へのredirect)は
    // 検証済みの利用者識別子が無いため監査・ログへ残さない(QUESTIONS Q-014)。
    // 認証済み利用者のGET連打で追記専用の監査領域を増やせないよう、拒否は
    // 運用ログだけに記録する(QUESTIONS Q-034)。
    if (error instanceof Response && error.status === 403) {
      logOperationEvent({
        event: AUDIT_SEARCH_LOG_EVENT,
        correlationId,
        result: "denied",
        errorCategory: "not_authorized",
      });
    }
    throw error;
  }

  const parsed = searchCriteriaSchema.safeParse(
    readSearchCriteria(request, criteriaNames),
  );
  if (!parsed.success) {
    logOperationEvent({
      event: AUDIT_SEARCH_LOG_EVENT,
      correlationId,
      result: "denied",
      errorCategory: "validation_failed",
      actorSubjectId: user.id,
    });
    // 利用者向けメッセージは短い日本語と相関IDだけにする(設計 §14)。
    // どの条件が不正だったかは画面へ出さない。
    throw new Response(
      `検索条件の形式が正しくありません（相関ID: ${correlationId}）`,
      { status: 400, headers: securityHeaders() },
    );
  }
  const criteria = parsed.data;

  const actor = {
    actorSubjectId: user.id,
    actorTenantId: user.tenantId,
    actorEmailAtEvent: normalizeEmail(user.email),
    actorGroupValues: user.groups,
    actorRoles: user.roles,
    correlationId,
  } as const;

  let page: AuditEventPage;
  try {
    // 設計 §15.1「管理操作は業務更新と監査を同じDBトランザクションで保存する」
    // 「管理者による監査履歴閲覧も記録」。監査保存に失敗した閲覧は成功させない。
    page = await deps.withTransaction(async (tx) => {
      const found = await deps.searchAuditEvents(
        {
          // 下限は指定した分を含み、上限は指定した分の終わりまで含める
          // (`occurredTo`はrepository側で「その日時より前」として扱うため、
          // 1分進めた値を渡す)。
          occurredFrom: criteria.occurredFrom
            ? jstMinuteToUtcIso(criteria.occurredFrom)
            : null,
          occurredTo: criteria.occurredTo
            ? jstMinuteToUtcIso(criteria.occurredTo, 1)
            : null,
          actorSubjectId: criteria.actorSubjectId || null,
          actorEmail: criteria.actorEmail || null,
          documentId: criteria.documentId || null,
          action: criteria.action || null,
          result: criteria.result || null,
          limit: AUDIT_SEARCH_PAGE_SIZE,
          cursor: criteria.cursor || null,
        },
        tx,
      );

      await deps.insertAuditEvent(
        {
          ...actor,
          action: AUDIT_SEARCH_AUDIT_ACTION,
          result: "success",
          // 検索条件(検索対象の利用者・メールアドレス)は監査へ保存しない
          // (設計 §12.2。`audit_events`のschemaにも該当する項目は無い)。
          documentId: auditedDocumentId(criteria, found),
          errorCategory: null,
        },
        tx,
      );

      return found;
    });
  } catch (error) {
    if (error instanceof InvalidAuditCursorError) {
      logOperationEvent({
        event: AUDIT_SEARCH_LOG_EVENT,
        correlationId,
        result: "denied",
        errorCategory: "validation_failed",
        actorSubjectId: user.id,
      });
      throw new Response(`${error.message}（相関ID: ${correlationId}）`, {
        status: 400,
        headers: securityHeaders(),
      });
    }
    // 検索または監査保存の失敗。監査を残せなかった閲覧結果は画面へ返さない
    // (設計 §15.1)。
    logOperationEvent({
      event: AUDIT_SEARCH_LOG_EVENT,
      correlationId,
      result: "failed",
      errorCategory: "database_failed",
      actorSubjectId: user.id,
    });
    throw new Response(
      `監査履歴を検索できませんでした。時間をおいてやり直してください。（相関ID: ${correlationId}）`,
      { status: 500, headers: securityHeaders() },
    );
  }

  logOperationEvent({
    event: AUDIT_SEARCH_LOG_EVENT,
    correlationId,
    result: "success",
    errorCategory: null,
    actorSubjectId: user.id,
    documentId: auditedDocumentId(criteria, page),
  });

  return {
    criteria,
    page: {
      events: page.events.map(toAuditEventRow),
      nextCursor: page.nextCursor,
    },
  };
}
