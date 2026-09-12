/**
 * 表示grantの署名・検証(設計 §7.2, §9.5, §10.3)。
 *
 * `services/` 配下は `app/` を一切importしない方針(docs/ARCHITECTURE.md, T04 Q-005)
 * だが、逆方向(`app/` → `services/shared/`)の依存はこの制約に反しない。grantは
 * Web(署名)とDisplay(検証)の双方が同じ形式を扱う必要があり、実装を二重に持つと
 * 署名対象のbyte列が食い違って事故になるため、実処理はここへ集約する。Web側は
 * `app/lib/grant.server.ts`から本モジュールを使う薄いラッパーにする。
 *
 * 形式(JWSに似せた3セグメント。すべてbase64urlなのでhidden formのPOST値として安全):
 *
 * ```text
 * <header>.<payload>.<signature>
 * ```
 *
 * - 署名対象のbyte列は`"<context>.<header>.<payload>"`のASCII文字列で、`context`は
 *   固定のdomain separation文字列。セグメントはbase64url(`.`を含まない文字集合)の
 *   ため、連結による境界の取り違えは起きない。
 * - `header`は`alg`・`typ`・`kid`だけを含む。`kid`は署名対象に含まれるため、
 *   `keyId`のすげ替えは署名検証で必ず落ちる(設計 §9.5 の鍵rotation)。
 * - `payload`に含めてよいのは資料ID・利用者識別子(`oid`)・tenant ID・操作時点の
 *   メールアドレス・`iat`/`exp`・ランダムnonceだけ。設計 §7.2 が禁じているのは
 *   **Blobキーとファイル名**で、メールアドレスは「grantに含める」と明記された
 *   要件のため含める(Displayが閲覧監査へ`actor_email_at_event`を保存するのに使う)。
 *   HTML本文・Blobキー・ファイル名は含めない。
 * - 有効期限内のgrantの**再利用は許容する**(設計 §18.2「60秒以内の再利用」の解釈。
 *   iframeのリロード・再表示で同じgrantが再POSTされるため単回使用にしない。
 *   司令塔の判断としてQUESTIONS.mdへ記録済み)。`nonce`はgrantの一意性と監査の
 *   相関のために持ち、使用済みnonceの保存は行わない。
 * - 検証はすべてfail closed。未知の`keyId`、署名不一致、形式不正、期限切れ、
 *   対象不一致はいずれも成功扱いにしない。署名検証が通るまでpayloadの値を使わない。
 * - grant文字列・鍵・nonceはログへ出さない(設計 §9.5)。本モジュールは一切ログを
 *   出力せず、失敗理由も秘密情報を含まない固定の分類だけを返す。
 */
import {
  createPrivateKey,
  createPublicKey,
  randomBytes,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from "node:crypto";
import { z } from "zod";

/** 署名アルゴリズム。Ed25519固定(設計 §7.2)。 */
export const DISPLAY_GRANT_ALGORITHM = "Ed25519";

/**
 * grantの種別。署名対象のheaderへ含めることで、同じ鍵が別用途の署名へ流用された
 * 場合の取り違え(cross-protocol attack)を防ぐ。形式を後方非互換に変更する場合は
 * ここのバージョンを上げる。
 */
export const DISPLAY_GRANT_TYPE = "display-grant+v1";

/** 署名対象byte列の先頭へ付けるdomain separation文字列。 */
export const DISPLAY_GRANT_SIGNING_CONTEXT = "siryou-mite/display-grant/v1";

/** hidden formでgrantを送るときのフィールド名(Web・Displayで一致させる)。 */
export const DISPLAY_GRANT_FORM_FIELD = "grant";

/**
 * 各セグメントを復号したあとの最大byte数。巨大なJSONの解析を避けるための上限。
 *
 * payloadのschema上限(`actorSubjectId`・`actorTenantId`各200文字、
 * `actorEmailAtEvent`320文字、`nonce`64文字、UUID、UNIX秒)をすべて使い切った
 * JSONは955byteのため、これを下回らない値にする。上限より小さいと「署名器が
 * 自分で検証できないgrantを発行できる」状態になり、長いメールアドレスの利用者
 * だけ表示が恒久的に失敗する(原因追跡が難しい)ため、schema上限から逆算する。
 */
const MAX_SEGMENT_DECODED_BYTES = 1024;

/**
 * grant文字列の最大長。これを超える入力は解析前に拒否する
 * (Display側のPOST bodyは別途8KB上限)。
 *
 * schema上限を使い切った場合の実測は
 * header 202文字 + payload 1274文字 + 署名86文字 + 区切り2文字 = 1564文字。
 * 余裕を見て2048とする(8KBのbody上限に対しても十分小さい)。
 */
export const MAX_DISPLAY_GRANT_LENGTH = 2048;

/** Ed25519署名のbyte長(RFC 8032)。 */
const ED25519_SIGNATURE_BYTES = 64;

/** nonceの乱数byte数(128bit)。 */
export const DISPLAY_GRANT_NONCE_BYTES = 16;

/**
 * 検証側が許容する時計ずれ(秒)。未来方向の`iat`だけに適用する。
 *
 * Web・Displayは同一Azure環境の別コンテナで、いずれもNTP同期された時計を使うため
 * 通常のずれは1秒未満だが、コンテナ再起動直後などの小さなずれで正常な表示が落ちる
 * のを避けるために数秒だけ許容する。有効期限(`exp`)側には猶予を与えない
 * (期限切れは常にfail closedで拒否し、grantの実効寿命が60秒を超えないようにする)。
 */
export const DEFAULT_GRANT_CLOCK_SKEW_SECONDS = 5;

const keyIdSchema = z.string().trim().min(1).max(100);

/** header。署名対象に含まれるため、ここの値は改ざんできない。 */
const grantHeaderSchema = z
  .object({
    alg: z.literal(DISPLAY_GRANT_ALGORITHM),
    typ: z.literal(DISPLAY_GRANT_TYPE),
    kid: keyIdSchema,
  })
  .strict();

/**
 * payload(設計 §7.2)。`.strict()`により未知フィールドを拒否するため、Blobキー・
 * ファイル名・メールアドレスなどを混ぜたgrantは検証時に必ず落ちる。
 *
 * - `documentId`: 対象資料ID(UUID)。
 * - `actorSubjectId`: 操作利用者のEntra `oid`。閲覧監査の`actor_subject_id`に使う。
 * - `actorTenantId`: 操作時点のtenant ID。閲覧監査の`actor_tenant_id`に使う。
 * - `actorEmailAtEvent`: 操作時点のメールアドレス(設計 §7.2)。閲覧監査の
 *   `actor_email_at_event`に使う。Easy Authの`email`/`preferred_username` claimは
 *   メールアドレス形式とは限らない(UPNなど)ため、形式として解釈できない場合は
 *   `null`にして発行自体は成功させる(T09 Q-016と同じ扱い)。
 * - `issuedAt` / `expiresAt`: UNIX秒。有効期間は60秒(設計 §7.2)。
 * - `nonce`: 128bitのランダム値。再利用検出の土台(利用はT12)。
 */
export const displayGrantPayloadSchema = z
  .object({
    documentId: z.uuid(),
    actorSubjectId: z.string().min(1).max(200),
    actorTenantId: z.string().min(1).max(200),
    actorEmailAtEvent: z.email().max(320).nullable(),
    issuedAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().positive(),
    nonce: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
  })
  .strict();

export type DisplayGrantPayload = z.infer<typeof displayGrantPayloadSchema>;

/** grantが指す対象。署名時の入力。 */
export type DisplayGrantSubject = {
  documentId: string;
  actorSubjectId: string;
  actorTenantId: string;
  /** 操作時点のメールアドレス。形式として解釈できない値・未設定は`null`になる。 */
  actorEmailAtEvent: string | null;
};

const displayGrantSubjectSchema = displayGrantPayloadSchema
  .pick({ documentId: true, actorSubjectId: true, actorTenantId: true })
  .strict();

/**
 * メールアドレスとして解釈できない値(UPNなど)は`null`にする(設計 §12.2、T09 Q-016)。
 * grantの発行がclaimの形式差で失敗しないようにするための正規化で、値そのものは
 * ログ・エラーメッセージへ出さない。
 */
export function normalizeDisplayGrantEmail(
  value: string | null | undefined,
): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const result = z.email().max(320).safeParse(value.trim());
  return result.success ? result.data : null;
}

const ttlSecondsSchema = z.number().int().min(1).max(120);

export type DisplayGrantSigningKey = {
  keyId: string;
  privateKey: KeyObject;
};

/** `keyId` → 公開鍵の索引。未知の`keyId`はここに無いので拒否される。 */
export type DisplayGrantVerificationKeys = ReadonlyMap<string, KeyObject>;

export class InvalidDisplayGrantKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidDisplayGrantKeyError";
  }
}

export class InvalidDisplayGrantInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidDisplayGrantInputError";
  }
}

/**
 * 署名鍵(PEMのEd25519秘密鍵)を`KeyObject`へ変換する。鍵の値はエラーメッセージへ
 * 含めない(設計 §9.5)。
 */
export function createDisplayGrantSigningKey(input: {
  keyId: string;
  privateKeyPem: string;
}): DisplayGrantSigningKey {
  const keyId = keyIdSchema.safeParse(input.keyId);
  if (!keyId.success) {
    throw new InvalidDisplayGrantKeyError("grant署名鍵のkeyIdが不正です");
  }

  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey({ key: input.privateKeyPem, format: "pem" });
  } catch {
    throw new InvalidDisplayGrantKeyError(
      "grant署名鍵をPEMとして読み込めません",
    );
  }

  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new InvalidDisplayGrantKeyError(
      "grant署名鍵はEd25519秘密鍵である必要があります",
    );
  }

  return { keyId: keyId.data, privateKey };
}

/**
 * 検証鍵(`keyId`と公開鍵PEMの配列)を索引へ変換する。`keyId`の重複は鍵rotationの
 * 設定ミスを隠すため、ここでも拒否する(環境変数側でも検証済み)。
 */
export function createDisplayGrantVerificationKeys(
  keys: readonly { keyId: string; publicKey: string | KeyObject }[],
): DisplayGrantVerificationKeys {
  const index = new Map<string, KeyObject>();

  for (const entry of keys) {
    const keyId = keyIdSchema.safeParse(entry.keyId);
    if (!keyId.success) {
      throw new InvalidDisplayGrantKeyError("grant検証鍵のkeyIdが不正です");
    }
    if (index.has(keyId.data)) {
      throw new InvalidDisplayGrantKeyError(
        "grant検証鍵のkeyIdが重複しています",
      );
    }

    let publicKey: KeyObject;
    try {
      publicKey =
        typeof entry.publicKey === "string"
          ? createPublicKey({ key: entry.publicKey, format: "pem" })
          : entry.publicKey;
    } catch {
      throw new InvalidDisplayGrantKeyError(
        "grant検証鍵をPEMとして読み込めません",
      );
    }

    if (publicKey.asymmetricKeyType !== "ed25519") {
      throw new InvalidDisplayGrantKeyError(
        "grant検証鍵はEd25519公開鍵である必要があります",
      );
    }

    index.set(keyId.data, publicKey);
  }

  if (index.size === 0) {
    throw new InvalidDisplayGrantKeyError("grant検証鍵が設定されていません");
  }

  return index;
}

/** 再利用検出(T12)のためのランダムnonce。予測可能な値を使わない。 */
export function generateDisplayGrantNonce(): string {
  return randomBytes(DISPLAY_GRANT_NONCE_BYTES).toString("base64url");
}

function encodeSegment(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

/**
 * base64urlセグメントを復号する。`Buffer.from(_, "base64url")`は不正文字を読み飛ばす
 * 寛容な実装のため、復号結果を再エンコードして入力と一致することを確認し、
 * 非正規形(余分なpadding bit・末尾の余り文字)を拒否する。
 */
function decodeSegment(segment: string): Buffer | undefined {
  const decoded = Buffer.from(segment, "base64url");
  if (decoded.length === 0 || decoded.length > MAX_SEGMENT_DECODED_BYTES) {
    return undefined;
  }
  if (decoded.toString("base64url") !== segment) {
    return undefined;
  }
  return decoded;
}

function parseJsonSegment(segment: string): unknown | undefined {
  const decoded = decodeSegment(segment);
  if (!decoded) {
    return undefined;
  }
  try {
    return JSON.parse(decoded.toString("utf8"));
  } catch {
    return undefined;
  }
}

/**
 * 署名対象のbyte列。固定のcontext文字列とセグメントを`.`で連結する。
 * セグメントはbase64url(`.`を含まない)ため、区切りの解釈は一意に定まる。
 */
function buildSigningInput(
  headerSegment: string,
  payloadSegment: string,
): Buffer {
  return Buffer.from(
    `${DISPLAY_GRANT_SIGNING_CONTEXT}.${headerSegment}.${payloadSegment}`,
    "ascii",
  );
}

export type SignDisplayGrantOptions = {
  signingKey: DisplayGrantSigningKey;
  /** 有効期間(秒)。設計 §7.2 は60秒。 */
  ttlSeconds: number;
  /** 発行時刻。テストのため注入可能にする。 */
  now?: Date | undefined;
  /** nonce。テストのため注入可能にする。通常は自動生成する。 */
  nonce?: string | undefined;
};

/**
 * 表示grantを署名して発行する(設計 §10.3(3))。
 *
 * 入力はZodで検証し、資料ID・`oid`・tenant ID・操作時点のメールアドレス以外の値は
 * 受け取らない(Blobキー・ファイル名を渡す余地を型と実装の双方で持たない)。
 * メールアドレスは形式として解釈できない場合に`null`へ正規化し、発行は成功させる。
 */
/**
 * 発行しようとしているgrantが、検証側(`verifyDisplayGrant`)の長さ上限を満たすかを
 * 確認する。満たさない場合は発行を失敗させる。
 */
function assertVerifiableSize(
  headerSegment: string,
  payloadSegment: string,
  grant: string,
): void {
  const oversizedSegment = [headerSegment, payloadSegment].some(
    (segment) =>
      Buffer.from(segment, "base64url").length > MAX_SEGMENT_DECODED_BYTES,
  );

  if (oversizedSegment || grant.length > MAX_DISPLAY_GRANT_LENGTH) {
    throw new InvalidDisplayGrantInputError("grantが長すぎます");
  }
}

export function signDisplayGrant(
  subject: DisplayGrantSubject,
  options: SignDisplayGrantOptions,
): string {
  // メールアドレスは正規化してから検証するため、ここでは他の項目だけを渡す。
  const parsedSubject = displayGrantSubjectSchema.safeParse({
    documentId: subject.documentId,
    actorSubjectId: subject.actorSubjectId,
    actorTenantId: subject.actorTenantId,
  });
  if (!parsedSubject.success) {
    throw new InvalidDisplayGrantInputError("grantの対象指定が不正です");
  }

  const parsedTtl = ttlSecondsSchema.safeParse(options.ttlSeconds);
  if (!parsedTtl.success) {
    throw new InvalidDisplayGrantInputError("grantの有効期間が不正です");
  }

  const issuedAt = Math.floor((options.now ?? new Date()).getTime() / 1000);
  if (!Number.isFinite(issuedAt) || issuedAt < 0) {
    throw new InvalidDisplayGrantInputError("grantの発行時刻が不正です");
  }

  const payload = displayGrantPayloadSchema.parse({
    ...parsedSubject.data,
    actorEmailAtEvent: normalizeDisplayGrantEmail(subject.actorEmailAtEvent),
    issuedAt,
    expiresAt: issuedAt + parsedTtl.data,
    nonce: options.nonce ?? generateDisplayGrantNonce(),
  } satisfies DisplayGrantPayload);

  const headerSegment = encodeSegment({
    alg: DISPLAY_GRANT_ALGORITHM,
    typ: DISPLAY_GRANT_TYPE,
    kid: options.signingKey.keyId,
  });
  const payloadSegment = encodeSegment(payload);
  const signature = cryptoSign(
    null,
    buildSigningInput(headerSegment, payloadSegment),
    options.signingKey.privateKey,
  );
  const grant = `${headerSegment}.${payloadSegment}.${signature.toString("base64url")}`;

  // 保険: 検証側の上限を超えるgrantは発行しない。UTF-8・JSONエスケープで想定外に
  // 膨らんだ場合でも、表示時に沈黙して壊れるのではなく発行時点で失敗させる。
  assertVerifiableSize(headerSegment, payloadSegment, grant);

  return grant;
}

/**
 * 検証の失敗理由。値そのものをログ・画面へ出しても秘密情報にならない固定の分類。
 * 監査へ記録するときは`displayGrantAuditErrorCategory`で2分類へ寄せる(T04 Q-003)。
 */
export const displayGrantFailureReasons = [
  /** 空、長すぎる、base64urlでない、セグメント数が違う。 */
  "malformed",
  /** `alg`・`typ`・`kid`が想定と異なる。 */
  "unsupported_header",
  /** `keyId`に対応する検証鍵が無い(rotationの取り違え・偽造)。 */
  "unknown_key_id",
  /** 署名がpayload・headerと一致しない(改ざん・別鍵での署名)。 */
  "signature_invalid",
  /** payloadがschemaに合わない(未知フィールド・型違い)。 */
  "payload_invalid",
  /** 有効期限切れ。 */
  "expired",
  /** 発行時刻が許容量を超えて未来。 */
  "issued_in_future",
  /** 有効期間が検証側の上限より長い。 */
  "ttl_too_long",
  /** 想定と違う資料IDのgrant。 */
  "document_mismatch",
  /** 想定と違う利用者のgrant。 */
  "actor_mismatch",
] as const;

export type DisplayGrantFailureReason =
  (typeof displayGrantFailureReasons)[number];

/**
 * 監査の`error_category`(`app/lib/db/audit-events.server.ts`のZod enum)のうち、
 * grant関連の2分類。値はそちらのenumと一致させること(T04 Q-003)。
 * `services/`配下は`app/`をimportできないため、型としては独立に定義する。
 */
export type DisplayGrantAuditErrorCategory = "grant_invalid" | "grant_expired";

/** 失敗理由を監査の分類へ寄せる。期限切れ以外はすべて`grant_invalid`。 */
export function displayGrantAuditErrorCategory(
  reason: DisplayGrantFailureReason,
): DisplayGrantAuditErrorCategory {
  return reason === "expired" ? "grant_expired" : "grant_invalid";
}

/** 呼び出し側が事前に知っている対象。指定した項目だけ一致を確認する。 */
export type DisplayGrantExpectation = {
  documentId?: string | undefined;
  actorSubjectId?: string | undefined;
};

export type VerifyDisplayGrantOptions = {
  verificationKeys: DisplayGrantVerificationKeys;
  /** 検証側が許容する最大有効期間(秒)。設計 §7.2 は60秒。 */
  maxAgeSeconds: number;
  /** 期待する対象。分かっている項目は必ず渡す(渡さない項目は検証しない)。 */
  expected?: DisplayGrantExpectation | undefined;
  now?: Date | undefined;
  /** 未来方向の`iat`だけに適用する時計ずれの許容量(秒)。 */
  clockSkewSeconds?: number | undefined;
};

export type DisplayGrantVerificationResult =
  | { valid: true; keyId: string; payload: DisplayGrantPayload }
  | {
      valid: false;
      reason: DisplayGrantFailureReason;
      errorCategory: DisplayGrantAuditErrorCategory;
    };

function failure(
  reason: DisplayGrantFailureReason,
): DisplayGrantVerificationResult {
  return {
    valid: false,
    reason,
    errorCategory: displayGrantAuditErrorCategory(reason),
  };
}

/** `<base64url>.<base64url>.<base64url>`だけを受け付ける。 */
const grantFormatPattern =
  /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/**
 * 表示grantを検証する(設計 §10.3(5))。
 *
 * 例外を投げず、失敗理由付きの結果を返す。検証順序は
 * 形式 → header → 鍵の解決 → 署名 → payload → 期限 → 対象 で、署名検証が通るまで
 * payloadの値を業務判断へ使わない(`kid`の読み出しだけは鍵rotationのために必要で、
 * 未知の`keyId`はここで拒否される)。
 */
export function verifyDisplayGrant(
  grant: unknown,
  options: VerifyDisplayGrantOptions,
): DisplayGrantVerificationResult {
  if (typeof grant !== "string" || grant.length > MAX_DISPLAY_GRANT_LENGTH) {
    return failure("malformed");
  }
  if (!grantFormatPattern.test(grant)) {
    return failure("malformed");
  }

  const [headerSegment, payloadSegment, signatureSegment] = grant.split(".") as [
    string,
    string,
    string,
  ];

  const headerJson = parseJsonSegment(headerSegment);
  if (headerJson === undefined) {
    return failure("malformed");
  }
  const header = grantHeaderSchema.safeParse(headerJson);
  if (!header.success) {
    return failure("unsupported_header");
  }

  const publicKey = options.verificationKeys.get(header.data.kid);
  if (!publicKey) {
    return failure("unknown_key_id");
  }

  const signature = decodeSegment(signatureSegment);
  if (!signature || signature.length !== ED25519_SIGNATURE_BYTES) {
    return failure("signature_invalid");
  }

  let signatureValid = false;
  try {
    signatureValid = cryptoVerify(
      null,
      buildSigningInput(headerSegment, payloadSegment),
      publicKey,
      signature,
    );
  } catch {
    signatureValid = false;
  }
  if (!signatureValid) {
    return failure("signature_invalid");
  }

  const payloadJson = parseJsonSegment(payloadSegment);
  if (payloadJson === undefined) {
    return failure("payload_invalid");
  }
  const payload = displayGrantPayloadSchema.safeParse(payloadJson);
  if (!payload.success) {
    return failure("payload_invalid");
  }

  const maxAge = ttlSecondsSchema.safeParse(options.maxAgeSeconds);
  if (!maxAge.success) {
    throw new InvalidDisplayGrantInputError("grantの有効期間上限が不正です");
  }

  const clockSkewSeconds =
    options.clockSkewSeconds ?? DEFAULT_GRANT_CLOCK_SKEW_SECONDS;
  if (!Number.isInteger(clockSkewSeconds) || clockSkewSeconds < 0) {
    throw new InvalidDisplayGrantInputError("時計ずれの許容量が不正です");
  }

  const nowSeconds = Math.floor((options.now ?? new Date()).getTime() / 1000);
  const { issuedAt, expiresAt } = payload.data;

  if (expiresAt <= issuedAt) {
    return failure("payload_invalid");
  }
  // 発行側が設計より長い有効期間を付けたgrantは、署名が正しくても受け付けない。
  if (expiresAt - issuedAt > maxAge.data) {
    return failure("ttl_too_long");
  }
  if (issuedAt - nowSeconds > clockSkewSeconds) {
    return failure("issued_in_future");
  }
  // 期限側には猶予を与えない(`exp`ちょうどは期限切れ扱い)。
  if (nowSeconds >= expiresAt) {
    return failure("expired");
  }
  // 検証側の時計が進んでいる場合でも、実効寿命が上限＋時計ずれを超えないようにする。
  if (nowSeconds - issuedAt > maxAge.data + clockSkewSeconds) {
    return failure("expired");
  }

  const expected = options.expected;
  if (expected?.documentId && expected.documentId !== payload.data.documentId) {
    return failure("document_mismatch");
  }
  if (
    expected?.actorSubjectId &&
    expected.actorSubjectId !== payload.data.actorSubjectId
  ) {
    return failure("actor_mismatch");
  }

  return { valid: true, keyId: header.data.kid, payload: payload.data };
}
