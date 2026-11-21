/**
 * 画面の本文の幅。一覧や表が中心の画面だけが、route moduleの`handle`で広い幅を選ぶ。
 *
 * 例: `export const handle: LayoutHandle = { layout: "wide" };`
 */
export type LayoutHandle = { layout?: "wide" };

/** 表示中のrouteのどれかが広い幅を選んでいれば`true`。 */
export function isWideLayout(matches: ReadonlyArray<{ handle?: unknown }>): boolean {
  return matches.some((match) => {
    const handle = match.handle as LayoutHandle | null | undefined;
    return typeof handle === "object" && handle !== null && handle.layout === "wide";
  });
}
