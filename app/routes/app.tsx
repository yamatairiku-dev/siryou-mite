import type { Route } from "./+types/app";
import { requireUser } from "~/lib/session.server";

export async function loader({ request }: Route.LoaderArgs) {
  return { user: await requireUser(request) };
}

export const meta: Route.MetaFunction = () => [{ title: "アプリ" }];

export default function Application({ loaderData }: Route.ComponentProps) {
  return (
    <section>
      <p className="eyebrow">DASHBOARD</p>
      <h1>{loaderData.user.name}さん、こんにちは</h1>
      <p className="lead">
        このrouteのloaderはサーバー側でセッションを検証しています。
      </p>
      <div className="grid">
        <article className="card">
          <h2>認証済みユーザー</h2>
          <dl>
            <dt>氏名</dt>
            <dd>{loaderData.user.name}</dd>
            <dt>メール</dt>
            <dd>{loaderData.user.email}</dd>
          </dl>
        </article>
        <article className="card">
          <h2>次の実装場所</h2>
          <p>
            業務機能はこのrouteを複製し、データ取得はloader、更新はactionへ実装します。
          </p>
        </article>
      </div>
    </section>
  );
}
