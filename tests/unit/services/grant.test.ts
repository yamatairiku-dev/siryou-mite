import { generateKeyPairSync, randomUUID, sign as cryptoSign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createDisplayGrantSigningKey,
  createDisplayGrantVerificationKeys,
  DEFAULT_GRANT_CLOCK_SKEW_SECONDS,
  displayGrantAuditErrorCategory,
  DISPLAY_GRANT_ALGORITHM,
  DISPLAY_GRANT_SIGNING_CONTEXT,
  DISPLAY_GRANT_TYPE,
  generateDisplayGrantNonce,
  InvalidDisplayGrantInputError,
  InvalidDisplayGrantKeyError,
  MAX_DISPLAY_GRANT_LENGTH,
  signDisplayGrant,
  verifyDisplayGrant,
  type DisplayGrantSubject,
} from "../../../services/shared/grant";

/**
 * 表示grantの署名・検証(設計 §7.2, §9.5, §10.3)。
 * 正常系のほか、期限切れ・改ざん・対象不一致・未知keyId・形式不正・鍵rotationを
 * 検証する(T11完了条件)。鍵はテストごとに生成した使い捨ての値で、実運用の
 * secretではない。
 */

function createKeyPair(keyId: string) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    signingKey: createDisplayGrantSigningKey({
      keyId,
      privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    }),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    keyId,
  };
}

const currentKey = createKeyPair("key-current");
const previousKey = createKeyPair("key-previous");
const foreignKey = createKeyPair("key-foreign");

const verificationKeys = createDisplayGrantVerificationKeys([
  { keyId: currentKey.keyId, publicKey: currentKey.publicKeyPem },
]);

const subject: DisplayGrantSubject = {
  documentId: randomUUID(),
  actorSubjectId: "00000000-1111-2222-3333-444444444444",
  actorTenantId: "99999999-8888-7777-6666-555555555555",
  actorEmailAtEvent: "user@example.com",
};

const issuedAt = new Date("2026-09-13T00:00:00.000Z");

function sign(overrides?: Partial<DisplayGrantSubject>, now: Date = issuedAt) {
  return signDisplayGrant({ ...subject, ...overrides }, {
    signingKey: currentKey.signingKey,
    ttlSeconds: 60,
    now,
  });
}

function decodeSegment(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as Record<
    string,
    unknown
  >;
}

function encodeSegment(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

/** headerとpayloadから、任意の鍵で署名し直したgrantを組み立てる。 */
function assembleGrant(
  header: unknown,
  payload: unknown,
  signingPrivateKey = currentKey.signingKey.privateKey,
): string {
  const headerSegment = encodeSegment(header);
  const payloadSegment = encodeSegment(payload);
  const signature = cryptoSign(
    null,
    Buffer.from(
      `${DISPLAY_GRANT_SIGNING_CONTEXT}.${headerSegment}.${payloadSegment}`,
      "ascii",
    ),
    signingPrivateKey,
  );
  return `${headerSegment}.${payloadSegment}.${signature.toString("base64url")}`;
}

function verify(grant: unknown, now: Date = issuedAt, options = {}) {
  return verifyDisplayGrant(grant, {
    verificationKeys,
    maxAgeSeconds: 60,
    now,
    ...options,
  });
}

describe("signDisplayGrant", () => {
  it("base64urlの3セグメントで、header・payloadが設計どおりの項目だけを持つ", () => {
    const grant = sign();

    expect(grant).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(grant.length).toBeLessThanOrEqual(MAX_DISPLAY_GRANT_LENGTH);

    const [headerSegment, payloadSegment] = grant.split(".") as [string, string];
    expect(decodeSegment(headerSegment)).toEqual({
      alg: DISPLAY_GRANT_ALGORITHM,
      typ: DISPLAY_GRANT_TYPE,
      kid: currentKey.keyId,
    });

    const payload = decodeSegment(payloadSegment);
    expect(Object.keys(payload).sort()).toEqual([
      "actorEmailAtEvent",
      "actorSubjectId",
      "actorTenantId",
      "documentId",
      "expiresAt",
      "issuedAt",
      "nonce",
    ]);
    expect(payload.actorEmailAtEvent).toBe(subject.actorEmailAtEvent);
    expect(payload.issuedAt).toBe(Math.floor(issuedAt.getTime() / 1000));
    expect(payload.expiresAt).toBe(Math.floor(issuedAt.getTime() / 1000) + 60);
  });

  it("Blobキー・ファイル名をgrantへ含めない(設計 §7.2)", () => {
    const grant = sign();
    const payload = decodeSegment(grant.split(".")[1] as string);

    expect(JSON.stringify(payload)).not.toMatch(/html\/|preview\/|\.html/);
    expect(payload).not.toHaveProperty("fileName");
    expect(payload).not.toHaveProperty("blobKey");
  });

  it("メールアドレス形式でない値(UPNなど)はnullにして発行を成功させる(Q-016)", () => {
    for (const value of ["user@corp", "DOMAIN\\user", "", "  "]) {
      const payload = decodeSegment(
        sign({ actorEmailAtEvent: value }).split(".")[1] as string,
      );
      expect(payload.actorEmailAtEvent).toBeNull();
    }

    const payload = decodeSegment(
      sign({ actorEmailAtEvent: null }).split(".")[1] as string,
    );
    expect(payload.actorEmailAtEvent).toBeNull();
  });

  it("発行のたびに異なるnonceを付ける", () => {
    const first = decodeSegment(sign().split(".")[1] as string);
    const second = decodeSegment(sign().split(".")[1] as string);

    expect(first.nonce).not.toBe(second.nonce);
    expect(String(first.nonce)).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it("schema上限を使い切ったpayloadでも署名・検証を往復できる", () => {
    const longSubject: DisplayGrantSubject = {
      documentId: randomUUID(),
      actorSubjectId: "s".repeat(200),
      actorTenantId: "t".repeat(200),
      // 320文字ちょうどのメールアドレス(schemaの上限)。
      actorEmailAtEvent: `${"a".repeat(308)}@example.com`,
    };
    const grant = signDisplayGrant(longSubject, {
      signingKey: currentKey.signingKey,
      ttlSeconds: 60,
      now: issuedAt,
    });

    expect(grant.length).toBeLessThanOrEqual(MAX_DISPLAY_GRANT_LENGTH);

    const result = verifyDisplayGrant(grant, {
      verificationKeys,
      maxAgeSeconds: 60,
      now: issuedAt,
      expected: {
        documentId: longSubject.documentId,
        actorSubjectId: longSubject.actorSubjectId,
      },
    });

    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.payload.actorEmailAtEvent).toBe(longSubject.actorEmailAtEvent);
  });

  it("JSONエスケープで検証側の上限を超える場合は発行時点で失敗させる", () => {
    // 制御文字は`\u0001`形式へエスケープされ1文字が6byteになるため、schema上限
    // (200文字)でも復号後のpayloadが上限を超える。表示時に沈黙して壊れるのを防ぐ。
    expect(() => sign({ actorSubjectId: "\u0001".repeat(200) })).toThrow(
      InvalidDisplayGrantInputError,
    );
  });

  it("資料ID・有効期間が不正な場合は署名しない", () => {
    expect(() => sign({ documentId: "../../etc/passwd" })).toThrow(
      InvalidDisplayGrantInputError,
    );
    expect(() => sign({ actorSubjectId: "" })).toThrow(
      InvalidDisplayGrantInputError,
    );
    expect(() =>
      signDisplayGrant(subject, {
        signingKey: currentKey.signingKey,
        ttlSeconds: 0,
      }),
    ).toThrow(InvalidDisplayGrantInputError);
    expect(() =>
      signDisplayGrant(subject, {
        signingKey: currentKey.signingKey,
        ttlSeconds: 3600,
      }),
    ).toThrow(InvalidDisplayGrantInputError);
  });
});

describe("verifyDisplayGrant(正常系)", () => {
  it("署名したgrantを検証でき、payloadと使用keyIdを返す", () => {
    const result = verify(sign());

    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.keyId).toBe(currentKey.keyId);
    expect(result.payload.documentId).toBe(subject.documentId);
    expect(result.payload.actorSubjectId).toBe(subject.actorSubjectId);
    expect(result.payload.actorTenantId).toBe(subject.actorTenantId);
    expect(result.payload.actorEmailAtEvent).toBe(subject.actorEmailAtEvent);
    expect(result.payload.nonce).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("期待する資料ID・利用者を渡しても一致すれば通る", () => {
    const result = verify(sign(), issuedAt, {
      expected: {
        documentId: subject.documentId,
        actorSubjectId: subject.actorSubjectId,
      },
    });

    expect(result.valid).toBe(true);
  });

  it("メールアドレスがnullのgrantも署名・検証できる", () => {
    const result = verify(sign({ actorEmailAtEvent: null }));

    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.payload.actorEmailAtEvent).toBeNull();
  });

  it("有効期限内であれば同じgrantを何度でも検証できる(設計 §18.2 の再利用)", () => {
    const grant = sign();

    expect(verify(grant).valid).toBe(true);
    expect(verify(grant, new Date(issuedAt.getTime() + 30_000)).valid).toBe(true);
    expect(verify(grant, new Date(issuedAt.getTime() + 59_000)).valid).toBe(true);
  });

  it("有効期限の直前(59秒後)まで有効で、期限ちょうどは無効", () => {
    const grant = sign();

    expect(verify(grant, new Date(issuedAt.getTime() + 59_000)).valid).toBe(true);
    expect(verify(grant, new Date(issuedAt.getTime() + 60_000)).valid).toBe(false);
  });

  it("既定の時計ずれ許容量までは、検証側の時計が遅れていても通る", () => {
    const grant = sign();
    const skewMs = DEFAULT_GRANT_CLOCK_SKEW_SECONDS * 1000;

    expect(verify(grant, new Date(issuedAt.getTime() - skewMs)).valid).toBe(true);
  });
});

describe("verifyDisplayGrant(期限)", () => {
  it("期限切れは expired(監査は grant_expired)", () => {
    const result = verify(sign(), new Date(issuedAt.getTime() + 61_000));

    expect(result).toMatchObject({
      valid: false,
      reason: "expired",
      errorCategory: "grant_expired",
    });
  });

  it("許容量を超えて未来のiatは issued_in_future として拒否する", () => {
    const grant = sign();
    const skewMs = (DEFAULT_GRANT_CLOCK_SKEW_SECONDS + 1) * 1000;

    expect(verify(grant, new Date(issuedAt.getTime() - skewMs))).toMatchObject({
      valid: false,
      reason: "issued_in_future",
      errorCategory: "grant_invalid",
    });
  });

  it("検証側の上限より長い有効期間のgrantは ttl_too_long として拒否する", () => {
    const grant = signDisplayGrant(subject, {
      signingKey: currentKey.signingKey,
      ttlSeconds: 120,
      now: issuedAt,
    });

    expect(
      verifyDisplayGrant(grant, {
        verificationKeys,
        maxAgeSeconds: 60,
        now: issuedAt,
      }),
    ).toMatchObject({ valid: false, reason: "ttl_too_long" });
  });

  it("expiresAtがissuedAt以下のgrantは payload_invalid として拒否する", () => {
    const seconds = Math.floor(issuedAt.getTime() / 1000);
    const grant = assembleGrant(
      { alg: DISPLAY_GRANT_ALGORITHM, typ: DISPLAY_GRANT_TYPE, kid: currentKey.keyId },
      {
        ...subject,
        issuedAt: seconds,
        expiresAt: seconds,
        nonce: generateDisplayGrantNonce(),
      },
    );

    expect(verify(grant)).toMatchObject({ valid: false, reason: "payload_invalid" });
  });
});

describe("verifyDisplayGrant(改ざん)", () => {
  it("payloadを書き換えたgrantを拒否する", () => {
    const grant = sign();
    const [headerSegment, payloadSegment, signatureSegment] = grant.split(".") as [
      string,
      string,
      string,
    ];
    const payload = decodeSegment(payloadSegment);
    const tampered = `${headerSegment}.${encodeSegment({
      ...payload,
      documentId: randomUUID(),
    })}.${signatureSegment}`;

    expect(verify(tampered)).toMatchObject({
      valid: false,
      reason: "signature_invalid",
      errorCategory: "grant_invalid",
    });
  });

  it("署名を書き換えたgrantを拒否する", () => {
    const grant = sign();
    const [headerSegment, payloadSegment, signatureSegment] = grant.split(".") as [
      string,
      string,
      string,
    ];
    const signature = Buffer.from(signatureSegment, "base64url");
    signature[0] = signature[0]! ^ 0xff;

    expect(
      verify(`${headerSegment}.${payloadSegment}.${signature.toString("base64url")}`),
    ).toMatchObject({ valid: false, reason: "signature_invalid" });
  });

  it("keyIdだけをすげ替えたgrantを拒否する(kidも署名対象)", () => {
    const rotationKeys = createDisplayGrantVerificationKeys([
      { keyId: currentKey.keyId, publicKey: currentKey.publicKeyPem },
      { keyId: previousKey.keyId, publicKey: previousKey.publicKeyPem },
    ]);
    const grant = sign();
    const [headerSegment, payloadSegment, signatureSegment] = grant.split(".") as [
      string,
      string,
      string,
    ];
    const header = decodeSegment(headerSegment);
    const swapped = `${encodeSegment({
      ...header,
      kid: previousKey.keyId,
    })}.${payloadSegment}.${signatureSegment}`;

    expect(
      verifyDisplayGrant(swapped, {
        verificationKeys: rotationKeys,
        maxAgeSeconds: 60,
        now: issuedAt,
      }),
    ).toMatchObject({ valid: false, reason: "signature_invalid" });
  });

  it("domain separation contextを外して署名したgrantを拒否する", () => {
    const grant = sign();
    const [headerSegment, payloadSegment] = grant.split(".") as [string, string];
    // `"<context>.<header>.<payload>"`ではなく`"<header>.<payload>"`へ署名した場合。
    const signature = cryptoSign(
      null,
      Buffer.from(`${headerSegment}.${payloadSegment}`, "ascii"),
      currentKey.signingKey.privateKey,
    );

    expect(
      verify(`${headerSegment}.${payloadSegment}.${signature.toString("base64url")}`),
    ).toMatchObject({ valid: false, reason: "signature_invalid" });
  });

  it("登録済みkeyIdを名乗る別鍵の署名を拒否する", () => {
    const forged = assembleGrant(
      { alg: DISPLAY_GRANT_ALGORITHM, typ: DISPLAY_GRANT_TYPE, kid: currentKey.keyId },
      {
        ...subject,
        issuedAt: Math.floor(issuedAt.getTime() / 1000),
        expiresAt: Math.floor(issuedAt.getTime() / 1000) + 60,
        nonce: generateDisplayGrantNonce(),
      },
      foreignKey.signingKey.privateKey,
    );

    expect(verify(forged)).toMatchObject({
      valid: false,
      reason: "signature_invalid",
    });
  });

  it("未知フィールドを足したpayloadを拒否する(署名し直しても通らない)", () => {
    const grant = assembleGrant(
      { alg: DISPLAY_GRANT_ALGORITHM, typ: DISPLAY_GRANT_TYPE, kid: currentKey.keyId },
      {
        ...subject,
        issuedAt: Math.floor(issuedAt.getTime() / 1000),
        expiresAt: Math.floor(issuedAt.getTime() / 1000) + 60,
        nonce: generateDisplayGrantNonce(),
        blobKey: "html/x/document.html",
      },
    );

    expect(verify(grant)).toMatchObject({ valid: false, reason: "payload_invalid" });
  });

  it("メールアドレス形式でないactorEmailAtEventのpayloadを拒否する", () => {
    const grant = assembleGrant(
      { alg: DISPLAY_GRANT_ALGORITHM, typ: DISPLAY_GRANT_TYPE, kid: currentKey.keyId },
      {
        ...subject,
        actorEmailAtEvent: "not-an-email",
        issuedAt: Math.floor(issuedAt.getTime() / 1000),
        expiresAt: Math.floor(issuedAt.getTime() / 1000) + 60,
        nonce: generateDisplayGrantNonce(),
      },
    );

    expect(verify(grant)).toMatchObject({ valid: false, reason: "payload_invalid" });
  });

  it("alg・typが異なるheaderを拒否する", () => {
    const payload = {
      ...subject,
      issuedAt: Math.floor(issuedAt.getTime() / 1000),
      expiresAt: Math.floor(issuedAt.getTime() / 1000) + 60,
      nonce: generateDisplayGrantNonce(),
    };

    expect(
      verify(assembleGrant({ alg: "none", typ: DISPLAY_GRANT_TYPE, kid: currentKey.keyId }, payload)),
    ).toMatchObject({ valid: false, reason: "unsupported_header" });
    expect(
      verify(
        assembleGrant(
          { alg: DISPLAY_GRANT_ALGORITHM, typ: "other+v1", kid: currentKey.keyId },
          payload,
        ),
      ),
    ).toMatchObject({ valid: false, reason: "unsupported_header" });
  });
});

describe("verifyDisplayGrant(対象不一致)", () => {
  it("想定と違う資料IDのgrantを拒否する", () => {
    expect(
      verify(sign(), issuedAt, { expected: { documentId: randomUUID() } }),
    ).toMatchObject({
      valid: false,
      reason: "document_mismatch",
      errorCategory: "grant_invalid",
    });
  });

  it("想定と違う利用者のgrantを拒否する", () => {
    expect(
      verify(sign(), issuedAt, {
        expected: {
          documentId: subject.documentId,
          actorSubjectId: "other-user-oid",
        },
      }),
    ).toMatchObject({
      valid: false,
      reason: "actor_mismatch",
      errorCategory: "grant_invalid",
    });
  });
});

describe("verifyDisplayGrant(keyIdと鍵rotation)", () => {
  it("未知のkeyIdはfail closedで拒否する", () => {
    const grant = signDisplayGrant(subject, {
      signingKey: previousKey.signingKey,
      ttlSeconds: 60,
      now: issuedAt,
    });

    expect(verify(grant)).toMatchObject({
      valid: false,
      reason: "unknown_key_id",
      errorCategory: "grant_invalid",
    });
  });

  it("新旧2鍵を登録している間は、どちらの鍵で署名したgrantも検証できる", () => {
    const rotationKeys = createDisplayGrantVerificationKeys([
      { keyId: currentKey.keyId, publicKey: currentKey.publicKeyPem },
      { keyId: previousKey.keyId, publicKey: previousKey.publicKeyPem },
    ]);

    for (const key of [currentKey, previousKey]) {
      const result = verifyDisplayGrant(
        signDisplayGrant(subject, {
          signingKey: key.signingKey,
          ttlSeconds: 60,
          now: issuedAt,
        }),
        { verificationKeys: rotationKeys, maxAgeSeconds: 60, now: issuedAt },
      );

      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.keyId).toBe(key.keyId);
      }
    }
  });
});

describe("verifyDisplayGrant(形式不正)", () => {
  const grant = sign();
  const segments = grant.split(".") as [string, string, string];

  it.each([
    ["空文字", ""],
    ["セグメント不足", `${segments[0]}.${segments[1]}`],
    ["セグメント過多", `${grant}.${segments[2]}`],
    ["base64urlでない文字", `${segments[0]}.${segments[1]}.abc+/=`],
    ["区切りが空", `${segments[0]}..${segments[2]}`],
    ["標準base64のpadding付き", `${segments[0]}.${segments[1]}.${Buffer.from("x").toString("base64")}=`],
    ["JSONでないheader", `${Buffer.from("not-json", "utf8").toString("base64url")}.${segments[1]}.${segments[2]}`],
    ["巨大入力", "A".repeat(MAX_DISPLAY_GRANT_LENGTH + 1)],
    ["巨大だが形式は正しい入力", `${"A".repeat(MAX_DISPLAY_GRANT_LENGTH)}.${segments[1]}.${segments[2]}`],
  ])("%s を malformed として拒否する", (_label, value) => {
    expect(verify(value)).toMatchObject({
      valid: false,
      reason: "malformed",
      errorCategory: "grant_invalid",
    });
  });

  it("文字列以外の入力を拒否する", () => {
    for (const value of [undefined, null, 42, {}, ["a", "b", "c"]]) {
      expect(verify(value)).toMatchObject({ valid: false, reason: "malformed" });
    }
  });

  it("署名部の長さがEd25519署名と違う場合は拒否する", () => {
    const shortSignature = Buffer.alloc(32, 1).toString("base64url");

    expect(verify(`${segments[0]}.${segments[1]}.${shortSignature}`)).toMatchObject({
      valid: false,
      reason: "signature_invalid",
    });
  });

  it("同じbyte列になる非正規なbase64url表現を拒否する", () => {
    // Ed25519署名(64byte)のbase64url表現は末尾4bitが余るため、最後の1文字を
    // 値+1の文字へ変えても復号結果は同じになる。canonicalでない表現は拒否する。
    const alphabet =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const signatureSegment = segments[2];
    const lastCharacter = signatureSegment.slice(-1);
    const nonCanonical =
      signatureSegment.slice(0, -1) +
      alphabet[alphabet.indexOf(lastCharacter) + 1];

    expect(
      Buffer.from(nonCanonical, "base64url").equals(
        Buffer.from(signatureSegment, "base64url"),
      ),
    ).toBe(true);
    expect(verify(`${segments[0]}.${segments[1]}.${nonCanonical}`)).toMatchObject({
      valid: false,
      reason: "signature_invalid",
    });
  });

  it("検証側の設定値が不正な場合は例外にする(fail closed)", () => {
    expect(() =>
      verifyDisplayGrant(grant, { verificationKeys, maxAgeSeconds: 0 }),
    ).toThrow(InvalidDisplayGrantInputError);
    expect(() =>
      verifyDisplayGrant(grant, {
        verificationKeys,
        maxAgeSeconds: 60,
        now: issuedAt,
        clockSkewSeconds: -1,
      }),
    ).toThrow(InvalidDisplayGrantInputError);
  });
});

describe("鍵の組み立て", () => {
  it("Ed25519以外・PEMでない鍵、keyIdの重複を拒否する", () => {
    const { privateKey: rsaPrivateKey, publicKey: rsaPublicKey } =
      generateKeyPairSync("rsa", { modulusLength: 2048 });

    expect(() =>
      createDisplayGrantSigningKey({ keyId: "key-1", privateKeyPem: "not-a-pem" }),
    ).toThrow(InvalidDisplayGrantKeyError);
    expect(() =>
      createDisplayGrantSigningKey({
        keyId: "key-1",
        privateKeyPem: rsaPrivateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      }),
    ).toThrow(InvalidDisplayGrantKeyError);
    expect(() =>
      createDisplayGrantSigningKey({
        keyId: "   ",
        privateKeyPem: currentKey.publicKeyPem,
      }),
    ).toThrow(InvalidDisplayGrantKeyError);

    expect(() =>
      createDisplayGrantVerificationKeys([
        { keyId: "key-1", publicKey: rsaPublicKey.export({ type: "spki", format: "pem" }).toString() },
      ]),
    ).toThrow(InvalidDisplayGrantKeyError);
    expect(() =>
      createDisplayGrantVerificationKeys([
        { keyId: "key-1", publicKey: "not-a-pem" },
      ]),
    ).toThrow(InvalidDisplayGrantKeyError);
    expect(() =>
      createDisplayGrantVerificationKeys([
        { keyId: "key-1", publicKey: currentKey.publicKeyPem },
        { keyId: "key-1", publicKey: previousKey.publicKeyPem },
      ]),
    ).toThrow(InvalidDisplayGrantKeyError);
    expect(() => createDisplayGrantVerificationKeys([])).toThrow(
      InvalidDisplayGrantKeyError,
    );
  });
});

describe("displayGrantAuditErrorCategory", () => {
  it("期限切れだけを grant_expired、他は grant_invalid へ寄せる(T04 Q-003)", () => {
    expect(displayGrantAuditErrorCategory("expired")).toBe("grant_expired");
    for (const reason of [
      "malformed",
      "unsupported_header",
      "unknown_key_id",
      "signature_invalid",
      "payload_invalid",
      "issued_in_future",
      "ttl_too_long",
      "document_mismatch",
      "actor_mismatch",
    ] as const) {
      expect(displayGrantAuditErrorCategory(reason)).toBe("grant_invalid");
    }
  });
});
