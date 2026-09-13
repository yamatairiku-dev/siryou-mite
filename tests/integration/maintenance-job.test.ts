import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ContainerClient } from "@azure/storage-blob";
import type { Client, Pool } from "pg";
import { createMaintenanceRuntime } from "../../services/maintenance/dependencies.js";
import { parseMaintenanceEnvironment } from "../../services/maintenance/env.js";
import {
  runMaintenanceJobOnce,
  type MaintenanceJobDependencies,
  type MaintenanceJobResult,
  type MaintenanceTaskName,
  type MaintenanceTaskReport,
} from "../../services/maintenance/job.js";
import {
  createDocument,
  deleteDocumentAsOwner,
} from "../../services/shared/db/documents.js";
import { createDatabasePool } from "../../services/shared/db/pool.js";
import {
  createBlobServiceClient,
  documentHtmlBlobKey,
  documentPreviewBlobKey,
  getDocumentsContainerClient,
  uploadDocumentHtml,
  uploadDocumentPreview,
} from "../../services/shared/storage.js";
import {
  dropSchema,
  migrateFreshSchema,
  newClient,
  requireDatabaseUrl,
} from "./helpers/schema.js";
import { requireStorageConnectionString, uniqueTestName } from "./helpers/storage.js";

/**
 * T19 結合テスト: 定期保守Job(設計 §7.7, §16, §18.2)。
 *
 * 実際のPostgreSQL(テスト専用schema)とAzurite(テスト専用container)に対して、
 * 本番と同じ組み立て(`createMaintenanceRuntime`)でJobを動かし、4つの保守処理
 * (Blob削除の再試行・1年経過後のpurge・孤児Blob掃除・`upload_attempts`のpurge)と、
 * 監査の追記専用性がruntime roleに対して維持されることを検証する。
 */

const schema = "t19_it_maintenance";
const ownerSubjectId = "oid-integration-maintenance-owner";
const tenantId = "tenant-integration";
const runtimeRole = "siryou_mite_runtime";
const maintenanceRole = "siryou_mite_maintenance";
const html = "<!doctype html><html><body><p>保守Job結合テスト</p></body></html>";
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const day = 24 * 3_600_000;

let client: Client;
let pool: Pool;
let containerClient: ContainerClient;
let containerName: string;
let connectionString: string;

function schemaScopedDatabaseUrl(): string {
  const url = new URL(requireDatabaseUrl());
  url.searchParams.set("options", `-c search_path=${schema}`);
  return url.toString();
}

function maintenanceEnvironment(
  overrides: NodeJS.ProcessEnv = {},
): ReturnType<typeof parseMaintenanceEnvironment> {
  return parseMaintenanceEnvironment({
    NODE_ENV: "test",
    DATABASE_URL: schemaScopedDatabaseUrl(),
    AZURE_STORAGE_CONNECTION_STRING: connectionString,
    AZURE_STORAGE_CONTAINER: containerName,
    LOG_HMAC_KEY: Buffer.alloc(32, 5).toString("base64"),
    // 小さなバッチで複数回ループする経路も通す。
    MAINTENANCE_BATCH_SIZE: "2",
    MAINTENANCE_BLOB_LIST_PAGE_SIZE: "2",
    // 孤児Blob掃除の猶予は最小値(1時間)。テストで作るBlobはこれより新しい。
    MAINTENANCE_ORPHAN_BLOB_GRACE_HOURS: "1",
    MAINTENANCE_UPLOAD_ATTEMPT_RETENTION_DAYS: "7",
    ...overrides,
  });
}

/** 本番と同じ組み立てでJobを1回実行する(必要な依存だけ差し替える)。 */
async function runJob(
  options: {
    overrides?: Partial<MaintenanceJobDependencies>;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<MaintenanceJobResult> {
  const runtime = createMaintenanceRuntime(maintenanceEnvironment(options.env));
  try {
    return await runMaintenanceJobOnce(
      { ...runtime.dependencies, ...options.overrides },
      AbortSignal.timeout(20_000),
    );
  } finally {
    await runtime.close();
  }
}

function reportFor(
  result: MaintenanceJobResult,
  task: MaintenanceTaskName,
): MaintenanceTaskReport {
  const report = result.tasks.find((item) => item.task === task);
  if (!report) {
    throw new Error(`report for ${task} not found`);
  }
  return report;
}

/** `active`な資料1件と、そのHTML・プレビューBlobを作る。 */
async function createDocumentWithBlobs(): Promise<string> {
  const document = await createDocument(
    {
      ownerSubjectId,
      ownerEmailAtUpload: "owner@example.com",
      originalFileName: "資料.html",
      title: "保守Job結合テスト",
      byteSize: Buffer.byteLength(html, "utf8"),
      previewStatus: "ready",
      warningCodes: [],
    },
    pool,
  );

  await uploadDocumentHtml(containerClient, document.id, Buffer.from(html, "utf8"));
  await uploadDocumentPreview(containerClient, document.id, jpeg);
  return document.id;
}

/** 所有者削除(soft delete)。`blob_cleanup_pending`がtrueになる(設計 §10.4(3))。 */
async function softDelete(documentId: string): Promise<void> {
  const deleted = await deleteDocumentAsOwner(
    { documentId, ownerSubjectId },
    pool,
  );
  expect(deleted).not.toBeNull();
}

/** 削除日時を過去へずらす(1年経過の判定を実時間で待たないため)。 */
async function backdateDeletion(documentId: string, days: number): Promise<void> {
  await client.query(
    `UPDATE documents SET deleted_at = now() - make_interval(days => $2) WHERE id = $1`,
    [documentId, days],
  );
}

/**
 * 監査イベントを1件作る。`occurred_at`を過去にすると、BEFORE INSERT triggerが
 * `retain_until`を`occurred_at + 1年`として計算するため、保持期間経過分の
 * purge対象になる(migrations/1789169486387)。
 */
async function insertAuditEventAt(
  documentId: string | null,
  daysAgo: number,
): Promise<string> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO audit_events (action, result, document_id, actor_subject_id,
                               actor_tenant_id, correlation_id, occurred_at, retain_until)
     VALUES ('upload', 'success', $1, $2, $3, gen_random_uuid(),
             now() - make_interval(days => $4), now())
     RETURNING id`,
    [documentId, ownerSubjectId, tenantId, daysAgo],
  );
  const id = result.rows[0]?.id;
  if (!id) {
    throw new Error("監査イベントを作成できませんでした");
  }
  return id;
}

async function documentExists(documentId: string): Promise<boolean> {
  const result = await client.query("SELECT 1 FROM documents WHERE id = $1", [
    documentId,
  ]);
  return result.rows.length > 0;
}

async function blobCleanupPendingOf(documentId: string): Promise<boolean> {
  const result = await client.query<{ blob_cleanup_pending: boolean }>(
    "SELECT blob_cleanup_pending FROM documents WHERE id = $1",
    [documentId],
  );
  const pending = result.rows[0]?.blob_cleanup_pending;
  if (pending === undefined) {
    throw new Error("資料が見つかりません");
  }
  return pending;
}

async function auditEventCount(): Promise<number> {
  const result = await client.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM audit_events",
  );
  return Number(result.rows[0]?.count ?? "0");
}

async function blobExists(key: string): Promise<boolean> {
  return containerClient.getBlobClient(key).exists();
}

async function clearContainer(): Promise<void> {
  for await (const blob of containerClient.listBlobsFlat()) {
    await containerClient.getBlobClient(blob.name).deleteIfExists();
  }
}

/** 指定したroleへ切り替えてSQLを実行する(権限・triggerの実挙動を確認する)。 */
async function asRole<T>(role: string, run: () => Promise<T>): Promise<T> {
  await client.query(`SET ROLE "${role}"`);
  try {
    return await run();
  } finally {
    await client.query("RESET ROLE");
  }
}

beforeAll(async () => {
  client = newClient();
  await client.connect();

  // roleが存在する状態でmigrationを適用し、GRANTの実挙動も確認できるようにする。
  await client.query(`DROP ROLE IF EXISTS "${runtimeRole}"`);
  await client.query(`DROP ROLE IF EXISTS "${maintenanceRole}"`);
  await client.query(`CREATE ROLE "${runtimeRole}" NOLOGIN`);
  await client.query(`CREATE ROLE "${maintenanceRole}" NOLOGIN`);

  await migrateFreshSchema(schema);
  await client.query(`SET search_path TO "${schema}"`);
  await client.query(
    `GRANT USAGE ON SCHEMA "${schema}" TO "${runtimeRole}", "${maintenanceRole}"`,
  );

  connectionString = requireStorageConnectionString();
  containerName = uniqueTestName("t19-documents");
  containerClient = getDocumentsContainerClient(
    createBlobServiceClient({ kind: "connectionString", connectionString }),
    containerName,
  );
  await containerClient.createIfNotExists();

  pool = createDatabasePool({
    connectionString: schemaScopedDatabaseUrl(),
    applicationName: "siryou-mite-test",
    requireTls: false,
  });
}, 60_000);

afterAll(async () => {
  await pool?.end();
  await client?.query("RESET ROLE").catch(() => {});
  await client?.end();
  // GRANTが残っている間はDROP ROLEできないため、schemaを先に削除する。
  await dropSchema(schema);
  const cleanup = newClient();
  await cleanup.connect();
  await cleanup.query(`DROP ROLE IF EXISTS "${runtimeRole}"`);
  await cleanup.query(`DROP ROLE IF EXISTS "${maintenanceRole}"`);
  await cleanup.end();
  await containerClient?.deleteIfExists();
}, 60_000);

beforeEach(async () => {
  await client.query(
    "TRUNCATE audit_events, documents, upload_attempts RESTART IDENTITY CASCADE",
  );
  await clearContainer();
});

describe("blob_cleanup_pending の再試行(設計 §7.7, §10.4(5))", () => {
  it("HTML・プレビューを削除してフラグを下ろし、2回目の実行でも壊れない(冪等)", async () => {
    const documentIds = [
      await createDocumentWithBlobs(),
      await createDocumentWithBlobs(),
      await createDocumentWithBlobs(),
    ];
    for (const documentId of documentIds) {
      await softDelete(documentId);
    }

    const first = await runJob();

    expect(reportFor(first, "blob_cleanup_retry")).toMatchObject({
      result: "success",
      examined: 3,
      succeeded: 3,
      failed: 0,
    });
    for (const documentId of documentIds) {
      expect(await blobExists(documentHtmlBlobKey(documentId))).toBe(false);
      expect(await blobExists(documentPreviewBlobKey(documentId))).toBe(false);
      expect(await blobCleanupPendingOf(documentId)).toBe(false);
    }

    // 2回目: 対象が無くなっているだけで、失敗も再削除も起きない。
    const second = await runJob();

    expect(reportFor(second, "blob_cleanup_retry")).toMatchObject({
      result: "success",
      examined: 0,
      failed: 0,
    });
    expect(second.hasFailure).toBe(false);
    for (const documentId of documentIds) {
      expect(await documentExists(documentId)).toBe(true);
      expect(await blobCleanupPendingOf(documentId)).toBe(false);
    }
  });

  it("Blobが既に存在しない資料でも成功扱いでフラグを下ろす(冪等)", async () => {
    const documentId = await createDocumentWithBlobs();
    await softDelete(documentId);
    await containerClient
      .getBlobClient(documentHtmlBlobKey(documentId))
      .deleteIfExists();
    await containerClient
      .getBlobClient(documentPreviewBlobKey(documentId))
      .deleteIfExists();

    const result = await runJob();

    expect(reportFor(result, "blob_cleanup_retry")).toMatchObject({
      succeeded: 1,
      failed: 0,
    });
    expect(await blobCleanupPendingOf(documentId)).toBe(false);
  });

  it("Blob削除に失敗した資料はフラグを残し、他の資料の再試行は続ける", async () => {
    const failing = await createDocumentWithBlobs();
    const succeeding = await createDocumentWithBlobs();
    await softDelete(failing);
    await softDelete(succeeding);

    const result = await runJob({
      overrides: {
        async deleteDocumentBlobs(documentId) {
          if (documentId === failing) {
            throw new Error("blob delete failed");
          }
          await containerClient
            .getBlobClient(documentHtmlBlobKey(documentId))
            .deleteIfExists();
          await containerClient
            .getBlobClient(documentPreviewBlobKey(documentId))
            .deleteIfExists();
        },
      },
    });

    expect(reportFor(result, "blob_cleanup_retry")).toMatchObject({
      result: "failed",
      examined: 2,
      succeeded: 1,
      failed: 1,
    });
    expect(result.hasFailure).toBe(true);
    expect(await blobCleanupPendingOf(failing)).toBe(true);
    expect(await blobCleanupPendingOf(succeeding)).toBe(false);
    // 失敗した資料のBlobは消えていない。
    expect(await blobExists(documentHtmlBlobKey(failing))).toBe(true);
  });
});

describe("1年経過後のpurge(設計 §7.7, §16)", () => {
  it("Blob削除完了・1年経過・監査なしの削除済み資料と、期限切れ監査を削除する", async () => {
    const documentId = await createDocumentWithBlobs();
    await softDelete(documentId);
    await backdateDeletion(documentId, 400);
    const expiredAudit = await insertAuditEventAt(null, 400);
    const freshAudit = await insertAuditEventAt(null, 10);

    const result = await runJob();

    expect(reportFor(result, "expired_audit_purge")).toMatchObject({
      result: "success",
      succeeded: 1,
    });
    expect(reportFor(result, "expired_document_purge")).toMatchObject({
      result: "success",
      succeeded: 1,
    });
    expect(await documentExists(documentId)).toBe(false);

    const remaining = await client.query("SELECT id FROM audit_events");
    expect(remaining.rows.map((row: { id: string }) => row.id)).toEqual([
      freshAudit,
    ]);
    expect(expiredAudit).not.toBe(freshAudit);
  });

  it("blob_cleanup_pending の資料は1年経過してもpurgeしない(設計 §7.7)", async () => {
    const documentId = await createDocumentWithBlobs();
    await softDelete(documentId);
    await backdateDeletion(documentId, 400);

    // Blob削除の再試行が失敗し続ける状況を作る(フラグが下りない)。
    const result = await runJob({
      overrides: {
        deleteDocumentBlobs: async () => {
          throw new Error("blob delete failed");
        },
      },
    });

    expect(reportFor(result, "expired_document_purge").succeeded).toBe(0);
    expect(await blobCleanupPendingOf(documentId)).toBe(true);
    expect(await documentExists(documentId)).toBe(true);
  });

  it("1年未満の削除済み資料と監査はpurgeしない", async () => {
    const documentId = await createDocumentWithBlobs();
    await softDelete(documentId);
    await backdateDeletion(documentId, 300);
    await insertAuditEventAt(null, 300);

    const result = await runJob();

    expect(reportFor(result, "expired_audit_purge").succeeded).toBe(0);
    expect(reportFor(result, "expired_document_purge").succeeded).toBe(0);
    expect(await documentExists(documentId)).toBe(true);
    expect(await auditEventCount()).toBe(1);
  });

  it("監査が残っている資料はpurgeせず、監査が消えた次回の実行でpurgeする", async () => {
    const documentId = await createDocumentWithBlobs();
    await softDelete(documentId);
    await backdateDeletion(documentId, 400);
    // 資料より後に記録された監査(まだ保持期間内)。
    await insertAuditEventAt(documentId, 300);

    const first = await runJob();

    expect(reportFor(first, "expired_document_purge").succeeded).toBe(0);
    expect(await documentExists(documentId)).toBe(true);

    // その監査も保持期間を過ぎた状態にする(保持期間内の行はDBのtriggerが
    // 削除もUPDATEも拒否するため、テストでは作り直す)。
    await client.query("TRUNCATE audit_events");
    await insertAuditEventAt(documentId, 400);

    // 同じ実行の中で、監査 → 資料の順にpurgeされる。
    const second = await runJob();

    expect(reportFor(second, "expired_audit_purge").succeeded).toBe(1);
    expect(reportFor(second, "expired_document_purge").succeeded).toBe(1);
    expect(await documentExists(documentId)).toBe(false);
    expect(await auditEventCount()).toBe(0);
  });

  it("保守Jobは監査を追記しない(purgeした監査が新たな監査を生まない)", async () => {
    const documentId = await createDocumentWithBlobs();
    await softDelete(documentId);

    await runJob();

    expect(await auditEventCount()).toBe(0);
  });
});

describe("孤児Blobの掃除(設計 §7.7)", () => {
  const orphanId = "44444444-4444-4444-8444-444444444444";

  it("猶予内の新しいBlobは、DBに行が無くても削除しない", async () => {
    await uploadDocumentHtml(containerClient, orphanId, Buffer.from(html, "utf8"));

    const result = await runJob();

    expect(reportFor(result, "orphan_blob_cleanup")).toMatchObject({
      result: "success",
      examined: 0,
    });
    expect(await blobExists(documentHtmlBlobKey(orphanId))).toBe(true);
  });

  it("猶予を過ぎた孤児Blobだけを削除し、DBに行がある資料のBlobは残す", async () => {
    const keptId = await createDocumentWithBlobs();
    await uploadDocumentHtml(containerClient, orphanId, Buffer.from(html, "utf8"));
    await uploadDocumentPreview(containerClient, orphanId, jpeg);
    // Azuriteの`lastModified`は後から変更できないため、猶予0で判定させる
    // (猶予そのものの判定は単体テストと上のテストで確認している)。
    const result = await runJob({ overrides: { orphanBlobGraceMs: 0 } });

    expect(reportFor(result, "orphan_blob_cleanup")).toMatchObject({
      result: "success",
      examined: 2,
      succeeded: 2,
      failed: 0,
    });
    expect(await blobExists(documentHtmlBlobKey(orphanId))).toBe(false);
    expect(await blobExists(documentPreviewBlobKey(orphanId))).toBe(false);
    expect(await blobExists(documentHtmlBlobKey(keptId))).toBe(true);
    expect(await blobExists(documentPreviewBlobKey(keptId))).toBe(true);
  });

  it("削除済み(soft delete)資料のBlobは孤児扱いしない", async () => {
    const documentId = await createDocumentWithBlobs();
    await softDelete(documentId);

    // Blob削除の再試行だけを止め、孤児判定の対象になり得る状態を作る。
    const result = await runJob({
      overrides: {
        orphanBlobGraceMs: 0,
        deleteDocumentBlobs: async () => {
          throw new Error("blob delete failed");
        },
      },
    });

    expect(reportFor(result, "orphan_blob_cleanup").examined).toBe(0);
    expect(await blobExists(documentHtmlBlobKey(documentId))).toBe(true);
  });

  it("想定外のキーのBlobには触らない", async () => {
    await containerClient
      .getBlockBlobClient("unexpected/object.bin")
      .uploadData(Buffer.from("x"));

    const result = await runJob({ overrides: { orphanBlobGraceMs: 0 } });

    expect(reportFor(result, "orphan_blob_cleanup").examined).toBe(0);
    expect(await blobExists("unexpected/object.bin")).toBe(true);
  });
});

describe("upload_attempts の古い行のpurge(Q-011)", () => {
  async function insertAttempt(values: {
    startedDaysAgo: number;
    expiresDaysAgo: number;
    finishedDaysAgo: number | null;
  }): Promise<string> {
    const result = await client.query<{ id: string }>(
      `INSERT INTO upload_attempts (owner_subject_id, started_at, expires_at, finished_at, byte_size)
       VALUES ($1,
               now() - make_interval(days => $2::int),
               now() - make_interval(days => $3::int),
               CASE WHEN $4::int IS NULL THEN NULL
                    ELSE now() - make_interval(days => $4::int) END,
               0)
       RETURNING id`,
      [
        ownerSubjectId,
        values.startedDaysAgo,
        values.expiresDaysAgo,
        values.finishedDaysAgo,
      ],
    );
    const id = result.rows[0]?.id;
    if (!id) {
      throw new Error("upload_attemptsを作成できませんでした");
    }
    return id;
  }

  it("保持期間を過ぎた行だけを削除する", async () => {
    const oldFinished = await insertAttempt({
      startedDaysAgo: 30,
      expiresDaysAgo: 29,
      finishedDaysAgo: 29,
    });
    const oldAbandoned = await insertAttempt({
      startedDaysAgo: 30,
      expiresDaysAgo: 29,
      finishedDaysAgo: null,
    });
    const recentlyFinished = await insertAttempt({
      startedDaysAgo: 30,
      expiresDaysAgo: 29,
      // lease失効後に解放された行。頻度判定には使わないが、保持期間内なら残す。
      finishedDaysAgo: 1,
    });
    const inProgress = await insertAttempt({
      startedDaysAgo: 0,
      expiresDaysAgo: -1,
      finishedDaysAgo: null,
    });

    const result = await runJob();

    expect(reportFor(result, "upload_attempt_purge")).toMatchObject({
      result: "success",
      succeeded: 2,
    });
    const remaining = await client.query<{ id: string }>(
      "SELECT id FROM upload_attempts ORDER BY started_at",
    );
    expect(remaining.rows.map((row) => row.id).sort()).toEqual(
      [recentlyFinished, inProgress].sort(),
    );
    expect([oldFinished, oldAbandoned]).toHaveLength(2);
  });
});

describe("DB roleの権限分離(設計 §7.4)", () => {
  async function grantedPrivileges(tableName: string, role: string): Promise<string[]> {
    const result = await client.query<{ privilege_type: string }>(
      `SELECT privilege_type FROM information_schema.role_table_grants
        WHERE table_schema = $1 AND table_name = $2 AND grantee = $3
        ORDER BY privilege_type`,
      [schema, tableName, role],
    );
    return result.rows.map((row) => row.privilege_type);
  }

  it("保守roleにはpurgeに必要な権限だけを与える", async () => {
    expect(await grantedPrivileges("documents", maintenanceRole)).toEqual([
      "DELETE",
      "SELECT",
      "UPDATE",
    ]);
    // 監査はSELECT/DELETEのみ(保守Jobは監査を書かない)。
    expect(await grantedPrivileges("audit_events", maintenanceRole)).toEqual([
      "DELETE",
      "SELECT",
    ]);
    expect(await grantedPrivileges("upload_attempts", maintenanceRole)).toEqual([
      "DELETE",
      "SELECT",
    ]);
  });

  it("runtime roleの権限は変わらない(DELETEを持たない)", async () => {
    expect(await grantedPrivileges("documents", runtimeRole)).toEqual([
      "INSERT",
      "SELECT",
      "UPDATE",
    ]);
    expect(await grantedPrivileges("audit_events", runtimeRole)).toEqual([
      "INSERT",
      "SELECT",
    ]);
    expect(await grantedPrivileges("upload_attempts", runtimeRole)).toEqual([
      "INSERT",
      "SELECT",
      "UPDATE",
    ]);
  });
});

describe("監査の追記専用性(設計 §12.2, §16)", () => {
  it("runtime roleはaudit_eventsをDELETEできない", async () => {
    const auditId = await insertAuditEventAt(null, 400);

    await asRole(runtimeRole, async () => {
      await expect(
        client.query("DELETE FROM audit_events WHERE id = $1", [auditId]),
      ).rejects.toThrow(/permission denied/i);
    });

    expect(await auditEventCount()).toBe(1);
  });

  it("runtime roleはdocuments・upload_attemptsもDELETEできない", async () => {
    await asRole(runtimeRole, async () => {
      await expect(client.query("DELETE FROM documents")).rejects.toThrow(
        /permission denied/i,
      );
      await expect(client.query("DELETE FROM upload_attempts")).rejects.toThrow(
        /permission denied/i,
      );
    });
  });

  it("保守roleでも保持期間内の監査はDELETEできない", async () => {
    const auditId = await insertAuditEventAt(null, 10);

    await asRole(maintenanceRole, async () => {
      await expect(
        client.query("DELETE FROM audit_events WHERE id = $1", [auditId]),
      ).rejects.toThrow(/append-only/i);
    });

    expect(await auditEventCount()).toBe(1);
  });

  it("保守roleは保持期間を過ぎた監査だけをDELETEできる", async () => {
    const expired = await insertAuditEventAt(null, 400);

    await asRole(maintenanceRole, async () => {
      await client.query("DELETE FROM audit_events WHERE id = $1", [expired]);
    });

    expect(await auditEventCount()).toBe(0);
  });

  it("pg_tempに同名リレーションを置いてもtriggerの判定は変わらない", async () => {
    const expired = await insertAuditEventAt(null, 400);
    // triggerが参照するカタログ(`pg_roles`)を`pg_temp`で影にする試み。
    // 関数は`SET search_path = pg_catalog, pg_temp`で固定しているため効かない。
    await client.query("CREATE TEMP TABLE pg_roles (rolname name)");
    // `pg_catalog`を明示的に後ろへ置かないと、PostgreSQLが暗黙に先頭へ付けるため
    // 影にならない(この順序が実際に影を作れる指定)。
    await client.query(`SET search_path TO pg_temp, pg_catalog, "${schema}"`);

    try {
      await asRole(maintenanceRole, async () => {
        await client.query(
          `DELETE FROM "${schema}".audit_events WHERE id = $1`,
          [expired],
        );
      });
    } finally {
      await client.query(`SET search_path TO "${schema}"`);
      await client.query("DROP TABLE pg_temp.pg_roles");
    }

    expect(await auditEventCount()).toBe(0);
  });

  it("保守roleでもaudit_eventsをUPDATEできない", async () => {
    const auditId = await insertAuditEventAt(null, 400);

    await asRole(maintenanceRole, async () => {
      await expect(
        client.query(
          "UPDATE audit_events SET error_category = 'internal_error' WHERE id = $1",
          [auditId],
        ),
      ).rejects.toThrow(/permission denied|append-only/i);
    });
  });
});
