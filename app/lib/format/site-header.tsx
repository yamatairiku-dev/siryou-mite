import { useEffect, useState } from "react";
import { Form } from "react-router";
import { AdminNav } from "~/lib/format/admin-nav";

type SiteHeaderProps = {
  appName: string;
  /** ログイン中の利用者の表示名。未ログインは`null`。 */
  userName: string | null;
  /** 管理画面への導線を出すか。表示制御であって認可ではない(設計 §4.2)。 */
  canUseAdminScreen: boolean;
  pathname: string;
};

const MENU_ID = "site-menu";

/**
 * 全画面共通のヘッダー。
 *
 * スマホ幅(CSSの`max-width: 680px`)では、ログイン中の項目(管理画面への導線・
 * 利用者名・ログアウト)をメニューボタンの中へ畳む。広い画面ではメニューボタンを
 * 出さず、項目を常に横並びで表示する(開閉状態はCSS側で無視される)。
 */
export function SiteHeader({
  appName,
  userName,
  canUseAdminScreen,
  pathname,
}: SiteHeaderProps) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);

  useEffect(() => {
    if (!isMenuOpen) return;
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setIsMenuOpen(false);
    }
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [isMenuOpen]);

  return (
    <header className="site-header">
      <a className="brand" href="/">
        {appName}
      </a>
      {userName === null ? (
        <nav aria-label="メインナビゲーション">
          <a className="button" href="/auth/login">
            ログイン
          </a>
        </nav>
      ) : (
        <>
          <button
            type="button"
            className="menu-toggle"
            aria-label={isMenuOpen ? "メニューを閉じる" : "メニューを開く"}
            aria-expanded={isMenuOpen}
            aria-controls={MENU_ID}
            onClick={() => setIsMenuOpen((open) => !open)}
          >
            <span className="menu-toggle-bar" />
            <span className="menu-toggle-bar" />
            <span className="menu-toggle-bar" />
          </button>
          <nav
            id={MENU_ID}
            aria-label="メインナビゲーション"
            className={isMenuOpen ? "site-menu site-menu-open" : "site-menu"}
          >
            {canUseAdminScreen && <AdminNav pathname={pathname} />}
            <span className="user-name">{userName}</span>
            <Form action="/auth/logout" method="post">
              <button className="button button-secondary" type="submit">
                ログアウト
              </button>
            </Form>
          </nav>
          {/*
            メニューの外を押したら閉じるための透明な覆い。資料表示画面の別オリジンiframeの
            上では親画面へ押下イベントが届かないため、documentへのlistenerではなく、
            画面全体を覆う要素で受ける。外を押した操作は「閉じる」だけに使い、下にある
            ボタンやリンクは反応させない。
          */}
          {isMenuOpen && (
            <div
              className="site-menu-backdrop"
              data-testid="site-menu-backdrop"
              aria-hidden="true"
              onClick={() => setIsMenuOpen(false)}
            />
          )}
        </>
      )}
    </header>
  );
}
