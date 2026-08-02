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

const claimTypes = {
  objectId: [
    "oid",
    "http://schemas.microsoft.com/identity/claims/objectidentifier",
  ],
  tenantId: ["tid", "http://schemas.microsoft.com/identity/claims/tenantid"],
  role: ["roles", "http://schemas.microsoft.com/ws/2008/06/identity/claims/role"],
  group: [
    "groups",
    "http://schemas.microsoft.com/ws/2008/06/identity/claims/groups",
  ],
  name: ["name", "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name"],
  email: [
    "email",
    "preferred_username",
    "upn",
    "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress",
    "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/upn",
  ],
} as const;

export function parseEasyAuthPrincipal(
  encodedPrincipal: string,
  expectedTenantId: string,
): AppUser {
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
  if (tenantId.toLowerCase() !== expectedTenantId.toLowerCase()) {
    throw unauthorized("許可されていないテナントです");
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

function firstClaim(
  claims: Array<{ typ: string; val: string }>,
  acceptedTypes: readonly string[],
): string | undefined {
  return claims.find((claim) => acceptedTypes.includes(claim.typ))?.val;
}

function allClaims(
  claims: Array<{ typ: string; val: string }>,
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
