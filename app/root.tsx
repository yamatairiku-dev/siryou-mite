import {
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
import { SiteHeader } from "~/lib/format/site-header";
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
      <SiteHeader
        appName={appName}
        userName={user?.name ?? null}
        canUseAdminScreen={canUseAdminScreen}
        pathname={pathname}
      />
      <main className="container">
        <Outlet />
      </main>
    </>
  );
}

export function ErrorBoundary({
  error,
  loaderData,
}: Route.ErrorBoundaryProps) {
  // ログイン中は初期画面(`/app`)へ戻す。`/`は未ログイン画面で、Easy Authの認証除外pathの
  // ためログイン済みでも未ログイン画面になる(設計 §7.1.1)。rootのloader自体が失敗した
  // 場合(App Roleなしの403など)は利用者が分からないため`/`へ戻す。
  const homeHref = loaderData?.user ? "/app" : "/";
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
      <a className="button" href={homeHref}>
        ホームへ戻る
      </a>
    </main>
  );
}
