import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Client } from "pg";
import {
  dropSchema,
  migrateFreshSchema,
  newClient,
} from "./helpers/schema.js";

/**
 * T03 結合テスト(設計 §18.2, §11, §12)。
 *
 * devcontainerのローカルPostgreSQLへ実際にmigrationを適用し、テーブル・カラム・
 * 型・NOT NULL・CHECK制約・indexが設計どおり存在すること、および
 * `audit_events`への追記専用(UPDATE/DELETE拒否)を確認する。
 *
 * `npm run test`(vitest.config.ts)には含めず、`npm run test:integration`から
 * 個別に実行する(CIでのPostgreSQL service containerが必要)。
 */

const schema = "t03_it_schema";
let client: Client;

beforeAll(async () => {
  await migrateFreshSchema(schema);
  client = newClient();
  await client.connect();
  await client.query(`SET search_path TO "${schema}"`);
});

afterAll(async () => {
  await client.end();
  await dropSchema(schema);
});

async function columnsOf(tableName: string) {
  const result = await client.query(
    `SELECT column_name, data_type, is_nullable, column_default
     FROM information_schema.columns
     WHERE table_schema = $1 AND table_name = $2
     ORDER BY ordinal_position`,
    [schema, tableName],
  );
  return result.rows as Array<{
    column_name: string;
    data_type: string;
    is_nullable: "YES" | "NO";
    column_default: string | null;
  }>;
}

function findColumn(
  columns: Awaited<ReturnType<typeof columnsOf>>,
  name: string,
) {
  const column = columns.find((c) => c.column_name === name);
  if (!column) {
    throw new Error(`column not found: ${name}`);
  }
  return column;
}

async function indexNamesOf(tableName: string): Promise<string[]> {
  const result = await client.query(
    `SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND tablename = $2`,
    [schema, tableName],
  );
  return result.rows.map((row: { indexname: string }) => row.indexname);
}

describe("documents table", () => {
  it("has the columns and types defined in 設計 §12.1", async () => {
    const columns = await columnsOf("documents");

    expect(findColumn(columns, "id")).toMatchObject({
      data_type: "uuid",
      is_nullable: "NO",
    });
    expect(findColumn(columns, "owner_subject_id")).toMatchObject({
      data_type: "text",
      is_nullable: "NO",
    });
    expect(findColumn(columns, "created_at")).toMatchObject({
      data_type: "timestamp with time zone",
      is_nullable: "NO",
    });
    expect(findColumn(columns, "byte_size").data_type).toBe("bigint");
    expect(findColumn(columns, "blob_cleanup_pending")).toMatchObject({
      data_type: "boolean",
      is_nullable: "NO",
    });

    // 削除時に消去する機微・表示用項目はNULL許容にする(設計 §12.1)。
    for (const name of [
      "owner_email_at_upload",
      "original_file_name",
      "title",
      "byte_size",
      "preview_status",
      "warning_codes",
    ]) {
      expect(findColumn(columns, name).is_nullable).toBe("YES");
    }
  });

  it("has indexes for owner-scoped listing and admin search (設計 §5.2, §5.6)", async () => {
    const indexes = await indexNamesOf("documents");
    expect(indexes).toEqual(
      expect.arrayContaining([
        "documents_pkey",
        // T04のmigrationで`id DESC`を加えたindexへ置き換えた(keyset pagination)。
        "documents_owner_created_at_id_idx",
        "documents_created_at_idx",
        "documents_owner_email_at_upload_idx",
        "documents_original_file_name_idx",
      ]),
    );
  });

  it("rejects an unknown status value", async () => {
    await expect(
      client.query(
        `INSERT INTO documents (owner_subject_id, status) VALUES ('owner-1', 'archived')`,
      ),
    ).rejects.toThrow(/documents_status_check/);
  });

  it("rejects an unknown preview_status value", async () => {
    await expect(
      client.query(
        `INSERT INTO documents (owner_subject_id, preview_status) VALUES ('owner-1', 'unknown')`,
      ),
    ).rejects.toThrow(/documents_preview_status_check/);
  });

  it("rejects a negative byte_size", async () => {
    await expect(
      client.query(
        `INSERT INTO documents (owner_subject_id, byte_size) VALUES ('owner-1', -1)`,
      ),
    ).rejects.toThrow(/documents_byte_size_check/);
  });

  it("enforces status/deleted_at consistency (設計 §11.1)", async () => {
    await expect(
      client.query(
        `INSERT INTO documents (owner_subject_id, status) VALUES ('owner-1', 'deleted')`,
      ),
    ).rejects.toThrow(/documents_deleted_consistency_check/);

    await expect(
      client.query(
        `INSERT INTO documents (owner_subject_id, status, deleted_at) VALUES ('owner-1', 'active', now())`,
      ),
    ).rejects.toThrow(/documents_deleted_consistency_check/);
  });

  it("requires owner_subject_id", async () => {
    await expect(
      client.query(`INSERT INTO documents (title) VALUES ('no owner')`),
    ).rejects.toThrow(/owner_subject_id/);
  });

  it("defaults to an active, pending-preview document with generated id", async () => {
    const result = await client.query(
      `INSERT INTO documents (owner_subject_id) VALUES ('owner-defaults')
       RETURNING id, status, preview_status, warning_codes, blob_cleanup_pending, created_at`,
    );
    const row = result.rows[0];
    expect(row.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(row.status).toBe("active");
    expect(row.preview_status).toBeNull();
    expect(row.warning_codes).toEqual([]);
    expect(row.blob_cleanup_pending).toBe(false);
    expect(row.created_at).toBeInstanceOf(Date);
  });
});

describe("audit_events table", () => {
  it("has the columns and types defined in 設計 §12.2", async () => {
    const columns = await columnsOf("audit_events");

    expect(findColumn(columns, "id")).toMatchObject({
      data_type: "uuid",
      is_nullable: "NO",
    });
    expect(findColumn(columns, "occurred_at")).toMatchObject({
      data_type: "timestamp with time zone",
      is_nullable: "NO",
    });
    expect(findColumn(columns, "action").is_nullable).toBe("NO");
    expect(findColumn(columns, "result").is_nullable).toBe("NO");
    expect(findColumn(columns, "document_id").is_nullable).toBe("YES");
    expect(findColumn(columns, "actor_subject_id").is_nullable).toBe("NO");
    expect(findColumn(columns, "actor_tenant_id").is_nullable).toBe("NO");
    expect(findColumn(columns, "correlation_id").is_nullable).toBe("NO");
    expect(findColumn(columns, "retain_until")).toMatchObject({
      data_type: "timestamp with time zone",
      is_nullable: "NO",
    });
  });

  it("has indexes supporting audit search by date/actor/document/action/result (設計 §5.7)", async () => {
    const indexes = await indexNamesOf("audit_events");
    expect(indexes).toEqual(
      expect.arrayContaining([
        "audit_events_pkey",
        // T04のmigrationで`id DESC`を加えたindexへ置き換えた(keyset pagination)。
        "audit_events_occurred_at_id_idx",
        "audit_events_document_id_idx",
        "audit_events_actor_subject_id_idx",
        "audit_events_action_idx",
        "audit_events_result_idx",
        "audit_events_retain_until_idx",
      ]),
    );
  });

  it("rejects an unknown action value", async () => {
    await expect(
      client.query(
        `INSERT INTO audit_events (action, result, actor_subject_id, actor_tenant_id, correlation_id)
         VALUES ('bogus', 'success', 'actor-1', 'tenant-1', gen_random_uuid())`,
      ),
    ).rejects.toThrow(/audit_events_action_check/);
  });

  it("rejects an unknown result value", async () => {
    await expect(
      client.query(
        `INSERT INTO audit_events (action, result, actor_subject_id, actor_tenant_id, correlation_id)
         VALUES ('upload', 'bogus', 'actor-1', 'tenant-1', gen_random_uuid())`,
      ),
    ).rejects.toThrow(/audit_events_result_check/);
  });

  it("computes retain_until as occurred_at + 1 year regardless of caller-supplied value (設計 §16)", async () => {
    const occurredAt = "2026-01-01T00:00:00Z";
    const result = await client.query(
      `INSERT INTO audit_events (occurred_at, action, result, actor_subject_id, actor_tenant_id, correlation_id, retain_until)
       VALUES ($1, 'upload', 'success', 'actor-1', 'tenant-1', gen_random_uuid(), '1999-01-01T00:00:00Z')
       RETURNING occurred_at, retain_until`,
      [occurredAt],
    );
    const row = result.rows[0] as { occurred_at: Date; retain_until: Date };
    const expected = new Date(row.occurred_at);
    expected.setUTCFullYear(expected.getUTCFullYear() + 1);
    expect(row.retain_until.getTime()).toBe(expected.getTime());
  });

  it("allows a valid insert referencing a document", async () => {
    const doc = await client.query(
      `INSERT INTO documents (owner_subject_id) VALUES ('owner-audit') RETURNING id`,
    );
    const documentId = doc.rows[0].id as string;

    const result = await client.query(
      `INSERT INTO audit_events (action, result, document_id, actor_subject_id, actor_tenant_id, actor_email_at_event, actor_group_values, actor_roles, correlation_id)
       VALUES ('view', 'success', $1, 'actor-2', 'tenant-1', 'actor@example.com', ARRAY['G1'], ARRAY['User'], gen_random_uuid())
       RETURNING id, document_id`,
      [documentId],
    );
    expect(result.rows[0].document_id).toBe(documentId);
  });

  it("rejects UPDATE (append-only, 設計 §12.2)", async () => {
    const inserted = await client.query(
      `INSERT INTO audit_events (action, result, actor_subject_id, actor_tenant_id, correlation_id)
       VALUES ('upload', 'success', 'actor-3', 'tenant-1', gen_random_uuid())
       RETURNING id`,
    );
    const id = inserted.rows[0].id as string;

    await expect(
      client.query(`UPDATE audit_events SET result = 'failed' WHERE id = $1`, [
        id,
      ]),
    ).rejects.toThrow(/append-only/);
  });

  it("rejects DELETE (append-only, 設計 §12.2)", async () => {
    const inserted = await client.query(
      `INSERT INTO audit_events (action, result, actor_subject_id, actor_tenant_id, correlation_id)
       VALUES ('upload', 'success', 'actor-4', 'tenant-1', gen_random_uuid())
       RETURNING id`,
    );
    const id = inserted.rows[0].id as string;

    await expect(
      client.query(`DELETE FROM audit_events WHERE id = $1`, [id]),
    ).rejects.toThrow(/append-only/);
  });
});

describe("upload_attempts table (T08: 設計 §6.1の頻度・同時実行判定)", () => {
  it("has the columns and types for rate/concurrency judgement", async () => {
    const columns = await columnsOf("upload_attempts");

    expect(findColumn(columns, "id")).toMatchObject({
      data_type: "uuid",
      is_nullable: "NO",
    });
    expect(findColumn(columns, "owner_subject_id")).toMatchObject({
      data_type: "text",
      is_nullable: "NO",
    });
    expect(findColumn(columns, "started_at")).toMatchObject({
      data_type: "timestamp with time zone",
      is_nullable: "NO",
    });
    expect(findColumn(columns, "expires_at")).toMatchObject({
      data_type: "timestamp with time zone",
      is_nullable: "NO",
    });
    // 明示的な解放時刻。未解放(NULL)かつ未失効の行だけを「進行中」として数える。
    expect(findColumn(columns, "finished_at")).toMatchObject({
      data_type: "timestamp with time zone",
      is_nullable: "YES",
    });
    // 予約byte数。旧versionのアプリがINSERTしても失敗しないよう既定値0を持つ。
    expect(findColumn(columns, "byte_size")).toMatchObject({
      data_type: "bigint",
      is_nullable: "NO",
    });
    expect(findColumn(columns, "byte_size").column_default).toContain("0");

    // HTML本文・ファイル名など設計 §12.2の非記録項目を持たない。
    expect(columns.map((column) => column.column_name).sort()).toEqual([
      "byte_size",
      "expires_at",
      "finished_at",
      "id",
      "owner_subject_id",
      "started_at",
    ]);
  });

  it("has indexes for the rate window and in-progress lookups", async () => {
    const indexes = await indexNamesOf("upload_attempts");
    expect(indexes).toEqual(
      expect.arrayContaining([
        "upload_attempts_pkey",
        "upload_attempts_owner_started_at_idx",
        "upload_attempts_owner_in_progress_idx",
        "upload_attempts_in_progress_byte_size_idx",
      ]),
    );
  });

  it("has a partial index for active document usage aggregation", async () => {
    expect(await indexNamesOf("documents")).toEqual(
      expect.arrayContaining(["documents_active_owner_byte_size_idx"]),
    );
  });

  it("rejects an expires_at that is not after started_at", async () => {
    await expect(
      client.query(
        `INSERT INTO upload_attempts (owner_subject_id, started_at, expires_at)
         VALUES ('owner-1', now(), now() - interval '1 second')`,
      ),
    ).rejects.toThrow(/upload_attempts_expires_at_check/);
  });

  it("rejects a negative byte_size", async () => {
    await expect(
      client.query(
        `INSERT INTO upload_attempts (owner_subject_id, expires_at, byte_size)
         VALUES ('owner-1', now() + interval '1 minute', -1)`,
      ),
    ).rejects.toThrow(/upload_attempts_byte_size_check/);
  });

  it("defaults to an in-progress attempt with generated id", async () => {
    const result = await client.query(
      `INSERT INTO upload_attempts (owner_subject_id, expires_at)
       VALUES ('owner-defaults', now() + interval '2 minutes')
       RETURNING id, started_at, finished_at, byte_size`,
    );
    const row = result.rows[0];
    expect(row.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(row.started_at).toBeInstanceOf(Date);
    expect(row.finished_at).toBeNull();
    expect(row.byte_size).toBe("0");
  });
});
