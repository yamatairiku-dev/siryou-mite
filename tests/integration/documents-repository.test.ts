import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Client } from "pg";
import {
  createDocument,
  decodeDocumentCursor,
  deleteDocumentAsAdmin,
  deleteDocumentAsOwner,
  encodeDocumentCursor,
  findDocumentById,
  getOwnerUsage,
  getSystemUsage,
  InvalidCursorError,
  listDocumentsByOwner,
  markBlobCleanupCompleted,
} from "~/lib/db/documents.server";
import { insertAuditEvent } from "~/lib/db/audit-events.server";
import { closePool, withTransaction } from "~/lib/db/pool.server";
import { dropSchema, migrateFreshSchema, newClient } from "./helpers/schema.js";

/**
 * T04 結合テスト: `documents` repository(設計 §7.4, §11.1, §12.1, §18.2)。
 *
 * 実際のPostgreSQLへmigrationを適用し、repositoryのSQLをそのまま実行する。
 * schemaはテスト専用のものを作り、`search_path`で切り替える。
 */

const schema = "t04_it_documents";
const owner = "owner-oid-001";
const otherOwner = "owner-oid-002";

let client: Client;

beforeAll(async () => {
  await migrateFreshSchema(schema);
  client = newClient();
  await client.connect();
  await client.query(`SET search_path TO "${schema}"`);
});

afterAll(async () => {
  await closePool();
  await client.end();
  await dropSchema(schema);
});

beforeEach(async () => {
  await client.query("TRUNCATE audit_events, documents");
});

async function addDocument(options: {
  ownerSubjectId: string;
  createdAt?: string;
  byteSize?: number;
  title?: string;
}) {
  const record = await createDocument(
    {
      ownerSubjectId: options.ownerSubjectId,
      ownerEmailAtUpload: "owner@example.com",
      originalFileName: "資料.html",
      title: options.title ?? "資料タイトル",
      byteSize: options.byteSize ?? 1024,
      warningCodes: ["script_disabled"],
    },
    client,
  );

  if (!options.createdAt) {
    return record;
  }

  // 同時刻の並び順(タイブレーカ)を検証するため、登録日時だけ直接調整する。
  const updated = await client.query<{ created_at: Date }>(
    "UPDATE documents SET created_at = $2 WHERE id = $1 RETURNING created_at",
    [record.id, options.createdAt],
  );
  return { ...record, createdAt: updated.rows[0]?.created_at ?? record.createdAt };
}

describe("createDocument / findDocumentById", () => {
  it("`active`・プレビュー`pending`として保存し、そのまま読み戻せる", async () => {
    const created = await addDocument({ ownerSubjectId: owner });

    expect(created.status).toBe("active");
    expect(created.previewStatus).toBe("pending");
    expect(created.blobCleanupPending).toBe(false);
    expect(created.byteSize).toBe(1024);

    const found = await findDocumentById(created.id, client);
    expect(found).toEqual(created);
  });

  it("存在しない資料IDはnullを返す", async () => {
    expect(
      await findDocumentById("00000000-0000-4000-8000-000000000000", client),
    ).toBeNull();
  });
});

describe("listDocumentsByOwner(cursor pagination)", () => {
  it("自分の`active`な資料だけを新しい順に返す", async () => {
    const mine = await addDocument({
      ownerSubjectId: owner,
      createdAt: "2026-01-02T00:00:00Z",
    });
    const deleted = await addDocument({
      ownerSubjectId: owner,
      createdAt: "2026-01-03T00:00:00Z",
    });
    await deleteDocumentAsOwner(
      { documentId: deleted.id, ownerSubjectId: owner },
      client,
    );
    await addDocument({
      ownerSubjectId: otherOwner,
      createdAt: "2026-01-04T00:00:00Z",
    });

    const page = await listDocumentsByOwner({ ownerSubjectId: owner }, client);

    expect(page.documents.map((document) => document.id)).toEqual([mine.id]);
    expect(page.nextCursor).toBeNull();
  });

  it("登録日時が同じ資料でも重複・欠落なくページングできる", async () => {
    const created = [];
    for (let index = 0; index < 5; index += 1) {
      created.push(
        await addDocument({
          ownerSubjectId: owner,
          createdAt: "2026-01-02T00:00:00Z",
        }),
      );
    }
    const expectedOrder = [...created]
      .sort((a, b) => (a.id < b.id ? 1 : -1))
      .map((document) => document.id);

    const collected: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 5; page += 1) {
      const result: Awaited<ReturnType<typeof listDocumentsByOwner>> =
        await listDocumentsByOwner(
          { ownerSubjectId: owner, limit: 2, cursor },
          client,
        );
      collected.push(...result.documents.map((document) => document.id));
      cursor = result.nextCursor;
      if (!cursor) {
        break;
      }
    }

    expect(cursor).toBeNull();
    expect(collected).toEqual(expectedOrder);
  });

  it("他人の資料のcursorを渡しても、自分の資料だけを返す", async () => {
    const theirs = await addDocument({
      ownerSubjectId: otherOwner,
      createdAt: "2026-01-05T00:00:00Z",
    });
    const mineNewer = await addDocument({
      ownerSubjectId: owner,
      createdAt: "2026-01-04T00:00:00Z",
    });
    await addDocument({
      ownerSubjectId: owner,
      createdAt: "2026-01-01T00:00:00Z",
    });

    const page = await listDocumentsByOwner(
      {
        ownerSubjectId: owner,
        cursor: encodeDocumentCursor({
          createdAt: theirs.createdAt,
          id: theirs.id,
        }),
      },
      client,
    );

    expect(page.documents.map((document) => document.ownerSubjectId)).toEqual([
      owner,
      owner,
    ]);
    expect(page.documents[0]?.id).toBe(mineNewer.id);
  });

  it("改ざんされたcursorはSQLを実行せずに拒否する", async () => {
    await expect(
      listDocumentsByOwner(
        { ownerSubjectId: owner, cursor: "cGxhaW4tdGV4dA" },
        client,
      ),
    ).rejects.toBeInstanceOf(InvalidCursorError);
  });

  it("次ページのcursorは最後の行の位置を指す", async () => {
    const older = await addDocument({
      ownerSubjectId: owner,
      createdAt: "2026-01-01T00:00:00Z",
    });
    await addDocument({ ownerSubjectId: owner, createdAt: "2026-01-02T00:00:00Z" });

    const first = await listDocumentsByOwner(
      { ownerSubjectId: owner, limit: 1 },
      client,
    );
    expect(first.nextCursor).not.toBeNull();

    const second = await listDocumentsByOwner(
      { ownerSubjectId: owner, limit: 1, cursor: first.nextCursor },
      client,
    );

    expect(second.documents.map((document) => document.id)).toEqual([older.id]);
    expect(second.nextCursor).toBeNull();
    expect(decodeDocumentCursor(first.nextCursor ?? "").id).toBe(
      first.documents[0]?.id,
    );
  });
});

describe("削除(設計 §10.4, §11.1, §12.1)", () => {
  it("所有者削除で状態を遷移し、機微・表示用項目をDBから消去する", async () => {
    const document = await addDocument({ ownerSubjectId: owner });

    const deleted = await deleteDocumentAsOwner(
      { documentId: document.id, ownerSubjectId: owner },
      client,
    );

    expect(deleted).toMatchObject({
      status: "deleted",
      ownerEmailAtUpload: null,
      originalFileName: null,
      title: null,
      byteSize: null,
      previewStatus: null,
      warningCodes: null,
      deletedBySubjectId: owner,
      blobCleanupPending: true,
    });
    expect(deleted?.deletedAt).toBeInstanceOf(Date);

    // 資料ID・owner・登録/削除日時・削除実行者は1年間保持する(設計 §10.4(6))。
    const stored = await client.query(
      `SELECT owner_subject_id, owner_email_at_upload, original_file_name, title,
              byte_size, preview_status, warning_codes
         FROM documents WHERE id = $1`,
      [document.id],
    );
    expect(stored.rows[0]).toEqual({
      owner_subject_id: owner,
      owner_email_at_upload: null,
      original_file_name: null,
      title: null,
      byte_size: null,
      preview_status: null,
      warning_codes: null,
    });
  });

  it("所有者以外の削除要求では1行も更新しない", async () => {
    const document = await addDocument({ ownerSubjectId: owner });

    expect(
      await deleteDocumentAsOwner(
        { documentId: document.id, ownerSubjectId: otherOwner },
        client,
      ),
    ).toBeNull();
    expect((await findDocumentById(document.id, client))?.status).toBe("active");
  });

  it("削除済み資料の再削除はnullを返す(`active`からの遷移だけを許す)", async () => {
    const document = await addDocument({ ownerSubjectId: owner });
    await deleteDocumentAsOwner(
      { documentId: document.id, ownerSubjectId: owner },
      client,
    );

    expect(
      await deleteDocumentAsOwner(
        { documentId: document.id, ownerSubjectId: owner },
        client,
      ),
    ).toBeNull();
  });

  it("管理者は他人の資料を強制削除でき、実行者が記録される", async () => {
    const document = await addDocument({ ownerSubjectId: owner });

    const deleted = await deleteDocumentAsAdmin(
      { documentId: document.id, adminSubjectId: "admin-oid" },
      client,
    );

    expect(deleted).toMatchObject({
      status: "deleted",
      ownerSubjectId: owner,
      deletedBySubjectId: "admin-oid",
    });
  });

  it("Blob削除完了で再試行フラグを下ろす", async () => {
    const document = await addDocument({ ownerSubjectId: owner });
    await deleteDocumentAsOwner(
      { documentId: document.id, ownerSubjectId: owner },
      client,
    );

    expect(await markBlobCleanupCompleted(document.id, client)).toBe(true);
    expect((await findDocumentById(document.id, client))?.blobCleanupPending).toBe(
      false,
    );
    expect(await markBlobCleanupCompleted(document.id, client)).toBe(false);
  });
});

describe("使用量の集計(設計 §6.1)", () => {
  it("`active`な資料だけを利用者別・システム全体で集計する", async () => {
    await addDocument({ ownerSubjectId: owner, byteSize: 1000 });
    const deleted = await addDocument({ ownerSubjectId: owner, byteSize: 2000 });
    await addDocument({ ownerSubjectId: otherOwner, byteSize: 3000 });
    await deleteDocumentAsOwner(
      { documentId: deleted.id, ownerSubjectId: owner },
      client,
    );

    expect(await getOwnerUsage(owner, client)).toEqual({
      documentCount: 1,
      totalByteSize: 1000,
    });
    expect(await getSystemUsage(client)).toEqual({
      documentCount: 2,
      totalByteSize: 4000,
    });
  });

  it("資料が無い場合は0を返す", async () => {
    expect(await getOwnerUsage(owner, client)).toEqual({
      documentCount: 0,
      totalByteSize: 0,
    });
  });
});

describe("withTransaction(業務更新と監査を同じトランザクションで保存する。設計 §15.1)", () => {
  const correlationId = "33333333-4444-4555-8666-777777777777";

  it("commitすると資料と監査の両方が残る", async () => {
    const documentId = await withTransaction(async (tx) => {
      await tx.query(`SET LOCAL search_path TO "${schema}"`);
      const document = await createDocument(
        { ownerSubjectId: owner, byteSize: 10 },
        tx,
      );
      await insertAuditEvent(
        {
          action: "upload",
          result: "success",
          documentId: document.id,
          actorSubjectId: owner,
          actorTenantId: "tenant-id",
          correlationId,
        },
        tx,
      );
      return document.id;
    });

    expect(await findDocumentById(documentId, client)).not.toBeNull();
    const audits = await client.query(
      "SELECT id FROM audit_events WHERE document_id = $1",
      [documentId],
    );
    expect(audits.rowCount).toBe(1);
  });

  it("監査保存に失敗すると資料登録もrollbackされる", async () => {
    await expect(
      withTransaction(async (tx) => {
        await tx.query(`SET LOCAL search_path TO "${schema}"`);
        await createDocument({ ownerSubjectId: owner, byteSize: 10 }, tx);
        // 存在しない資料IDはFK違反になり、監査保存が失敗する。
        await insertAuditEvent(
          {
            action: "upload",
            result: "success",
            documentId: "00000000-0000-4000-8000-000000000000",
            actorSubjectId: owner,
            actorTenantId: "tenant-id",
            correlationId,
          },
          tx,
        );
      }),
    ).rejects.toThrow();

    expect(await getSystemUsage(client)).toEqual({
      documentCount: 0,
      totalByteSize: 0,
    });
  });
});
