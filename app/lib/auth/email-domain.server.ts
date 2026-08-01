import { z } from "zod";

const emailClaimsSchema = z.object({
  email: z.email().optional(),
  preferred_username: z.email().optional(),
});

export function requireAllowedEntraEmail(
  claims: unknown,
  allowedDomains: readonly string[],
): string {
  const parsedClaims = emailClaimsSchema.safeParse(claims);
  if (!parsedClaims.success) {
    throw new Response("メールアドレスを確認できませんでした", { status: 401 });
  }

  const email =
    parsedClaims.data.email ?? parsedClaims.data.preferred_username;
  if (!email) {
    throw new Response("メールアドレスを確認できませんでした", { status: 401 });
  }

  const domain = email.slice(email.lastIndexOf("@") + 1).toLowerCase();
  const isAllowed = allowedDomains.some(
    (allowedDomain) => allowedDomain.toLowerCase() === domain,
  );
  if (!isAllowed) {
    throw new Response("このアカウントではログインできません", {
      status: 403,
    });
  }

  return email;
}
