type AdminNavProps = {
  current: "documents" | "audit";
};

const ADMIN_SCREENS = [
  { key: "documents", href: "/admin/documents", label: "全資料の検索" },
  { key: "audit", href: "/admin/audit", label: "監査履歴" },
] as const;

/**
 * 管理画面どうしを直接行き来する導線(設計 §5.6, §5.7)。
 *
 * 表示制御であって認可ではない。遷移先のloaderが必ず`requireAdmin`で判定する。
 */
export function AdminNav({ current }: AdminNavProps) {
  return (
    <nav className="admin-nav" aria-label="管理画面">
      {ADMIN_SCREENS.map((screen) =>
        screen.key === current ? (
          <a
            key={screen.key}
            className="button"
            href={screen.href}
            aria-current="page"
          >
            {screen.label}
          </a>
        ) : (
          <a key={screen.key} className="button button-secondary" href={screen.href}>
            {screen.label}
          </a>
        ),
      )}
      <a className="admin-nav-back" href="/app">
        資料一覧へ戻る
      </a>
    </nav>
  );
}
