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
      <p className="eyebrow">資料みて！</p>
      {/* 句の途中(「み／て！」など)で折り返さないよう、句ごとにまとめる。
          入れ子の句は、外側が1行に入らないときだけ内側の切れ目で折り返す。 */}
      <h1>
        <span className="phrase">その資料、</span>
        <span className="phrase">
          <span className="phrase">URLで「みて！」と</span>
          <span className="phrase">送ろう。</span>
        </span>
      </h1>
      <p className="lead">
        <span className="phrase">
          <span className="phrase">HTMLファイルを</span>
          <span className="phrase">アップロードすると、</span>
        </span>
        <span className="phrase">
          <span className="phrase">社内のだれでも</span>
          <span className="phrase">ブラウザで開けるURLができます。</span>
        </span>
        <span className="phrase">
          <span className="phrase">TeamsやメールにURLを</span>
          <span className="phrase">貼るだけで共有完了。</span>
        </span>
      </p>
      <a className="button button-large" href="/auth/login">
        ログインして始める
      </a>
    </section>
  );
}
