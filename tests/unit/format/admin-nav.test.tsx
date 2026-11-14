import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AdminNav } from "~/lib/format/admin-nav";

afterEach(cleanup);

describe("AdminNav(ヘッダーの管理画面への導線)", () => {
  it("全資料の検索と監査履歴へのリンクを出す", () => {
    render(<AdminNav pathname="/app" />);

    expect(
      screen.getByRole("link", { name: "全資料の検索" }).getAttribute("href"),
    ).toBe("/admin/documents");
    expect(
      screen.getByRole("link", { name: "監査履歴" }).getAttribute("href"),
    ).toBe("/admin/audit");
    // 管理画面以外では、どちらも「現在の画面」にしない。
    expect(document.querySelector('[aria-current="page"]')).toBeNull();
  });

  it.each([
    ["/admin/documents", "全資料の検索", "監査履歴"],
    ["/admin/audit", "監査履歴", "全資料の検索"],
  ])("%s では表示中の画面だけを示す", (pathname, current, other) => {
    render(<AdminNav pathname={pathname} />);

    expect(
      screen.getByRole("link", { name: current }).getAttribute("aria-current"),
    ).toBe("page");
    expect(
      screen.getByRole("link", { name: other }).getAttribute("aria-current"),
    ).toBeNull();
  });
});
