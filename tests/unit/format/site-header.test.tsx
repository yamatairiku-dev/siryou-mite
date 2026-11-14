import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRoutesStub } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { SiteHeader } from "~/lib/format/site-header";

afterEach(cleanup);

function renderHeader(props: Partial<Parameters<typeof SiteHeader>[0]> = {}) {
  const Stub = createRoutesStub([
    {
      path: "/app",
      Component: () => (
        <SiteHeader
          appName="資料みて！"
          userName="利用者 太郎"
          canUseAdminScreen={false}
          pathname="/app"
          {...props}
        />
      ),
    },
  ]);
  return render(<Stub initialEntries={["/app"]} />);
}

describe("SiteHeader", () => {
  it("ログイン中は利用者名とログアウトを出し、メニューは閉じた状態で始まる", async () => {
    renderHeader();

    const toggle = await screen.findByRole("button", { name: "メニューを開く" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    const menu = screen.getByRole("navigation", { name: "メインナビゲーション" });
    expect(toggle.getAttribute("aria-controls")).toBe(menu.id);
    expect(menu.className).toBe("site-menu");
    expect(screen.getByText("利用者 太郎")).toBeTruthy();
    expect(screen.getByRole("button", { name: "ログアウト" })).toBeTruthy();
  });

  it("メニューボタンで開閉し、Escでも閉じる", async () => {
    renderHeader();

    fireEvent.click(await screen.findByRole("button", { name: "メニューを開く" }));
    const menu = screen.getByRole("navigation", { name: "メインナビゲーション" });
    const close = screen.getByRole("button", { name: "メニューを閉じる" });
    expect(close.getAttribute("aria-expanded")).toBe("true");
    expect(menu.className).toContain("site-menu-open");

    fireEvent.click(close);
    expect(menu.className).toBe("site-menu");

    fireEvent.click(screen.getByRole("button", { name: "メニューを開く" }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(menu.className).toBe("site-menu");
  });

  it("メニューの外を押すと閉じ、メニューの中を押しても閉じない", async () => {
    renderHeader();

    fireEvent.click(await screen.findByRole("button", { name: "メニューを開く" }));
    const menu = screen.getByRole("navigation", { name: "メインナビゲーション" });

    fireEvent.click(screen.getByText("利用者 太郎"));
    expect(menu.className).toContain("site-menu-open");

    // 外側は透明な覆いが受ける(別オリジンiframeの上でも閉じられるようにするため)。
    fireEvent.click(screen.getByTestId("site-menu-backdrop"));
    expect(menu.className).toBe("site-menu");
    expect(screen.queryByTestId("site-menu-backdrop")).toBeNull();
  });

  it("管理画面への導線は許可された利用者にだけ出す", async () => {
    const general = renderHeader({ canUseAdminScreen: false });
    await screen.findByRole("button", { name: "ログアウト" });
    expect(screen.queryByRole("link", { name: "全資料の検索" })).toBeNull();
    expect(screen.queryByRole("link", { name: "監査履歴" })).toBeNull();
    general.unmount();

    renderHeader({ canUseAdminScreen: true });
    expect(
      (await screen.findByRole("link", { name: "全資料の検索" })).getAttribute(
        "href",
      ),
    ).toBe("/admin/documents");
    expect(
      screen.getByRole("link", { name: "監査履歴" }).getAttribute("href"),
    ).toBe("/admin/audit");
  });

  it("未ログインではログインだけを出し、メニューボタンは出さない", async () => {
    renderHeader({ userName: null });

    expect(
      (await screen.findByRole("link", { name: "ログイン" })).getAttribute("href"),
    ).toBe("/auth/login");
    expect(screen.queryByRole("button", { name: /メニュー/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "ログアウト" })).toBeNull();
  });
});
