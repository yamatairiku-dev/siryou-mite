import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContainerClient } from "@azure/storage-blob";
import type { QueueClient } from "@azure/storage-queue";
import type { Client } from "pg";
import { closePool, getPool, runInTransaction, type Queryable } from "~/lib/db/pool.server";
import {
  isLockWaitTimeoutError,
  auditErrorCategoryForRejection,
  releaseUploadSlot,
  reserveUploadSlotWithin,
  uploadLimitsFromEnv,
  type UploadLimitsInput,
  type UploadSlotDecision,
} from "~/lib/db/upload-limits.server";
import {
  createDocument,
  updateDocumentPreviewStatus,
} from "~/lib/db/documents.server";
import { insertAuditEvent } from "~/lib/db/audit-events.server";
import { createUserSession, type AppUser } from "~/lib/session.server";
import {
  handleDocumentUpload,
  type UploadDependencies,
  type UploadSuccessBody,
} from "~/lib/upload/upload.server";
import {
  createBlobServiceClient,
  createQueueServiceClient,
  deleteDocumentHtml,
  documentHtmlBlobKey,
  downloadDocumentHtml,
  getDocumentsContainerClient,
  getPreviewQueueClient,
  receivePreviewGenerationMessages,
  sendPreviewGenerationMessage,
  uploadDocumentHtml,
} from "../../services/shared/storage.js";
import { dropSchema, migrateFreshSchema, newClient } from "./helpers/schema.js";
import { requireStorageConnectionString, uniqueTestName } from "./helpers/storage.js";

/**
 * T09 結合テスト: アップロード`POST /documents`(設計 §10.1, §10.2, §18.2)。
 *
 * 実際のPostgreSQL(テスト専用schema)とAzurite(テスト専用container/queue)に対して
 * actionの処理本体をそのまま実行し、正常系・拒否・補償処理を検証する。
 */

const schema = "t09_it_document_upload";
const origin = "http://localhost:3000";
const uploadUrl = `${origin}/documents`;
const acceptedHtml =
  "<!doctype html><html><head><title>結合テスト資料</title></head><body><p>本文</p></body></html>";

const testUser: AppUser = {
  id: "oid-integration-uploader",
  tenantId: "tenant-integration",
  name: "結合テスト利用者",
  email: "integration@example.com",
  roles: ["User"],
  groups: ["ZAA535-A"],
};

let client: Client;
let containerClient: ContainerClient;
let queueClient: QueueClient;
let sessionCookie = "";
let limitOverrides: Partial<UploadLimitsInput> = {};

beforeAll(async () => {
  await migrateFreshSchema(schema);
  client = newClient();
  await client.connect();
  await client.query(`SET search_path TO "${schema}"`);

  const connectionString = requireStorageConnectionString();
  containerClient = getDocumentsContainerClient(
    createBlobServiceClient({ kind: "connectionString", connectionString }),
    uniqueTestName("t09-documents"),
  );
  queueClient = getPreviewQueueClient(
    createQueueServiceClient({ kind: "connectionString", connectionString }),
    uniqueTestName("t09-preview"),
  );
  await containerClient.createIfNotExists();
  await queueClient.createIfNotExists();
}, 30_000);

afterAll(async () => {
  await closePool();
  await client.end();
  await dropSchema(schema);
  await containerClient?.deleteIfExists();
  await queueClient?.deleteIfExists();
}, 30_000);

beforeEach(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  await client.query("TRUNCATE upload_attempts, audit_events, documents");
  await queueClient.clearMessages();
  limitOverrides = {};
  sessionCookie =
    (await createUserSession(testUser)).headers.get("Set-Cookie") ?? "";
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

/** `reserveUploadSlot`と同じ手順をテスト専用schemaで実行する。 */
async function reserveInSchema(input: {
  ownerSubjectId: string;
  byteSize: number;
}): Promise<UploadSlotDecision> {
  const limits = uploadLimitsFromEnv(limitOverrides);
  const poolClient = await getPool().connect();
  try {
    return await runInTransaction(poolClient, async () => {
      await poolClient.query(`SET LOCAL search_path TO "${schema}"`);
      return reserveUploadSlotWithin(poolClient, input, limits);
    });
  } catch (error) {
    if (isLockWaitTimeoutError(error)) {
      return {
        allowed: false,
        reason: "lock_wait_timeout",
        retryAfterSeconds: 5,
        errorCategory: auditErrorCategoryForRejection("lock_wait_timeout"),
      };
    }
    throw error;
  } finally {
    poolClient.release();
  }
}

function integrationDependencies(
  overrides: Partial<UploadDependencies> = {},
): Partial<UploadDependencies> {
  return {
    reserveUploadSlot: reserveInSchema,
    releaseUploadSlot: (params) => releaseUploadSlot(params, client),
    withTransaction: withSchemaTransaction,
    createDocument,
    insertAuditEvent,
    updatePreviewStatus: updateDocumentPreviewStatus,
    saveHtml: (documentId, html) =>
      uploadDocumentHtml(containerClient, documentId, html),
    deleteHtml: (documentId) => deleteDocumentHtml(containerClient, documentId),
    sendPreviewMessage: (documentId) =>
      sendPreviewGenerationMessage(queueClient, documentId),
    newDocumentId: () => randomUUID(),
    ...overrides,
  };
}

function uploadRequest(
  body: BodyInit = acceptedHtml,
  fileName = "結合テスト資料.html",
): Request {
  return new Request(uploadUrl, {
    method: "POST",
    headers: {
      Cookie: sessionCookie,
      Origin: origin,
      "Content-Type": "application/octet-stream",
      "X-File-Name": Buffer.from(fileName, "utf8").toString("base64url"),
    },
    body,
  });
}

async function upload(
  overrides: Partial<UploadDependencies> = {},
  body?: BodyInit,
  fileName?: string,
): Promise<Response> {
  return handleDocumentUpload(
    uploadRequest(body, fileName),
    integrationDependencies(overrides),
  );
}

async function documentRows() {
  const result = await client.query(
    "SELECT id, owner_subject_id, original_file_name, title, byte_size, status, preview_status, warning_codes FROM documents",
  );
  return result.rows;
}

async function auditRows() {
  const result = await client.query(
    "SELECT action, result, document_id, actor_subject_id, error_category, correlation_id FROM audit_events ORDER BY occurred_at, id",
  );
  return result.rows;
}

describe("正常系(設計 §10.1)", () => {
  it("Blob保存・DB登録・監査・Queue送信を行い、資料表示画面へ案内する", async () => {
    const response = await upload();
    const body = (await response.json()) as UploadSuccessBody;

    expect(response.status).toBe(201);
    expect(body.documentUrl).toBe(`/documents/${body.documentId}`);

    const documents = await documentRows();
    expect(documents).toHaveLength(1);
    expect(documents[0]).toMatchObject({
      id: body.documentId,
      owner_subject_id: testUser.id,
      original_file_name: "結合テスト資料.html",
      title: "結合テスト資料",
      byte_size: String(Buffer.byteLength(acceptedHtml, "utf8")),
      status: "active",
      preview_status: "pending",
    });

    const stored = await downloadDocumentHtml(containerClient, body.documentId);
    expect(stored.toString("utf8")).toBe(acceptedHtml);

    const audits = await auditRows();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: "upload",
      result: "success",
      document_id: body.documentId,
      actor_subject_id: testUser.id,
      error_category: null,
      correlation_id: body.correlationId,
    });

    const messages = await receivePreviewGenerationMessages(queueClient);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.message.documentId).toBe(body.documentId);
  });

  it("予約枠は資料登録をcommitした後に解放する(QUESTIONS Q-012)", async () => {
    let attemptId = "";
    let finishedAtDuringTransaction: unknown = "未取得";

    const response = await upload({
      reserveUploadSlot: async (input) => {
        const decision = await reserveInSchema(input);
        if (decision.allowed) {
          attemptId = decision.attemptId;
        }
        return decision;
      },
      createDocument: async (input, tx) => {
        const created = await createDocument(input, tx);
        // 資料登録のトランザクションが未commitの時点では、枠はまだ解放されていない。
        const result = await client.query(
          "SELECT finished_at FROM upload_attempts WHERE id = $1",
          [attemptId],
        );
        finishedAtDuringTransaction = result.rows[0]?.finished_at ?? null;
        return created;
      },
    });

    expect(response.status).toBe(201);
    expect(finishedAtDuringTransaction).toBeNull();

    const after = await client.query(
      "SELECT finished_at FROM upload_attempts WHERE id = $1",
      [attemptId],
    );
    expect(after.rows[0]?.finished_at).not.toBeNull();
  });
});

describe("拒否(設計 §10.2)", () => {
  it("HTML検査で拒否した場合は資料もBlobも残さず、拒否を監査する", async () => {
    const response = await upload(
      {},
      "<!doctype html><html><head><meta http-equiv=\"refresh\" content=\"0\"></head><body>a</body></html>",
    );

    expect(response.status).toBe(400);
    expect(await documentRows()).toHaveLength(0);

    const audits = await auditRows();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      result: "denied",
      error_category: "html_inspection_failed",
      document_id: null,
    });

    // 枠は解放され、同時実行の上限を塞がない。
    const attempts = await client.query(
      "SELECT finished_at FROM upload_attempts",
    );
    expect(attempts.rows).toHaveLength(1);
    expect(attempts.rows[0]?.finished_at).not.toBeNull();
  });

  it("件数上限に達している場合は保存せずに拒否する(設計 §6.1)", async () => {
    expect((await upload()).status).toBe(201);

    limitOverrides = { maxActiveDocumentsPerUser: 1 };
    const response = await upload();

    expect(response.status).toBe(409);
    expect(await documentRows()).toHaveLength(1);

    const audits = await auditRows();
    expect(audits.map((row) => row.result)).toEqual(["success", "denied"]);
    expect(audits[1]).toMatchObject({ error_category: "quota_exceeded" });
  });

  it("同時アップロードが進行中の場合は拒否する(設計 §6.1)", async () => {
    // 解放されない進行中の試行を1件作る(異常終了した直前のアップロード相当)。
    const inProgress = await reserveInSchema({
      ownerSubjectId: testUser.id,
      byteSize: 10,
    });
    expect(inProgress.allowed).toBe(true);

    const response = await upload();

    expect(response.status).toBe(429);
    expect(await documentRows()).toHaveLength(0);
    expect((await auditRows())[0]).toMatchObject({
      result: "denied",
      error_category: "rate_limited",
    });
  });
});

describe("補償処理(設計 §10.2, §15.1)", () => {
  it("DB登録に失敗した場合は不完全なBlobを削除する", async () => {
    let savedDocumentId = "";

    const response = await upload({
      saveHtml: async (documentId, html) => {
        savedDocumentId = documentId;
        await uploadDocumentHtml(containerClient, documentId, html);
      },
      createDocument: async () => {
        throw new Error("insert failed");
      },
    });

    expect(response.status).toBe(500);
    expect(await documentRows()).toHaveLength(0);

    const blobClient = containerClient.getBlobClient(
      documentHtmlBlobKey(savedDocumentId),
    );
    expect(await blobClient.exists()).toBe(false);

    const attempts = await client.query("SELECT finished_at FROM upload_attempts");
    expect(attempts.rows[0]?.finished_at).not.toBeNull();
  });

  it("監査保存に失敗した場合は資料を登録しない(設計 §15.1)", async () => {
    const response = await upload({
      insertAuditEvent: async (input, tx) => {
        if (input.result === "success") {
          throw new Error("audit insert failed");
        }
        return insertAuditEvent(input, tx);
      },
    });

    expect(response.status).toBe(500);
    expect(await documentRows()).toHaveLength(0);
    expect(await receivePreviewGenerationMessages(queueClient)).toHaveLength(0);
  });

  it("Queue送信に失敗した場合はプレビュー状態をfailedにし、資料は閲覧可能にする", async () => {
    const response = await upload({
      sendPreviewMessage: async () => {
        throw new Error("queue down");
      },
    });
    const body = (await response.json()) as UploadSuccessBody;

    expect(response.status).toBe(201);
    expect(body.previewStatus).toBe("failed");

    const documents = await documentRows();
    expect(documents[0]).toMatchObject({
      status: "active",
      preview_status: "failed",
    });

    const audits = await auditRows();
    expect(audits.map((row) => row.result)).toEqual(["success", "failed"]);
    expect(audits[1]).toMatchObject({
      error_category: "queue_failed",
      document_id: body.documentId,
    });
  });
});
