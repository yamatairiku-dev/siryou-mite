/**
 * `documents`テーブルのrepository(設計 §7.4, §11.1, §12.1)。
 *
 * SQLはこのファイルの中だけに置き、値は必ずプレースホルダー(`$1`)で渡す
 * (利用者入力をSQL文字列へ連結しない)。認可判定そのものはloader/action側で
 * 行うが、所有者条件を渡し忘れられないよう、所有者スコープが必要な操作は
 * 所有者IDを必須引数にした専用関数として公開する。
 */
import { z } from "zod";
import { getPool, type Queryable } from "~/lib/db/pool.server";

export type DocumentStatus = "active" | "deleted";
export type PreviewStatus = "pending" | "ready" | "failed";

/** `documents`の1行(migrationのカラム定義と1対1に対応する)。 */
export type DocumentRecord = {
  id: string;
  ownerSubjectId: string;
  /** 以下6項目は削除時にNULLへ消去される(設計 §12.1)。 */
  ownerEmailAtUpload: string | null;
  originalFileName: string | null;
  title: string | null;
  byteSize: number | null;
  previewStatus: PreviewStatus | null;
  warningCodes: string[] | null;
  status: DocumentStatus;
  createdAt: Date;
  deletedAt: Date | null;
  deletedBySubjectId: string | null;
  blobCleanupPending: boolean;
};

export type DocumentListPage = {
  documents: DocumentRecord[];
  /** 次ページがある場合だけ文字列。無い場合は`null`。 */
  nextCursor: string | null;
};

/** 所有者別の使用量(設計 §6.1の件数・容量上限の判定に使う)。 */
export type DocumentUsage = {
  documentCount: number;
  totalByteSize: number;
};

/** cursorが壊れている・改ざんされている場合に投げる。 */
export class InvalidCursorError extends Error {
  constructor() {
    super("一覧の続きを取得できませんでした");
    this.name = "InvalidCursorError";
  }
}

const subjectIdSchema = z.string().trim().min(1).max(200);

const createDocumentInputSchema = z
  .object({
    /** 省略時はDBの`gen_random_uuid()`が採番する(設計 §10.1はアプリ側発行)。 */
    id: z.uuid().optional(),
    ownerSubjectId: subjectIdSchema,
    ownerEmailAtUpload: z.email().max(320).nullable().default(null),
    originalFileName: z.string().min(1).max(1000).nullable().default(null),
    title: z.string().max(1000).nullable().default(null),
    byteSize: z.number().int().min(0).nullable().default(null),
    previewStatus: z
      .enum(["pending", "ready", "failed"])
      .nullable()
      .default("pending"),
    warningCodes: z.array(z.string().min(1).max(100)).max(100).default([]),
  })
  .strict();

export type CreateDocumentInput = z.input<typeof createDocumentInputSchema>;

const listOptionsSchema = z
  .object({
    ownerSubjectId: subjectIdSchema,
    /** 初期画面は20件ずつ表示する(設計 §5.2)。 */
    limit: z.number().int().min(1).max(100).default(20),
    cursor: z.string().max(500).nullable().default(null),
  })
  .strict();

export type ListDocumentsByOwnerOptions = z.input<typeof listOptionsSchema>;

const cursorPayloadSchema = z
  .object({
    createdAt: z.iso.datetime({ offset: true }),
    id: z.uuid(),
  })
  .strict();

/**
 * keyset paginationのcursor。`(created_at, id)`だけを持ち、署名しない。
 * cursorを改ざんしても、一覧SQLが常に`owner_subject_id`で絞り込むため
 * 他人の資料は返らない(位置の指定だけに使う値)。
 */
export function encodeDocumentCursor(document: {
  createdAt: Date;
  id: string;
}): string {
  const payload = JSON.stringify({
    createdAt: document.createdAt.toISOString(),
    id: document.id,
  });
  return Buffer.from(payload, "utf8").toString("base64url");
}

export function decodeDocumentCursor(value: string): {
  createdAt: string;
  id: string;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new InvalidCursorError();
  }

  const result = cursorPayloadSchema.safeParse(parsed);
  if (!result.success) {
    throw new InvalidCursorError();
  }
  return result.data;
}

/**
 * SELECTで取得するカラム。固定文字列だけを組み立て、利用者入力は含めない。
 */
const documentColumns = `id,
       owner_subject_id,
       owner_email_at_upload,
       original_file_name,
       title,
       byte_size,
       preview_status,
       warning_codes,
       status,
       created_at,
       deleted_at,
       deleted_by_subject_id,
       blob_cleanup_pending`;

type DocumentRow = {
  id: string;
  owner_subject_id: string;
  owner_email_at_upload: string | null;
  original_file_name: string | null;
  title: string | null;
  /** BIGINTは`pg`が精度を落とさないよう文字列で返す。 */
  byte_size: string | null;
  preview_status: string | null;
  warning_codes: string[] | null;
  status: string;
  created_at: Date;
  deleted_at: Date | null;
  deleted_by_subject_id: string | null;
  blob_cleanup_pending: boolean;
};

function toByteSize(value: string | null): number | null {
  if (value === null) {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    // 10MB上限(設計 §6.1)の運用でここへ来ることはないが、静かに丸めない。
    throw new Error("byte_size がJavaScriptの安全な整数の範囲を超えています");
  }
  return parsed;
}

function toDocumentRecord(row: DocumentRow): DocumentRecord {
  return {
    id: row.id,
    ownerSubjectId: row.owner_subject_id,
    ownerEmailAtUpload: row.owner_email_at_upload,
    originalFileName: row.original_file_name,
    title: row.title,
    byteSize: toByteSize(row.byte_size),
    previewStatus: row.preview_status as PreviewStatus | null,
    warningCodes: row.warning_codes,
    status: row.status as DocumentStatus,
    createdAt: row.created_at,
    deletedAt: row.deleted_at,
    deletedBySubjectId: row.deleted_by_subject_id,
    blobCleanupPending: row.blob_cleanup_pending,
  };
}

function firstRecord(rows: DocumentRow[]): DocumentRecord | null {
  const row = rows[0];
  return row ? toDocumentRecord(row) : null;
}

/**
 * 資料を1件取得する。資料IDがUUIDでない場合はfail closedで`null`を返す。
 * 削除済み(`status = 'deleted'`)の資料も返すため、閲覧可否は呼び出し側が
 * `status`で判定する(設計 §10.3(2))。
 */
export async function findDocumentById(
  documentId: string,
  executor: Queryable = getPool(),
): Promise<DocumentRecord | null> {
  if (!z.uuid().safeParse(documentId).success) {
    return null;
  }

  const result = await executor.query<DocumentRow>(
    `SELECT ${documentColumns}
       FROM documents
      WHERE id = $1`,
    [documentId],
  );
  return firstRecord(result.rows);
}

/**
 * 所有者の`active`な資料を新しい順に返す(設計 §5.2)。
 * 並び順は`(created_at DESC, id DESC)`で、同時刻の資料でも重複・欠落しない。
 */
export async function listDocumentsByOwner(
  options: ListDocumentsByOwnerOptions,
  executor: Queryable = getPool(),
): Promise<DocumentListPage> {
  const { ownerSubjectId, limit, cursor } = listOptionsSchema.parse(options);
  // 次ページの有無を判定するため1件多く取得する。
  const fetchLimit = limit + 1;

  let result;
  if (cursor === null) {
    result = await executor.query<DocumentRow>(
      `SELECT ${documentColumns}
         FROM documents
        WHERE owner_subject_id = $1
          AND status = 'active'
        ORDER BY created_at DESC, id DESC
        LIMIT $2`,
      [ownerSubjectId, fetchLimit],
    );
  } else {
    const position = decodeDocumentCursor(cursor);
    result = await executor.query<DocumentRow>(
      `SELECT ${documentColumns}
         FROM documents
        WHERE owner_subject_id = $1
          AND status = 'active'
          AND (created_at, id) < ($2::timestamptz, $3::uuid)
        ORDER BY created_at DESC, id DESC
        LIMIT $4`,
      [ownerSubjectId, position.createdAt, position.id, fetchLimit],
    );
  }

  const rows = result.rows.slice(0, limit);
  const documents = rows.map(toDocumentRecord);
  const hasNext = result.rows.length > limit;
  const last = documents[documents.length - 1];

  return {
    documents,
    nextCursor: hasNext && last ? encodeDocumentCursor(last) : null,
  };
}

/**
 * 資料を`active`として登録する(設計 §10.1(7))。
 *
 * `executor`に既定値を持たせない。業務更新(この関数)と監査保存
 * (`insertAuditEvent`)は同じDBトランザクションで行う必要があり(設計
 * §15.1)、既定値があると呼び出し側が`tx`を渡し忘れても`getPool()`で動いて
 * しまうため、渡し忘れを型エラーにする。
 */
export async function createDocument(
  input: CreateDocumentInput,
  executor: Queryable,
): Promise<DocumentRecord> {
  const values = createDocumentInputSchema.parse(input);

  const result = await executor.query<DocumentRow>(
    `INSERT INTO documents (id,
                            owner_subject_id,
                            owner_email_at_upload,
                            original_file_name,
                            title,
                            byte_size,
                            preview_status,
                            warning_codes,
                            status)
     VALUES (COALESCE($1::uuid, gen_random_uuid()),
             $2, $3, $4, $5, $6, $7, $8, 'active')
     RETURNING ${documentColumns}`,
    [
      values.id ?? null,
      values.ownerSubjectId,
      values.ownerEmailAtUpload,
      values.originalFileName,
      values.title,
      values.byteSize,
      values.previewStatus,
      values.warningCodes,
    ],
  );

  const record = firstRecord(result.rows);
  if (!record) {
    throw new Error("資料を登録できませんでした");
  }
  return record;
}

/**
 * `active`から`deleted`への状態遷移(設計 §11.1)。
 * 機微・表示用項目を同時にNULLへ消去し、Blob削除の再試行対象として印を付ける
 * (設計 §10.4(3)(5), §12.1)。物理削除はしない(soft delete)。
 */
async function markDeleted(
  executor: Queryable,
  documentId: string,
  deletedBySubjectId: string,
  ownerSubjectId: string | null,
): Promise<DocumentRecord | null> {
  if (!z.uuid().safeParse(documentId).success) {
    return null;
  }

  const result = await executor.query<DocumentRow>(
    `UPDATE documents
        SET status = 'deleted',
            deleted_at = now(),
            deleted_by_subject_id = $2,
            owner_email_at_upload = NULL,
            original_file_name = NULL,
            title = NULL,
            byte_size = NULL,
            preview_status = NULL,
            warning_codes = NULL,
            blob_cleanup_pending = true
      WHERE id = $1
        AND status = 'active'
        AND ($3::text IS NULL OR owner_subject_id = $3::text)
     RETURNING ${documentColumns}`,
    [documentId, deletedBySubjectId, ownerSubjectId],
  );
  return firstRecord(result.rows);
}

/**
 * 所有者自身による削除。所有者IDが一致しない資料は更新されず`null`を返す
 * (呼び出し側が所有者条件を渡し忘れられないよう、引数を必須にしている)。
 * `executor`にも既定値を持たせず、削除監査と同じ`tx`の渡し忘れを型エラーに
 * する(設計 §15.1)。
 */
export async function deleteDocumentAsOwner(
  params: { documentId: string; ownerSubjectId: string },
  executor: Queryable,
): Promise<DocumentRecord | null> {
  const ownerSubjectId = subjectIdSchema.parse(params.ownerSubjectId);
  return markDeleted(
    executor,
    params.documentId,
    ownerSubjectId,
    ownerSubjectId,
  );
}

/**
 * 管理者による強制削除(設計 §5.6)。所有者では絞り込まないため、`Admin`
 * ロールの確認を済ませた呼び出し側からだけ使う。削除実行者は監査と
 * `deleted_by_subject_id`へ残す。`executor`にも既定値を持たせず、削除監査と
 * 同じ`tx`の渡し忘れを型エラーにする(設計 §15.1)。
 */
export async function deleteDocumentAsAdmin(
  params: { documentId: string; adminSubjectId: string },
  executor: Queryable,
): Promise<DocumentRecord | null> {
  const adminSubjectId = subjectIdSchema.parse(params.adminSubjectId);
  return markDeleted(executor, params.documentId, adminSubjectId, null);
}

/** Blob削除が完了した資料の再試行フラグを下ろす(設計 §10.4(4)(5))。 */
export async function markBlobCleanupCompleted(
  documentId: string,
  executor: Queryable = getPool(),
): Promise<boolean> {
  if (!z.uuid().safeParse(documentId).success) {
    return false;
  }

  const result = await executor.query<{ id: string }>(
    `UPDATE documents
        SET blob_cleanup_pending = false
      WHERE id = $1
        AND blob_cleanup_pending = true
     RETURNING id`,
    [documentId],
  );
  return result.rows.length > 0;
}

type UsageRow = { document_count: string; total_byte_size: string | null };

function toUsage(row: UsageRow | undefined): DocumentUsage {
  return {
    documentCount: Number(row?.document_count ?? 0),
    totalByteSize: toByteSize(row?.total_byte_size ?? null) ?? 0,
  };
}

/** 利用者単位の件数・合計byte数(設計 §6.1)。上限判定はトランザクション内で行う。 */
export async function getOwnerUsage(
  ownerSubjectId: string,
  executor: Queryable = getPool(),
): Promise<DocumentUsage> {
  const owner = subjectIdSchema.parse(ownerSubjectId);
  const result = await executor.query<UsageRow>(
    `SELECT count(*)::text AS document_count,
            COALESCE(sum(byte_size), 0)::text AS total_byte_size
       FROM documents
      WHERE owner_subject_id = $1
        AND status = 'active'`,
    [owner],
  );
  return toUsage(result.rows[0]);
}

/** システム全体の件数・合計byte数(設計 §6.1のシステム上限・警告閾値)。 */
export async function getSystemUsage(
  executor: Queryable = getPool(),
): Promise<DocumentUsage> {
  const result = await executor.query<UsageRow>(
    `SELECT count(*)::text AS document_count,
            COALESCE(sum(byte_size), 0)::text AS total_byte_size
       FROM documents
      WHERE status = 'active'`,
  );
  return toUsage(result.rows[0]);
}
