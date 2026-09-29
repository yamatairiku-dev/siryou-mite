import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuditEventInput } from "~/lib/db/audit-events.server";
import type {
  CreateDocumentInput,
  DocumentRecord,
} from "~/lib/db/documents.server";
import type { Queryable } from "~/lib/db/pool.server";
import type { UploadSlotDecision } from "~/lib/db/upload-limits.server";
import { createUserSession, type AppUser } from "~/lib/session.server";
import {
  handleDocumentUpload,
  type UploadDependencies,
  type UploadErrorBody,
  type UploadSuccessBody,
} from "~/lib/upload/upload.server";

/**
 * T09 単体テスト: アップロードaction(設計 §10.1, §10.2, §14, §15)。
 *
 * DB・Blob・Queueは差し替え、認証・同一オリジン検証・入力検証・HTML受け入れ検査・
 * 手順の順序・補償処理をそのまま実行して検証する。
 */

const origin = "http://localhost:3000";
const uploadUrl = `${origin}/documents`;
const documentId = "33333333-3333-4333-8333-333333333333";
const attemptId = "44444444-4444-4444-8444-444444444444";

const testUser: AppUser = {
  id: "oid-uploader",
  tenantId: "tenant-001",
  name: "テスト利用者",
  email: "user@example.com",
  roles: ["User"],
  groups: ["ZAA535-A"],
};

let sessionCookie = "";

beforeEach(async () => {
  // 実装の`console.log`(運用ログ)でテスト出力を汚さない。
  vi.spyOn(console, "log").mockImplementation(() => {});
  const response = await createUserSession(testUser);
  sessionCookie = response.headers.get("Set-Cookie") ?? "";
});

afterEach(() => {
  vi.restoreAllMocks();
});

const acceptedHtml = "<!doctype html><html><head><title>資料の題名</title></head><body><p>本文</p></body></html>";

type Harness = {
  deps: Partial<UploadDependencies>;
  calls: string[];
  audits: AuditEventInput[];
  documents: CreateDocumentInput[];
  previewStatusUpdates: { documentId: string; previewStatus: string }[];
};

const allowedDecision: UploadSlotDecision = {
  allowed: true,
  attemptId,
  expiresAt: new Date(Date.now() + 120_000),
  systemWarning: false,
};

function createdRecord(input: CreateDocumentInput): DocumentRecord {
  return {
    id: input.id ?? documentId,
    ownerSubjectId: input.ownerSubjectId,
    ownerEmailAtUpload: input.ownerEmailAtUpload ?? null,
    originalFileName: input.originalFileName ?? null,
    title: input.title ?? null,
    byteSize: input.byteSize ?? null,
    previewStatus: "pending",
    warningCodes: input.warningCodes ?? [],
    status: "active",
    createdAt: new Date(),
    deletedAt: null,
    deletedBySubjectId: null,
    blobCleanupPending: false,
  };
}

function createHarness(overrides: Partial<UploadDependencies> = {}): Harness {
  const calls: string[] = [];
  const audits: AuditEventInput[] = [];
  const documents: CreateDocumentInput[] = [];
  const previewStatusUpdates: { documentId: string; previewStatus: string }[] = [];
  const tx = { query: async () => ({ rows: [] }) } as unknown as Queryable;

  const base: UploadDependencies = {
    reserveUploadSlot: async () => {
      calls.push("reserve");
      return allowedDecision;
    },
    releaseUploadSlot: async () => {
      calls.push("release");
      return true;
    },
    withTransaction: async (run) => {
      calls.push("tx:begin");
      try {
        const result = await run(tx);
        calls.push("tx:commit");
        return result;
      } catch (error) {
        calls.push("tx:rollback");
        throw error;
      }
    },
    createDocument: async (input) => {
      calls.push("createDocument");
      documents.push(input);
      return createdRecord(input);
    },
    insertAuditEvent: async (input) => {
      calls.push(`audit:${input.result}`);
      audits.push(input);
      return { id: "audit-1", occurredAt: new Date(), retainUntil: new Date() };
    },
    updatePreviewStatus: async (params) => {
      calls.push("updatePreviewStatus");
      previewStatusUpdates.push(params);
      return true;
    },
    saveHtml: async () => {
      calls.push("saveHtml");
    },
    deleteHtml: async () => {
      calls.push("deleteHtml");
    },
    sendPreviewMessage: async () => {
      calls.push("sendPreview");
    },
    newDocumentId: () => documentId,
  };

  return {
    deps: { ...base, ...overrides },
    calls,
    audits,
    documents,
    previewStatusUpdates,
  };
}

type RequestOptions = {
  body?: BodyInit | null;
  fileName?: string | null;
  fileNameHeader?: string | null;
  contentType?: string | null;
  originHeader?: string | null;
  cookie?: string | null;
  method?: string;
  extraHeaders?: Record<string, string>;
};

function uploadRequest(options: RequestOptions = {}): Request {
  const headers = new Headers(options.extraHeaders);
  const cookie = options.cookie === undefined ? sessionCookie : options.cookie;
  if (cookie) {
    headers.set("Cookie", cookie);
  }
  const originHeader =
    options.originHeader === undefined ? origin : options.originHeader;
  if (originHeader) {
    headers.set("Origin", originHeader);
  }
  const contentType =
    options.contentType === undefined
      ? "application/octet-stream"
      : options.contentType;
  if (contentType) {
    headers.set("Content-Type", contentType);
  }

  const fileNameHeader =
    options.fileNameHeader !== undefined
      ? options.fileNameHeader
      : Buffer.from(options.fileName ?? "資料.html", "utf8").toString("base64url");
  if (fileNameHeader) {
    headers.set("X-File-Name", fileNameHeader);
  }

  const body = options.body === undefined ? acceptedHtml : options.body;
  return new Request(uploadUrl, {
    method: options.method ?? "POST",
    headers,
    ...(body === null ? {} : { body }),
    // @ts-expect-error Node.jsのfetchはstream bodyへ`duplex`を要求する。
    duplex: "half",
  });
}

async function upload(
  options: RequestOptions = {},
  overrides: Partial<UploadDependencies> = {},
): Promise<{ response: Response; harness: Harness }> {
  const harness = createHarness(overrides);
  const response = await handleDocumentUpload(uploadRequest(options), harness.deps);
  return { response, harness };
}

async function errorBody(response: Response): Promise<UploadErrorBody> {
  return (await response.json()) as UploadErrorBody;
}

describe("正常系(設計 §10.1)", () => {
  it("HTMLを保存し、資料表示画面へ案内する", async () => {
    const { response, harness } = await upload();
    const body = (await response.json()) as UploadSuccessBody;

    expect(response.status).toBe(201);
    expect(body.documentId).toBe(documentId);
    expect(body.documentUrl).toBe(`/documents/${documentId}`);
    expect(body.previewStatus).toBe("pending");
    expect(body.correlationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(response.headers.get("Cache-Control")).toBe("no-store");

    expect(harness.documents[0]).toMatchObject({
      id: documentId,
      ownerSubjectId: testUser.id,
      ownerEmailAtUpload: testUser.email,
      originalFileName: "資料.html",
      title: "資料の題名",
      byteSize: Buffer.byteLength(acceptedHtml, "utf8"),
      previewStatus: "pending",
      warningCodes: [],
    });
  });

  it("手順どおりに 上限判定 → Blob保存 → DB登録(監査と同一transaction) → Queue送信 を実行する", async () => {
    const { harness } = await upload();

    expect(harness.calls).toEqual([
      "reserve",
      "saveHtml",
      "tx:begin",
      "createDocument",
      "audit:success",
      "tx:commit",
      "release",
      "sendPreview",
    ]);
  });

  it("予約枠は資料登録をcommitした後に解放する(QUESTIONS Q-012)", async () => {
    const { harness } = await upload();

    const commitIndex = harness.calls.indexOf("tx:commit");
    const releaseIndex = harness.calls.indexOf("release");

    expect(commitIndex).toBeGreaterThanOrEqual(0);
    expect(releaseIndex).toBeGreaterThan(commitIndex);
    expect(harness.calls.indexOf("createDocument")).toBeLessThan(releaseIndex);
  });

  it("成功監査へ禁止項目(ファイル名・本文・token)を保存しない(設計 §12.2)", async () => {
    const { harness } = await upload();
    const audit = harness.audits[0];

    expect(audit).toMatchObject({
      action: "upload",
      result: "success",
      documentId,
      actorSubjectId: testUser.id,
      actorTenantId: testUser.tenantId,
      actorEmailAtEvent: testUser.email,
      actorGroupValues: testUser.groups,
      actorRoles: testUser.roles,
      errorCategory: null,
    });
    expect(JSON.stringify(audit)).not.toContain("資料.html");
    expect(JSON.stringify(audit)).not.toContain("本文");
  });

  it("無効化される機能を警告として返す(設計 §5.3, §6.2)", async () => {
    const html =
      "<!doctype html><html><body><script>var a=1;</script><form action=\"https://example.com/\"></form></body></html>";
    const { response } = await upload({ body: html });
    const body = (await response.json()) as UploadSuccessBody;

    expect(response.status).toBe(201);
    expect(body.warnings.map((warning) => warning.code)).toEqual(
      expect.arrayContaining(["script", "form_submission"]),
    );
    expect(body.warnings[0]?.message.length).toBeGreaterThan(0);
  });

  it("titleが無い場合はファイル名をtitleとして保存する(設計 §12.1)", async () => {
    const { harness } = await upload({
      body: "<!doctype html><html><body>本文のみ</body></html>",
      fileName: "名前だけ.htm",
    });

    expect(harness.documents[0]).toMatchObject({
      originalFileName: "名前だけ.htm",
      title: "名前だけ.htm",
    });
  });
});

describe("認証・同一オリジン(設計 §10.1(1)(2))", () => {
  it("未認証の要求はログイン画面へ戻す", async () => {
    const harness = createHarness();

    await expect(
      handleDocumentUpload(uploadRequest({ cookie: null }), harness.deps),
    ).rejects.toMatchObject({ status: 302 });
    expect(harness.calls).toEqual([]);
  });

  it("cross-originの要求を拒否し、拒否を監査する", async () => {
    const { response, harness } = await upload({
      originHeader: "https://attacker.example",
    });

    expect(response.status).toBe(403);
    expect((await errorBody(response)).message).toBe("不正なリクエストです。");
    expect(harness.calls).toEqual(["tx:begin", "audit:denied", "tx:commit"]);
    expect(harness.audits[0]).toMatchObject({
      result: "denied",
      errorCategory: "not_authorized",
      documentId: null,
    });
  });

  it("Originヘッダーが無い要求を拒否する", async () => {
    const { response, harness } = await upload({ originHeader: null });

    expect(response.status).toBe(403);
    expect(harness.calls).not.toContain("reserve");
  });
});

describe("監査・運用ログ(設計 §15)", () => {
  it("拒否の監査保存に失敗しても、元の拒否結果を成功へ変えない", async () => {
    const { response, harness } = await upload(
      { originHeader: "https://attacker.example" },
      {
        insertAuditEvent: async () => {
          throw new Error("audit insert failed");
        },
      },
    );

    expect(response.status).toBe(403);
    expect(harness.calls).toContain("tx:rollback");
  });

  it("システム容量が警告閾値に達した場合は運用ログへ残す(設計 §6.1, §17)", async () => {
    const logSpy = vi.mocked(console.log);

    const { response } = await upload(
      {},
      {
        reserveUploadSlot: async () => ({
          allowed: true,
          attemptId,
          expiresAt: new Date(Date.now() + 120_000),
          systemWarning: true,
        }),
      },
    );

    expect(response.status).toBe(201);
    expect(logSpy.mock.calls.flat().join("\n")).toContain(
      "system_html_capacity_warning",
    );
  });
});

describe("入力検証(設計 §10.1(4))", () => {
  it("Content-Typeがapplication/octet-stream以外の要求を拒否する", async () => {
    const { response, harness } = await upload({ contentType: "text/html" });

    expect(response.status).toBe(415);
    expect(harness.audits[0]).toMatchObject({
      result: "denied",
      errorCategory: "validation_failed",
    });
    expect(harness.calls).not.toContain("reserve");
  });

  it("X-File-Nameが無い要求を拒否する", async () => {
    const { response } = await upload({ fileNameHeader: null });

    expect(response.status).toBe(400);
    expect((await errorBody(response)).message).toBe("ファイル名を確認できません。");
  });

  it("X-File-Nameがbase64urlでない要求を拒否する", async () => {
    const { response, harness } = await upload({ fileNameHeader: "not-base64url!!" });

    expect(response.status).toBe(400);
    expect(harness.calls).not.toContain("reserve");
  });

  it("拡張子が.html/.htm以外の場合は拒否する", async () => {
    const { response, harness } = await upload({ fileName: "資料.txt" });
    const body = await errorBody(response);

    expect(response.status).toBe(400);
    expect(body.rejections?.map((item) => item.code)).toContain(
      "invalid_file_extension",
    );
    expect(harness.calls).not.toContain("saveHtml");
    expect(harness.calls).toContain("release");
  });

  it("空ファイルを拒否する", async () => {
    const { response } = await upload({ body: new Uint8Array(0) });
    const body = await errorBody(response);

    expect(response.status).toBe(400);
    expect(body.rejections?.map((item) => item.code)).toContain("empty_file");
  });

  it("UTF-8として読めないファイルを拒否する", async () => {
    const { response, harness } = await upload({
      body: new Uint8Array([0xff, 0xfe, 0x3c, 0x68]),
    });
    const body = await errorBody(response);

    expect(response.status).toBe(400);
    expect(body.rejections?.map((item) => item.code)).toContain("invalid_utf8");
    expect(harness.audits[0]).toMatchObject({ errorCategory: "validation_failed" });
  });

  it("10MBを超えるbodyはstreaming中に中断して拒否する(DBへ触れない)", async () => {
    let pulls = 0;
    const megabyte = new Uint8Array(1024 * 1024).fill(0x61);
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(megabyte);
      },
    });

    const { response, harness } = await upload({ body: stream });

    expect(response.status).toBe(413);
    expect(pulls).toBeLessThanOrEqual(12);
    expect(harness.calls).not.toContain("reserve");
    expect(harness.audits[0]).toMatchObject({ errorCategory: "validation_failed" });
  });

  it("Content-Lengthが上限を超える要求は読み込む前に拒否する", async () => {
    const { response, harness } = await upload({
      extraHeaders: { "Content-Length": String(20 * 1024 * 1024) },
    });

    expect(response.status).toBe(413);
    expect(harness.calls).not.toContain("reserve");
  });
});

describe("HTML受け入れ検査による拒否(設計 §10.1(5), §10.2)", () => {
  it.each([
    [
      "meta refresh",
      "<!doctype html><html><head><meta http-equiv=\"refresh\" content=\"0;url=https://example.com\"></head><body>a</body></html>",
      "meta_refresh",
    ],
    [
      "base href",
      "<!doctype html><html><head><base href=\"https://example.com/\"></head><body>a</body></html>",
      "base_href",
    ],
    [
      "ページ内以外の相対リンク",
      "<!doctype html><html><body><a href=\"other.html\">a</a></body></html>",
      "relative_link",
    ],
    [
      "禁止scheme",
      "<!doctype html><html><body><a href=\"file:///etc/passwd\">a</a></body></html>",
      "forbidden_link_scheme",
    ],
    [
      "外部resource",
      "<!doctype html><html><body><img src=\"https://example.com/a.png\"></body></html>",
      "external_resource",
    ],
  ])("%s を含むHTMLを保存せずに拒否する", async (_name, html, code) => {
    const { response, harness } = await upload({ body: html });
    const body = await errorBody(response);

    expect(response.status).toBe(400);
    expect(body.rejections?.map((item) => item.code)).toContain(code);
    expect(body.correlationId.length).toBeGreaterThan(0);
    expect(harness.calls).not.toContain("saveHtml");
    expect(harness.calls).not.toContain("createDocument");
    expect(harness.calls).toContain("release");
    expect(harness.audits[0]).toMatchObject({
      result: "denied",
      errorCategory: "html_inspection_failed",
      documentId: null,
    });
  });

  it("エラー応答へ内部情報(Blobキー・stack trace)を含めない(設計 §14)", async () => {
    const { response } = await upload({
      body: "<!doctype html><html><body><img src=\"https://example.com/a.png\"></body></html>",
    });
    const text = JSON.stringify(await response.json());

    expect(text).not.toContain("html/");
    expect(text).not.toContain("Error");
    expect(text).not.toContain("documents");
  });
});

describe("上限超過(設計 §6.1, §10.1(3))", () => {
  it.each([
    ["quota_exceeded" as const, "owner_document_count_exceeded" as const, 409, null],
    ["quota_exceeded" as const, "system_total_bytes_exceeded" as const, 409, null],
    ["rate_limited" as const, "rate_limit_exceeded" as const, 429, 30],
    ["rate_limited" as const, "concurrent_upload_in_progress" as const, 429, 60],
    ["rate_limited" as const, "lock_wait_timeout" as const, 429, 5],
  ])(
    "%s(%s)を拒否して監査する",
    async (errorCategory, reason, status, retryAfterSeconds) => {
      const { response, harness } = await upload(
        {},
        {
          reserveUploadSlot: async () => ({
            allowed: false,
            reason,
            retryAfterSeconds,
            errorCategory,
          }),
        },
      );

      expect(response.status).toBe(status);
      expect((await errorBody(response)).message.length).toBeGreaterThan(0);
      if (retryAfterSeconds !== null) {
        expect(response.headers.get("Retry-After")).toBe(String(retryAfterSeconds));
      }
      expect(harness.calls).not.toContain("saveHtml");
      expect(harness.audits[0]).toMatchObject({ result: "denied", errorCategory });
    },
  );

  it("上限判定に渡すbyte数は実際に読み込んだbyte数にする(QUESTIONS Q-012)", async () => {
    const reserved: { ownerSubjectId: string; byteSize: number }[] = [];
    await upload(
      { extraHeaders: { "Content-Length": "1" } },
      {
        reserveUploadSlot: async (input) => {
          reserved.push(input);
          return allowedDecision;
        },
      },
    );

    expect(reserved[0]).toEqual({
      ownerSubjectId: testUser.id,
      byteSize: Buffer.byteLength(acceptedHtml, "utf8"),
    });
  });

  it("上限判定自体が失敗した場合は失敗として扱う", async () => {
    const { response, harness } = await upload(
      {},
      {
        reserveUploadSlot: async () => {
          throw new Error("db down");
        },
      },
    );

    expect(response.status).toBe(500);
    expect(harness.calls).not.toContain("saveHtml");
    expect(harness.audits[0]).toMatchObject({
      result: "failed",
      errorCategory: "database_failed",
    });
  });
});

describe("補償処理(設計 §10.2, §15.1)", () => {
  it("Blob保存に失敗した場合は資料を登録せず、枠を解放する", async () => {
    const { response, harness } = await upload(
      {},
      {
        saveHtml: async () => {
          throw new Error("blob down");
        },
      },
    );

    expect(response.status).toBe(503);
    expect(harness.calls).not.toContain("createDocument");
    expect(harness.calls).toContain("release");
    expect(harness.audits[0]).toMatchObject({
      result: "failed",
      errorCategory: "storage_failed",
      documentId: null,
    });
  });

  it("DB登録に失敗した場合は保存済みのBlobを削除する", async () => {
    const { response, harness } = await upload(
      {},
      {
        createDocument: async () => {
          throw new Error("insert failed");
        },
      },
    );

    expect(response.status).toBe(500);
    expect(harness.calls).toContain("saveHtml");
    expect(harness.calls).toContain("tx:rollback");
    expect(harness.calls).toContain("deleteHtml");
    expect(harness.calls).toContain("release");
    expect(harness.documents).toHaveLength(0);
  });

  it("監査保存に失敗した操作は成功させない(設計 §15.1)", async () => {
    const { response, harness } = await upload(
      {},
      {
        insertAuditEvent: async (input) => {
          if (input.result === "success") {
            throw new Error("audit insert failed");
          }
          return { id: "a", occurredAt: new Date(), retainUntil: new Date() };
        },
      },
    );

    expect(response.status).toBe(500);
    expect(harness.calls).toContain("tx:rollback");
    expect(harness.calls).toContain("deleteHtml");
    expect(harness.calls).not.toContain("sendPreview");
  });

  it("Blob削除にも失敗した場合でも利用者へは短いエラーだけを返す", async () => {
    const { response } = await upload(
      {},
      {
        createDocument: async () => {
          throw new Error("insert failed");
        },
        deleteHtml: async () => {
          throw new Error("delete failed");
        },
      },
    );

    expect(response.status).toBe(500);
    expect((await errorBody(response)).message).toBe(
      "アップロードに失敗しました。時間をおいてやり直してください。",
    );
  });

  it("枠の解放に失敗しても成功応答を覆さない", async () => {
    const { response } = await upload(
      {},
      {
        releaseUploadSlot: async () => {
          throw new Error("release failed");
        },
      },
    );

    expect(response.status).toBe(201);
  });
});

describe("想定外の例外(設計 §10.2, §14, §15.1)", () => {
  it("HTML受け入れ検査が想定外の例外を投げても、枠を解放して相関ID付きで失敗を返す", async () => {
    const inspection = await import("~/lib/html/inspection.server");
    vi.spyOn(inspection, "inspectHtmlUpload").mockImplementation(() => {
      throw new Error("想定外の失敗");
    });

    const { response, harness } = await upload();
    const body = await errorBody(response);

    expect(response.status).toBe(500);
    expect(body.message).toBe(
      "アップロードに失敗しました。時間をおいてやり直してください。",
    );
    expect(body.correlationId.length).toBeGreaterThan(0);
    expect(body.rejections).toBeUndefined();
    expect(harness.calls).toContain("release");
    expect(harness.calls).not.toContain("saveHtml");
    expect(harness.calls).not.toContain("createDocument");
    expect(harness.audits[0]).toMatchObject({
      result: "failed",
      errorCategory: "internal_error",
      documentId: null,
    });
  });

  it("Blob保存が想定外の形で失敗しても枠を解放する", async () => {
    const { response, harness } = await upload(
      {},
      {
        newDocumentId: () => {
          throw new Error("想定外の失敗");
        },
      },
    );

    expect(response.status).toBe(500);
    expect(harness.calls).toContain("release");
    expect(harness.audits[0]).toMatchObject({ errorCategory: "internal_error" });
  });
});

describe("Queue送信の失敗(設計 §10.1(9), §10.2)", () => {
  it("プレビュー状態をfailedにし、資料は閲覧可能のままにする", async () => {
    const { response, harness } = await upload(
      {},
      {
        sendPreviewMessage: async () => {
          throw new Error("queue down");
        },
      },
    );
    const body = (await response.json()) as UploadSuccessBody;

    expect(response.status).toBe(201);
    expect(body.documentId).toBe(documentId);
    expect(body.previewStatus).toBe("failed");
    expect(harness.previewStatusUpdates).toEqual([
      { documentId, previewStatus: "failed" },
    ]);
    expect(harness.audits.map((audit) => audit.result)).toEqual([
      "success",
      "failed",
    ]);
    expect(harness.audits[1]).toMatchObject({
      errorCategory: "queue_failed",
      documentId,
    });
  });

  it("プレビュー状態の更新にも失敗した場合でも資料の登録は維持する", async () => {
    let transactionCount = 0;
    const { response, harness } = await upload(
      {},
      {
        sendPreviewMessage: async () => {
          throw new Error("queue down");
        },
        withTransaction: async (run) => {
          transactionCount += 1;
          if (transactionCount > 1) {
            throw new Error("db down");
          }
          return run({ query: async () => ({ rows: [] }) } as unknown as Queryable);
        },
      },
    );

    expect(response.status).toBe(201);
    expect(harness.documents).toHaveLength(1);
    expect(harness.previewStatusUpdates).toEqual([]);
  });
});
