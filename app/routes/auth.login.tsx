import { Form, redirect } from "react-router";
import type { Route } from "./+types/auth.login";
import { beginEntraLogin } from "~/lib/auth/entra.server";
import { env } from "~/lib/env.server";
import { assertSameOrigin } from "~/lib/security.server";
import {
  createUserSession,
  getUser,
  safeInternalPath,
} from "~/lib/session.server";

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
    return createUserSession(
      {
        id: "dev-user",
        name: "開発ユーザー",
        email: "dev@example.local",
        roles: ["developer"],
      },
      returnTo,
    );
  }

  const { location, cookie } = await beginEntraLogin(request, returnTo);
  return redirect(location, { headers: { "Set-Cookie": cookie } });
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
      <Form method="post">
        <input name="returnTo" type="hidden" value={loaderData.returnTo} />
        <button className="button button-large" type="submit">
          {loaderData.authMode === "dev"
            ? "開発ユーザーでログイン"
            : "Microsoftでログイン"}
        </button>
      </Form>
      {loaderData.authMode === "dev" && (
        <p className="notice">
          AUTH_MODE=devは本番環境では起動できないように設定されています。
        </p>
      )}
    </section>
  );
}
