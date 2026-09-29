/**
 * プレビュー画像の配信処理本体(設計 §5.2, §5.3, §7.3, §9.1, §13, §14、
 * QUESTIONS.md Q-030)。
 *
 * - Blob(`preview/{documentId}/preview.jpg`)は公開せず、短期SASも発行しない。
 *   Webが認証・認可をしたうえでBlobを読み、同一オリジンの応答として中継する
 *   (Q-030)。Blobキーは応答・ログのどちらにも出さない(設計 §14, §15.2)。
 * - 認可は`/documents/:documentId/preview-status`と同じ順序
 *   (`requireUser` → `z.uuid()` → `findDocumentById` → `assertCanViewDocument`)。
 *   削除済み・未存在・UUID形式でない`documentId`は同じ404にする(設計 §10.3(2), §14)。
 * - `preview_status`が`ready`でない資料(`pending`/`failed`/不明)も同じ404にする。
 *   画像が無いことは状態routeで分かるため、ここで状態の違いを区別して返さない。
 * - Blob取得にはtimeoutを付け(`PREVIEW_IMAGE_DOWNLOAD_TIMEOUT_MS`)、利用者が
 *   要求を中断した場合(`request.signal`)もBlob取得を止める。失敗時は画像を
 *   返さず(fail closed)、運用ログへ分類だけを記録する。Blob未存在は資料未存在と
 *   同じ404、それ以外(timeout・通信失敗・JPEGでない内容)は503にする。
 * - GET専用でDB・Blobを更新しないため`assertSameOrigin`は呼ばない(AGENTS.md 7項は
 *   cookie認証のmutation actionが対象)。
 * - プレビュー画像の参照は監査しない(Q-032、設計 §15.1。初期画面・管理画面の
 *   カードごとに呼ばれ、監査行を作ると本来の閲覧監査の分析を妨げる)。
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { assertCanViewDocument } from "~/lib/auth/authorization.server";
import {
  findDocumentById,
  type DocumentRecord,
} from "~/lib/db/documents.server";
import { logOperationEvent } from "~/lib/log.server";
import { securityHeaders } from "~/lib/security.server";
import { requireUser } from "~/lib/session.server";
import {
  downloadDocumentPreview,
  getDocumentsContainerClientForWeb,
  PREVIEW_BLOB_CONTENT_TYPE,
  type StorageOperationOptions,
} from "~/lib/storage.server";

/** ログの処理名(設計 §15.2)。固定文字列だけを使う。 */
export const PREVIEW_IMAGE_LOG_EVENT = "document_preview_image";

/**
 * Blob取得のtimeout(ミリ秒)。カード画像のため、Storage操作の既定(10秒)より
 * 短くして、遅延時に接続を長く保持しない。
 */
export const PREVIEW_IMAGE_DOWNLOAD_TIMEOUT_MS = 5_000;

const NOT_FOUND_MESSAGE = "資料が見つかりません";
const UNAVAILABLE_MESSAGE = "プレビュー画像を取得できません";

const documentIdParamSchema = z.uuid();

/** 外部への依存。既定は実装本体で、テストからだけ差し替える。 */
export type PreviewImageDependencies = {
  findDocumentById(documentId: string): Promise<DocumentRecord | null>;
  downloadPreview(
    documentId: string,
    options: StorageOperationOptions,
  ): Promise<Buffer>;
};

export const defaultPreviewImageDependencies: PreviewImageDependencies = {
  findDocumentById: (documentId) => findDocumentById(documentId),
  downloadPreview: (documentId, options) =>
    downloadDocumentPreview(
      getDocumentsContainerClientForWeb(),
      documentId,
      options,
    ),
};

function notFound(): Response {
  return new Response(NOT_FOUND_MESSAGE, {
    status: 404,
    headers: {
      ...securityHeaders(),
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}

function unavailable(): Response {
  return new Response(UNAVAILABLE_MESSAGE, {
    status: 503,
    headers: {
      ...securityHeaders(),
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}

/**
 * Blobそのものが存在しない(`BlobNotFound`)ときだけtrue。container不在などは含めない。
 * SDKのpackage間で`RestError`のclassが一致する保証が無いため、`instanceof`ではなく
 * `statusCode`と`code`だけで判定する。
 */
function isBlobNotFoundError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const { statusCode, code } = error as { statusCode?: unknown; code?: unknown };
  return statusCode === 404 && code === "BlobNotFound";
}

/**
 * JPEGのSOIマーカー(`FF D8 FF`)で始まるかだけを確認する。Preview Jobが保存した
 * 内容以外(空・別形式)を`image/jpeg`として中継しないための最小限の検査。
 */
function looksLikeJpeg(content: Buffer): boolean {
  return (
    content.length >= 3 &&
    content[0] === 0xff &&
    content[1] === 0xd8 &&
    content[2] === 0xff
  );
}

/**
 * プレビュー画像要求を処理する。未認証は`requireUser`がログイン画面への
 * redirectをthrowし、閲覧不可(削除済み・未存在)は`assertCanViewDocument`が
 * 404をthrowする。それ以外の拒否・失敗は画像を含まない`Response`を返す。
 */
export async function handlePreviewImageRequest(
  request: Request,
  params: { documentId?: string | undefined },
  overrides: Partial<PreviewImageDependencies> = {},
): Promise<Response> {
  const deps = { ...defaultPreviewImageDependencies, ...overrides };

  // 未ログインならここで`/auth/login?returnTo=...`へredirectする。
  const user = await requireUser(request);

  // UUID形式でない`documentId`はDBへ触れる前に拒否し、未存在と同じ404経路へ合流させる。
  const parsedDocumentId = documentIdParamSchema.safeParse(params.documentId);
  const document = parsedDocumentId.success
    ? await deps.findDocumentById(parsedDocumentId.data)
    : null;

  // 資料表示画面・プレビュー状態routeと同じ認可(閲覧可否)。削除済み・未存在は同じ404。
  assertCanViewDocument(user, document);
  if (!document) {
    // 上の`assertCanViewDocument`が必ず例外を投げるため到達しないが、
    // 非nullを型として確定させるためのfail closedな保険。
    return notFound();
  }

  // 生成済みでない資料には画像が無い。状態の違いは区別せず同じ404にする。
  if (document.previewStatus !== "ready") {
    return notFound();
  }

  let content: Buffer;
  try {
    content = await deps.downloadPreview(document.id, {
      timeoutMs: PREVIEW_IMAGE_DOWNLOAD_TIMEOUT_MS,
      abortSignal: request.signal,
    });
  } catch (error) {
    const blobMissing = isBlobNotFoundError(error);
    // Blobキー・例外本文(URLを含み得る)は記録せず、分類だけを残す(設計 §15.2)。
    logOperationEvent({
      event: PREVIEW_IMAGE_LOG_EVENT,
      correlationId: randomUUID(),
      result: "failed",
      errorCategory: blobMissing ? "document_not_found" : "storage_failed",
      actorSubjectId: user.id,
      documentId: document.id,
    });
    return blobMissing ? notFound() : unavailable();
  }

  if (!looksLikeJpeg(content)) {
    logOperationEvent({
      event: PREVIEW_IMAGE_LOG_EVENT,
      correlationId: randomUUID(),
      result: "failed",
      errorCategory: "preview_failed",
      actorSubjectId: user.id,
      documentId: document.id,
    });
    return unavailable();
  }

  return new Response(new Uint8Array(content), {
    status: 200,
    headers: {
      // `Cache-Control: no-store`(削除後にブラウザ・中間キャッシュへ画像を残さない)と
      // `X-Content-Type-Options: nosniff`は`securityHeaders()`が付ける。
      ...securityHeaders(),
      "Content-Type": PREVIEW_BLOB_CONTENT_TYPE,
      "Content-Length": String(content.length),
      "Content-Disposition": "inline",
      // 他オリジンのページから`<img>`等で読み込ませない。
      "Cross-Origin-Resource-Policy": "same-origin",
    },
  });
}
