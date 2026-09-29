/**
 * Easy Authが付加する`X-MS-CLIENT-PRINCIPAL`の解析(設計 §7.1, §7.1.2, §9.1)。
 *
 * このmoduleは「このprincipalを信頼して読み切れるか」だけを判断する信頼境界で、
 * 業務認可(App Role・所属・owner/admin)は`app/lib/auth/authorization.server.ts`と
 * `requireUser`が行う。
 *
 * 方針:
 * - headerの中身は一切信頼せず、Base64 → JSON → Zodの順に検証する。
 * - claim typeはEasy Authのclaim mappingに備えて短縮名とMicrosoftのURI形式を
 *   明示的なallowlistで扱い、未知のclaim typeは認証・認可に使わない(設計 §7.1)。
 * - `tid`は構成値と一致する場合だけ通す。構成値が無い場合は認証させない。
 * - group overageを検出した場合は403で拒否し、Microsoft Graphで補完するfallbackは
 *   設けない(設計 §4.1, §7.1.2)。
 * - principal本文・claim値を例外メッセージへ含めない(設計 §9.5, §15.2)。
 */
import { z } from "zod";
import type { AppUser } from "~/lib/session.server";

const principalSchema = z.object({
  auth_typ: z.string().min(1).max(64),
  claims: z
    .array(
      z.object({
        typ: z.string().min(1).max(512),
        val: z.string().min(1).max(2048),
      }),
    )
    .max(512),
});

type PrincipalClaim = { typ: string; val: string };

/**
 * 認証・認可へ使ってよいclaim typeのallowlist(設計 §7.1.2の表)。
 * ここに無いclaim typeは、値が入っていても読み取らない。
 */
const claimTypes = {
  /** 安定した利用者ID・owner判定。メールアドレスは認可へ使わない(設計 §4.2)。 */
  objectId: [
    "oid",
    "http://schemas.microsoft.com/identity/claims/objectidentifier",
  ],
  /** tenant固定(設計 §4.1)。 */
  tenantId: ["tid", "http://schemas.microsoft.com/identity/claims/tenantid"],
  /** 業務認可に使うApp Role(`User`・`Admin`)。 */
  role: [
    "roles",
    "http://schemas.microsoft.com/ws/2008/06/identity/claims/role",
  ],
  /** 所属コード。複数値を前提とする(設計 §7.1.2)。 */
  group: [
    "groups",
    "http://schemas.microsoft.com/ws/2008/06/identity/claims/groups",
  ],
  /** 画面・監査時点表示だけに使う(認可キーにしない)。 */
  name: ["name", "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name"],
  email: [
    "email",
    "preferred_username",
    "upn",
    "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress",
    "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/upn",
  ],
} as const;

/**
 * JWTのgroup overage(所属が多すぎてtokenへ入りきらない状態)を示すclaim type。
 *
 * Entraはoverage時に`groups`を出さず、代わりにGraphのエンドポイントを指す
 * `_claim_names`・`_claim_sources`(JWT)、`groups.link`(SAML)、または
 * `hasgroups`を発行する。これらを見ないと「所属0件」と区別できず、
 * fail closedにならないため、allowlistとして明示する(設計 §7.1.2)。
 */
const groupOverageClaimTypes = [
  "hasgroups",
  "_claim_names",
  "_claim_sources",
  "http://schemas.microsoft.com/claims/groups.link",
] as const;

/** overageの有無を判定しない`hasgroups`の値(Entraは`true`のときだけ発行する)。 */
const negativeHasGroupsValues = ["false", "0", ""];

export function parseEasyAuthPrincipal(
  encodedPrincipal: string,
  expectedTenantId: string | undefined,
): AppUser {
  // 構成漏れで「空文字のtenantと一致」してしまう経路を作らない(設計 §4.1)。
  // 環境変数名は秘密ではないため、運用が気付けるようメッセージへ残す。
  const expectedTenant = expectedTenantId?.trim();
  if (!expectedTenant) {
    throw new Error("ENTRA_TENANT_ID が構成されていないため認証できません");
  }

  if (encodedPrincipal.length > 64 * 1024) {
    throw unauthorized("認証情報が大きすぎます");
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(
      Buffer.from(encodedPrincipal, "base64").toString("utf8"),
    );
  } catch {
    throw unauthorized("認証情報を解析できません");
  }

  const parsed = principalSchema.safeParse(decoded);
  if (!parsed.success || parsed.data.auth_typ.toLowerCase() !== "aad") {
    throw unauthorized("認証情報を検証できません");
  }

  const claims = parsed.data.claims;
  const objectId = firstClaim(claims, claimTypes.objectId);
  const tenantId = firstClaim(claims, claimTypes.tenantId);
  const email = firstClaim(claims, claimTypes.email);

  if (!objectId || !tenantId || !email) {
    throw unauthorized("必須の認証クレームがありません");
  }
  if (tenantId.toLowerCase() !== expectedTenant.toLowerCase()) {
    throw unauthorized("許可されていないテナントです");
  }

  // overageのときは`groups`が欠落または不完全になる。所属はこのアプリの必須属性の
  // ため、Graphで補完せずここで拒否する(設計 §4.1, §7.1.2)。
  if (hasGroupOverage(claims)) {
    throw forbidden("所属情報を確認できません");
  }

  return {
    id: objectId,
    tenantId,
    name: firstClaim(claims, claimTypes.name) ?? email,
    email,
    roles: allClaims(claims, claimTypes.role),
    groups: allClaims(claims, claimTypes.group),
  };
}

function hasGroupOverage(claims: PrincipalClaim[]): boolean {
  return claims.some((claim) => {
    const typ = claim.typ.toLowerCase();
    if (!groupOverageClaimTypes.some((candidate) => candidate === typ)) {
      return false;
    }
    if (typ === "hasgroups") {
      return !negativeHasGroupsValues.includes(claim.val.trim().toLowerCase());
    }
    // `_claim_names`・`_claim_sources`は他のclaimのoverageにも使われるため、
    // `groups`を指している場合だけoverageとして扱う。
    if (typ === "_claim_names" || typ === "_claim_sources") {
      return /groups/i.test(claim.val);
    }
    return true;
  });
}

function firstClaim(
  claims: PrincipalClaim[],
  acceptedTypes: readonly string[],
): string | undefined {
  return claims.find((claim) => acceptedTypes.includes(claim.typ))?.val;
}

/** 同じ所属が複数のclaim typeで届いても1件として扱う(設計 §7.1.2)。 */
function allClaims(
  claims: PrincipalClaim[],
  acceptedTypes: readonly string[],
): string[] {
  return [
    ...new Set(
      claims
        .filter((claim) => acceptedTypes.includes(claim.typ))
        .map((claim) => claim.val),
    ),
  ];
}

function unauthorized(message: string): Response {
  return new Response(message, { status: 401 });
}

function forbidden(message: string): Response {
  return new Response(message, { status: 403 });
}
