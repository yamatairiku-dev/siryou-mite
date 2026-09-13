/**
 * 管理画面の資料検索(設計 §5.6, §4.2, §13の`/admin/documents`)。
 *
 * - 認可はこのserver側でだけ決まる。`requireAdmin`で`Admin`ロールを確認してから
 *   でないと検索SQLを1回も実行しない(UIの非表示を認可にしない。設計 §4.2、
 *   AGENTS.md 5項)。
 * - 検索条件(資料ID・オーナーのメールアドレス・元ファイル名・アップロード日時)は
 *   すべて任意で、Zodで検証してからrepositoryへ渡す(AGENTS.md 6項)。形式が
 *   不正な値はDBへ渡さず400で拒否する。
 * - 日時の入力は画面と同じ日本時間(設計 §5.2)として解釈し、UTCのISO日時へ
 *   変換してからrepositoryへ渡す(DBはUTC)。
 * - 管理画面での検索・一覧閲覧は`admin_operation`として監査する(設計 §5.6
 *   「管理者による閲覧と削除も監査履歴へ記録する」、§15.1)。監査には検索条件
 *   そのもの(メールアドレス・ファイル名)を保存しない(設計 §12.2)。
 * - 強制削除はこのmoduleでは行わない。削除確認画面
 *   `/documents/:documentId/delete`(T14)への導線を出すだけで、削除の認可と実行は
 *   `app/lib/documents/delete.server.ts`が担当する(設計 §5.5)。
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
  insertAuditEvent,
  type AuditAction,
  type AuditEventInput,
} from "~/lib/db/audit-events.server";
import {
  InvalidCursorError,
  searchDocumentsForAdmin,
  type DocumentListPage,
  type DocumentRecord,
  type PreviewStatus,
  type SearchDocumentsForAdminOptions,
} from "~/lib/db/documents.server";
import { withTransaction, type Queryable } from "~/lib/db/pool.server";
import { logOperationEvent } from "~/lib/log.server";
import { securityHeaders } from "~/lib/security.server";

/**
 * 監査の`action`(設計 §12.2)。管理画面での検索・一覧閲覧は`admin_operation`と
 * して記録する。管理者による強制削除は削除経路が一律`delete`で記録するため
 * (QUESTIONS Q-026)、ここでは重複して記録しない。
 */
const ADMIN_SEARCH_AUDIT_ACTION: AuditAction = "admin_operation";

/** ログの処理名(設計 §15.2)。固定文字列だけを使う。 */
const ADMIN_SEARCH_LOG_EVENT = "admin_document_search";

/** 1ページの件数。全件は返さない(設計 §5.2の20件に合わせる)。 */
export const ADMIN_SEARCH_PAGE_SIZE = 20;

/**
 * URLのクエリ文字列から受け取る検索条件。すべて任意で、空文字は「絞り込まない」。
 * 長すぎる値・UUIDでない資料ID・不正な日時はここで弾き、DBへ渡さない。
 */
const searchCriteriaSchema = z
  .object({
    documentId: optionalCriterion(z.uuid()),
    ownerEmail: optionalCriterion(z.string().min(1).max(320)),
    fileName: optionalCriterion(z.string().min(1).max(1000)),
    uploadedFrom: optionalCriterion(jstMinuteSchema),
    uploadedTo: optionalCriterion(jstMinuteSchema),
    cursor: optionalCriterion(z.string().min(1).max(500)),
  })
  .strict();

/** 画面へ返す検索条件(入力欄の再表示に使う。管理者自身が入力した値)。 */
export type AdminDocumentSearchCriteria = z.infer<typeof searchCriteriaSchema>;

/**
 * 管理画面のカード表示用DTO(設計 §5.2のカード項目)。
 * `ownerEmail`は管理者だけに見せる項目で、`Admin`確認済みのloaderからのみ返す
 * (設計 §5.6, §4.2)。
 */
export type AdminDocumentCard = {
  id: string;
  title: string;
  originalFileName: string;
  ownerEmail: string;
  byteSize: number | null;
  previewStatus: PreviewStatus | null;
  createdAt: Date;
};

export type AdminDocumentSearchData = {
  criteria: AdminDocumentSearchCriteria;
  page: { documents: AdminDocumentCard[]; nextCursor: string | null };
};

/**
 * 外部への依存。既定は実装本体で、テストからだけ差し替える
 * (トランザクション境界と検索条件の受け渡しをそのまま検証できるようにするため)。
 */
export type AdminDocumentSearchDependencies = {
  withTransaction<T>(run: (tx: Queryable) => Promise<T>): Promise<T>;
  searchDocumentsForAdmin(
    options: SearchDocumentsForAdminOptions,
    tx: Queryable,
  ): Promise<DocumentListPage>;
  insertAuditEvent(input: AuditEventInput, tx: Queryable): Promise<unknown>;
};

export const defaultAdminDocumentSearchDependencies: AdminDocumentSearchDependencies =
  {
    withTransaction: (run) => withTransaction(run),
    searchDocumentsForAdmin: (options, tx) =>
      searchDocumentsForAdmin(options, tx),
    insertAuditEvent,
  };

/** メールアドレス形式でないclaim(UPNなど)は保存しない(QUESTIONS Q-016, Q-020)。 */
function normalizeEmail(value: string): string | null {
  const result = z.email().max(320).safeParse(value.trim());
  return result.success ? result.data : null;
}

/** 画面から受け取る検索条件の名前(schemaのkeyと一致させる)。 */
const criteriaNames = [
  "documentId",
  "ownerEmail",
  "fileName",
  "uploadedFrom",
  "uploadedTo",
  "cursor",
] as const;

function toAdminDocumentCard(document: DocumentRecord): AdminDocumentCard {
  return {
    id: document.id,
    title: document.title ?? document.originalFileName ?? "(タイトル不明)",
    originalFileName: document.originalFileName ?? "(不明なファイル名)",
    // 管理者にだけ表示する項目(設計 §5.6)。一般利用者向けの画面へは返さない。
    ownerEmail: document.ownerEmailAtUpload ?? "(不明)",
    byteSize: document.byteSize,
    previewStatus: document.previewStatus,
    createdAt: document.createdAt,
  };
}

/**
 * 監査へ残す資料ID。資料IDの完全一致で1件だけ見つかった検索だけ対象が一意に
 * 定まるため、それ以外は`null`にする(QUESTIONS Q-027と同じ方針。
 * `audit_events.document_id`は`documents`へのFKで、未存在のIDは保存できない)。
 */
function auditedDocumentId(
  criteria: AdminDocumentSearchCriteria,
  page: DocumentListPage,
): string | null {
  if (criteria.documentId === "" || page.documents.length !== 1) {
    return null;
  }
  return page.documents[0]?.id ?? null;
}

/**
 * 管理画面の検索loaderの本体。
 *
 * 未認証はログイン画面へのredirect、`Admin`以外は403を`requireAdmin`がthrowする。
 * この行より後ろでしか検索SQLを実行しないため、一般利用者の要求はDBへ届かない。
 */
export async function handleAdminDocumentSearch(
  request: Request,
  overrides: Partial<AdminDocumentSearchDependencies> = {},
): Promise<AdminDocumentSearchData> {
  const deps = { ...defaultAdminDocumentSearchDependencies, ...overrides };
  // 相関IDはserver側でUUIDとして発行し、応答・ログ・監査へ同じ値を使う(設計 §15.2)。
  const correlationId = randomUUID();

  let user;
  try {
    user = await requireAdmin(request);
  } catch (error) {
    // 権限不足(403)だけを運用ログへ残す。未認証(ログイン画面へのredirect)は
    // 検証済みの利用者識別子が無いため監査・ログへ残さない(QUESTIONS Q-014)。
    // 認証済み利用者のGETで監査行を増やせる状態を作らないため、拒否は運用ログ
    // だけに記録する(QUESTIONS Q-028と同じ考え方)。
    if (error instanceof Response && error.status === 403) {
      logOperationEvent({
        event: ADMIN_SEARCH_LOG_EVENT,
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
      event: ADMIN_SEARCH_LOG_EVENT,
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

  let page: DocumentListPage;
  try {
    // 設計 §15.1「アップロード、削除、管理操作は業務更新と監査を同じDB
    // トランザクションで保存する」。監査保存に失敗した検索は成功させない。
    page = await deps.withTransaction(async (tx) => {
      const found = await deps.searchDocumentsForAdmin(
        {
          documentId: criteria.documentId || null,
          ownerEmail: criteria.ownerEmail || null,
          originalFileName: criteria.fileName || null,
          // 下限は指定した分を含み、上限は指定した分の終わりまで含める
          // (`uploadedTo`はrepository側で「その日時より前」として扱うため、
          // 1分進めた値を渡す)。
          uploadedFrom: criteria.uploadedFrom
            ? jstMinuteToUtcIso(criteria.uploadedFrom)
            : null,
          uploadedTo: criteria.uploadedTo
            ? jstMinuteToUtcIso(criteria.uploadedTo, 1)
            : null,
          limit: ADMIN_SEARCH_PAGE_SIZE,
          cursor: criteria.cursor || null,
        },
        tx,
      );

      await deps.insertAuditEvent(
        {
          ...actor,
          action: ADMIN_SEARCH_AUDIT_ACTION,
          result: "success",
          // 検索条件(メールアドレス・ファイル名)は監査へ保存しない(設計 §12.2)。
          // `audit_events`のschemaにも該当する項目は無い。
          documentId: auditedDocumentId(criteria, found),
          errorCategory: null,
        },
        tx,
      );

      return found;
    });
  } catch (error) {
    if (error instanceof InvalidCursorError) {
      logOperationEvent({
        event: ADMIN_SEARCH_LOG_EVENT,
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
    // 検索または監査保存の失敗。監査を残せなかった検索結果は画面へ返さない
    // (設計 §15.1)。
    logOperationEvent({
      event: ADMIN_SEARCH_LOG_EVENT,
      correlationId,
      result: "failed",
      errorCategory: "database_failed",
      actorSubjectId: user.id,
    });
    throw new Response(
      `資料を検索できませんでした。時間をおいてやり直してください。（相関ID: ${correlationId}）`,
      { status: 500, headers: securityHeaders() },
    );
  }

  logOperationEvent({
    event: ADMIN_SEARCH_LOG_EVENT,
    correlationId,
    result: "success",
    errorCategory: null,
    actorSubjectId: user.id,
    documentId: auditedDocumentId(criteria, page),
  });

  return {
    criteria,
    page: {
      documents: page.documents.map(toAdminDocumentCard),
      nextCursor: page.nextCursor,
    },
  };
}
