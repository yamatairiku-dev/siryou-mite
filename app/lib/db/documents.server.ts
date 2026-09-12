/**
 * `documents` repositoryのWeb向け薄いラッパー(設計 §7.4, §11.1, §12.1)。
 *
 * SQLとZod schemaの実処理は`services/shared/db/documents.ts`にあり、Display
 * (閲覧時の`active`再確認)などのserviceも同じ実装を使う(docs/ARCHITECTURE.md)。
 * このファイルはWeb固有の関心事、すなわち読み取り系で`executor`を省略したときに
 * `getPool()`を使う既定値だけを足す。
 *
 * 更新系(`createDocument`・`deleteDocumentAsOwner`・`deleteDocumentAsAdmin`・
 * `updateDocumentPreviewStatus`)は既定値を持たない。監査と同じトランザクションで
 * 保存する必要があるため(設計 §15.1)、`tx`の渡し忘れを型エラーにする。
 */
import { getPool, type Queryable } from "~/lib/db/pool.server";
import {
  findDocumentById as findDocumentByIdWith,
  getOwnerUsage as getOwnerUsageWith,
  getSystemUsage as getSystemUsageWith,
  listDocumentsByOwner as listDocumentsByOwnerWith,
  markBlobCleanupCompleted as markBlobCleanupCompletedWith,
  type DocumentListPage,
  type DocumentRecord,
  type DocumentUsage,
  type ListDocumentsByOwnerOptions,
} from "../../../services/shared/db/documents";

export {
  createDocument,
  decodeDocumentCursor,
  deleteDocumentAsAdmin,
  deleteDocumentAsOwner,
  encodeDocumentCursor,
  InvalidCursorError,
  updateDocumentPreviewStatus,
} from "../../../services/shared/db/documents";
export type {
  CreateDocumentInput,
  DocumentListPage,
  DocumentRecord,
  DocumentStatus,
  DocumentUsage,
  ListDocumentsByOwnerOptions,
  PreviewStatus,
} from "../../../services/shared/db/documents";

/** 資料を1件取得する(削除済みも返すため、閲覧可否は呼び出し側が`status`で判定する)。 */
export async function findDocumentById(
  documentId: string,
  executor: Queryable = getPool(),
): Promise<DocumentRecord | null> {
  return findDocumentByIdWith(documentId, executor);
}

/** 所有者の`active`な資料を新しい順に返す(設計 §5.2)。 */
export async function listDocumentsByOwner(
  options: ListDocumentsByOwnerOptions,
  executor: Queryable = getPool(),
): Promise<DocumentListPage> {
  return listDocumentsByOwnerWith(options, executor);
}

/** Blob削除が完了した資料の再試行フラグを下ろす(設計 §10.4(4)(5))。 */
export async function markBlobCleanupCompleted(
  documentId: string,
  executor: Queryable = getPool(),
): Promise<boolean> {
  return markBlobCleanupCompletedWith(documentId, executor);
}

/** 利用者単位の件数・合計byte数(設計 §6.1)。 */
export async function getOwnerUsage(
  ownerSubjectId: string,
  executor: Queryable = getPool(),
): Promise<DocumentUsage> {
  return getOwnerUsageWith(ownerSubjectId, executor);
}

/** システム全体の件数・合計byte数(設計 §6.1)。 */
export async function getSystemUsage(
  executor: Queryable = getPool(),
): Promise<DocumentUsage> {
  return getSystemUsageWith(executor);
}
