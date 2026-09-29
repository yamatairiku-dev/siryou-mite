/**
 * アップロード`POST /documents`の処理本体(設計 §10.1, §10.2, §13, §14, §15)。
 *
 * 設計 §10.1の手順どおりに、認証 → 同一オリジン検証 → 上限判定(枠の確保) →
 * raw bodyと`X-File-Name`の検証 → HTML受け入れ検査 → 資料ID発行 → Blob保存 →
 * DB登録(監査と同一トランザクション) → Queue送信 → 資料表示画面への案内、
 * の順に実行する。
 *
 * ただし上限判定(手順3)に渡すbyte数は、`Content-Length`のような自己申告値では
 * なくstreaming上限で強制した実byte数でなければならない(QUESTIONS Q-012)。
 * そのため実装順としては、bodyを上限付きで読み切った直後に上限判定を行う
 * (10MBを超えるbodyはこの時点で中断済みで、DBへは触れない)。
 *
 * 失敗時の補償(設計 §10.2):
 * - DB登録に失敗した場合、保存済みの不完全なBlobを削除する(DBはrollbackされる)。
 * - 監査保存に失敗した操作は成功させない(設計 §15.1)。
 * - Queue送信に失敗した場合はプレビュー状態を`failed`にし、資料は閲覧可能に保つ。
 *
 * 利用者向けの応答は短い日本語メッセージと相関IDだけで、stack trace、Blobキー、
 * DB情報、内部URL、外部サービス応答を含めない(設計 §14)。
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { hasAppAccess } from "~/lib/auth/authorization.server";
import {
  insertAuditEvent,
  type AuditErrorCategory,
  type AuditEventInput,
} from "~/lib/db/audit-events.server";
import {
  createDocument,
  updateDocumentPreviewStatus,
  type CreateDocumentInput,
  type DocumentRecord,
  type PreviewStatus,
} from "~/lib/db/documents.server";
import { withTransaction, type Queryable } from "~/lib/db/pool.server";
import {
  releaseUploadSlot,
  reserveUploadSlot,
  type UploadLimitRejectionReason,
  type UploadSlotDecision,
} from "~/lib/db/upload-limits.server";
import { env } from "~/lib/env.server";
import {
  htmlRejectionMessage,
  htmlWarningMessage,
  type HtmlRejectionCode,
  type HtmlWarningCode,
} from "~/lib/html/inspection-codes";
import { inspectHtmlUpload } from "~/lib/html/inspection.server";
import { logOperationEvent } from "~/lib/log.server";
import { assertSameOrigin, securityHeaders } from "~/lib/security.server";
import { requireUser } from "~/lib/session.server";
import {
  getDocumentsContainerClientForWeb,
  getPreviewQueueClientForWeb,
  sendPreviewGenerationMessage,
  uploadDocumentHtml,
  deleteDocumentHtml,
} from "~/lib/storage.server";
import {
  declaredContentLength,
  decodeFileNameHeader,
  isOctetStreamContentType,
  readBodyWithinLimit,
} from "~/lib/upload/upload-request.server";

/** ログの処理名(設計 §15.2)。固定文字列だけを使う。 */
const UPLOAD_LOG_EVENT = "document_upload";

/**
 * 外部への依存。既定は実装本体で、テストからだけ差し替える
 * (トランザクション境界と呼び出し順をそのまま検証できるようにするため)。
 */
export type UploadDependencies = {
  reserveUploadSlot(input: {
    ownerSubjectId: string;
    byteSize: number;
  }): Promise<UploadSlotDecision>;
  releaseUploadSlot(params: {
    attemptId: string;
    ownerSubjectId: string;
  }): Promise<boolean>;
  withTransaction<T>(run: (tx: Queryable) => Promise<T>): Promise<T>;
  createDocument(
    input: CreateDocumentInput,
    tx: Queryable,
  ): Promise<DocumentRecord>;
  insertAuditEvent(input: AuditEventInput, tx: Queryable): Promise<unknown>;
  updatePreviewStatus(
    params: { documentId: string; previewStatus: PreviewStatus },
    tx: Queryable,
  ): Promise<boolean>;
  saveHtml(documentId: string, html: Buffer): Promise<void>;
  deleteHtml(documentId: string): Promise<void>;
  sendPreviewMessage(documentId: string): Promise<void>;
  /** 資料ID(UUID v4)の発行(設計 §10.1(6))。 */
  newDocumentId(): string;
};

export const defaultUploadDependencies: UploadDependencies = {
  reserveUploadSlot: (input) => reserveUploadSlot(input),
  releaseUploadSlot: (params) => releaseUploadSlot(params),
  withTransaction: (run) => withTransaction(run),
  createDocument,
  insertAuditEvent,
  updatePreviewStatus: (params, tx) => updateDocumentPreviewStatus(params, tx),
  saveHtml: (documentId, html) =>
    uploadDocumentHtml(getDocumentsContainerClientForWeb(), documentId, html),
  deleteHtml: (documentId) =>
    deleteDocumentHtml(getDocumentsContainerClientForWeb(), documentId),
  sendPreviewMessage: (documentId) =>
    sendPreviewGenerationMessage(getPreviewQueueClientForWeb(), documentId),
  newDocumentId: () => randomUUID(),
};

/** 成功応答(設計 §10.1(10)、§5.3)。資料表示画面のpathを返す。 */
export type UploadSuccessBody = {
  documentId: string;
  /** 資料表示画面(設計 §13の`/documents/:documentId`)。 */
  documentUrl: string;
  previewStatus: PreviewStatus;
  /** 表示時に無効化される機能の警告(設計 §5.3, §6.2)。 */
  warnings: { code: HtmlWarningCode; message: string }[];
  correlationId: string;
};

/** 失敗応答(設計 §14)。内部情報は含めない。 */
export type UploadErrorBody = {
  message: string;
  correlationId: string;
  /** HTML受け入れ検査の拒否理由(設計 §10.2の利用者向け表示に使う)。 */
  rejections?: { code: HtmlRejectionCode; message: string }[];
};

/**
 * 基本条件(設計 §10.1(4))による拒否理由。これら以外はHTMLの安全性検査
 * (設計 §10.1(5))による拒否として監査する。
 */
const basicRejectionCodes = new Set<HtmlRejectionCode>([
  "invalid_file_name",
  "file_name_too_long",
  "invalid_file_extension",
  "empty_file",
  "file_too_large",
  "invalid_utf8",
]);

/** 上限超過の利用者向けメッセージ(設計 §14)。内部の集計値は出さない。 */
const uploadLimitMessages: Record<UploadLimitRejectionReason, string> = {
  concurrent_upload_in_progress:
    "別のアップロードが進行中です。完了してからやり直してください。",
  rate_limit_exceeded:
    "短時間にアップロードが集中しています。しばらくしてからやり直してください。",
  owner_document_count_exceeded:
    "登録できる資料の件数が上限に達しています。不要な資料を削除してください。",
  owner_total_bytes_exceeded:
    "登録できる合計サイズの上限に達しています。不要な資料を削除してください。",
  system_total_bytes_exceeded:
    "サーバーの空き容量が不足しています。管理者へ連絡してください。",
  lock_wait_timeout:
    "アップロードが混み合っています。しばらくしてからやり直してください。",
};

/** メールアドレス以外の値(UPNなど)が来た場合は保存しない(設計 §12.1, §12.2)。 */
function normalizeEmail(value: string): string | null {
  const result = z.email().max(320).safeParse(value.trim());
  return result.success ? result.data : null;
}

function jsonResponse(body: unknown, status: number, headers: HeadersInit = {}) {
  return Response.json(body, {
    status,
    headers: { ...securityHeaders(), ...headers },
  });
}

/**
 * アップロード要求を処理する。認証に失敗した場合は`requireUser`が
 * ログイン画面へのredirect、権限不足は403 Responseをthrowする(設計 §7.1)。
 */
export async function handleDocumentUpload(
  request: Request,
  overrides: Partial<UploadDependencies> = {},
): Promise<Response> {
  const deps = { ...defaultUploadDependencies, ...overrides };
  // 相関IDはserver側でUUIDとして発行し、応答とログ・監査へ同じ値を使う(設計 §15.2)。
  const correlationId = randomUUID();

  // 設計 §10.1(1): 認証。
  const user = await requireUser(request);

  const actor = {
    action: "upload",
    actorSubjectId: user.id,
    actorTenantId: user.tenantId,
    actorEmailAtEvent: normalizeEmail(user.email),
    actorGroupValues: user.groups,
    actorRoles: user.roles,
    correlationId,
  } as const;

  /** 業務更新を伴わない監査(拒否・失敗)だけを保存する。 */
  async function recordAudit(input: {
    result: "denied" | "failed";
    errorCategory: AuditErrorCategory;
    documentId?: string | null;
  }): Promise<void> {
    await deps.withTransaction((tx) =>
      deps.insertAuditEvent(
        {
          ...actor,
          result: input.result,
          errorCategory: input.errorCategory,
          documentId: input.documentId ?? null,
        },
        tx,
      ),
    );
  }

  /**
   * 既に失敗が確定している経路の監査。監査保存にも失敗した場合は分類だけを
   * 運用ログへ残し、元の結果(拒否・失敗)を上書きしない(設計 §15.2)。
   */
  async function recordAuditSafely(input: {
    result: "denied" | "failed";
    errorCategory: AuditErrorCategory;
    documentId?: string | null;
  }): Promise<void> {
    try {
      await recordAudit(input);
    } catch {
      logOperationEvent({
        event: `${UPLOAD_LOG_EVENT}_audit_write`,
        correlationId,
        result: "failed",
        errorCategory: "database_failed",
        actorSubjectId: user.id,
        documentId: input.documentId ?? null,
      });
    }
  }

  /** 拒否・失敗の応答を作り、監査と運用ログを残す(設計 §14, §15)。 */
  async function reject(params: {
    status: number;
    message: string;
    errorCategory: AuditErrorCategory;
    result?: "denied" | "failed";
    rejections?: { code: HtmlRejectionCode; message: string }[];
    headers?: HeadersInit;
    documentId?: string | null;
  }): Promise<Response> {
    const result = params.result ?? "denied";
    await recordAuditSafely({
      result,
      errorCategory: params.errorCategory,
      documentId: params.documentId ?? null,
    });
    logOperationEvent({
      event: UPLOAD_LOG_EVENT,
      correlationId,
      result,
      errorCategory: params.errorCategory,
      actorSubjectId: user.id,
      documentId: params.documentId ?? null,
    });

    const body: UploadErrorBody = { message: params.message, correlationId };
    if (params.rejections) {
      body.rejections = params.rejections;
    }
    return jsonResponse(body, params.status, params.headers ?? {});
  }

  // 設計 §10.1(2): cookie認証のmutation actionでは同一オリジンを必ず検証する。
  try {
    assertSameOrigin(request);
  } catch (error) {
    const status = error instanceof Response ? error.status : 403;
    return reject({
      status,
      message: "不正なリクエストです。",
      errorCategory: "not_authorized",
    });
  }

  // UIの非表示を認可にしない(設計 §4.2)。データ更新の直前でも権限を確認する。
  if (!hasAppAccess(user)) {
    return reject({
      status: 403,
      message: "このアプリを利用する権限がありません。",
      errorCategory: "not_authorized",
    });
  }

  // 設計 §7.1: `application/octet-stream`だけを受け付ける。
  if (!isOctetStreamContentType(request.headers.get("Content-Type"))) {
    return reject({
      status: 415,
      message: "アップロード形式が不正です。",
      errorCategory: "validation_failed",
    });
  }

  // 設計 §7.1: UTF-8ファイル名は`X-File-Name`へbase64urlで格納する。
  const fileNameHeader = decodeFileNameHeader(request.headers.get("X-File-Name"));
  if (!fileNameHeader.ok) {
    return reject({
      status: 400,
      message: "ファイル名を確認できません。",
      errorCategory: "validation_failed",
    });
  }

  const maxBytes = env.MAX_HTML_UPLOAD_BYTES;
  const tooLarge = () =>
    reject({
      status: 413,
      message: htmlRejectionMessage("file_too_large"),
      errorCategory: "validation_failed",
      rejections: [
        { code: "file_too_large", message: htmlRejectionMessage("file_too_large") },
      ],
    });

  // `Content-Length`の事前検査(設計 §7.1)。自己申告値のため、これだけでは信用しない。
  const declaredLength = declaredContentLength(request);
  if (declaredLength !== null && declaredLength > maxBytes) {
    return tooLarge();
  }

  // 設計 §10.1(4): streaming中に上限を超えた時点で中止する。
  const body = await readBodyWithinLimit(request.body, maxBytes);
  if (!body.ok) {
    return tooLarge();
  }
  const bytes = body.bytes;

  // 設計 §10.1(3): 件数・容量・頻度・同時実行の上限判定と枠の確保。
  // 渡すbyte数はstreaming上限で強制した実byte数を使う(QUESTIONS Q-012)。
  let decision: UploadSlotDecision;
  try {
    decision = await deps.reserveUploadSlot({
      ownerSubjectId: user.id,
      byteSize: bytes.byteLength,
    });
  } catch {
    return reject({
      status: 500,
      message: "アップロードに失敗しました。時間をおいてやり直してください。",
      errorCategory: "database_failed",
      result: "failed",
    });
  }

  if (!decision.allowed) {
    const retryAfter =
      decision.retryAfterSeconds === null
        ? {}
        : { "Retry-After": String(Math.max(1, decision.retryAfterSeconds)) };
    return reject({
      status: decision.errorCategory === "quota_exceeded" ? 409 : 429,
      message: uploadLimitMessages[decision.reason],
      errorCategory: decision.errorCategory,
      headers: retryAfter,
    });
  }

  const reservation = decision;

  /** 確保した枠の解放。失敗しても元の処理結果を覆さない(QUESTIONS Q-012)。 */
  async function releaseSlot(): Promise<void> {
    try {
      await deps.releaseUploadSlot({
        attemptId: reservation.attemptId,
        ownerSubjectId: user.id,
      });
    } catch {
      // leaseの`expires_at`で自動失効するため、解放失敗は業務結果に影響させない。
      logOperationEvent({
        event: `${UPLOAD_LOG_EVENT}_slot_release`,
        correlationId,
        result: "failed",
        errorCategory: "database_failed",
        actorSubjectId: user.id,
      });
    }
  }

  // 枠を確保した後の処理は、想定外の例外でも必ず枠の解放・失敗監査・相関IDの返却を
  // 行えるようにまとめてtryで囲む(設計 §10.2, §14, §15.1)。解放せずに抜けると、
  // T08のlease(既定120秒)が切れるまで同じ利用者のアップロードが塞がる。
  try {
    if (reservation.systemWarning) {
      // システム容量の警告閾値(設計 §6.1の40GB相当)。監視はこのログを使う(設計 §17)。
      logOperationEvent({
        event: "system_html_capacity_warning",
        correlationId,
        result: "success",
        actorSubjectId: user.id,
      });
    }

    // 設計 §10.1(5): `parse5`による受け入れ検査。HTMLは書き換えない。
    const inspection = inspectHtmlUpload(
      { fileName: fileNameHeader.fileName, bytes },
      { maxBytes },
    );

    if (!inspection.accepted) {
      await releaseSlot();
      const firstCode = inspection.rejectionCodes[0];
      const isBasic = firstCode !== undefined && basicRejectionCodes.has(firstCode);
      return reject({
        status: firstCode === "file_too_large" ? 413 : 400,
        message: firstCode
          ? htmlRejectionMessage(firstCode)
          : "アップロードできないファイルです。",
        errorCategory: isBasic ? "validation_failed" : "html_inspection_failed",
        rejections: inspection.rejectionCodes.map((code) => ({
          code,
          message: htmlRejectionMessage(code),
        })),
      });
    }

    const displayFileName = inspection.displayFileName;
    if (displayFileName === null) {
      // 受理された場合は必ず表示用ファイル名が返るが、fail closedで扱う。
      await releaseSlot();
      return reject({
        status: 400,
        message: "ファイル名を確認できません。",
        errorCategory: "validation_failed",
      });
    }

    // 設計 §10.1(6): UUID v4の資料IDを発行し、private Blobへ保存する。
    const documentId = deps.newDocumentId();

    try {
      await deps.saveHtml(documentId, Buffer.from(bytes));
    } catch {
      await releaseSlot();
      return reject({
        status: 503,
        message: "アップロードに失敗しました。時間をおいてやり直してください。",
        errorCategory: "storage_failed",
        result: "failed",
      });
    }

    // 設計 §10.1(7), §15.1: 資料登録と成功監査を同じトランザクションで保存する。
    try {
      await deps.withTransaction(async (tx) => {
        const created = await deps.createDocument(
          {
            id: documentId,
            ownerSubjectId: user.id,
            ownerEmailAtUpload: normalizeEmail(user.email),
            originalFileName: displayFileName,
            title: inspection.title ?? displayFileName,
            byteSize: inspection.byteSize,
            previewStatus: "pending",
            warningCodes: inspection.warningCodes,
          },
          tx,
        );
        await deps.insertAuditEvent(
          { ...actor, result: "success", documentId: created.id, errorCategory: null },
          tx,
        );
        return created;
      });
    } catch {
      // 設計 §10.2: 不完全なBlobとDBレコードを削除する(DBはrollback済み)。
      try {
        await deps.deleteHtml(documentId);
      } catch {
        logOperationEvent({
          event: `${UPLOAD_LOG_EVENT}_blob_compensation`,
          correlationId,
          result: "failed",
          errorCategory: "storage_failed",
          actorSubjectId: user.id,
        });
      }
      await releaseSlot();
      // 資料レコードは残っていないため、監査の`document_id`は持たせない(設計 §11.1)。
      return reject({
        status: 500,
        message: "アップロードに失敗しました。時間をおいてやり直してください。",
        errorCategory: "database_failed",
        result: "failed",
      });
    }

    // 登録をcommitした**後**に解放する(QUESTIONS Q-012)。先に解放すると、
    // 予約からも`documents`からも消える瞬間ができ、上限超過を許してしまう。
    await releaseSlot();

    // 設計 §10.1(8)(9): Queue送信に失敗してもプレビュー状態を`failed`にして閲覧は維持する。
    let previewStatus: PreviewStatus = "pending";
    try {
      await deps.sendPreviewMessage(documentId);
    } catch {
      previewStatus = "failed";
      try {
        await deps.withTransaction(async (tx) => {
          await deps.updatePreviewStatus(
            { documentId, previewStatus: "failed" },
            tx,
          );
          await deps.insertAuditEvent(
            { ...actor, result: "failed", documentId, errorCategory: "queue_failed" },
            tx,
          );
        });
      } catch {
        logOperationEvent({
          event: `${UPLOAD_LOG_EVENT}_preview_status`,
          correlationId,
          result: "failed",
          errorCategory: "database_failed",
          actorSubjectId: user.id,
          documentId,
        });
      }
      // 資料の登録自体は成功しているため、`document_upload`とは別のeventとして記録する。
      logOperationEvent({
        event: `${UPLOAD_LOG_EVENT}_preview_queue`,
        correlationId,
        result: "failed",
        errorCategory: "queue_failed",
        actorSubjectId: user.id,
        documentId,
      });
    }

    logOperationEvent({
      event: UPLOAD_LOG_EVENT,
      correlationId,
      result: "success",
      actorSubjectId: user.id,
      documentId,
    });

    // 設計 §10.1(10): 資料表示画面へ案内する。
    const success: UploadSuccessBody = {
      documentId,
      documentUrl: `/documents/${documentId}`,
      previewStatus,
      warnings: inspection.warningCodes.map((code) => ({
        code,
        message: htmlWarningMessage(code),
      })),
      correlationId,
    };
    return jsonResponse(success, 201, { Location: success.documentUrl });
  } catch (error) {
    if (error instanceof Response) {
      // `requireUser`などがthrowするResponseは利用者向けの結果なのでそのまま伝える。
      throw error;
    }
    await releaseSlot();
    return reject({
      status: 500,
      message: "アップロードに失敗しました。時間をおいてやり直してください。",
      errorCategory: "internal_error",
      result: "failed",
    });
  }
}
