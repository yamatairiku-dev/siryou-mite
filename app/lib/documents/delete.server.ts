/**
 * 資料削除の処理本体(設計 §5.5, §10.4, §11.1, §12.1, §14, §15)。
 *
 * 設計 §10.4の手順どおりに、認証 → 同一オリジン検証 → 資料IDの検証 →
 * (データ更新の直前に)オーナー・管理者判定 → 同一トランザクションでの
 * `active`→`deleted`遷移・機微項目の消去・削除監査 → commit後のBlob削除、
 * の順に実行する。
 *
 * - 認可はこのserver側でだけ決まる。確認画面(loader)の表示可否は認可ではなく、
 *   actionでも必ず再判定する(AGENTS.md 5項、設計 §4.2)。
 * - 認可判定は`withTransaction`の中で、削除SQLを実行する直前に読み直した資料に
 *   対して行う(設計 §10.4(2))。判定から更新までの間に状態が変わる余地を作らない。
 * - 監査保存に失敗した削除は成功させない(設計 §15.1)。同じトランザクションで
 *   保存し、失敗時はrollbackする。
 * - Blob削除はcommitの後に行う。失敗しても資料は既に閲覧禁止で、
 *   `blob_cleanup_pending`が立ったまま残るため、定期保守Job(T19)が冪等に
 *   再試行する(設計 §10.4(5)、QUESTIONS Q-011)。ここでは再試行ループを持たない。
 * - 利用者向けの応答は短い日本語メッセージと相関IDだけで、stack trace、Blobキー、
 *   DB情報、内部URL、外部サービス応答を含めない(設計 §14)。削除済みと未存在は
 *   一般利用者向けに同じ404表示にする(設計 §10.4)。
 */
import { randomUUID } from "node:crypto";
import { data, redirect } from "react-router";
import { z } from "zod";
import {
  hasAppAccess,
  requireDocumentDeletionScope,
} from "~/lib/auth/authorization.server";
import {
  insertAuditEvent,
  type AuditAction,
  type AuditErrorCategory,
  type AuditEventInput,
} from "~/lib/db/audit-events.server";
import {
  deleteDocumentAsAdmin,
  deleteDocumentAsOwner,
  findDocumentById,
  markBlobCleanupCompleted,
  type DocumentRecord,
} from "~/lib/db/documents.server";
import { withTransaction, type Queryable } from "~/lib/db/pool.server";
import { logOperationEvent } from "~/lib/log.server";
import { assertSameOrigin, securityHeaders } from "~/lib/security.server";
import { requireUser } from "~/lib/session.server";
import {
  deleteDocumentHtml,
  deleteDocumentPreview,
  getDocumentsContainerClientForWeb,
} from "~/lib/storage.server";

/**
 * 監査の`action`(設計 §12.2)。成功・拒否・失敗のいずれも、オーナー本人の削除か
 * 管理者による強制削除かに関わらず`delete`で記録する。`action = delete`で絞れば
 * すべての削除履歴が揃い(設計 §15.1「削除を記録」)、管理者による他人の資料の
 * 強制削除は`actor_roles`と、削除後も1年保持される`documents.owner_subject_id`と
 * `actor_subject_id`の不一致で判別できる(設計 §10.4(6), §12.1)。
 * `admin_operation`は管理画面の操作(検索・監査閲覧)のために取っておく。
 */
const DELETE_AUDIT_ACTION: AuditAction = "delete";

/** ログの処理名(設計 §15.2)。固定文字列だけを使う。 */
const DELETE_LOG_EVENT = "document_delete";

/** 資料不存在・削除済み・不正な資料IDで共通に使う表示(設計 §10.4, §14)。 */
const NOT_FOUND_MESSAGE = "資料が見つかりません";

const documentIdParamSchema = z.uuid();

/**
 * 外部への依存。既定は実装本体で、テストからだけ差し替える
 * (トランザクション境界と呼び出し順をそのまま検証できるようにするため)。
 */
export type DocumentDeleteDependencies = {
  withTransaction<T>(run: (tx: Queryable) => Promise<T>): Promise<T>;
  findDocumentById(
    documentId: string,
    tx: Queryable,
  ): Promise<DocumentRecord | null>;
  deleteAsOwner(
    params: { documentId: string; ownerSubjectId: string },
    tx: Queryable,
  ): Promise<DocumentRecord | null>;
  deleteAsAdmin(
    params: { documentId: string; adminSubjectId: string },
    tx: Queryable,
  ): Promise<DocumentRecord | null>;
  insertAuditEvent(input: AuditEventInput, tx: Queryable): Promise<unknown>;
  deleteHtml(documentId: string): Promise<void>;
  deletePreview(documentId: string): Promise<void>;
  markBlobCleanupCompleted(documentId: string): Promise<boolean>;
};

export const defaultDocumentDeleteDependencies: DocumentDeleteDependencies = {
  withTransaction: (run) => withTransaction(run),
  findDocumentById,
  deleteAsOwner: (params, tx) => deleteDocumentAsOwner(params, tx),
  deleteAsAdmin: (params, tx) => deleteDocumentAsAdmin(params, tx),
  insertAuditEvent,
  deleteHtml: (documentId) =>
    deleteDocumentHtml(getDocumentsContainerClientForWeb(), documentId),
  deletePreview: (documentId) =>
    deleteDocumentPreview(getDocumentsContainerClientForWeb(), documentId),
  markBlobCleanupCompleted: (documentId) => markBlobCleanupCompleted(documentId),
};

/** 確認画面へ再表示する失敗内容(設計 §14)。内部情報は含めない。 */
export type DocumentDeleteErrorData = {
  message: string;
  correlationId: string;
};

/**
 * 成功時はredirect(`Response`)、失敗時は確認画面へ再表示するための`data`を返す。
 * 認可拒否・未存在は`Response`をthrowし、`root.tsx`のErrorBoundaryが表示する。
 */
export type DocumentDeleteActionResult =
  | Response
  | ReturnType<typeof data<DocumentDeleteErrorData>>;

/** Blob削除の成否を返す。失敗しても例外にせず、削除自体は成功として扱う(設計 §10.4(5))。 */
async function deleteBlobSafely(run: () => Promise<void>): Promise<boolean> {
  try {
    await run();
    return true;
  } catch {
    return false;
  }
}

/** メールアドレス形式でないclaim(UPNなど)は保存しない(QUESTIONS Q-016, Q-020)。 */
function normalizeEmail(value: string): string | null {
  const result = z.email().max(320).safeParse(value.trim());
  return result.success ? result.data : null;
}

/**
 * 削除要求を処理する。未認証は`requireUser`がログイン画面へのredirectを、
 * 権限不足は403 `Response`をthrowする(設計 §7.1)。
 */
export async function handleDocumentDeletion(
  request: Request,
  params: { documentId?: string | undefined },
  overrides: Partial<DocumentDeleteDependencies> = {},
): Promise<DocumentDeleteActionResult> {
  const deps = { ...defaultDocumentDeleteDependencies, ...overrides };
  // 相関IDはserver側でUUIDとして発行し、応答・ログ・監査へ同じ値を使う(設計 §15.2)。
  const correlationId = randomUUID();

  // 設計 §10.4(1): 認証。
  const user = await requireUser(request);

  const actor = {
    actorSubjectId: user.id,
    actorTenantId: user.tenantId,
    actorEmailAtEvent: normalizeEmail(user.email),
    actorGroupValues: user.groups,
    actorRoles: user.roles,
    correlationId,
  } as const;

  /**
   * 業務更新を伴わない監査(拒否・失敗)を別トランザクションで保存する。
   * 監査保存にも失敗した場合は分類だけを運用ログへ残し、元の結果を上書きしない
   * (設計 §15.2)。
   */
  async function recordAuditSafely(input: {
    result: "denied" | "failed";
    errorCategory: AuditErrorCategory;
    documentId?: string | null;
  }): Promise<void> {
    try {
      await deps.withTransaction((tx) =>
        deps.insertAuditEvent(
          {
            ...actor,
            action: DELETE_AUDIT_ACTION,
            result: input.result,
            documentId: input.documentId ?? null,
            errorCategory: input.errorCategory,
          },
          tx,
        ),
      );
    } catch {
      logOperationEvent({
        event: `${DELETE_LOG_EVENT}_audit_write`,
        correlationId,
        result: "failed",
        errorCategory: "database_failed",
        actorSubjectId: user.id,
        documentId: input.documentId ?? null,
      });
    }
  }

  /**
   * 認証後の拒否を監査・運用ログへ残し、利用者向け`Response`を返す
   * (QUESTIONS Q-014。未認証の拒否は`requireUser`側で監査しない)。
   * 呼び出し側は`throw await deny(...)`の形で使う。
   */
  async function deny(input: {
    status: number;
    message: string;
    errorCategory: AuditErrorCategory;
    documentId?: string | null;
  }): Promise<Response> {
    await recordAuditSafely({
      result: "denied",
      errorCategory: input.errorCategory,
      documentId: input.documentId ?? null,
    });
    logOperationEvent({
      event: DELETE_LOG_EVENT,
      correlationId,
      result: "denied",
      errorCategory: input.errorCategory,
      actorSubjectId: user.id,
      documentId: input.documentId ?? null,
    });
    // 利用者向けメッセージは短い日本語と相関IDだけにする(設計 §14, §15.2)。
    // 相関IDは`root.tsx`のErrorBoundaryが本文として表示する。
    return new Response(`${input.message}（相関ID: ${correlationId}）`, {
      status: input.status,
      headers: securityHeaders(),
    });
  }

  // 設計 §10.4(1): cookie認証のmutation actionでは同一オリジンを必ず検証する
  // (AGENTS.md 7項)。
  try {
    assertSameOrigin(request);
  } catch (error) {
    throw await deny({
      status: error instanceof Response ? error.status : 403,
      message: "不正なリクエストです",
      errorCategory: "not_authorized",
    });
  }

  // UIの非表示を認可にしない(設計 §4.2)。アプリ利用権限もここで確認する。
  if (!hasAppAccess(user)) {
    throw await deny({
      status: 403,
      message: "このアプリを利用する権限がありません",
      errorCategory: "not_authorized",
    });
  }

  // 資料IDはZodで検証してからDBへ触る(AGENTS.md 6項)。UUID形式でない値は
  // 未存在と同じ404にして、存在有無を推測させない(設計 §14)。
  const parsedDocumentId = documentIdParamSchema.safeParse(params.documentId);
  if (!parsedDocumentId.success) {
    throw await deny({
      status: 404,
      message: NOT_FOUND_MESSAGE,
      errorCategory: "validation_failed",
    });
  }
  const documentId = parsedDocumentId.data;

  try {
    // 設計 §10.4(3), §15.1: 状態遷移・機微項目の消去・削除監査を同一
    // トランザクションで保存する。監査保存が失敗すればrollbackされる。
    await deps.withTransaction(async (tx) => {
      const document = await deps.findDocumentById(documentId, tx);

      // 設計 §10.4(2): データ更新の直前に、同じトランザクションで読み直した
      // 資料に対してオーナー・管理者判定を行う。拒否なら`Response`がthrowされ、
      // DBは1行も更新されないままrollbackされる。
      const deletionScope = requireDocumentDeletionScope(user, document);

      const deleted =
        deletionScope === "owner"
          ? // 所有者条件付きSQL。他人の資料はそもそも1行も更新されない。
            await deps.deleteAsOwner(
              { documentId, ownerSubjectId: user.id },
              tx,
            )
          : // 管理者による強制削除(設計 §5.6)。Adminロール確認済みの経路だけが呼ぶ。
            await deps.deleteAsAdmin({ documentId, adminSubjectId: user.id }, tx);

      if (!deleted) {
        // 判定後に他の操作が削除した場合など。更新0行のためrollbackし、
        // 未存在・削除済みと同じ404にする。
        throw new Response(NOT_FOUND_MESSAGE, { status: 404 });
      }

      await deps.insertAuditEvent(
        {
          ...actor,
          action: DELETE_AUDIT_ACTION,
          result: "success",
          documentId,
          errorCategory: null,
        },
        tx,
      );
    });
  } catch (error) {
    if (error instanceof Response) {
      // 認可拒否(403)と未存在・削除済み(404)。監査へは区別して残す(設計 §14)。
      throw await deny({
        status: error.status,
        message: await error.text(),
        errorCategory:
          error.status === 404 ? "document_not_found" : "not_authorized",
        documentId: error.status === 404 ? null : documentId,
      });
    }
    // DBまたは監査保存の失敗。資料は削除されていない(設計 §15.1)。
    await recordAuditSafely({
      result: "failed",
      errorCategory: "database_failed",
      documentId: null,
    });
    logOperationEvent({
      event: DELETE_LOG_EVENT,
      correlationId,
      result: "failed",
      errorCategory: "database_failed",
      actorSubjectId: user.id,
      documentId,
    });
    return data(
      {
        message: "資料を削除できませんでした。時間をおいてやり直してください。",
        correlationId,
      },
      { status: 500 },
    );
  }

  // 設計 §10.4(4): commit後に、資料IDから導出したHTMLとプレビュー画像を削除する。
  const htmlDeleted = await deleteBlobSafely(() => deps.deleteHtml(documentId));
  // HTML削除が失敗してもプレビュー削除は試みる(残す理由が無いため)。
  const previewDeleted = await deleteBlobSafely(() =>
    deps.deletePreview(documentId),
  );

  if (htmlDeleted && previewDeleted) {
    try {
      await deps.markBlobCleanupCompleted(documentId);
    } catch {
      // フラグを下ろせなくても実害は無い(定期保守Jobが冪等に再試行する)。
      logOperationEvent({
        event: `${DELETE_LOG_EVENT}_blob_cleanup_flag`,
        correlationId,
        result: "failed",
        errorCategory: "database_failed",
        actorSubjectId: user.id,
        documentId,
      });
    }
  } else {
    // 設計 §10.4(5): 閲覧禁止は維持されているため利用者には成功を返し、
    // `blob_cleanup_pending`を立てたまま運用エラーとして記録する。
    logOperationEvent({
      event: `${DELETE_LOG_EVENT}_blob_cleanup`,
      correlationId,
      result: "failed",
      errorCategory: "storage_failed",
      actorSubjectId: user.id,
      documentId,
    });
  }

  logOperationEvent({
    event: DELETE_LOG_EVENT,
    correlationId,
    result: "success",
    errorCategory: null,
    actorSubjectId: user.id,
    documentId,
  });

  // 削除後の資料表示画面は404になるため、一覧が更新される初期画面へ戻す
  // (設計 §5.2の所有資料一覧。管理者による強制削除でも、管理画面(T17)が
  // まだ無い初期リリースでは同じ初期画面へ戻す)。
  return redirect("/app", { status: 303 });
}
