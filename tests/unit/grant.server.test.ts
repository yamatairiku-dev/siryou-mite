import { createPublicKey, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  issueDisplayGrant,
  resetDisplayGrantSigningKeyForTest,
} from "~/lib/grant.server";
// 検証系APIはWeb側で再exportしないため、実処理のmoduleから直接importする。
import {
  createDisplayGrantVerificationKeys,
  verifyDisplayGrant,
} from "../../services/shared/grant";

/**
 * Web向け薄いラッパー(設計 §7.2, §9.5)。署名・検証の実処理は
 * `services/shared/grant.ts`の単体テスト(`tests/unit/services/grant.test.ts`)で
 * 検証済みのため、ここでは`app/lib/env.server.ts`の署名鍵・TTLを使って発行し、
 * 対応する公開鍵で検証できることだけを確認する。鍵は`tests/setup.ts`が生成する
 * 使い捨ての値で、実運用のsecretではない。
 */
const verificationKeys = createDisplayGrantVerificationKeys([
  {
    keyId: process.env.GRANT_SIGNING_KEY_ID as string,
    // `createPublicKey`は秘密鍵PEMから対応する公開鍵を導出する。
    publicKey: createPublicKey({
      key: process.env.GRANT_SIGNING_PRIVATE_KEY as string,
      format: "pem",
    })
      .export({ type: "spki", format: "pem" })
      .toString(),
  },
]);

const documentId = randomUUID();
const user = {
  id: "00000000-1111-2222-3333-444444444444",
  tenantId: "99999999-8888-7777-6666-555555555555",
  email: "user@example.com",
};

afterEach(() => {
  resetDisplayGrantSigningKeyForTest();
});

describe("issueDisplayGrant", () => {
  it("env の署名鍵・keyId・TTL(60秒)で発行し、対応する公開鍵で検証できる", () => {
    const now = new Date("2026-09-13T00:00:00.000Z");
    const grant = issueDisplayGrant({ documentId, user }, { now });

    const result = verifyDisplayGrant(grant, {
      verificationKeys,
      maxAgeSeconds: 60,
      now,
      expected: { documentId, actorSubjectId: user.id },
    });

    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.keyId).toBe(process.env.GRANT_SIGNING_KEY_ID);
    expect(result.payload.expiresAt - result.payload.issuedAt).toBe(60);
    expect(result.payload.actorTenantId).toBe(user.tenantId);
    // 設計 §7.2: grantは操作時点のメールアドレスを含む(Displayの閲覧監査で使う)。
    expect(result.payload.actorEmailAtEvent).toBe(user.email);
  });

  it("署名鍵を使い回しても、発行ごとに異なるgrantになる(nonce)", () => {
    expect(issueDisplayGrant({ documentId, user })).not.toBe(
      issueDisplayGrant({ documentId, user }),
    );
  });

  it("メールアドレス形式でないclaim(UPNなど)はnullとして発行する(Q-016)", () => {
    const now = new Date("2026-09-13T00:00:00.000Z");
    const grant = issueDisplayGrant(
      { documentId, user: { ...user, email: "DOMAIN\\user" } },
      { now },
    );

    const result = verifyDisplayGrant(grant, {
      verificationKeys,
      maxAgeSeconds: 60,
      now,
    });

    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.payload.actorEmailAtEvent).toBeNull();
  });

  it("発行時刻を省略すると現在時刻で発行し、60秒後に期限切れになる", () => {
    const grant = issueDisplayGrant({ documentId, user });

    expect(
      verifyDisplayGrant(grant, { verificationKeys, maxAgeSeconds: 60 }).valid,
    ).toBe(true);
    expect(
      verifyDisplayGrant(grant, {
        verificationKeys,
        maxAgeSeconds: 60,
        now: new Date(Date.now() + 61_000),
      }),
    ).toMatchObject({ valid: false, reason: "expired" });
  });
});
