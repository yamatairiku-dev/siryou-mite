import {
  Form,
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useLoaderData,
} from "react-router";
import type { Route } from "./+types/root";
import { env } from "~/lib/env.server";
import { securityHeaders } from "~/lib/security.server";
import { getUser } from "~/lib/session.server";
import "./app.css";

export async function loader({ request }: Route.LoaderArgs) {
  return {
    appName: env.APP_NAME,
    user: await getUser(request),
  };
}

export function headers() {
  return securityHeaders();
}

export const links: Route.LinksFunction = () => [
  { rel: "icon", href: "/favicon.svg", type: "image/svg+xml" },
];

export const meta: Route.MetaFunction = () => [
  { title: "社内Webアプリ" },
  {
    name: "description",
    content: "React Router Framework Mode社内標準テンプレート",
  },
];

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  const { appName, user } = useLoaderData<typeof loader>();

  return (
    <>
      <header className="site-header">
        <a className="brand" href="/">
          {appName}
        </a>
        <nav aria-label="メインナビゲーション">
          {user ? (
            <>
              <a href="/app">アプリ</a>
              <span className="user-name">{user.name}</span>
              <Form action="/auth/logout" method="post">
                <button className="button button-secondary" type="submit">
                  ログアウト
                </button>
              </Form>
            </>
          ) : (
            <a className="button" href="/auth/login">
              ログイン
            </a>
          )}
        </nav>
      </header>
      <main className="container">
        <Outlet />
      </main>
    </>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let title = "エラーが発生しました";
  let message = "しばらく時間をおいて、もう一度お試しください。";
  let status: number | undefined;

  if (isRouteErrorResponse(error)) {
    status = error.status;
    if (error.status === 401) {
      title = "認証が必要です";
    } else if (error.status === 403) {
      title = "アクセス権限がありません";
    } else if (error.status === 404) {
      title = "ページが見つかりません";
    }
    message =
      typeof error.data === "string" ? error.data : error.statusText || message;
  } else if (import.meta.env.DEV && error instanceof Error) {
    message = error.message;
  }

  return (
    <main className="container error-panel">
      <p className="eyebrow">{status ? `HTTP ${status}` : "SYSTEM ERROR"}</p>
      <h1>{title}</h1>
      <p>{message}</p>
      <a className="button" href="/">
        ホームへ戻る
      </a>
    </main>
  );
}
