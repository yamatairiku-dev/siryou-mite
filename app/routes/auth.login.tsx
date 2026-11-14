import { Form, redirect, redirectDocument } from "react-router";
import { z } from "zod";
import type { Route } from "./+types/auth.login";
import { env } from "~/lib/env.server";
import { assertSameOrigin } from "~/lib/security.server";
import {
  createUserSession,
  getUser,
  safeInternalPath,
} from "~/lib/session.server";

const devRoleSchema = z.enum(["user", "admin"]);

export async function loader({ request }: Route.LoaderArgs) {
  if (await getUser(request)) {
    throw redirect("/app");
  }
  return {
    authMode: env.AUTH_MODE,
    returnTo: safeInternalPath(new URL(request.url).searchParams.get("returnTo")),
  };
}

export async function action({ request }: Route.ActionArgs) {
  assertSameOrigin(request);
  const formData = await request.formData();
  const returnTo = safeInternalPath(String(formData.get("returnTo") ?? ""));

  if (env.AUTH_MODE === "dev") {
    // 開発用ログイン。`AUTH_MODE=dev`は本番では起動時に拒否される(`env.server.ts`)。
    // 管理画面をローカルで確認できるよう、`Admin`ロール付きの開発ユーザーも選べる。
    const parsedRole = devRoleSchema.safeParse(formData.get("devRole") ?? "user");
    if (!parsedRole.success) {
      throw new Response("不正なリクエストです", { status: 400 });
    }
    const devRole = parsedRole.data;
    return createUserSession(
      devRole === "admin"
        ? {
            id: "dev-admin",
            tenantId: "dev-tenant",
            name: "開発管理者",
            email: "dev-admin@example.local",
            roles: ["User", "Admin"],
            groups: ["DEV"],
          }
        : {
            id: "dev-user",
            tenantId: "dev-tenant",
            name: "開発ユーザー",
            email: "dev@example.local",
            roles: ["User"],
            groups: ["DEV"],
          },
      returnTo,
    );
  }

  // `/.auth/login/aad`はEasy Authのendpointで、アプリのrouteではない。画面内の遷移
  // (client side navigation)として扱うと404になるため、document全体の遷移にする。
  const postLoginUri = new URL(returnTo, env.APP_ORIGIN).toString();
  return redirectDocument(
    `/.auth/login/aad?post_login_redirect_uri=${encodeURIComponent(postLoginUri)}`,
  );
}

export default function Login({ loaderData }: Route.ComponentProps) {
  return (
    <section className="auth-card">
      <p className="eyebrow">SIGN IN</p>
      <h1>ログイン</h1>
      <p>
        {loaderData.authMode === "dev"
          ? "ローカル開発用ユーザーでログインします。"
          : "会社のMicrosoftアカウントを使用します。"}
      </p>
      {/*
        ログインはブラウザ標準のform送信(document全体の遷移)で行う。Easy Authは未認証の
        要求をEntra IDへ転送するため、fetchによる送信(`/auth/login.data`)やroute探索
        (`/__manifest`)は認証除外path(設計 §7.1.1)に含まれず、失敗する。
      */}
      <Form method="post" reloadDocument discover="none">
        <input name="returnTo" type="hidden" value={loaderData.returnTo} />
        <button className="button button-large" type="submit">
          {loaderData.authMode === "dev"
            ? "開発ユーザーでログイン"
            : "Microsoftでログイン"}
        </button>
        {loaderData.authMode === "dev" && (
          <button
            className="button button-secondary button-large"
            type="submit"
            name="devRole"
            value="admin"
          >
            開発管理者でログイン
          </button>
        )}
      </Form>
      {loaderData.authMode === "dev" && (
        <p className="notice">
          AUTH_MODE=devは本番環境では起動できないように設定されています。
        </p>
      )}
    </section>
  );
}
