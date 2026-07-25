import { createCookieSessionStorage, redirect } from "react-router";
import { env } from "~/lib/env.server";

export type AppUser = {
  id: string;
  name: string;
  email: string;
  roles: string[];
};

type SessionData = {
  user: AppUser;
};

type FlashData = {
  error: string;
};

const sessionStorage = createCookieSessionStorage<SessionData, FlashData>({
  cookie: {
    name:
      env.NODE_ENV === "production"
        ? "__Host-company_session"
        : "company_session",
    httpOnly: true,
    maxAge: env.SESSION_MAX_AGE_SECONDS,
    path: "/",
    sameSite: "lax",
    secrets: [env.SESSION_SECRET],
    secure: env.NODE_ENV === "production",
  },
});

export async function getUser(request: Request): Promise<AppUser | null> {
  const session = await sessionStorage.getSession(
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
  return user;
}

export async function createUserSession(
  user: AppUser,
  redirectTo = "/app",
): Promise<Response> {
  const session = await sessionStorage.getSession();
  session.set("user", user);

  return redirect(safeInternalPath(redirectTo), {
    headers: {
      "Set-Cookie": await sessionStorage.commitSession(session),
    },
  });
}

export async function destroyUserSession(request: Request): Promise<Response> {
  const session = await sessionStorage.getSession(
    request.headers.get("Cookie"),
  );
  return redirect("/", {
    headers: {
      "Set-Cookie": await sessionStorage.destroySession(session),
    },
  });
}

export function safeInternalPath(value: string | null | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) {
    return "/app";
  }
  return value;
}
