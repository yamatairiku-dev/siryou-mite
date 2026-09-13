import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContainerClient } from "@azure/storage-blob";
import type { QueueClient } from "@azure/storage-queue";
import type { Client } from "pg";
import { insertAuditEvent } from "../../services/shared/db/audit-events.js";
import {
  createDocument,
  deleteDocumentAsOwner,
} from "../../services/shared/db/documents.js";
import { createDatabasePool } from "../../services/shared/db/pool.js";
import {
  createBlobServiceClient,
  createQueueServiceClient,
  documentPreviewBlobKey,
  getDocumentsContainerClient,
  getPreviewQueueClient,
  sendPreviewGenerationMessage,
  uploadDocumentHtml,
  type ReceivedPreviewQueueEnvelope,
} from "../../services/shared/storage.js";
import { createPreviewRuntime } from "../../services/preview/dependencies.js";
import { parsePreviewEnvironment } from "../../services/preview/env.js";
import {
  runPreviewWorkerOnce,
  type PreviewWorkerDependencies,
} from "../../services/preview/worker.js";
import { dropSchema, migrateFreshSchema, newClient, requireDatabaseUrl } from "./helpers/schema.js";
import { requireStorageConnectionString, uniqueTestName } from "./helpers/storage.js";

/**
 * T18 結合テスト: プレビュー生成ワーカー(設計 §7.5, §10.2, §15.1, §18.2)。
 *
 * 実際のPostgreSQL(テスト専用schema)とAzurite(テスト専用container/queue)に対して、
 * 本番と同じ組み立て(`createPreviewRuntime`)でワーカーを動かし、
 * 重複配信・再試行(`dequeueCount`)・timeoutの扱いを検証する。
 *
 * 撮影(Chromium)だけは固定のJPEGを返す関数へ差し替える。撮影そのものの安全設定は
 * `tests/integration/preview-capture.test.ts`(実際のChromium)と
 * `tests/unit/services/preview-capture.test.ts`で検証する。
 */

const schema = "t18_it_preview_worker";
const ownerSubjectId = "oid-integration-preview-owner";
const tenantId = "tenant-integration";
const html = "<!doctype html><html><body><p>結合テスト資料</p></body></html>";
/** 撮影結果の代わりに使う最小のJPEG(SOI/EOIマーカーだけ)。 */
const fakeJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

let client: Client;
let containerClient: ContainerClient;
let queueClient: QueueClient;
let containerName: string;
let queueName: string;
let connectionString: string;
let documentId: string;

function schemaScopedDatabaseUrl(): string {
  const url = new URL(requireDatabaseUrl());
  url.searchParams.set("options", `-c search_path=${schema}`);
  return url.toString();
}

function previewEnvironment(): ReturnType<typeof parsePreviewEnvironment> {
  return parsePreviewEnvironment({
    NODE_ENV: "test",
    DATABASE_URL: schemaScopedDatabaseUrl(),
    AZURE_STORAGE_CONNECTION_STRING: connectionString,
    AZURE_STORAGE_CONTAINER: containerName,
    AZURE_STORAGE_QUEUE_NAME: queueName,
    LOG_HMAC_KEY: Buffer.alloc(32, 9).toString("base64"),
  });
}

type WorkerHarness = {
  dependencies: PreviewWorkerDependencies;
  /** 受信した封筒(dequeueCountの推移と再表示に使う)。 */
  received: ReceivedPreviewQueueEnvelope[];
  close(): Promise<void>;
};

function createWorker(
  capturePreview: (html: Buffer) => Promise<Buffer> = async () => fakeJpeg,
): WorkerHarness {
  const runtime = createPreviewRuntime(previewEnvironment(), { capturePreview });
  const received: ReceivedPreviewQueueEnvelope[] = [];

  return {
    received,
    dependencies: {
      ...runtime.dependencies,
      async receiveMessage() {
        const envelope = await runtime.dependencies.receiveMessage();
        if (envelope) {
          received.push(envelope);
        }
        return envelope;
      },
    },
    close: runtime.close,
  };
}

/**
 * 再試行を待たずに検証するため、処理後に残っているメッセージを即座に再表示する。
 * `dequeueCount`は実際の受信で増えるため、判定そのものは本番と同じ経路を通る
 * (visibility timeoutの経過を実時間で待たないようにするだけ)。
 */
async function makeVisibleAgain(
  envelope: ReceivedPreviewQueueEnvelope,
): Promise<void> {
  await queueClient.updateMessage(
    envelope.messageId,
    envelope.popReceipt,
    undefined,
    0,
  );
}

async function queueMessageCount(): Promise<number> {
  const properties = await queueClient.getProperties();
  return properties.approximateMessagesCount ?? 0;
}

async function previewStatusOf(id: string): Promise<string | null> {
  const result = await client.query<{ preview_status: string | null }>(
    "SELECT preview_status FROM documents WHERE id = $1",
    [id],
  );
  return result.rows[0]?.preview_status ?? null;
}

async function auditRows(): Promise<
  Array<{ action: string; result: string; error_category: string | null; actor_subject_id: string; actor_tenant_id: string }>
> {
  const result = await client.query(
    "SELECT action, result, error_category, actor_subject_id, actor_tenant_id FROM audit_events ORDER BY occurred_at, id",
  );
  return result.rows as Array<{
    action: string;
    result: string;
    error_category: string | null;
    actor_subject_id: string;
    actor_tenant_id: string;
  }>;
}

/** アップロード直後の状態(`pending`の資料・HTML・アップロード監査)を作る。 */
async function createPendingDocument(): Promise<string> {
  const pool = createDatabasePool({
    connectionString: schemaScopedDatabaseUrl(),
    applicationName: "siryou-mite-test",
    requireTls: false,
  });

  try {
    const document = await createDocument(
      {
        ownerSubjectId,
        ownerEmailAtUpload: "owner@example.com",
        originalFileName: "資料.html",
        title: "結合テスト資料",
        byteSize: Buffer.byteLength(html, "utf8"),
        previewStatus: "pending",
        warningCodes: [],
      },
      pool,
    );

    // プレビュー監査の操作者はアップロード監査から引き継ぐ(設計 §12.2のNOT NULL)。
    await insertAuditEvent(
      {
        action: "upload",
        result: "success",
        documentId: document.id,
        actorSubjectId: ownerSubjectId,
        actorTenantId: tenantId,
        actorEmailAtEvent: "owner@example.com",
        correlationId: "00000000-0000-4000-8000-00000000aaaa",
      },
      pool,
    );

    await uploadDocumentHtml(
      containerClient,
      document.id,
      Buffer.from(html, "utf8"),
    );

    return document.id;
  } finally {
    await pool.end();
  }
}

beforeAll(async () => {
  await migrateFreshSchema(schema);
  client = newClient();
  await client.connect();
  await client.query(`SET search_path TO "${schema}"`);

  connectionString = requireStorageConnectionString();
  containerName = uniqueTestName("t18-documents");
  queueName = uniqueTestName("t18-preview");

  containerClient = getDocumentsContainerClient(
    createBlobServiceClient({ kind: "connectionString", connectionString }),
    containerName,
  );
  queueClient = getPreviewQueueClient(
    createQueueServiceClient({ kind: "connectionString", connectionString }),
    queueName,
  );

  await containerClient.createIfNotExists();
  await queueClient.createIfNotExists();
}, 60_000);

afterAll(async () => {
  await client?.end();
  await dropSchema(schema);
  await containerClient?.deleteIfExists();
  await queueClient?.deleteIfExists();
}, 60_000);

beforeEach(async () => {
  await queueClient.clearMessages();
  await client.query("TRUNCATE audit_events, documents RESTART IDENTITY CASCADE");
  documentId = await createPendingDocument();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("正常系(設計 §7.5)", () => {
  it("撮影結果を保存してreadyへ更新し、監査を残してメッセージを削除する", async () => {
    await sendPreviewGenerationMessage(queueClient, documentId);
    const worker = createWorker();

    try {
      const result = await runPreviewWorkerOnce(worker.dependencies);

      expect(result).toEqual({
        outcome: "completed",
        documentId,
        errorCategory: null,
      });
    } finally {
      await worker.close();
    }

    expect(await previewStatusOf(documentId)).toBe("ready");
    const previewBlob = containerClient.getBlobClient(
      documentPreviewBlobKey(documentId),
    );
    expect(await previewBlob.exists()).toBe(true);
    expect(await queueMessageCount()).toBe(0);

    const audits = await auditRows();
    expect(audits).toHaveLength(2);
    expect(audits[1]).toMatchObject({
      action: "upload",
      result: "success",
      error_category: null,
      actor_subject_id: ownerSubjectId,
      actor_tenant_id: tenantId,
    });
  });

  it("メッセージが無い実行は何もしない", async () => {
    const worker = createWorker();

    try {
      const result = await runPreviewWorkerOnce(worker.dependencies);
      expect(result.outcome).toBe("no_message");
    } finally {
      await worker.close();
    }
  });
});

describe("重複配信(設計 §7.5「同じメッセージを複数回受け取っても結果が壊れない」)", () => {
  it("同じ資料のメッセージを2回処理しても結果が変わらない", async () => {
    await sendPreviewGenerationMessage(queueClient, documentId);
    await sendPreviewGenerationMessage(queueClient, documentId);

    let captureCalls = 0;
    const worker = createWorker(async () => {
      captureCalls += 1;
      return fakeJpeg;
    });

    try {
      const first = await runPreviewWorkerOnce(worker.dependencies);
      const second = await runPreviewWorkerOnce(worker.dependencies);

      expect(first.outcome).toBe("completed");
      // 2回目は撮影し直さず、状態も監査も増やさない。
      expect(second.outcome).toBe("skipped");
    } finally {
      await worker.close();
    }

    expect(captureCalls).toBe(1);
    expect(await previewStatusOf(documentId)).toBe("ready");
    expect(await queueMessageCount()).toBe(0);

    const audits = await auditRows();
    expect(audits.filter((row) => row.result === "success")).toHaveLength(2);
    const previewBlob = containerClient.getBlobClient(
      documentPreviewBlobKey(documentId),
    );
    const downloaded = await previewBlob.downloadToBuffer();
    expect(downloaded.equals(fakeJpeg)).toBe(true);
  });

  it("削除済み資料のメッセージは撮影せずに削除する", async () => {
    await sendPreviewGenerationMessage(queueClient, documentId);
    const pool = createDatabasePool({
      connectionString: schemaScopedDatabaseUrl(),
      applicationName: "siryou-mite-test",
      requireTls: false,
    });
    try {
      await deleteDocumentAsOwner({ documentId, ownerSubjectId }, pool);
    } finally {
      await pool.end();
    }

    let captureCalls = 0;
    const worker = createWorker(async () => {
      captureCalls += 1;
      return fakeJpeg;
    });

    try {
      const result = await runPreviewWorkerOnce(worker.dependencies);
      expect(result.outcome).toBe("skipped");
    } finally {
      await worker.close();
    }

    expect(captureCalls).toBe(0);
    expect(await previewStatusOf(documentId)).toBeNull();
    expect(await queueMessageCount()).toBe(0);
    const previewBlob = containerClient.getBlobClient(
      documentPreviewBlobKey(documentId),
    );
    expect(await previewBlob.exists()).toBe(false);
  });

  it("検証できないメッセージは撮影せずqueueから取り除く", async () => {
    await queueClient.sendMessage(
      Buffer.from('{"documentId":"' + documentId + '"}', "utf8").toString(
        "base64",
      ),
    );

    const worker = createWorker();
    try {
      const result = await runPreviewWorkerOnce(worker.dependencies);
      expect(result).toEqual({
        outcome: "discarded",
        documentId: null,
        errorCategory: "validation_failed",
      });
    } finally {
      await worker.close();
    }

    expect(await queueMessageCount()).toBe(0);
    expect(await previewStatusOf(documentId)).toBe("pending");
    expect(await auditRows()).toHaveLength(1);
  });
});

describe("再試行(設計 §7.5「dequeueCountで最大3回」)", () => {
  it("dequeueCountが1・2の失敗は再試行に回し、3回目でfailedと監査を残して削除する", async () => {
    await sendPreviewGenerationMessage(queueClient, documentId);

    const worker = createWorker(async () => {
      throw new Error("撮影に失敗しました");
    });

    try {
      const first = await runPreviewWorkerOnce(worker.dependencies);
      expect(first).toEqual({
        outcome: "retry_scheduled",
        documentId,
        errorCategory: "preview_failed",
      });
      // 1回目の失敗ではDBもqueueも変えない。
      expect(await previewStatusOf(documentId)).toBe("pending");
      expect(await auditRows()).toHaveLength(1);
      await makeVisibleAgain(worker.received[0]!);

      const second = await runPreviewWorkerOnce(worker.dependencies);
      expect(second.outcome).toBe("retry_scheduled");
      expect(await previewStatusOf(documentId)).toBe("pending");
      await makeVisibleAgain(worker.received[1]!);

      const third = await runPreviewWorkerOnce(worker.dependencies);
      expect(third).toEqual({
        outcome: "permanently_failed",
        documentId,
        errorCategory: "preview_failed",
      });

      // 実際の受信で`dequeueCount`が1→2→3と増えている。
      expect(worker.received.map((envelope) => envelope.dequeueCount)).toEqual([
        1, 2, 3,
      ]);
    } finally {
      await worker.close();
    }

    expect(await previewStatusOf(documentId)).toBe("failed");
    expect(await queueMessageCount()).toBe(0);

    const audits = await auditRows();
    expect(audits).toHaveLength(2);
    expect(audits[1]).toMatchObject({
      action: "upload",
      result: "failed",
      error_category: "preview_failed",
      actor_subject_id: ownerSubjectId,
      actor_tenant_id: tenantId,
    });
  });
});

describe("timeout(設計 §7.5「1メッセージの処理上限は30秒」)", () => {
  /**
   * 実時間に依存させないため、Q-006(`tests/integration/blob-queue.test.ts`)と同じ
   * 方式で`AbortSignal.timeout`が返すsignalだけを「既に中断済み」のものへ差し替える。
   * 確認するのは次の3点。
   *   1. 呼び出し側が指定した処理上限(30秒)がそのままsignalの生成へ渡ること
   *   2. そのsignalの中断が`preview_timeout`として扱われ、DBもqueueも変わらないこと
   *   3. 差し替えを戻すと同じメッセージの処理が成功すること
   */
  it("処理上限を超えた実行はpreview_timeoutとして再試行に回す", async () => {
    await sendPreviewGenerationMessage(queueClient, documentId);
    const worker = createWorker();

    try {
      // 受信自体(Queue呼び出し)は差し替え前に済ませ、処理だけを中断させる。
      const envelope = await worker.dependencies.receiveMessage();
      expect(envelope?.dequeueCount).toBe(1);

      const timeoutSpy = vi
        .spyOn(AbortSignal, "timeout")
        .mockReturnValue(AbortSignal.abort());

      try {
        const result = await runPreviewWorkerOnce({
          ...worker.dependencies,
          receiveMessage: async () => envelope,
        });

        expect(result).toEqual({
          outcome: "retry_scheduled",
          documentId,
          errorCategory: "preview_timeout",
        });
        expect(timeoutSpy).toHaveBeenCalledWith(30_000);
      } finally {
        timeoutSpy.mockRestore();
      }

      // timeoutした試行ではDBを変えず、メッセージも残す(再配信で再試行される)。
      expect(await previewStatusOf(documentId)).toBe("pending");
      expect(await auditRows()).toHaveLength(1);

      // 差し替えを戻すと、同じメッセージの処理が成功する。
      await makeVisibleAgain(envelope!);
      const retried = await runPreviewWorkerOnce(worker.dependencies);
      expect(retried.outcome).toBe("completed");
      expect(worker.received.map((item) => item.dequeueCount)).toEqual([1, 2]);
    } finally {
      await worker.close();
    }

    expect(await previewStatusOf(documentId)).toBe("ready");
    expect(await queueMessageCount()).toBe(0);
  });
});
