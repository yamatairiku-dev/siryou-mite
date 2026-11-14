import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRoutesStub } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import Login from "~/routes/auth.login";

/**
 * ログイン画面(設計 §7.1.1)。
 *
 * ログイン前の要求はEasy AuthがEntra IDへ転送するため、認証除外path以外へのfetch
 * (`/auth/login.data`への送信、`/__manifest`のroute探索)は失敗する。ログインformが
 * ブラウザ標準の送信だけを使い、route探索を起こさないことを確認する。
 */

afterEach(cleanup);

function renderLogin(authMode: "dev" | "easyauth") {
  const Stub = createRoutesStub([
    {
      path: "/auth/login",
      Component: () => (
        <Login
          {...({
            loaderData: { authMode, returnTo: "/app" },
          } as unknown as Parameters<typeof Login>[0])}
        />
      ),
    },
  ]);
  return render(<Stub initialEntries={["/auth/login"]} />);
}

describe("ログイン画面", () => {
  it("Easy AuthモードではMicrosoftでのログインだけを出す", async () => {
    renderLogin("easyauth");

    expect(
      await screen.findByRole("button", { name: "Microsoftでログイン" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "開発管理者でログイン" })).toBeNull();
  });

  it("formはブラウザ標準の送信を使い、route探索の対象にしない", async () => {
    renderLogin("easyauth");

    const form = (
      await screen.findByRole("button", { name: "Microsoftでログイン" })
    ).closest("form") as HTMLFormElement;

    expect(form.getAttribute("method")).toBe("post");
    // React Routerが`/__manifest`を取りに行く対象の印(`data-discover`)を付けない。
    expect(form.hasAttribute("data-discover")).toBe(false);
    // React Routerが送信を横取りする場合は`preventDefault`され、falseが返る。
    expect(fireEvent.submit(form)).toBe(true);
    expect(
      (form.querySelector('input[name="returnTo"]') as HTMLInputElement).value,
    ).toBe("/app");
  });
});
