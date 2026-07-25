import {
  ConfidentialClientApplication,
  type AuthenticationResult,
} from "@azure/msal-node";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createCookieSessionStorage } from "react-router";
import { env } from "~/lib/env.server";
import type { AppUser } from "~/lib/session.server";

type AuthFlowData = {
  state: string;
  verifier: string;
  returnTo: string;
};

const flowStorage = createCookieSessionStorage<AuthFlowData>({
  cookie: {
    name:
      env.NODE_ENV === "production"
        ? "__Host-company_auth_flow"
        : "company_auth_flow",
    httpOnly: true,
    maxAge: 600,
    path: "/",
    sameSite: "lax",
    secrets: [env.SESSION_SECRET],
    secure: env.NODE_ENV === "production",
  },
});

function getClient(): ConfidentialClientApplication {
  if (
    !env.ENTRA_CLIENT_ID ||
    !env.ENTRA_CLIENT_SECRET ||
    !env.ENTRA_TENANT_ID
  ) {
    throw new Error("Entra ID設定が不足しています");
  }

  return new ConfidentialClientApplication({
    auth: {
      clientId: env.ENTRA_CLIENT_ID,
      clientSecret: env.ENTRA_CLIENT_SECRET,
      authority: `https://login.microsoftonline.com/${env.ENTRA_TENANT_ID}`,
    },
  });
}

function base64Url(value: Buffer): string {
  return value.toString("base64url");
}

export async function beginEntraLogin(
  request: Request,
  returnTo: string,
): Promise<{ location: string; cookie: string }> {
  if (!env.ENTRA_REDIRECT_URI) {
    throw new Error("ENTRA_REDIRECT_URIが設定されていません");
  }

  const state = base64Url(randomBytes(32));
  const verifier = base64Url(randomBytes(64));
  const challenge = base64Url(createHash("sha256").update(verifier).digest());
  const session = await flowStorage.getSession(request.headers.get("Cookie"));
  session.set("state", state);
  session.set("verifier", verifier);
  session.set("returnTo", returnTo);

  const location = await getClient().getAuthCodeUrl({
    codeChallenge: challenge,
    codeChallengeMethod: "S256",
    redirectUri: env.ENTRA_REDIRECT_URI,
    scopes: ["openid", "profile", "email"],
    state,
  });

  return {
    location,
    cookie: await flowStorage.commitSession(session),
  };
}

export async function finishEntraLogin(
  request: Request,
  code: string,
  receivedState: string,
): Promise<{ user: AppUser; returnTo: string; clearFlowCookie: string }> {
  if (!env.ENTRA_REDIRECT_URI) {
    throw new Error("ENTRA_REDIRECT_URIが設定されていません");
  }

  const flow = await flowStorage.getSession(request.headers.get("Cookie"));
  const expectedState = flow.get("state");
  const verifier = flow.get("verifier");
  const returnTo = flow.get("returnTo") ?? "/app";

  if (!expectedState || !verifier || !equalState(receivedState, expectedState)) {
    throw new Response("認証状態を検証できませんでした", { status: 400 });
  }

  const result: AuthenticationResult | null =
    await getClient().acquireTokenByCode({
      code,
      codeVerifier: verifier,
      redirectUri: env.ENTRA_REDIRECT_URI,
      scopes: ["openid", "profile", "email"],
    });

  const account = result?.account;
  if (!account?.homeAccountId || !account.username) {
    throw new Response("ユーザー情報を取得できませんでした", { status: 401 });
  }

  return {
    user: {
      id: account.homeAccountId,
      name: account.name ?? account.username,
      email: account.username,
      roles: [],
    },
    returnTo,
    clearFlowCookie: await flowStorage.destroySession(flow),
  };
}

function equalState(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}
