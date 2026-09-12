// @vitest-environment node
import { generateKeyPairSync, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDisplayGrantSigningKey,
  createDisplayGrantVerificationKeys,
  DISPLAY_GRANT_FORM_FIELD,
  signDisplayGrant,
} from "../../../services/shared/grant.js";
import { createOperationLogger } from "../../../services/shared/log.js";
import {
  displayContentSecurityPolicy,
  DISPLAY_SANDBOX_DIRECTIVE,
  NON_FRAMABLE_CONTENT_SECURITY_POLICY,
} from "../../../services/display/headers.js";
import {
  createDisplayRequestListener,
  createDisplayServer,
  type DisplayDependencies,
  type DisplayViewAudit,
} from "../../../services/display/server.js";

/**
 * T12 単体テスト: HTML表示サービス(設計 §7.2, §9.2, §10.3, §18.1)。
 *
 * 実際のHTTPサーバーを立て、公開経路・Origin検証・body上限・grant検証・
 * 監査の順序・CSPヘッダー・ログ非記録を検証する。DBとBlobは注入した偽実装を使い、
 * 実サービスへの接続は結合テスト(`tests/integration/display-service.test.ts`)で行う。
 */

const appOrigin = "http://localhost:3000";
const documentId = "11111111-2222-4333-8444-555555555555";
const actorSubjectId = "oid-viewer-001";
const actorTenantId = "tenant-001";
const html = "<!doctype html><html><body><p>資料本文</p></body></html>";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const signingKey = createDisplayGrantSigningKey({
  keyId: "test-key-1",
  privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
});
const verificationKeys = createDisplayGrantVerificationKeys([
  { keyId: "test-key-1", publicKey },
]);

function issueGrant(
  overrides: {
    documentId?: string;
    now?: Date;
    ttlSeconds?: number;
    subjectId?: string;
  } = {},
): string {
  return signDisplayGrant(
    {
      documentId: overrides.documentId ?? documentId,
      actorSubjectId: overrides.subjectId ?? actorSubjectId,
      actorTenantId,
      actorEmailAtEvent: "viewer@example.com",
    },
    {
      signingKey,
      ttlSeconds: overrides.ttlSeconds ?? 60,
      ...(overrides.now ? { now: overrides.now } : {}),
    },
  );
}

type Harness = {
  baseUrl: string;
  audits: DisplayViewAudit[];
  /** 監査保存・HTML取得・active確認の呼び出し順(監査がHTML取得より後であることの確認用)。 */
  calls: string[];
  logLines: string[];
  setActive(value: boolean): void;
  failAudit(value: boolean): void;
  failBlob(value: boolean): void;
  failDatabase(value: boolean): void;
};

let server: Server | undefined;
let harness: Harness;
/** requestListenerを直接呼ぶテスト(切断時の挙動)で使う。 */
let displayDependencies: DisplayDependencies;
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  const audits: DisplayViewAudit[] = [];
  const calls: string[] = [];
  const logLines: string[] = [];
  let active = true;
  let auditFails = false;
  let blobFails = false;
  let databaseFails = false;

  logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logLines.push(args.map((value) => String(value)).join(" "));
  });

  const dependencies: DisplayDependencies = {
    appOrigin,
    maxPostBodyBytes: 8 * 1024,
    grantMaxAgeSeconds: 60,
    verificationKeys,
    logger: createOperationLogger(Buffer.alloc(32, 3).toString("base64")),
    async isDocumentActive(id) {
      calls.push(`isDocumentActive:${id}`);
      if (databaseFails) {
        throw new Error("db down");
      }
      return active;
    },
    async saveViewAudit(audit) {
      calls.push(`saveViewAudit:${audit.result}`);
      if (auditFails) {
        throw new Error("audit insert failed");
      }
      audits.push(audit);
    },
    async fetchDocumentHtml(id) {
      calls.push(`fetchDocumentHtml:${id}`);
      if (blobFails) {
        throw new Error("blob not found");
      }
      return Buffer.from(html, "utf8");
    },
  };

  displayDependencies = dependencies;

  const created = createDisplayServer(dependencies);
  server = created;
  await new Promise<void>((resolve) => created.listen(0, "127.0.0.1", resolve));
  const address = created.address() as AddressInfo;

  harness = {
    baseUrl: `http://127.0.0.1:${address.port}`,
    audits,
    calls,
    logLines,
    setActive: (value) => {
      active = value;
    },
    failAudit: (value) => {
      auditFails = value;
    },
    failBlob: (value) => {
      blobFails = value;
    },
    failDatabase: (value) => {
      databaseFails = value;
    },
  };
});

afterEach(async () => {
  logSpy.mockRestore();
  const current = server;
  server = undefined;
  if (current) {
    await new Promise<void>((resolve) => {
      current.closeAllConnections();
      current.close(() => resolve());
    });
  }
});

async function postDisplay(
  init: {
    grant?: string | null;
    origin?: string | null;
    contentType?: string | null;
    path?: string;
    extraFields?: Record<string, string>;
    rawBody?: string;
  } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  const origin = init.origin === undefined ? appOrigin : init.origin;
  if (origin !== null) {
    headers.Origin = origin;
  }
  const contentType =
    init.contentType === undefined
      ? "application/x-www-form-urlencoded"
      : init.contentType;
  if (contentType !== null) {
    headers["Content-Type"] = contentType;
  }

  let body = init.rawBody;
  if (body === undefined) {
    const params = new URLSearchParams(init.extraFields ?? {});
    if (init.grant !== null && init.grant !== undefined) {
      params.set(DISPLAY_GRANT_FORM_FIELD, init.grant);
    }
    body = params.toString();
  }

  return fetch(`${harness.baseUrl}${init.path ?? "/display"}`, {
    method: "POST",
    headers,
    body,
  });
}

describe("公開する経路(設計 §7.2, §13)", () => {
  it("GET /health だけがhealth checkに応答する", async () => {
    const response = await fetch(`${harness.baseUrl}/health`);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "ok" });
    expect(response.headers.get("cache-control")).toBe("no-store");
    // どのページからも埋め込めない。
    expect(response.headers.get("content-security-policy")).toBe(
      NON_FRAMABLE_CONTENT_SECURITY_POLICY,
    );
  });

  it("POST /health は405で拒否する", async () => {
    const response = await postDisplay({ path: "/health" });

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET");
  });

  it("GET /display は405で拒否する(grantをURLで受け取らない)", async () => {
    const response = await fetch(
      `${harness.baseUrl}/display?${DISPLAY_GRANT_FORM_FIELD}=${issueGrant()}`,
    );

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
    expect(harness.audits).toEqual([]);
  });

  it("POST /display にクエリ文字列が付いた要求は内容を読まずに拒否する", async () => {
    const response = await postDisplay({
      grant: issueGrant(),
      path: `/display?${DISPLAY_GRANT_FORM_FIELD}=x`,
    });

    expect(response.status).toBe(400);
    expect(harness.calls).toEqual([]);
  });

  it.each(["/", "/documents", "/display/", "/.env"])(
    "%s は404で拒否する",
    async (path) => {
      const response = await fetch(`${harness.baseUrl}${path}`);

      expect(response.status).toBe(404);
    },
  );
});

describe("Origin検証(設計 §7.2)", () => {
  it("アプリオリジン以外のOriginを拒否する", async () => {
    const response = await postDisplay({
      grant: issueGrant(),
      origin: "http://evil.example.com",
    });

    expect(response.status).toBe(403);
    expect(harness.calls).toEqual([]);
    expect(harness.audits).toEqual([]);
  });

  it("Origin欠落をfail closedで拒否する", async () => {
    const response = await postDisplay({ grant: issueGrant(), origin: null });

    expect(response.status).toBe(403);
    expect(harness.calls).toEqual([]);
  });

  it("Origin不正のレスポンスはどのページからも埋め込めない", async () => {
    const response = await postDisplay({
      grant: issueGrant(),
      origin: "http://evil.example.com",
    });

    expect(response.headers.get("content-security-policy")).toBe(
      NON_FRAMABLE_CONTENT_SECURITY_POLICY,
    );
  });
});

describe("POST bodyの上限(設計 §7.2)", () => {
  it("Content-Lengthが8KBを超える要求は読まずに拒否する", async () => {
    const response = await postDisplay({ rawBody: "x".repeat(8 * 1024 + 1) });

    expect(response.status).toBe(413);
    expect(harness.calls).toEqual([]);
  });

  it("Content-Lengthが無くても、streaming中に8KBを超えた時点で打ち切る", async () => {
    const chunk = new TextEncoder().encode("x".repeat(1024));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let index = 0; index < 16; index += 1) {
          controller.enqueue(chunk);
        }
        controller.close();
      },
    });

    const response = await fetch(`${harness.baseUrl}/display`, {
      method: "POST",
      headers: {
        Origin: appOrigin,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: stream,
      // Node.jsのfetchでstreaming bodyを送る(Content-Lengthは付かない)。
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    expect(response.status).toBe(413);
    expect(harness.calls).toEqual([]);
  });

  it("8KB以内のbodyは受け付ける", async () => {
    const response = await postDisplay({
      grant: issueGrant(),
      extraFields: { padding: "y".repeat(4 * 1024) },
    });

    expect(response.status).toBe(200);
  });

  it("hidden form以外のContent-Typeを拒否する", async () => {
    const response = await postDisplay({
      grant: issueGrant(),
      contentType: "application/json",
    });

    expect(response.status).toBe(415);
    expect(harness.calls).toEqual([]);
  });
});

describe("grant検証(設計 §10.3)", () => {
  it("有効なgrantでHTMLを返し、閲覧成功監査を保存する", async () => {
    const response = await postDisplay({ grant: issueGrant() });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await response.text()).toBe(html);
    expect(harness.audits).toEqual([
      {
        result: "success",
        documentId,
        actorSubjectId,
        actorTenantId,
        actorEmailAtEvent: "viewer@example.com",
        correlationId: expect.any(String),
        errorCategory: null,
      },
    ]);
  });

  it("HTMLを取得した後、監査を保存してから返す(設計 §7.2)", async () => {
    await postDisplay({ grant: issueGrant() });

    expect(harness.calls).toEqual([
      `isDocumentActive:${documentId}`,
      `fetchDocumentHtml:${documentId}`,
      "saveViewAudit:success",
    ]);
  });

  it("有効期限内であれば同じgrantを再利用できる(設計 §18.2)", async () => {
    const grant = issueGrant();

    const first = await postDisplay({ grant });
    const second = await postDisplay({ grant });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    // 2回とも閲覧監査が残る。
    expect(harness.audits).toHaveLength(2);
    expect(harness.audits.map((audit) => audit.result)).toEqual([
      "success",
      "success",
    ]);
  });

  it("期限切れのgrantを拒否し、監査を残さない", async () => {
    const expired = issueGrant({
      now: new Date(Date.now() - 61_000),
      ttlSeconds: 60,
    });

    const response = await postDisplay({ grant: expired });

    expect(response.status).toBe(403);
    expect(harness.calls).toEqual([]);
    expect(harness.audits).toEqual([]);
    expect(harness.logLines.join("\n")).toContain("grant_expired");
  });

  it("改ざんしたgrantを拒否する", async () => {
    const grant = issueGrant();
    const [header, payload, signature] = grant.split(".") as [
      string,
      string,
      string,
    ];
    const tamperedPayload = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
        documentId: randomUUID(),
      }),
      "utf8",
    ).toString("base64url");

    const response = await postDisplay({
      grant: `${header}.${tamperedPayload}.${signature}`,
    });

    expect(response.status).toBe(403);
    expect(harness.calls).toEqual([]);
    expect(harness.logLines.join("\n")).toContain("grant_invalid");
  });

  it("別の鍵で署名したgrantを拒否する", async () => {
    const other = generateKeyPairSync("ed25519");
    const grant = signDisplayGrant(
      { documentId, actorSubjectId, actorTenantId, actorEmailAtEvent: null },
      {
        signingKey: createDisplayGrantSigningKey({
          keyId: "test-key-1",
          privateKeyPem: other.privateKey
            .export({ type: "pkcs8", format: "pem" })
            .toString(),
        }),
        ttlSeconds: 60,
      },
    );

    const response = await postDisplay({ grant });

    expect(response.status).toBe(403);
    expect(harness.audits).toEqual([]);
  });

  it("未知のkeyIdのgrantを拒否する", async () => {
    const grant = signDisplayGrant(
      { documentId, actorSubjectId, actorTenantId, actorEmailAtEvent: null },
      {
        signingKey: createDisplayGrantSigningKey({
          keyId: "unknown-key",
          privateKeyPem: privateKey
            .export({ type: "pkcs8", format: "pem" })
            .toString(),
        }),
        ttlSeconds: 60,
      },
    );

    const response = await postDisplay({ grant });

    expect(response.status).toBe(403);
    expect(harness.audits).toEqual([]);
  });

  it("grantが無いPOSTを拒否する", async () => {
    const response = await postDisplay({ grant: null });

    expect(response.status).toBe(403);
    expect(harness.calls).toEqual([]);
  });

  it("対象資料はgrantの署名済みpayloadだけから決め、bodyの他の項目を使わない", async () => {
    const otherDocumentId = randomUUID();

    await postDisplay({
      grant: issueGrant(),
      extraFields: { documentId: otherDocumentId },
    });

    expect(harness.calls).toContain(`fetchDocumentHtml:${documentId}`);
    expect(harness.calls.join(",")).not.toContain(otherDocumentId);
    expect(harness.audits[0]?.documentId).toBe(documentId);
  });
});

describe("資料状態の再確認と失敗時の扱い(設計 §10.3)", () => {
  it("grantが有効でも削除済みの資料は拒否し、denied監査を残す", async () => {
    harness.setActive(false);

    const response = await postDisplay({ grant: issueGrant() });

    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("資料本文");
    expect(harness.calls).not.toContain(`fetchDocumentHtml:${documentId}`);
    expect(harness.audits).toEqual([
      expect.objectContaining({
        result: "denied",
        errorCategory: "document_not_found",
        documentId,
      }),
    ]);
  });

  it("Blob取得に失敗した場合はfailed監査を残してHTMLを返さない", async () => {
    harness.failBlob(true);

    const response = await postDisplay({ grant: issueGrant() });

    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("資料本文");
    expect(harness.audits).toEqual([
      expect.objectContaining({
        result: "failed",
        errorCategory: "storage_failed",
      }),
    ]);
  });

  it("監査保存に失敗した場合はHTMLを返さない(設計 §10.3(6))", async () => {
    harness.failAudit(true);

    const response = await postDisplay({ grant: issueGrant() });

    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).not.toContain("資料本文");
    expect(harness.audits).toEqual([]);
    expect(harness.logLines.join("\n")).toContain("database_failed");
  });

  it("DB障害で状態を確認できない場合もHTMLを返さない", async () => {
    harness.failDatabase(true);

    const response = await postDisplay({ grant: issueGrant() });

    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("資料本文");
    expect(harness.calls).not.toContain(`fetchDocumentHtml:${documentId}`);
  });
});

describe("表示レスポンスのヘッダー(設計 §9.2)", () => {
  it("設計 §9.2のCSPとsandboxを付ける", async () => {
    const response = await postDisplay({ grant: issueGrant() });
    const policy = response.headers.get("content-security-policy") ?? "";

    expect(policy).toBe(
      "default-src 'none'; script-src 'none'; connect-src 'none'; " +
        "frame-src 'none'; object-src 'none'; form-action 'none'; " +
        "base-uri 'none'; style-src 'unsafe-inline'; img-src data: blob:; " +
        "font-src data:; frame-ancestors http://localhost:3000; " +
        "sandbox allow-popups allow-popups-to-escape-sandbox",
    );
    expect(policy).toBe(displayContentSecurityPolicy(appOrigin));
    expect(policy).toContain(DISPLAY_SANDBOX_DIRECTIVE);
  });

  it("アプリ本体用のX-Frame-Options: DENYを流用しない(設計 §9.2)", async () => {
    const response = await postDisplay({ grant: issueGrant() });

    expect(response.headers.get("x-frame-options")).toBeNull();
    expect(response.headers.get("content-security-policy")).toContain(
      `frame-ancestors ${appOrigin}`,
    );
  });

  it("キャッシュ・referrer・MIME sniffingを抑止する", async () => {
    const response = await postDisplay({ grant: issueGrant() });

    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("拒否画面もアプリのiframe内に表示でき、相関IDを示す", async () => {
    harness.setActive(false);

    const response = await postDisplay({ grant: issueGrant() });

    expect(response.headers.get("content-security-policy")).toBe(
      displayContentSecurityPolicy(appOrigin),
    );
    expect(await response.text()).toContain(
      response.headers.get("x-correlation-id") ?? "",
    );
  });
});

describe("ログ(設計 §9.5, §15.2)", () => {
  it("grantとPOST bodyをログへ出さない", async () => {
    const grant = issueGrant();

    await postDisplay({ grant, extraFields: { padding: "secret-padding" } });
    harness.setActive(false);
    await postDisplay({ grant });
    await postDisplay({ grant: `${grant}tampered` });

    const logged = harness.logLines.join("\n");
    expect(logged).not.toContain(grant);
    expect(logged).not.toContain(grant.slice(0, 40));
    expect(logged).not.toContain("secret-padding");
    expect(logged).not.toContain("viewer@example.com");
    expect(logged).not.toContain(actorSubjectId);
  });

  it("記録してよい項目だけを1行1eventのJSONで出力する", async () => {
    await postDisplay({ grant: issueGrant() });

    const line = JSON.parse(harness.logLines[0] ?? "{}") as Record<
      string,
      unknown
    >;
    expect(Object.keys(line).sort()).toEqual([
      "actor",
      "correlationId",
      "documentId",
      "errorCategory",
      "event",
      "result",
      "time",
    ]);
    expect(line.result).toBe("success");
    expect(line.documentId).toBe(documentId);
    // 利用者識別子はHMAC化して記録する。
    expect(line.actor).toMatch(/^[0-9a-f]{32}$/);
  });
});

/**
 * body受信が正常終了しなかった場合の扱い。実際のHTTPクライアントでは切断後の応答を
 * 観測できないため、requestListenerへ直接streamを渡して検証する。
 */
describe("body受信が中断された場合(切断・受信エラー)", () => {
  type CapturedResponse = {
    statusCode: number;
    headers: Record<string, string>;
    body: string;
    writableEnded: boolean;
    destroyed: boolean;
  };

  function fakeRequest(): PassThrough & IncomingMessage {
    const stream = new PassThrough() as PassThrough & IncomingMessage;
    stream.method = "POST";
    stream.url = "/display";
    stream.headers = {
      origin: appOrigin,
      "content-type": "application/x-www-form-urlencoded",
    };
    return stream;
  }

  function fakeResponse(): {
    captured: CapturedResponse;
    response: ServerResponse;
  } {
    const captured: CapturedResponse = {
      statusCode: 0,
      headers: {},
      body: "",
      writableEnded: false,
      destroyed: false,
    };
    const response = {
      get writableEnded() {
        return captured.writableEnded;
      },
      get destroyed() {
        return captured.destroyed;
      },
      on() {
        return response;
      },
      writeHead(status: number, headers: Record<string, string>) {
        captured.statusCode = status;
        captured.headers = headers;
        return response;
      },
      end(body?: Buffer) {
        captured.writableEnded = true;
        captured.body = body ? body.toString("utf8") : "";
      },
    };
    return { captured, response: response as unknown as ServerResponse };
  }

  async function runInterrupted(
    interrupt: (req: PassThrough & IncomingMessage) => void,
  ): Promise<CapturedResponse> {
    const listener = createDisplayRequestListener(displayDependencies);
    const request = fakeRequest();
    const { captured, response } = fakeResponse();

    listener(request, response);
    // 途中まで送ってから中断する(grantは完成していない)。
    request.write(`${DISPLAY_GRANT_FORM_FIELD}=partial`);
    interrupt(request);

    await vi.waitFor(() => expect(captured.writableEnded).toBe(true));
    return captured;
  }

  it("受信エラーのときは400を返して接続を開いたままにしない", async () => {
    const captured = await runInterrupted((request) =>
      request.emit("error", new Error("socket hang up")),
    );

    expect(captured.statusCode).toBe(400);
    // 例外メッセージ・bodyの内容は応答へ出さない(相関IDだけ)。
    expect(captured.body).not.toContain("socket hang up");
    expect(captured.body).not.toContain("partial");
    expect(captured.body).toContain(captured.headers["X-Correlation-Id"] ?? "");
    // 他の拒否応答と同じ共通ヘッダー・CSPが付く。
    expect(captured.headers["Content-Security-Policy"]).toBe(
      NON_FRAMABLE_CONTENT_SECURITY_POLICY,
    );
    expect(captured.headers["Cache-Control"]).toBe("no-store");
    expect(captured.headers["X-Content-Type-Options"]).toBe("nosniff");
    expect(harness.calls).toEqual([]);
    expect(harness.audits).toEqual([]);
  });

  it("body送信の途中で切断された場合もbody読み取りがsettleして応答する", async () => {
    // `end`が来ないまま`close`になる経路(readLimitedBodyのPromiseが未解決で
    // 残らないことの確認)。
    const captured = await runInterrupted((request) => request.destroy());

    expect(captured.statusCode).toBe(400);
    expect(captured.body).not.toContain("partial");
    expect(harness.calls).toEqual([]);
  });

  it("`close`は正常終了後にも発火するが、二重に応答しない", async () => {
    const listener = createDisplayRequestListener(displayDependencies);
    const request = fakeRequest();
    const { captured, response } = fakeResponse();

    listener(request, response);
    request.end(
      new URLSearchParams({
        [DISPLAY_GRANT_FORM_FIELD]: issueGrant(),
      }).toString(),
    );

    await vi.waitFor(() => expect(captured.writableEnded).toBe(true));
    expect(captured.statusCode).toBe(200);
    expect(captured.body).toBe(html);

    // 正常終了後の`close`で結果が上書きされない(settle済みのため無視される)。
    request.emit("close");
    await new Promise((resolve) => setImmediate(resolve));
    expect(captured.statusCode).toBe(200);
    expect(harness.audits).toHaveLength(1);
  });
});
