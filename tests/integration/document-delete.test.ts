import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { ContainerClient } from "@azure/storage-blob";
import type { Client } from "pg";
import { insertAuditEvent } from "~/lib/db/audit-events.server";
import {
  createDocument,
  deleteDocumentAsAdmin,
  deleteDocumentAsOwner,
  findDocumentById,
  markBlobCleanupCompleted,
  type DocumentRecord,
} from "~/lib/db/documents.server";
import {
  closePool,
  getPool,
  runInTransaction,
  type Queryable,
} from "~/lib/db/pool.server";
import {
  handleDocumentDeletion,
  type DocumentDeleteDependencies,
} from "~/lib/documents/delete.server";
import { createUserSession, type AppUser } from "~/lib/session.server";
import {
  createBlobServiceClient,
  deleteDocumentHtml,
  deleteDocumentPreview,
  documentHtmlBlobKey,
  documentPreviewBlobKey,
  getDocumentsContainerClient,
  uploadDocumentHtml,
  uploadDocumentPreview,
} from "../../services/shared/storage.js";
import { dropSchema, migrateFreshSchema, newClient } from "./helpers/schema.js";
import {
  requireStorageConnectionString,
  uniqueTestName,
} from "./helpers/storage.js";

/**
 * T14 結合テスト: 削除(設計 §10.4, §11.1, §12.1, §15.1, §18.2)。
 *
 * 実際のPostgreSQL(テスト専用schema)とAzurite(テスト専用container)に対して
 * 削除actionの処理本体をそのまま実行し、状態遷移・機微項目の消去・
 * `blob_cleanup_pending`・削除監査の同一トランザクション性・認可を検証する。
 */

const schema = "t14_it_document_delete";
const origin = "http://localhost:3000";

const owner: AppUser = {
  id: "oid-integration-owner",
  tenantId: "tenant-integration",
  name: "結合テスト所有者",
  email: "owner@example.com",
  roles: ["User"],
  groups: ["ZAA535-A"],
};

const otherUser: AppUser = {
  id: "oid-integration-other",
  tenantId: "tenant-integration",
  name: "結合テスト他人",
  email: "other@example.com",
  roles: ["User"],
  groups: ["ZAA535-A"],
};

const adminUser: AppUser = {
  id: "oid-integration-admin",
  tenantId: "tenant-integration",
  name: "結合テスト管理者",
  email: "admin@example.com",
  roles: ["Admin"],
  groups: ["ZAA535-A"],
};

let client: Client;
let containerClient: ContainerClient;

beforeAll(async () => {
  await migrateFreshSchema(schema);
  client = newClient();
  await client.connect();
  await client.query(`SET search_path TO "${schema}"`);

  containerClient = getDocumentsContainerClient(
    createBlobServiceClient({
      kind: "connectionString",
      connectionString: requireStorageConnectionString(),
    }),
    uniqueTestName("t14-documents"),
  );
  await containerClient.createIfNotExists();
}, 30_000);

afterAll(async () => {
  await closePool();
  await client.end();
  await dropSchema(schema);
  await containerClient?.deleteIfExists();
}, 30_000);

beforeEach(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  await client.query("TRUNCATE audit_events, documents");
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** テスト専用schemaへ`search_path`を向けたトランザクション。 */
async function withSchemaTransaction<T>(
  run: (tx: Queryable) => Promise<T>,
): Promise<T> {
  const poolClient = await getPool().connect();
  try {
    return await runInTransaction(poolClient, async (tx) => {
      await tx.query(`SET LOCAL search_path TO "${schema}"`);
      return run(tx);
    });
  } finally {
    poolClient.release();
  }
}

function integrationDependencies(
  overrides: Partial<DocumentDeleteDependencies> = {},
): Partial<DocumentDeleteDependencies> {
  return {
    withTransaction: withSchemaTransaction,
    findDocumentById,
    deleteAsOwner: deleteDocumentAsOwner,
    deleteAsAdmin: deleteDocumentAsAdmin,
    insertAuditEvent,
    deleteHtml: (documentId) => deleteDocumentHtml(containerClient, documentId),
    deletePreview: (documentId) =>
      deleteDocumentPreview(containerClient, documentId),
    markBlobCleanupCompleted: (documentId) =>
      markBlobCleanupCompleted(documentId, client),
    ...overrides,
  };
}

/** `active`な資料1件とそのHTML・プレビューBlobを用意する。 */
async function addDocument(): Promise<DocumentRecord> {
  const document = await createDocument(
    {
      ownerSubjectId: owner.id,
      ownerEmailAtUpload: owner.email,
      originalFileName: "結合テスト資料.html",
      title: "結合テスト資料",
      byteSize: 1024,
      warningCodes: ["script_disabled"],
    },
    client,
  );
  await uploadDocumentHtml(
    containerClient,
    document.id,
    Buffer.from("<!doctype html><html><body>本文</body></html>", "utf8"),
  );
  await uploadDocumentPreview(
    containerClient,
    document.id,
    Buffer.from("dummy-jpeg", "utf8"),
  );
  return document;
}

async function deleteAsUser(
  user: AppUser,
  documentId: string,
  overrides: Partial<DocumentDeleteDependencies> = {},
) {
  const cookie =
    (await createUserSession(user)).headers.get("Set-Cookie") ?? "";
  return handleDocumentDeletion(
    new Request(`${origin}/documents/${documentId}/delete`, {
      method: "POST",
      headers: { Cookie: cookie, Origin: origin },
    }),
    { documentId },
    integrationDependencies(overrides),
  );
}

async function documentRow(documentId: string) {
  const result = await client.query(
    `SELECT owner_subject_id, owner_email_at_upload, original_file_name, title,
            byte_size, preview_status, warning_codes, status, created_at,
            deleted_at, deleted_by_subject_id, blob_cleanup_pending
       FROM documents WHERE id = $1`,
    [documentId],
  );
  return result.rows[0];
}

async function auditRows() {
  const result = await client.query(
    `SELECT action, result, document_id, actor_subject_id, actor_email_at_event,
            error_category, correlation_id, retain_until
       FROM audit_events ORDER BY occurred_at, id`,
  );
  return result.rows;
}

describe("所有者による削除(設計 §10.4, §11.1, §12.1)", () => {
  it("activeからdeletedへ遷移し、削除時に消去する項目をNULLにして、削除監査を残す", async () => {
    const document = await addDocument();

    const result = await deleteAsUser(owner, document.id);

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(303);
    expect((result as Response).headers.get("Location")).toBe("/app");

    const row = await documentRow(document.id);
    expect(row).toMatchObject({
      // 1年間保持する項目(設計 §10.4(6))。
      owner_subject_id: owner.id,
      status: "deleted",
      deleted_by_subject_id: owner.id,
      // 削除時に消去する項目(設計 §12.1)。
      owner_email_at_upload: null,
      original_file_name: null,
      title: null,
      byte_size: null,
      preview_status: null,
      warning_codes: null,
    });
    expect(row?.["deleted_at"]).toBeInstanceOf(Date);
    expect(row?.["created_at"]).toBeInstanceOf(Date);

    const audits = await auditRows();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: "delete",
      result: "success",
      document_id: document.id,
      actor_subject_id: owner.id,
      error_category: null,
    });

    // Blob削除まで成功したので再試行フラグは下りている(設計 §10.4(4))。
    expect(row?.["blob_cleanup_pending"]).toBe(false);
    expect(
      await containerClient
        .getBlobClient(documentHtmlBlobKey(document.id))
        .exists(),
    ).toBe(false);
    expect(
      await containerClient
        .getBlobClient(documentPreviewBlobKey(document.id))
        .exists(),
    ).toBe(false);
  });

  it("Blob削除に失敗しても削除は成功し、blob_cleanup_pendingが立ったまま残る", async () => {
    const document = await addDocument();

    const result = await deleteAsUser(owner, document.id, {
      deleteHtml: async () => {
        throw new Error("storage unavailable");
      },
    });

    expect((result as Response).status).toBe(303);

    const row = await documentRow(document.id);
    // 閲覧禁止は維持され、定期保守Job(T19)が再試行できる状態で残る(設計 §10.4(5))。
    expect(row).toMatchObject({ status: "deleted", blob_cleanup_pending: true });
    expect(
      await containerClient
        .getBlobClient(documentHtmlBlobKey(document.id))
        .exists(),
    ).toBe(true);
  });

  it("削除済み資料の再削除は404になり、削除監査(success)を増やさない", async () => {
    const document = await addDocument();
    await deleteAsUser(owner, document.id);

    const denial = (await deleteAsUser(owner, document.id).catch(
      (error: Response) => error,
    )) as Response;

    expect(denial.status).toBe(404);
    const audits = await auditRows();
    expect(audits.map((row) => `${row["action"]}:${row["result"]}`)).toEqual([
      "delete:success",
      "delete:denied",
    ]);
    expect(audits[1]).toMatchObject({
      error_category: "document_not_found",
      document_id: null,
    });
  });
});

describe("認可(設計 §4.2, §10.4(2))", () => {
  it("一般ユーザーは他人の資料を削除できず、資料もBlobも残る", async () => {
    const document = await addDocument();

    const denial = (await deleteAsUser(otherUser, document.id).catch(
      (error: Response) => error,
    )) as Response;

    expect(denial.status).toBe(403);
    expect((await findDocumentById(document.id, client))?.status).toBe("active");
    expect(
      await containerClient
        .getBlobClient(documentHtmlBlobKey(document.id))
        .exists(),
    ).toBe(true);

    const audits = await auditRows();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: "delete",
      result: "denied",
      error_category: "not_authorized",
      actor_subject_id: otherUser.id,
      document_id: document.id,
    });
  });

  it("所有者条件付き削除は、他人のIDでは1行も更新しない", async () => {
    const document = await addDocument();

    // 認可を通過したと仮定しても、SQL側の所有者条件で更新されない。
    const updated = await withSchemaTransaction((tx) =>
      deleteDocumentAsOwner(
        { documentId: document.id, ownerSubjectId: otherUser.id },
        tx,
      ),
    );

    expect(updated).toBeNull();
    expect((await findDocumentById(document.id, client))?.status).toBe("active");
  });

  it("管理者は他人の資料を強制削除でき、deleteとして監査される", async () => {
    const document = await addDocument();

    const result = await deleteAsUser(adminUser, document.id);

    expect((result as Response).status).toBe(303);
    const row = await documentRow(document.id);
    expect(row).toMatchObject({
      status: "deleted",
      owner_subject_id: owner.id,
      deleted_by_subject_id: adminUser.id,
    });

    // 削除は所有者・管理者を問わず`delete`で記録する(監査履歴で`action = delete`を
    // 絞れば全削除が揃う)。強制削除は実行者と`owner_subject_id`の不一致で判別する。
    const audits = await auditRows();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: "delete",
      result: "success",
      document_id: document.id,
      actor_subject_id: adminUser.id,
    });
    expect(row?.["owner_subject_id"]).not.toBe(audits[0]?.["actor_subject_id"]);
  });
});

describe("監査と業務更新の同一トランザクション(設計 §15.1)", () => {
  it("削除監査の保存に失敗したらrollbackし、資料はactiveのまま残る", async () => {
    const document = await addDocument();

    const result = await deleteAsUser(owner, document.id, {
      insertAuditEvent: async (input, tx) => {
        if (input.result === "success") {
          throw new Error("audit write failed");
        }
        return insertAuditEvent(input, tx);
      },
    });

    // 利用者には相関ID付きの失敗を返す(設計 §14)。
    expect(result).not.toBeInstanceOf(Response);
    const failure = result as {
      data: { message: string; correlationId: string };
    };
    expect(failure.data.message).toContain("削除できませんでした");

    const row = await documentRow(document.id);
    expect(row).toMatchObject({
      status: "active",
      original_file_name: "結合テスト資料.html",
      blob_cleanup_pending: false,
    });
    // 削除成功の監査も残らない(失敗監査だけが残る)。
    const audits = await auditRows();
    expect(audits.map((auditRow) => auditRow["result"])).toEqual(["failed"]);
    expect(audits[0]).toMatchObject({ error_category: "database_failed" });
    // commit前に失敗しているため、Blobは削除されない。
    expect(
      await containerClient
        .getBlobClient(documentHtmlBlobKey(document.id))
        .exists(),
    ).toBe(true);
  });

  it("削除監査は業務更新と同じトランザクションで保存され、1年間の保持期限を持つ", async () => {
    const document = await addDocument();
    await deleteAsUser(owner, document.id);

    const audits = await auditRows();
    const retainUntil = audits[0]?.["retain_until"] as Date;
    const createdAt = (await documentRow(document.id))?.["deleted_at"] as Date;

    expect(retainUntil.getTime()).toBeGreaterThan(createdAt.getTime());
    // 監査へメールアドレスは操作時点の値として残るが、ファイル名・タイトルは残さない。
    const serialized = JSON.stringify(audits);
    expect(serialized).not.toContain("結合テスト資料");
  });
});
