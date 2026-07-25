import { redirect } from "react-router";
import type { Route } from "./+types/home";
import { getUser } from "~/lib/session.server";

export async function loader({ request }: Route.LoaderArgs) {
  if (await getUser(request)) {
    throw redirect("/app");
  }
  return null;
}

export default function Home() {
  return (
    <section className="hero">
      <p className="eyebrow">INTERNAL APPLICATION</p>
      <h1>社内業務を、安全で分かりやすいWebアプリに。</h1>
      <p className="lead">
        React Router Framework Mode、Entra ID、Docker、テストを標準化した
        情報システム部向けスターターです。
      </p>
      <a className="button button-large" href="/auth/login">
        ログインして開始
      </a>
    </section>
  );
}
