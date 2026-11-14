type AdminNavProps = {
  /** 現在のURLのpathname。表示中の管理画面を示すために使う。 */
  pathname: string;
};

const ADMIN_SCREENS = [
  { href: "/admin/documents", label: "全資料の検索" },
  { href: "/admin/audit", label: "監査履歴" },
] as const;

/**
 * ヘッダーに置く管理画面への導線(設計 §5.6, §5.7)。管理者にだけ表示する。
 *
 * 表示制御であって認可ではない。遷移先のloaderが必ず`requireAdmin`で判定する
 * (設計 §4.2、AGENTS.md 5項)。
 */
export function AdminNav({ pathname }: AdminNavProps) {
  return (
    <>
      {ADMIN_SCREENS.map((screen) =>
        pathname === screen.href ? (
          <a
            key={screen.href}
            className="button header-button"
            href={screen.href}
            aria-current="page"
          >
            {screen.label}
          </a>
        ) : (
          <a
            key={screen.href}
            className="button button-secondary header-button"
            href={screen.href}
          >
            {screen.label}
          </a>
        ),
      )}
    </>
  );
}
