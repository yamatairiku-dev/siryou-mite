import {
  Form,
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useLoaderData,
  useLocation,
} from "react-router";
import type { Route } from "./+types/root";
import { DEFAULT_APP_NAME } from "~/lib/app-name";
import { isAdmin } from "~/lib/auth/authorization.server";
import { env } from "~/lib/env.server";
import { AdminNav } from "~/lib/format/admin-nav";
import { securityHeaders } from "~/lib/security.server";
import { getUser } from "~/lib/session.server";
import "./app.css";

export async function loader({ request }: Route.LoaderArgs) {
  const user = await getUser(request);
  return {
    appName: env.APP_NAME,
    user,
    // 管理画面への導線を出すかどうか(設計 §5.6, §5.7)。表示制御であって認可ではなく、
    // `/admin/documents`・`/admin/audit`のloaderが必ず`requireAdmin`で判定する。
    canUseAdminScreen: user ? isAdmin(user) : false,
  };
}

export function headers() {
  return securityHeaders();
}

export const links: Route.LinksFunction = () => [
  { rel: "icon", href: "/favicon.svg", type: "image/svg+xml" },
];

// loaderが失敗したエラー画面ではloaderDataが無いため、既定のアプリ名へ戻す。
export const meta: Route.MetaFunction = ({ loaderData }) => [
  { title: loaderData?.appName ?? DEFAULT_APP_NAME },
  {
    name: "description",
    content: "HTML資料をアップロードし、社内で安全に共有するアプリ",
  },
];

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        {/* stylesheetは`style-src 'self'`で許可しており、nonceは要らない。既定の
            `<ServerRouter nonce>`を付けると、ブラウザがnonce属性を空にするため
            hydrationの属性不一致になる。 */}
        <Links nonce="" />
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
  const { appName, user, canUseAdminScreen } = useLoaderData<typeof loader>();
  const { pathname } = useLocation();

  return (
    <>
      <header className="site-header">
        <a className="brand" href="/">
          {appName}
        </a>
        <nav aria-label="メインナビゲーション">
          {user ? (
            <>
              {canUseAdminScreen && <AdminNav pathname={pathname} />}
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
