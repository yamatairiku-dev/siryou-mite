import { createCookieSessionStorage, redirect } from "react-router";
import { parseEasyAuthPrincipal } from "~/lib/auth/easy-auth.server";
import { env } from "~/lib/env.server";

export type AppUser = {
  id: string;
  tenantId: string;
  name: string;
  email: string;
  roles: string[];
  groups: string[];
};

type SessionData = {
  user: AppUser;
};

type FlashData = {
  error: string;
};

export async function getUser(request: Request): Promise<AppUser | null> {
  if (env.AUTH_MODE === "easyauth") {
    const principal = request.headers.get("X-MS-CLIENT-PRINCIPAL");
    return principal
      ? parseEasyAuthPrincipal(principal, env.ENTRA_TENANT_ID ?? "")
      : null;
  }

  const session = await getDevSessionStorage().getSession(
    request.headers.get("Cookie"),
  );
  return session.get("user") ?? null;
}

export async function requireUser(request: Request): Promise<AppUser> {
  const user = await getUser(request);
  if (!user) {
    const target = new URL(request.url);
    const returnTo = `${target.pathname}${target.search}`;
    throw redirect(`/auth/login?returnTo=${encodeURIComponent(returnTo)}`);
  }
  if (!user.roles.some((role) => role === "User" || role === "Admin")) {
    throw new Response("このアプリを利用する権限がありません", { status: 403 });
  }
  if (user.groups.length === 0) {
    throw new Response("所属情報を確認できません", { status: 403 });
  }
  return user;
}

export async function createUserSession(
  user: AppUser,
  redirectTo = "/app",
): Promise<Response> {
  if (env.AUTH_MODE !== "dev") {
    throw new Error("アプリ内セッションはローカル開発専用です");
  }
  const sessionStorage = getDevSessionStorage();
  const session = await sessionStorage.getSession();
  session.set("user", user);

  return redirect(safeInternalPath(redirectTo), {
    headers: {
      "Set-Cookie": await sessionStorage.commitSession(session),
    },
  });
}

export async function destroyUserSession(request: Request): Promise<Response> {
  if (env.AUTH_MODE === "easyauth") {
    const postLogoutUri = new URL("/", env.APP_ORIGIN).toString();
    return redirect(
      `/.auth/logout?post_logout_redirect_uri=${encodeURIComponent(postLogoutUri)}`,
    );
  }

  const sessionStorage = getDevSessionStorage();
  const session = await sessionStorage.getSession(
    request.headers.get("Cookie"),
  );
  return redirect("/", {
    headers: {
      "Set-Cookie": await sessionStorage.destroySession(session),
    },
  });
}

function getDevSessionStorage() {
  if (env.AUTH_MODE !== "dev" || !env.SESSION_SECRET) {
    throw new Error("開発用セッション設定がありません");
  }

  return createCookieSessionStorage<SessionData, FlashData>({
    cookie: {
      name: "company_session",
      httpOnly: true,
      maxAge: env.SESSION_MAX_AGE_SECONDS,
      path: "/",
      sameSite: "lax",
      secrets: [env.SESSION_SECRET],
      secure: false,
    },
  });
}

export function safeInternalPath(value: string | null | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) {
    return "/app";
  }
  return value;
}
