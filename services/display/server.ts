/**
 * HTML表示サービスのHTTPハンドラー(設計 §7.2, §9.2, §10.3)。
 *
 * Node.js標準の`node:http`だけで実装し、`GET /health`と`POST /display`以外は
 * すべて拒否する。外部I/O(DB・Blob)は`DisplayDependencies`で注入し、この
 * モジュール自体は環境変数もクライアントも持たない(単体テストで実サーバーを
 * 立てて経路とヘッダーを検証できるようにするため)。
 *
 * 安全側(fail closed)の方針:
 *   - `Origin`がアプリオリジンと完全一致しない要求(欠落を含む)は拒否する。
 *   - POST bodyは`maxPostBodyBytes`(既定8KB)を超えた時点でstreamingを打ち切る。
 *   - grantはURL・クエリ文字列・Cookieから受け取らない。Cookieヘッダーは読まない。
 *   - grantの署名・期限を検証したうえで、DBで資料が`active`であることを再確認する。
 *   - 閲覧成功監査を保存できた場合だけHTMLを返す(設計 §10.3(6))。
 *   - grant、POST body、メールアドレス、HTML本文、ファイル名はログへ出さない
 *     (設計 §9.5)。ログに出すのは相関ID・処理名・成否・エラー分類・HMAC化した
 *     利用者識別子・資料IDだけ。
 */
import { randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import {
  DISPLAY_GRANT_FORM_FIELD,
  verifyDisplayGrant,
  type DisplayGrantVerificationKeys,
} from "../shared/grant.js";
import type { OperationLogger } from "../shared/log.js";
import {
  commonSecurityHeaders,
  displayContentSecurityPolicy,
  NON_FRAMABLE_CONTENT_SECURITY_POLICY,
} from "./headers.js";

/** 閲覧監査(設計 §12.2)。Displayが保存するのは`action = view`だけ。 */
export type DisplayViewAudit = {
  result: "success" | "denied" | "failed";
  documentId: string;
  actorSubjectId: string;
  actorTenantId: string;
  actorEmailAtEvent: string | null;
  correlationId: string;
  /** 成功時は`null`。値は監査の`error_category` enumと一致させる。 */
  errorCategory: "document_not_found" | "storage_failed" | null;
};

export type DisplayDependencies = {
  /** `POST /display`で許可する唯一のOrigin(設計 §7.2)。 */
  appOrigin: string;
  /** POST bodyの上限byte数(設計 §7.2は8KB)。 */
  maxPostBodyBytes: number;
  /** 受け付けるgrantの最大有効期間(秒、設計 §7.2は60秒)。 */
  grantMaxAgeSeconds: number;
  verificationKeys: DisplayGrantVerificationKeys;
  /**
   * DBで資料が`active`であることを再確認する(設計 §10.3(5))。
   * 未存在と削除済みを区別せず、どちらも`false`にする(設計 §10.4)。
   */
  isDocumentActive(documentId: string): Promise<boolean>;
  /** 監査を1件保存する。失敗した場合は例外を投げること(HTMLを返さないため)。 */
  saveViewAudit(audit: DisplayViewAudit): Promise<void>;
  /** 資料IDから導出したBlobのHTMLを取得する(timeoutは実装側で設定する)。 */
  fetchDocumentHtml(documentId: string): Promise<Buffer>;
  logger: OperationLogger;
  /** テストのため注入可能にする。 */
  now?: (() => Date) | undefined;
  /** テストのため注入可能にする。 */
  newCorrelationId?: (() => string) | undefined;
};

/** 運用ログの処理名(固定文字列)。 */
const VIEW_LOG_EVENT = "display_view";
const REJECTED_LOG_EVENT = "display_request_rejected";

/**
 * 上限超過後に読み捨てる残りbodyの上限。ここを超えた要求は接続ごと打ち切る。
 * (レスポンスを返す前にクライアントが送信を終えられるよう、少しだけ読み捨てる。)
 */
const MAX_DISCARDED_BODY_BYTES = 1024 * 1024;

/** 表示要求が受け付ける`Content-Type`(設計 §7.2のhidden form)。 */
const EXPECTED_CONTENT_TYPE = "application/x-www-form-urlencoded";

/** 利用者向けメッセージは短い日本語で、内部情報を含めない(設計 §14)。 */
const messages = {
  notFound: "ページが見つかりません。",
  methodNotAllowed: "この方法では利用できません。",
  forbidden: "この要求は受け付けられません。",
  payloadTooLarge: "送信内容が大きすぎます。",
  unsupportedMediaType: "送信形式が正しくありません。",
  grantRejected: "表示の有効期限が切れました。資料の画面を開き直してください。",
  documentNotFound: "資料が見つかりません。",
  internal: "資料を表示できませんでした。",
} as const;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * 利用者向けの短いエラー画面。相関IDだけを表示し、資料ID・grant・内部情報は
 * 出さない(設計 §14)。
 */
function errorPage(message: string, correlationId: string): Buffer {
  return Buffer.from(
    `<!doctype html><html lang="ja"><head><meta charset="utf-8">` +
      `<title>資料を表示できません</title></head><body>` +
      `<p>${escapeHtml(message)}</p>` +
      `<p>相関ID: ${escapeHtml(correlationId)}</p>` +
      `</body></html>`,
    "utf8",
  );
}

type RespondOptions = {
  status: number;
  correlationId: string;
  /** アプリのiframe内へ表示してよいレスポンスかどうか(CSPの`frame-ancestors`)。 */
  contentSecurityPolicy: string;
  contentType: string;
  body: Buffer;
  extraHeaders?: Record<string, string>;
};

/**
 * レスポンスを1回だけ返す。クライアント切断後の書き込みは無視する
 * (切断で業務ログ以外の例外を発生させない)。
 */
function respond(res: ServerResponse, options: RespondOptions): void {
  if (res.writableEnded || res.destroyed) {
    return;
  }

  try {
    res.writeHead(options.status, {
      ...commonSecurityHeaders(),
      "Content-Security-Policy": options.contentSecurityPolicy,
      "Content-Type": options.contentType,
      "Content-Length": String(options.body.byteLength),
      "X-Correlation-Id": options.correlationId,
      ...options.extraHeaders,
    });
    res.end(options.body);
  } catch {
    // 送信中の切断など。内容は既に決まっており、再送も詳細の記録もしない。
  }
}

type BodyReadResult =
  | { status: "ok"; body: Buffer }
  | { status: "too_large" }
  | { status: "error" };

/**
 * POST bodyを上限付きで読む(設計 §7.2)。上限を超えた時点で読み取りを打ち切り、
 * それまでのchunkも破棄する(先に全部読んでから測らない)。
 */
function readLimitedBody(
  req: IncomingMessage,
  maxBytes: number,
): Promise<BodyReadResult> {
  return new Promise((resolve) => {
    let chunks: Buffer[] = [];
    let received = 0;
    let discarded = 0;
    let settled = false;

    const settle = (result: BodyReadResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      chunks = [];
      req.removeListener("data", onData);
      req.removeListener("end", onEnd);
      req.removeListener("close", onClose);
      resolve(result);
    };

    function onData(chunk: Buffer): void {
      received += chunk.byteLength;
      if (received > maxBytes) {
        settle({ status: "too_large" });
        // 上限超過のレスポンスをクライアントが受け取れるよう残りは読み捨てるが、
        // 無制限には付き合わない。
        req.on("data", (rest: Buffer) => {
          discarded += rest.byteLength;
          if (discarded > MAX_DISCARDED_BODY_BYTES) {
            req.destroy();
          }
        });
        return;
      }
      chunks.push(chunk);
    }

    function onEnd(): void {
      settle({ status: "ok", body: Buffer.concat(chunks) });
    }

    /**
     * `close`は正常終了(`end`)の後にも発火するが、その場合は既にsettle済みのため
     * 無視される。body送信の途中で切断された場合にPromiseが未解決のまま残らない
     * よう、ここでも必ずsettleする。
     */
    function onClose(): void {
      settle({ status: "error" });
    }

    // errorリスナーは外さない(読み捨て中の切断でプロセスを落とさないため)。
    req.on("error", () => settle({ status: "error" }));
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("close", onClose);
  });
}

/** `Content-Type`のmedia typeだけを取り出して比較する(charsetなどのパラメーターは無視)。 */
function hasExpectedContentType(header: string | undefined): boolean {
  if (!header) {
    return false;
  }
  const mediaType = header.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return mediaType === EXPECTED_CONTENT_TYPE;
}

/**
 * `Content-Length`が上限を超えていないことの事前検査。値が不正な場合も拒否する
 * (streaming側の上限判定は別途必ず行う)。
 */
function contentLengthWithinLimit(
  header: string | undefined,
  maxBytes: number,
): boolean {
  if (header === undefined) {
    return true;
  }
  const value = Number(header);
  return Number.isSafeInteger(value) && value >= 0 && value <= maxBytes;
}

function healthResponse(res: ServerResponse, correlationId: string): void {
  // 生存確認だけを返し、設定値や依存サービスの状態は公開しない(docs/OPERATIONS.md)。
  respond(res, {
    status: 200,
    correlationId,
    contentSecurityPolicy: NON_FRAMABLE_CONTENT_SECURITY_POLICY,
    contentType: "application/json; charset=utf-8",
    body: Buffer.from(
      JSON.stringify({ status: "ok", timestamp: new Date().toISOString() }),
      "utf8",
    ),
  });
}

/** Origin検証前・許可外経路の拒否。どのページからも埋め込めないCSPを付ける。 */
function rejectRequest(
  res: ServerResponse,
  deps: DisplayDependencies,
  options: {
    status: number;
    message: string;
    correlationId: string;
    errorCategory: string;
    extraHeaders?: Record<string, string>;
  },
): void {
  deps.logger.logOperationEvent({
    event: REJECTED_LOG_EVENT,
    correlationId: options.correlationId,
    result: "denied",
    errorCategory: options.errorCategory,
  });
  respond(res, {
    status: options.status,
    correlationId: options.correlationId,
    contentSecurityPolicy: NON_FRAMABLE_CONTENT_SECURITY_POLICY,
    contentType: "text/html; charset=utf-8",
    body: errorPage(options.message, options.correlationId),
    ...(options.extraHeaders ? { extraHeaders: options.extraHeaders } : {}),
  });
}

/** Origin検証を通った要求の拒否。アプリのiframe内へ短いメッセージを表示する。 */
function respondDisplayError(
  res: ServerResponse,
  deps: DisplayDependencies,
  options: { status: number; message: string; correlationId: string },
): void {
  respond(res, {
    status: options.status,
    correlationId: options.correlationId,
    contentSecurityPolicy: displayContentSecurityPolicy(deps.appOrigin),
    contentType: "text/html; charset=utf-8",
    body: errorPage(options.message, options.correlationId),
  });
}

/**
 * `POST /display`の本体(設計 §10.3(5)〜(7))。
 */
async function handleDisplay(
  req: IncomingMessage,
  res: ServerResponse,
  deps: DisplayDependencies,
  correlationId: string,
  search: string,
): Promise<void> {
  // grantはURL・クエリ文字列では受け取らない(設計 §7.2)。クエリ付きの要求は
  // ingressログへ値が残り得るため、内容を読まずに拒否する。
  if (search !== "") {
    rejectRequest(res, deps, {
      status: 400,
      message: messages.forbidden,
      correlationId,
      errorCategory: "validation_failed",
    });
    return;
  }

  // Origin検証(設計 §7.2)。欠落もfail closedで拒否する。
  const origin = req.headers.origin;
  if (typeof origin !== "string" || origin !== deps.appOrigin) {
    rejectRequest(res, deps, {
      status: 403,
      message: messages.forbidden,
      correlationId,
      errorCategory: "not_authorized",
    });
    return;
  }

  if (!hasExpectedContentType(req.headers["content-type"])) {
    rejectRequest(res, deps, {
      status: 415,
      message: messages.unsupportedMediaType,
      correlationId,
      errorCategory: "validation_failed",
    });
    return;
  }

  if (
    !contentLengthWithinLimit(
      req.headers["content-length"],
      deps.maxPostBodyBytes,
    )
  ) {
    rejectRequest(res, deps, {
      status: 413,
      message: messages.payloadTooLarge,
      correlationId,
      errorCategory: "validation_failed",
    });
    return;
  }

  const bodyResult = await readLimitedBody(req, deps.maxPostBodyBytes);
  if (bodyResult.status !== "ok") {
    // `too_large`は上限超過、`error`は受信中の切断・受信エラー。いずれも内容や
    // 例外メッセージは応答・ログへ出さず、相関IDだけを返す(設計 §9.5, §14)。
    // `error`でも必ず応答して接続を閉じる(既に切断済みの場合は`respond`が無視する)。
    rejectRequest(res, deps, {
      status: bodyResult.status === "too_large" ? 413 : 400,
      message:
        bodyResult.status === "too_large"
          ? messages.payloadTooLarge
          : messages.forbidden,
      correlationId,
      errorCategory: "validation_failed",
    });
    return;
  }

  // 値そのものはログ・エラーメッセージへ出さない(設計 §9.5)。
  const grant = new URLSearchParams(bodyResult.body.toString("utf8")).get(
    DISPLAY_GRANT_FORM_FIELD,
  );

  const verification = verifyDisplayGrant(grant, {
    verificationKeys: deps.verificationKeys,
    maxAgeSeconds: deps.grantMaxAgeSeconds,
    ...(deps.now ? { now: deps.now() } : {}),
  });

  // 判別可能unionのため、必ず`valid`を明示的に確認する。
  if (!verification.valid) {
    // 署名検証が通らないgrantの利用者情報は信用できないため、監査
    // (`actor_subject_id`が必須の追記専用テーブル)へは残さず、運用ログの
    // エラー分類だけを記録する。
    deps.logger.logOperationEvent({
      event: VIEW_LOG_EVENT,
      correlationId,
      result: "denied",
      errorCategory: verification.errorCategory,
    });
    respondDisplayError(res, deps, {
      status: 403,
      message: messages.grantRejected,
      correlationId,
    });
    return;
  }

  const { payload } = verification;
  const auditBase = {
    documentId: payload.documentId,
    actorSubjectId: payload.actorSubjectId,
    actorTenantId: payload.actorTenantId,
    actorEmailAtEvent: payload.actorEmailAtEvent,
    correlationId,
  };
  const logBase = {
    event: VIEW_LOG_EVENT,
    correlationId,
    actorSubjectId: payload.actorSubjectId,
    documentId: payload.documentId,
  } as const;

  // 監査を保存できない場合はHTMLを返さない(設計 §10.3(6), §15.1)。
  const saveAudit = async (
    result: DisplayViewAudit["result"],
    errorCategory: DisplayViewAudit["errorCategory"],
  ): Promise<boolean> => {
    try {
      await deps.saveViewAudit({ ...auditBase, result, errorCategory });
      return true;
    } catch {
      deps.logger.logOperationEvent({
        ...logBase,
        result: "failed",
        errorCategory: "database_failed",
      });
      respondDisplayError(res, deps, {
        status: 500,
        message: messages.internal,
        correlationId,
      });
      return false;
    }
  };

  // DBで`active`を再確認する(grantが有効でも削除済みなら拒否、設計 §10.3(5))。
  let isActive: boolean;
  try {
    isActive = await deps.isDocumentActive(payload.documentId);
  } catch {
    deps.logger.logOperationEvent({
      ...logBase,
      result: "failed",
      errorCategory: "database_failed",
    });
    respondDisplayError(res, deps, {
      status: 500,
      message: messages.internal,
      correlationId,
    });
    return;
  }

  if (!isActive) {
    if (!(await saveAudit("denied", "document_not_found"))) {
      return;
    }
    deps.logger.logOperationEvent({
      ...logBase,
      result: "denied",
      errorCategory: "document_not_found",
    });
    respondDisplayError(res, deps, {
      status: 404,
      message: messages.documentNotFound,
      correlationId,
    });
    return;
  }

  let html: Buffer;
  try {
    html = await deps.fetchDocumentHtml(payload.documentId);
  } catch {
    if (!(await saveAudit("failed", "storage_failed"))) {
      return;
    }
    deps.logger.logOperationEvent({
      ...logBase,
      result: "failed",
      errorCategory: "storage_failed",
    });
    respondDisplayError(res, deps, {
      status: 500,
      message: messages.internal,
      correlationId,
    });
    return;
  }

  // HTMLを返す直前に閲覧成功監査を保存する(設計 §15.1)。
  if (!(await saveAudit("success", null))) {
    return;
  }

  deps.logger.logOperationEvent({ ...logBase, result: "success" });

  // HTMLは書き換えずそのまま返す(設計 §10.1(5))。`Content-Type`は固定値を使い、
  // 利用者由来の値をヘッダーへ使わない。
  respond(res, {
    status: 200,
    correlationId,
    contentSecurityPolicy: displayContentSecurityPolicy(deps.appOrigin),
    contentType: "text/html; charset=utf-8",
    body: html,
  });
}

/**
 * 公開するのは`GET /health`と`POST /display`だけ(設計 §7.2, §13)。
 * それ以外のpathは404、pathが一致してもmethodが違う場合は405で拒否する。
 */
export function createDisplayRequestListener(
  deps: DisplayDependencies,
): (req: IncomingMessage, res: ServerResponse) => void {
  const newCorrelationId = deps.newCorrelationId ?? randomUUID;

  return (req, res) => {
    const correlationId = newCorrelationId();

    // 切断時のsocketエラーでプロセスを落とさない(listenerが無いと例外になる)。
    req.on("error", () => undefined);
    res.on("error", () => undefined);

    // Cookieは読まない(設計 §7.2「アプリのセッションCookieを受け取らない」)。
    // `req.url`は常にorigin-form(`/path?query`)のため、比較用の固定baseで解析する。
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://display.invalid");
    } catch {
      rejectRequest(res, deps, {
        status: 400,
        message: messages.forbidden,
        correlationId,
        errorCategory: "validation_failed",
      });
      return;
    }

    const run = async (): Promise<void> => {
      if (url.pathname === "/health") {
        if (req.method !== "GET") {
          rejectRequest(res, deps, {
            status: 405,
            message: messages.methodNotAllowed,
            correlationId,
            errorCategory: "validation_failed",
            extraHeaders: { Allow: "GET" },
          });
          return;
        }
        healthResponse(res, correlationId);
        return;
      }

      if (url.pathname === "/display") {
        if (req.method !== "POST") {
          rejectRequest(res, deps, {
            status: 405,
            message: messages.methodNotAllowed,
            correlationId,
            errorCategory: "validation_failed",
            extraHeaders: { Allow: "POST" },
          });
          return;
        }
        await handleDisplay(req, res, deps, correlationId, url.search);
        return;
      }

      rejectRequest(res, deps, {
        status: 404,
        message: messages.notFound,
        correlationId,
        errorCategory: "validation_failed",
      });
    };

    void run().catch(() => {
      try {
        // 想定外の例外でもレスポンス内容に内部情報を混ぜない(設計 §14)。
        deps.logger.logOperationEvent({
          event: REJECTED_LOG_EVENT,
          correlationId,
          result: "failed",
          errorCategory: "internal_error",
        });
        respondDisplayError(res, deps, {
          status: 500,
          message: messages.internal,
          correlationId,
        });
      } catch {
        // ここでの失敗は握りつぶす(未処理rejectionでプロセスを落とさない)。
      }
    });
  };
}

/** リクエスト全体のtimeout(ms)。緩いままにせず、短い値を明示する(設計 §14)。 */
export const DISPLAY_REQUEST_TIMEOUT_MS = 15_000;
/** ヘッダー受信のtimeout(ms)。 */
export const DISPLAY_HEADERS_TIMEOUT_MS = 10_000;

export function createDisplayServer(deps: DisplayDependencies): Server {
  const server = createServer(createDisplayRequestListener(deps));
  server.requestTimeout = DISPLAY_REQUEST_TIMEOUT_MS;
  server.headersTimeout = DISPLAY_HEADERS_TIMEOUT_MS;
  return server;
}
