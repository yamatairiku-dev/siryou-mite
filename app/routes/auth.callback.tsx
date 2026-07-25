import { finishEntraLogin } from "~/lib/auth/entra.server";
import { createUserSession } from "~/lib/session.server";
import type { Route } from "./+types/auth.callback";

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const error = url.searchParams.get("error");
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  if (error) {
    throw new Response("Microsoft認証がキャンセルされたか失敗しました", {
      status: 401,
    });
  }
  if (!code || !state) {
    throw new Response("認証レスポンスが不足しています", { status: 400 });
  }

  const result = await finishEntraLogin(request, code, state);
  const response = await createUserSession(result.user, result.returnTo);
  response.headers.append("Set-Cookie", result.clearFlowCookie);
  return response;
}

export default function AuthCallback() {
  return <p>ログインを完了しています…</p>;
}
