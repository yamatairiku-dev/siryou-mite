/**
 * E2Eでアップロードする自己完結HTMLのfixture(設計 §6.1, §6.2, §6.3, §18.3)。
 *
 * `tests/unit/html/inspection.server.test.ts`が検証済みの受け入れ・拒否条件と
 * 同じパターンを使う。ここで作るHTMLは書き換え対象にしないため、検査をすり抜ける
 * ような細工はしない。
 */

function wrapDocument(title: string, bodyHtml: string): string {
  return `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8"><title>${title}</title></head><body>${bodyHtml}</body></html>`;
}

/** 警告の出ない、最小の自己完結HTML(設計 §6.1)。 */
export function plainValidHtml(title: string): string {
  return wrapDocument(title, `<p>${title}の本文です。</p>`);
}

/**
 * script・inline event handler・javascript:リンクを含み、警告付きで受理される
 * HTML(設計 §6.2)。表示時にscript-src 'none'でJavaScriptが実行されないこと、
 * 外部への通信が発生しないことを確認するためのマーカーと`fetch`呼び出しを含む。
 */
export function scriptedHtml(title: string): string {
  return wrapDocument(
    title,
    [
      `<p id="marker">original</p>`,
      `<button id="handler-btn" onclick="document.getElementById('marker').textContent='clicked'">押す</button>`,
      `<script>document.getElementById('marker').textContent = 'executed'; fetch('https://e2e-should-not-load.example.invalid/leak');</script>`,
      `<a id="js-link" href="javascript:document.title='pwned'">JSリンク</a>`,
    ].join(""),
  );
}

/**
 * `target="_top"`・`target="_parent"`・`target="_blank"`・target省略のリンクを
 * 持つHTML(設計 §6.3)。href先はテスト側が指定する(公衆ネットワークに依存
 * しないよう、呼び出し側がアプリ自身のオリジンを渡す想定)。target省略時は
 * 確認画面を経由せずiframe自身が遷移する(設計 §6.3「target省略時と
 * target="_self"は同じiframe内で開く」「アプリ独自の確認画面…は設けない」)。
 */
export function frameNavigationHtml(title: string, absoluteHref: string): string {
  return wrapDocument(
    title,
    [
      `<a id="top-link" target="_top" href="${absoluteHref}">topへ</a>`,
      `<a id="parent-link" target="_parent" href="${absoluteHref}">parentへ</a>`,
      `<a id="blank-link" target="_blank" href="${absoluteHref}">blankへ</a>`,
      `<a id="self-link" href="${absoluteHref}">同じiframe内へ</a>`,
    ].join(""),
  );
}

/** `data:`スキームのリンクを含み、アップロード自体が拒否されるHTML(設計 §6.2, §6.3)。 */
export function htmlWithDataSchemeLink(title: string): string {
  return wrapDocument(title, `<a href="data:text/html,hacked">data</a>`);
}

/** `file:`スキームのリンクを含み、アップロード自体が拒否されるHTML。 */
export function htmlWithFileSchemeLink(title: string): string {
  return wrapDocument(title, `<a href="file:///etc/passwd">file</a>`);
}

/** 未許可の独自schemeのリンクを含み、アップロード自体が拒否されるHTML。 */
export function htmlWithCustomSchemeLink(title: string): string {
  return wrapDocument(title, `<a href="myapp://open">custom</a>`);
}

/** ページ内リンク以外の相対リンクを含み、アップロード自体が拒否されるHTML。 */
export function htmlWithRelativeLink(title: string): string {
  return wrapDocument(title, `<a href="other.html">relative</a>`);
}

/** `base href`を含み、アップロード自体が拒否されるHTML。 */
export function htmlWithBaseHref(title: string): string {
  return `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8"><title>${title}</title><base href="https://example.com/"></head><body><a href="next.html">next</a></body></html>`;
}
