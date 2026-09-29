/**
 * App Role(`User`・`Admin`)の判定(設計 §4.1, §4.2, §7.1.2)。
 *
 * - `roles` claimだけを業務認可へ使い、`groups`(所属)は認可へ使わない。
 * - `Admin`は一般機能と管理機能の両方を使え、`User`との二重割り当てを必要としない。
 * - Entra側の設定変更などで未知の値が`roles`へ入っても、ここで`User`・`Admin`
 *   以外は無視する(未知の値を権限として解釈しない)。
 *
 * `session.server.ts`と`authorization.server.ts`の両方から使うため、依存を持たない
 * 純粋な判定だけを置く。
 */

/** 設計 §4.1で定義したApp Role。値はEntraのApp Role値と完全一致させる。 */
export const appRoles = ["User", "Admin"] as const;
export type AppRole = (typeof appRoles)[number];

/** `roles`だけを見れば判定できるため、`AppUser`全体を要求しない。 */
type RoleBearer = { roles: readonly string[] };

/**
 * `roles` claimのうち、アプリが認可へ使うApp Roleだけを取り出す。
 * 比較は完全一致で行う(`admin`のような大文字小文字違いは別の値として扱い、
 * 権限として認めない)。
 */
export function appRolesOf(user: RoleBearer): AppRole[] {
  return appRoles.filter((role) => user.roles.includes(role));
}

/**
 * このアプリを利用できるApp Roleを持つか(設計 §7.1「`User`・`Admin`がない場合は拒否」)。
 * `Admin`単独でも一般機能を利用できる(設計 §4.1)。
 */
export function hasAppAccessRole(user: RoleBearer): boolean {
  return appRolesOf(user).length > 0;
}

/** 管理機能(他人の資料の検索・閲覧・強制削除、監査履歴)を使えるか(設計 §4.2)。 */
export function isAdmin(user: RoleBearer): boolean {
  return user.roles.includes("Admin");
}
