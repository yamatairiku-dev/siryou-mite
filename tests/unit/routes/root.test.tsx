import { cleanup, render, screen } from "@testing-library/react";
import {
  createRoutesStub,
  UNSAFE_ErrorResponseImpl as ErrorResponseImpl,
} from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import App, { ErrorBoundary, meta } from "~/root";
import { handle as appHandle } from "~/routes/app";
import { handle as auditHandle } from "~/routes/admin.audit";

type MetaArgs = Parameters<typeof meta>[0];
type BoundaryProps = Parameters<typeof ErrorBoundary>[0];

afterEach(cleanup);

function titleOf(loaderData: MetaArgs["loaderData"]): unknown {
  const descriptors = meta({ loaderData } as MetaArgs);
  const descriptor = descriptors.find((item) => "title" in item) as
    | { title?: unknown }
    | undefined;
  return descriptor?.title;
}

describe("root meta", () => {
  it("<title>にAPP_NAME(loaderのappName)を使う", () => {
    expect(
      titleOf({
        appName: "資料みて！(検証)",
        user: null,
        canUseAdminScreen: false,
      }),
    ).toBe("資料みて！(検証)");
  });

  it("loaderDataが無いエラー画面では既定のアプリ名にする", () => {
    expect(titleOf(undefined)).toBe("資料みて！");
  });
});

describe("root ErrorBoundary", () => {
  const notFound = new ErrorResponseImpl(404, "Not Found", "資料が見つかりません");

  function renderBoundary(loaderData: BoundaryProps["loaderData"]) {
    return render(
      <ErrorBoundary
        {...({ error: notFound, loaderData, params: {} } as BoundaryProps)}
      />,
    );
  }

  it("ログイン中の「ホームへ戻る」は初期画面(/app)を指す", () => {
    // `/`は未ログイン画面。Easy Authの認証除外pathではログイン済みでも未ログイン画面になる。
    renderBoundary({
      appName: "資料みて！",
      user: { name: "利用者 太郎" },
      canUseAdminScreen: false,
    } as BoundaryProps["loaderData"]);

    expect(screen.getByText("ページが見つかりません")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "ホームへ戻る" }).getAttribute("href"),
    ).toBe("/app");
  });

  it("アプリが投げた404の文言はそのまま表示する", () => {
    renderBoundary(undefined);
    expect(screen.getByText("資料が見つかりません")).toBeTruthy();
  });

  it("一致するrouteが無い404では、React Router内部の文言を表示しない", () => {
    // React Routerはrouteが無いURLを`internal`のErrorResponseにし、dataへ
    // 「Error: No route matches URL "..."」を入れる(stagingの`/.auth/me`で発生)。
    const noRoute = new ErrorResponseImpl(
      404,
      "Not Found",
      new Error('No route matches URL "/.auth/me"'),
      true,
    );
    render(
      <ErrorBoundary
        {...({
          error: noRoute,
          loaderData: undefined,
          params: {},
        } as unknown as BoundaryProps)}
      />,
    );

    expect(screen.getByText("ページが見つかりません")).toBeTruthy();
    expect(screen.getByText("URLが正しいか確認してください。")).toBeTruthy();
    expect(document.body.textContent).not.toContain("No route matches");
    expect(document.body.textContent).not.toContain("/.auth/me");
  });

  it("未ログイン、またはrootのloaderが失敗した場合は未ログイン画面(/)を指す", () => {
    renderBoundary({
      appName: "資料みて！",
      user: null,
      canUseAdminScreen: false,
    });
    expect(
      screen.getByRole("link", { name: "ホームへ戻る" }).getAttribute("href"),
    ).toBe("/");
    cleanup();

    renderBoundary(undefined);
    expect(
      screen.getByRole("link", { name: "ホームへ戻る" }).getAttribute("href"),
    ).toBe("/");
  });
});

describe("root 本文の幅", () => {
  async function mainClassAt(path: string) {
    const Stub = createRoutesStub([
      {
        path: "/",
        Component: App,
        loader: () => ({ appName: "資料みて！", user: null, canUseAdminScreen: false }),
        children: [
          { path: "app", Component: () => <p>一覧</p>, handle: appHandle },
          { path: "admin/audit", Component: () => <p>一覧</p>, handle: auditHandle },
          { path: "other", Component: () => <p>一覧</p> },
        ],
      },
    ]);
    render(<Stub initialEntries={[path]} />);
    await screen.findByText("一覧");
    return screen.getByRole("main").className;
  }

  it("資料一覧・監査履歴は広い幅で表示する", async () => {
    expect(await mainClassAt("/app")).toBe("container container-wide");
    cleanup();
    expect(await mainClassAt("/admin/audit")).toBe("container container-wide");
  });

  it("handleで選んでいない画面は通常の幅のまま", async () => {
    expect(await mainClassAt("/other")).toBe("container");
  });
});
