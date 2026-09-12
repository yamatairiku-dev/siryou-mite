import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Client } from "pg";
import { dropSchema, migrateFreshSchema, newClient } from "./helpers/schema.js";

/**
 * T03 結合テスト: runtime用roleへの権限分離(設計 §7.4, §12.2)。
 *
 * `siryou_mite_runtime`roleが存在しない場合でもmigrationが失敗しないこと
 * (ローカル・CIの前提)と、roleが存在する場合にdocuments/audit_eventsへ
 * 想定どおりの権限だけが付与されることの両方を確認する。
 */

const schemaWithoutRole = "t03_it_grants_norole";
const schemaWithRole = "t03_it_grants_role";
const roleName = "siryou_mite_runtime";

let client: Client;

async function grantedPrivileges(
  schema: string,
  tableName: string,
): Promise<string[]> {
  const result = await client.query(
    `SELECT privilege_type FROM information_schema.role_table_grants
     WHERE table_schema = $1 AND table_name = $2 AND grantee = $3
     ORDER BY privilege_type`,
    [schema, tableName, roleName],
  );
  return result.rows.map((row: { privilege_type: string }) => row.privilege_type);
}

beforeAll(async () => {
  client = newClient();
  await client.connect();

  // roleが存在しない状態でmigrationがエラーにならないことを確認する(ローカル/CI想定)。
  await migrateFreshSchema(schemaWithoutRole);

  // roleが存在する状態で、想定どおりのGRANTだけが行われることを確認する。
  await client.query(`DROP ROLE IF EXISTS "${roleName}"`);
  await client.query(`CREATE ROLE "${roleName}" NOLOGIN`);
  try {
    await migrateFreshSchema(schemaWithRole);
  } catch (error) {
    await dropSchema(schemaWithRole).catch(() => {});
    await client.query(`DROP ROLE IF EXISTS "${roleName}"`);
    throw error;
  }
});

afterAll(async () => {
  // roleへのGRANTが残っている間はDROP ROLEできないため、GRANT先のテーブルを
  // 含むschemaを先に削除してからroleを削除する。
  await dropSchema(schemaWithoutRole);
  await dropSchema(schemaWithRole);
  await client.query(`DROP ROLE IF EXISTS "${roleName}"`);
  await client.end();
});

describe("when the runtime role does not exist", () => {
  it("migrates successfully without granting anything", async () => {
    expect(await grantedPrivileges(schemaWithoutRole, "documents")).toEqual(
      [],
    );
    expect(
      await grantedPrivileges(schemaWithoutRole, "audit_events"),
    ).toEqual([]);
    expect(
      await grantedPrivileges(schemaWithoutRole, "upload_attempts"),
    ).toEqual([]);
  });
});

describe("when the runtime role exists", () => {
  it("grants only SELECT/INSERT/UPDATE on documents (no DELETE)", async () => {
    expect(await grantedPrivileges(schemaWithRole, "documents")).toEqual([
      "INSERT",
      "SELECT",
      "UPDATE",
    ]);
  });

  it("grants only SELECT/INSERT on audit_events (no UPDATE/DELETE)", async () => {
    expect(await grantedPrivileges(schemaWithRole, "audit_events")).toEqual([
      "INSERT",
      "SELECT",
    ]);
  });

  // T08: upload_attempts(設計 §6.1の頻度・同時実行判定)。解放はUPDATEで行い、
  // 古い行のpurgeはMaintenance Job側の作業とするためDELETEは与えない。
  it("grants only SELECT/INSERT/UPDATE on upload_attempts (no DELETE)", async () => {
    expect(await grantedPrivileges(schemaWithRole, "upload_attempts")).toEqual([
      "INSERT",
      "SELECT",
      "UPDATE",
    ]);
  });
});
