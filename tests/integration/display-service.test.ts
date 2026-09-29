import { generateKeyPairSync } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ContainerClient } from "@azure/storage-blob";
import type { Client } from "pg";
import {
  createDisplayGrantSigningKey,
  DISPLAY_GRANT_FORM_FIELD,
  signDisplayGrant,
} from "../../services/shared/grant.js";
import {
  createDocument,
  deleteDocumentAsOwner,
} from "../../services/shared/db/documents.js";
import {
  createBlobServiceClient,
  getDocumentsContainerClient,
  uploadDocumentHtml,
} from "../../services/shared/storage.js";
import { parseDisplayEnvironment } from "../../services/display/env.js";
import { createDisplayRuntime } from "../../services/display/dependencies.js";
import { createDisplayServer } from "../../services/display/server.js";
import { displayContentSecurityPolicy } from "../../services/display/headers.js";
import { dropSchema, migrateFreshSchema, newClient, requireDatabaseUrl } from "./helpers/schema.js";
import { requireStorageConnectionString, uniqueTestName } from "./helpers/storage.js";

/**
 * T12 結合テスト: HTML表示サービス(設計 §7.2, §9.2, §10.3, §18.2)。
 *
 * 実際のPostgreSQL(テスト専用schema)とAzurite(テスト専用container)に対して、
 * 本番と同じ組み立て(`createDisplayRuntime`)でDisplayを起動し、grantの正常系・
 * 60秒以内の再利用・期限切れ・削除直後の拒否・CSPヘッダーを検証する。
 */

const schema = "t12_it_display";
const appOrigin = "http://localhost:3000";
const ownerSubjectId = "oid-integration-viewer";
const tenantId = "tenant-integration";
const html =
  "<!doctype html><html><head><title>結合テスト資料</title></head><body><p>本文</p></body></html>";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const signingKey = createDisplayGrantSigningKey({
  keyId: "t12-key-1",
  privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
});

let client: Client;
let containerClient: ContainerClient;
let containerName: string;
let server: Server;
let runtimeClose: () => Promise<void>;
let baseUrl: string;
let documentId: string;

/** テスト専用schemaを見るように`search_path`を接続文字列で指定する。 */
function schemaScopedDatabaseUrl(): string {
  const url = new URL(requireDatabaseUrl());
  url.searchParams.set("options", `-c search_path=${schema}`);
  return url.toString();
}

function issueGrant(
  overrides: { documentId?: string; now?: Date } = {},
): string {
  return signDisplayGrant(
    {
      documentId: overrides.documentId ?? documentId,
      actorSubjectId: ownerSubjectId,
      actorTenantId: tenantId,
      actorEmailAtEvent: "viewer@example.com",
    },
    {
      signingKey,
      ttlSeconds: 60,
      ...(overrides.now ? { now: overrides.now } : {}),
    },
  );
}

async function postDisplay(grant: string, origin = appOrigin): Promise<Response> {
  return fetch(`${baseUrl}/display`, {
    method: "POST",
    headers: {
      Origin: origin,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ [DISPLAY_GRANT_FORM_FIELD]: grant }).toString(),
  });
}

async function auditRows(): Promise<Array<Record<string, unknown>>> {
  const result = await client.query(
    "SELECT * FROM audit_events ORDER BY occurred_at, id",
  );
  return result.rows as Array<Record<string, unknown>>;
}

beforeAll(async () => {
  await migrateFreshSchema(schema);
  client = newClient();
  await client.connect();
  await client.query(`SET search_path TO "${schema}"`);

  const connectionString = requireStorageConnectionString();
  containerName = uniqueTestName("t12-documents");
  containerClient = getDocumentsContainerClient(
    createBlobServiceClient({ kind: "connectionString", connectionString }),
    containerName,
  );
  await containerClient.createIfNotExists();

  const env = parseDisplayEnvironment({
    NODE_ENV: "test",
    APP_ORIGIN: appOrigin,
    DATABASE_URL: schemaScopedDatabaseUrl(),
    AZURE_STORAGE_CONNECTION_STRING: connectionString,
    AZURE_STORAGE_CONTAINER: containerName,
    GRANT_VERIFICATION_KEYS: JSON.stringify([
      {
        keyId: "t12-key-1",
        publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
      },
    ]),
    GRANT_MAX_AGE_SECONDS: "60",
    LOG_HMAC_KEY: Buffer.alloc(32, 5).toString("base64"),
  });

  const runtime = createDisplayRuntime(env);
  runtimeClose = runtime.close;
  server = createDisplayServer(runtime.dependencies);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 60_000);

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
  await runtimeClose();
  await containerClient.deleteIfExists();
  await client.end();
  await dropSchema(schema);
});

beforeEach(async () => {
  await client.query("TRUNCATE audit_events, documents");
  const document = await createDocument(
    {
      ownerSubjectId,
      ownerEmailAtUpload: "viewer@example.com",
      originalFileName: "資料.html",
      title: "結合テスト資料",
      byteSize: Buffer.byteLength(html, "utf8"),
    },
    client,
  );
  documentId = document.id;
  await uploadDocumentHtml(containerClient, documentId, Buffer.from(html, "utf8"));
});

describe("POST /display", () => {
  it("有効なgrantでHTMLを返し、閲覧成功監査を保存する(設計 §10.3)", async () => {
    const response = await postDisplay(issueGrant());

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(html);

    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "view",
      result: "success",
      document_id: documentId,
      actor_subject_id: ownerSubjectId,
      actor_tenant_id: tenantId,
      actor_email_at_event: "viewer@example.com",
      error_category: null,
    });
    // ファイル名・HTML本文は監査へ保存しない(設計 §12.2)。
    expect(JSON.stringify(rows[0])).not.toContain("資料.html");
    expect(JSON.stringify(rows[0])).not.toContain("本文");
  });

  it("有効期限内なら同じgrantを再利用でき、2回とも監査が残る(設計 §18.2)", async () => {
    const grant = issueGrant();

    const first = await postDisplay(grant);
    const second = await postDisplay(grant);

    expect([first.status, second.status]).toEqual([200, 200]);
    expect(await second.text()).toBe(html);

    const rows = await auditRows();
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.result)).toEqual(["success", "success"]);
    // 相関IDは要求ごとに別の値になる。
    expect(rows[0]?.correlation_id).not.toBe(rows[1]?.correlation_id);
  });

  it("期限切れのgrantを拒否し、監査を残さない(設計 §18.2)", async () => {
    const response = await postDisplay(
      issueGrant({ now: new Date(Date.now() - 61_000) }),
    );

    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain("本文");
    expect(await auditRows()).toEqual([]);
  });

  it("削除直後の資料はgrantが有効でも拒否する(設計 §18.2)", async () => {
    const grant = issueGrant();
    const before = await postDisplay(grant);
    expect(before.status).toBe(200);

    await deleteDocumentAsOwner({ documentId, ownerSubjectId }, client);

    const after = await postDisplay(grant);

    expect(after.status).toBe(404);
    expect(await after.text()).not.toContain("本文");
    const rows = await auditRows();
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({
      action: "view",
      result: "denied",
      error_category: "document_not_found",
      document_id: documentId,
    });
  });

  it("HTMLがBlobに無い場合はfailed監査を残してHTMLを返さない", async () => {
    const other = await createDocument({ ownerSubjectId, byteSize: 1 }, client);

    const response = await postDisplay(issueGrant({ documentId: other.id }));

    expect(response.status).toBe(500);
    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "view",
      result: "failed",
      error_category: "storage_failed",
      document_id: other.id,
    });
  });

  it("アプリオリジン以外のOriginを拒否し、監査を残さない(設計 §7.2)", async () => {
    const response = await postDisplay(issueGrant(), "http://evil.example.com");

    expect(response.status).toBe(403);
    expect(await auditRows()).toEqual([]);
  });

  it("設計 §9.2のCSPとsandboxをレスポンスへ付ける", async () => {
    const response = await postDisplay(issueGrant());

    expect(response.headers.get("content-security-policy")).toBe(
      displayContentSecurityPolicy(appOrigin),
    );
    expect(response.headers.get("content-security-policy")).toContain(
      "sandbox allow-popups allow-popups-to-escape-sandbox",
    );
    expect(response.headers.get("x-frame-options")).toBeNull();
  });
});

describe("GET /health", () => {
  it("依存サービスの詳細を出さずに生存だけを返す", async () => {
    const response = await fetch(`${baseUrl}/health`);
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(["status", "timestamp"]);
    expect(body.status).toBe("ok");
  });
});
