import { describe, expect, it } from "vitest";
import {
  htmlRejectionMessage,
  htmlWarningMessage,
  htmlRejectionCodes,
  htmlWarningCodes,
} from "~/lib/html/inspection-codes";
import {
  inspectHtmlUpload,
  type HtmlInspectionResult,
} from "~/lib/html/inspection.server";

const limits = { maxBytes: 10 * 1024 * 1024 };

function inspect(html: string, fileName = "資料.html"): HtmlInspectionResult {
  return inspectHtmlUpload(
    { fileName, bytes: new TextEncoder().encode(html) },
    limits,
  );
}

/** `<body>`に断片を差し込んだ最小の文書を作る。 */
function documentWith(bodyHtml: string): string {
  return `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8"><title>資料</title></head><body>${bodyHtml}</body></html>`;
}

describe("基本条件の検証(設計 §6.1)", () => {
  it("自己完結した最小のHTMLを受け入れる", () => {
    const result = inspect(documentWith("<p>こんにちは</p>"));

    expect(result.accepted).toBe(true);
    expect(result.rejectionCodes).toEqual([]);
    expect(result.warningCodes).toEqual([]);
    expect(result.title).toBe("資料");
    expect(result.displayFileName).toBe("資料.html");
  });

  it("拡張子が`.html`と`.htm`のときだけ受け入れる", () => {
    expect(inspect("<p>a</p>", "a.html").accepted).toBe(true);
    expect(inspect("<p>a</p>", "a.htm").accepted).toBe(true);
    expect(inspect("<p>a</p>", "a.HTML").accepted).toBe(true);
    expect(inspect("<p>a</p>", "a.HtM").accepted).toBe(true);

    for (const fileName of ["a.txt", "a.html.exe", "a.xhtml", "a.htmlx", "a"]) {
      expect(inspect("<p>a</p>", fileName).rejectionCodes).toEqual([
        "invalid_file_extension",
      ]);
    }
  });

  it("ファイル名の制御文字とパス区切りを拒否する", () => {
    for (const fileName of [
      "  ",
      "a\u0000.html",
      "a\n.html",
      "a\u007f.html",
      "../../etc/passwd.html",
      "dir\\a.html",
    ]) {
      expect(inspect("<p>a</p>", fileName).rejectionCodes).toEqual([
        "invalid_file_name",
      ]);
    }
  });

  it("ファイル名の長さ上限を超えたら拒否する", () => {
    const fileName = `${"あ".repeat(300)}.html`;

    expect(inspect("<p>a</p>", fileName).rejectionCodes).toEqual([
      "file_name_too_long",
    ]);
    expect(
      inspectHtmlUpload(
        { fileName, bytes: new TextEncoder().encode("<p>a</p>") },
        { ...limits, maxFileNameLength: 400 },
      ).accepted,
    ).toBe(true);
  });

  it("ファイル名はHTMLとして解釈せず、そのまま表示用文字列として返す", () => {
    const result = inspect(documentWith("<p>a</p>"), "<img onerror=alert(1)>.html");

    expect(result.accepted).toBe(true);
    expect(result.displayFileName).toBe("<img onerror=alert(1)>.html");
    expect(result.warningCodes).toEqual([]);
  });

  it("空ファイルを拒否する", () => {
    const result = inspectHtmlUpload(
      { fileName: "a.html", bytes: new Uint8Array(0) },
      limits,
    );

    expect(result.rejectionCodes).toEqual(["empty_file"]);
    expect(result.byteSize).toBe(0);
  });

  it("BOMだけのファイルを空ファイルとして拒否する", () => {
    const result = inspectHtmlUpload(
      { fileName: "a.html", bytes: new Uint8Array([0xef, 0xbb, 0xbf]) },
      limits,
    );

    expect(result.rejectionCodes).toEqual(["empty_file"]);
  });

  it("BOM付きのUTF-8を受け入れる", () => {
    const bytes = new Uint8Array([
      0xef,
      0xbb,
      0xbf,
      ...new TextEncoder().encode(documentWith("<p>あ</p>")),
    ]);

    const result = inspectHtmlUpload({ fileName: "a.html", bytes }, limits);

    expect(result.accepted).toBe(true);
    expect(result.title).toBe("資料");
  });

  it("上限を超えるサイズを拒否し、HTMLを解析しない", () => {
    const html = documentWith('<a href="relative.html">x</a>');
    const result = inspectHtmlUpload(
      { fileName: "a.html", bytes: new TextEncoder().encode(html) },
      { maxBytes: 10 },
    );

    // サイズ超過で確定した時点で解析しないため、リンクの拒否理由は付かない。
    expect(result.rejectionCodes).toEqual(["file_too_large"]);
    expect(result.byteSize).toBe(new TextEncoder().encode(html).byteLength);
  });

  it("上限ちょうどのサイズは受け入れる", () => {
    const bytes = new TextEncoder().encode("<p>abcdefg</p>");

    expect(
      inspectHtmlUpload(
        { fileName: "a.html", bytes },
        { maxBytes: bytes.byteLength },
      ).accepted,
    ).toBe(true);
    expect(
      inspectHtmlUpload(
        { fileName: "a.html", bytes },
        { maxBytes: bytes.byteLength - 1 },
      ).rejectionCodes,
    ).toEqual(["file_too_large"]);
  });

  it("UTF-8として読み取れないbyte列を拒否する", () => {
    for (const invalid of [
      [0x3c, 0x70, 0x3e, 0xff, 0xfe], // UTF-16 BOM
      [0x3c, 0x70, 0x3e, 0x82, 0xa0], // Shift_JISの「あ」
      [0xc3], // 途中で切れた2byte文字
      [0xed, 0xa0, 0x80], // surrogate
    ]) {
      const result = inspectHtmlUpload(
        { fileName: "a.html", bytes: new Uint8Array(invalid) },
        limits,
      );

      expect(result.rejectionCodes).toEqual(["invalid_utf8"]);
    }
  });

  it("`title`は空白を正規化して長さを制限する", () => {
    const longTitle = "あ".repeat(500);
    const result = inspect(
      `<html><head><title>  資料\n  タイトル  </title></head><body></body></html>`,
    );

    expect(result.title).toBe("資料 タイトル");
    expect(inspect(`<title>${longTitle}</title>`).title).toHaveLength(200);
    expect(inspect("<p>本文だけ</p>").title).toBeNull();
    expect(inspect("<title>   </title>").title).toBeNull();
  });

  it("`title`が複数あるときは文書順で最初のものを採る", () => {
    const result = inspect(
      "<html><head><title>A</title><title>B</title></head><body></body></html>",
    );

    expect(result.title).toBe("A");
  });
});

describe("URLのscheme正規化と許可・拒否(設計 §6.3)", () => {
  it("絶対URLの`http:`・`https:`と同一ページ内リンクを許可する", () => {
    const result = inspect(
      documentWith(
        [
          '<a href="https://example.com/a">https</a>',
          '<a href="http://example.com/a">http</a>',
          '<a href="HTTPS://EXAMPLE.COM/A">大文字</a>',
          '<a href="#section">ページ内</a>',
          '<a href="#">先頭へ</a>',
          '<a href="https://example.com/a" target="_blank">新しいタブ</a>',
        ].join(""),
      ),
    );

    expect(result.accepted).toBe(true);
    expect(result.rejectionCodes).toEqual([]);
    expect(result.warningCodes).toEqual([]);
  });

  it("ページ内リンク以外の相対リンクを拒否する", () => {
    for (const href of [
      "next.html",
      "./next.html",
      "../next.html",
      "/next.html",
      "//example.com/next.html",
      "?page=2",
      "",
      "   ",
    ]) {
      expect(inspect(documentWith(`<a href="${href}">x</a>`)).rejectionCodes).toEqual(
        ["relative_link"],
      );
    }
  });

  it("`data:`、`file:`、その他のschemeのリンクを拒否する", () => {
    for (const href of [
      "data:text/html,&lt;p&gt;x&lt;/p&gt;",
      "file:///etc/passwd",
      "mailto:user@example.com",
      "ftp://example.com/a",
      "ms-msdt:/id",
      "vbscript:msgbox(1)",
      "blob:https://example.com/abc",
    ]) {
      const result = inspect(documentWith(`<a href="${href}">x</a>`));

      expect(result.accepted).toBe(false);
      expect(result.rejectionCodes).toEqual(["forbidden_link_scheme"]);
    }
  });

  it("`javascript:`リンクは受け付けて警告にする", () => {
    const result = inspect(
      documentWith('<a href="javascript:alert(1)">クリック</a>'),
    );

    expect(result.accepted).toBe(true);
    expect(result.rejectionCodes).toEqual([]);
    expect(result.warningCodes).toEqual(["javascript_url"]);
  });

  it("`form action`と`formaction`にも同じリンク規則を適用する", () => {
    expect(
      inspect(documentWith('<form action="https://example.com/post"></form>'))
        .rejectionCodes,
    ).toEqual([]);
    expect(
      inspect(documentWith('<form action="/post"></form>')).rejectionCodes,
    ).toEqual(["relative_link"]);
    expect(
      inspect(
        documentWith(
          '<form><button formaction="data:text/plain,x">送信</button></form>',
        ),
      ).rejectionCodes,
    ).toEqual(["forbidden_link_scheme"]);
  });

  it("SVGの`a`はリンク、`use`・`image`はresourceとして判定する", () => {
    expect(
      inspect(
        documentWith(
          '<svg><a href="https://example.com/a"><use href="#icon"/></a></svg>',
        ),
      ).accepted,
    ).toBe(true);
    expect(
      inspect(documentWith('<svg><a href="dir/a.html">x</a></svg>'))
        .rejectionCodes,
    ).toEqual(["relative_link"]);
    expect(
      inspect(
        documentWith('<svg><use xlink:href="https://example.com/i.svg#a"/></svg>'),
      ).rejectionCodes,
    ).toEqual(["external_resource"]);
  });
});

describe("`meta refresh`と`base href`の拒否(設計 §6.3)", () => {
  it("`meta refresh`を拒否する", () => {
    for (const meta of [
      '<meta http-equiv="refresh" content="0;url=https://example.com/">',
      '<meta http-equiv="REFRESH" content="5">',
      '<meta http-equiv=" Refresh " content="0">',
      '<meta http-equiv="refresh">',
    ]) {
      expect(inspect(`<html><head>${meta}</head><body></body></html>`).rejectionCodes)
        .toEqual(["meta_refresh"]);
    }
  });

  it("`meta refresh`以外の`meta`は受け入れる", () => {
    expect(
      inspect(
        '<html><head><meta charset="utf-8"><meta name="refresh" content="0"><meta http-equiv="content-language" content="ja"></head><body></body></html>',
      ).accepted,
    ).toBe(true);
  });

  it("`base href`を拒否し、`href`の無い`base`は受け入れる", () => {
    expect(
      inspect('<html><head><base href="https://example.com/"></head><body></body></html>')
        .rejectionCodes,
    ).toEqual(["base_href"]);
    expect(
      inspect('<html><head><base href=""></head><body></body></html>').rejectionCodes,
    ).toEqual(["base_href"]);

    const targetOnly = inspect(
      '<html><head><base target="_blank"></head><body></body></html>',
    );
    expect(targetOnly.accepted).toBe(true);
  });
});

describe("外部resourceの拒否(設計 §6.2)", () => {
  it("属性で検出できる外部resource参照を拒否する", () => {
    const externalSamples = [
      '<img src="https://example.com/a.png">',
      '<img src="/a.png">',
      '<img src="a.png">',
      '<img srcset="a.png 1x, https://example.com/b.png 2x">',
      '<picture><source srcset="//example.com/a.webp"></picture>',
      '<video src="https://example.com/a.mp4" poster="https://example.com/p.jpg"></video>',
      '<video poster="p.jpg"></video>',
      '<audio src="https://example.com/a.mp3"></audio>',
      '<video><track src="captions.vtt"></video>',
      '<script src="https://example.com/a.js"></script>',
      '<link rel="stylesheet" href="https://example.com/a.css">',
      '<link rel="preload" as="font" href="font.woff2" imagesrcset="x.png 1x">',
      '<iframe src="https://example.com/"></iframe>',
      '<object data="https://example.com/a.pdf"></object>',
      '<embed src="https://example.com/a.swf">',
      '<input type="image" src="https://example.com/b.png">',
      '<body background="bg.png">',
      '<table background="https://example.com/bg.png"></table>',
      '<svg><image href="https://example.com/a.png"/></svg>',
      '<a href="https://example.com/" ping="https://tracker.example.com/p">x</a>',
      '<my-widget src="https://example.com/a.json"></my-widget>',
    ];

    for (const sample of externalSamples) {
      const result = inspect(documentWith(sample));

      expect(result.accepted).toBe(false);
      expect(result.rejectionCodes).toContain("external_resource");
    }
  });

  it("`noscript`の中の外部resourceも検出する", () => {
    expect(
      inspect(documentWith('<noscript><img src="https://example.com/a.png"></noscript>'))
        .rejectionCodes,
    ).toEqual(["external_resource"]);
  });

  it("`template`の中の外部resourceも検出する", () => {
    expect(
      inspect(documentWith('<template><img src="https://example.com/a.png"></template>'))
        .rejectionCodes,
    ).toEqual(["external_resource"]);
  });

  it("`iframe srcdoc`の中身も検査する", () => {
    const result = inspect(
      documentWith('<iframe srcdoc="&lt;img src=&quot;https://example.com/a.png&quot;&gt;"></iframe>'),
    );

    expect(result.rejectionCodes).toEqual(["external_resource"]);
    // `srcdoc`の中身はDOCTYPEの無い文書として解析されるため構文警告が付く。
    expect(result.warningCodes).toContain("embedded_content");
  });

  it("`srcdoc`が多数あってもそれぞれ検査する", () => {
    const iframes = `${'<iframe srcdoc="&lt;p&gt;安全&lt;/p&gt;"></iframe>'.repeat(30)}<iframe srcdoc="&lt;img src=&quot;https://example.com/a.png&quot;&gt;"></iframe>`;

    expect(inspect(documentWith(iframes)).rejectionCodes).toEqual([
      "external_resource",
    ]);
  });

  it("`srcdoc`の中の`srcdoc`も検査する", () => {
    const inner = '<iframe srcdoc="&amp;lt;img src=&amp;quot;https://example.com/a.png&amp;quot;&amp;gt;"></iframe>';
    const result = inspect(documentWith(`<iframe srcdoc="${inner}"></iframe>`));

    expect(result.rejectionCodes).toEqual(["external_resource"]);
  });

  it("CSSの`url()`と`@import`の外部参照を拒否する", () => {
    for (const sample of [
      '<style>body { background: url(https://example.com/bg.png); }</style>',
      "<style>@import url('https://example.com/a.css');</style>",
      '<style>@import "theme.css";</style>',
      '<div style="background-image:url(&quot;../bg.png&quot;)"></div>',
      '<svg><style>text { fill: url(https://example.com/p.svg#g); }</style></svg>',
    ]) {
      expect(inspect(documentWith(sample)).rejectionCodes).toEqual([
        "external_resource",
      ]);
    }
  });

  it("Data URLと同一文書内参照の自己完結HTMLは受け入れる", () => {
    const result = inspect(
      documentWith(
        [
          '<img src="data:image/png;base64,iVBORw0KGgo=">',
          '<img srcset="data:image/png;base64,iVBORw0KGgo= 1x, data:image/gif;base64,R0lGOD 2x">',
          '<style>@font-face { src: url(data:font/woff2;base64,AAAA); }</style>',
          '<div style="background:url(data:image/png;base64,iVBORw0KGgo=)"></div>',
          '<svg><use href="#icon"/></svg>',
          '<img src="">',
        ].join(""),
      ),
    );

    expect(result.rejectionCodes).toEqual([]);
    expect(result.accepted).toBe(true);
  });
});

describe("表示時に無効化される機能の警告(設計 §6.2, §5.3)", () => {
  it("scriptを警告にする(拒否しない)", () => {
    const result = inspect(documentWith("<script>window.alert(1)</script>"));

    expect(result.accepted).toBe(true);
    expect(result.warningCodes).toEqual(["script"]);
  });

  it("inline event handlerを警告にする", () => {
    const result = inspect(
      documentWith('<div onclick="alert(1)" ONMOUSEOVER="alert(2)">x</div>'),
    );

    expect(result.accepted).toBe(true);
    expect(result.warningCodes).toEqual(["inline_event_handler"]);
  });

  it("フォームとダウンロードを警告にする", () => {
    const result = inspect(
      documentWith(
        '<form action="https://example.com/p"><input name="q"></form><a href="https://example.com/f.zip" download>取得</a>',
      ),
    );

    expect(result.accepted).toBe(true);
    expect(result.warningCodes).toEqual(["form_submission", "download_link"]);
  });

  it("外部resourceを持たない`iframe`は警告だけで受け入れる", () => {
    const result = inspect(documentWith('<iframe src="about:blank"></iframe>'));

    expect(result.accepted).toBe(true);
    expect(result.warningCodes).toEqual(["embedded_content"]);
  });

  it("`target=_top`・`_parent`を警告にする", () => {
    const result = inspect(
      documentWith(
        '<a href="https://example.com/a" target="_TOP">x</a><a href="https://example.com/b" target="_parent">y</a>',
      ),
    );

    expect(result.accepted).toBe(true);
    expect(result.warningCodes).toEqual(["frame_navigation_disabled"]);
  });

  it("HTML構文誤りは警告にする(拒否しない)", () => {
    const result = inspect("<p>閉じていない<div>入れ子</p></div>");

    expect(result.accepted).toBe(true);
    expect(result.warningCodes).toEqual(["html_syntax_error"]);
  });

  it("同じ警告は重複させず、コード定義順で返す", () => {
    const result = inspect(
      documentWith(
        '<script>1</script><script>2</script><form></form><a href="javascript:void(0)" download>x</a>',
      ),
    );

    expect(result.warningCodes).toEqual([
      "script",
      "javascript_url",
      "form_submission",
      "download_link",
    ]);
  });
});

describe("攻撃者視点の入力", () => {
  it("文字参照でschemeを偽装しても判定を変えられない", () => {
    // `parse5`が属性値の文字参照を復号するため、二重復号せずに判定できる。
    expect(
      inspect(documentWith('<a href="&#106;avascript:alert(1)">x</a>'))
        .warningCodes,
    ).toEqual(["javascript_url"]);
    expect(
      inspect(documentWith('<a href="&#100;ata:text/html,x">x</a>')).rejectionCodes,
    ).toEqual(["forbidden_link_scheme"]);
    expect(
      inspect(documentWith('<img src="&#104;ttps://example.com/a.png">'))
        .rejectionCodes,
    ).toEqual(["external_resource"]);
  });

  it("大文字小文字・前後空白・制御文字でschemeを偽装しても判定を変えられない", () => {
    expect(
      inspect(documentWith('<a href="  JaVaScRiPt:alert(1)  ">x</a>')).warningCodes,
    ).toEqual(["javascript_url"]);
    expect(
      inspect(documentWith('<a href="java&#9;script:alert(1)">x</a>')).warningCodes,
    ).toEqual(["javascript_url"]);
    expect(
      inspect(documentWith('<a href="&#1;DATA:text/html,x">x</a>')).rejectionCodes,
    ).toEqual(["forbidden_link_scheme"]);
    expect(
      inspect(documentWith('<a href="da&#10;ta:text/html,x">x</a>')).rejectionCodes,
    ).toEqual(["forbidden_link_scheme"]);
    // NUL文字参照はHTML標準どおりU+FFFDへ置き換わるため、`file:`のscheme名にならない。
    // ブラウザも相対URLとして扱うが、相対リンクとして拒否する。
    expect(
      inspect(documentWith('<a href="&#0;&#32;file:///etc/passwd">x</a>'))
        .rejectionCodes,
    ).toEqual(["relative_link"]);
  });

  it("protocol-relative URLを絶対URLとして扱わない", () => {
    expect(
      inspect(documentWith('<a href="//example.com/x">x</a>')).rejectionCodes,
    ).toEqual(["relative_link"]);
    expect(
      inspect(documentWith('<img src="//example.com/a.png">')).rejectionCodes,
    ).toEqual(["external_resource"]);
  });

  it("`#`で始まらない同名ページ内風のリンクを許可しない", () => {
    expect(
      inspect(documentWith('<a href="index.html#section">x</a>')).rejectionCodes,
    ).toEqual(["relative_link"]);
  });

  it("上限までの入れ子は検査でき、深い部分の外部resourceも検出する", () => {
    const depth = 400;
    const html = `${"<div>".repeat(depth)}<img src="https://example.com/a.png">${"</div>".repeat(depth)}`;

    expect(inspect(html).rejectionCodes).toContain("external_resource");
  });

  it("極端に深い入れ子は解析を打ち切って拒否する(解析時間の爆発を防ぐ)", () => {
    // 上限を設けない場合、`parse5`の終了タグ処理が深さに対して二次的に増え、
    // 数MBの`<div>`の羅列だけで検査が終わらなくなる。
    const html = `${"<div>".repeat(200_000)}x${"</div>".repeat(200_000)}`;
    const startedAt = Date.now();

    const result = inspect(html);

    expect(result.rejectionCodes).toEqual(["excessive_complexity"]);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  it("終了タグの無い深い入れ子も打ち切る", () => {
    const result = inspect("<div>".repeat(200_000));

    expect(result.rejectionCodes).toEqual(["excessive_complexity"]);
  });

  it("要素数が多すぎるHTMLは解析を打ち切って拒否する", () => {
    const html = documentWith("<p>x</p>".repeat(200_000));

    expect(
      inspectHtmlUpload(
        { fileName: "a.html", bytes: new TextEncoder().encode(html) },
        { ...limits, maxElementCount: 1_000 },
      ).rejectionCodes,
    ).toEqual(["excessive_complexity"]);
  });

  it("入れ子の上限は引数で変更できる", () => {
    const html = `${"<div>".repeat(50)}x${"</div>".repeat(50)}`;

    expect(
      inspectHtmlUpload(
        { fileName: "a.html", bytes: new TextEncoder().encode(html) },
        { ...limits, maxNestingDepth: 10 },
      ).rejectionCodes,
    ).toEqual(["excessive_complexity"]);
    expect(
      inspectHtmlUpload(
        { fileName: "a.html", bytes: new TextEncoder().encode(html) },
        { ...limits, maxNestingDepth: 100 },
      ).accepted,
    ).toBe(true);
  });

  it("`srcdoc`が大量にあっても例外を投げずに検査を終える", () => {
    const html = documentWith(
      '<iframe srcdoc="&lt;p&gt;x&lt;/p&gt;"></iframe>'.repeat(10_000),
    );
    const startedAt = Date.now();

    const result = inspect(html);

    expect(result.rejectionCodes).toEqual([]);
    expect(result.warningCodes).toContain("embedded_content");
    expect(Date.now() - startedAt).toBeLessThan(10_000);
  });

  it("壊れたCSSでも実用的な時間で検査できる", () => {
    const html = documentWith(
      `<style>url(${" ".repeat(200_000)}@import ${" ".repeat(200_000)}</style>`,
    );
    const startedAt = Date.now();

    const result = inspect(html);

    expect(result.accepted).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  it("深さの浅い巨大なHTMLを実用的な時間で検査できる", () => {
    const sawtooth = `${"<div>".repeat(400)}${"</div>".repeat(400)}`;
    const html = documentWith(sawtooth.repeat(200));
    const startedAt = Date.now();

    const result = inspect(html);

    expect(result.accepted).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(10_000);
  });

  it("要素数の多いHTMLを実用的な時間で検査できる", () => {
    const html = documentWith(
      '<a href="https://example.com/a">x</a>'.repeat(50_000),
    );
    const startedAt = Date.now();

    const result = inspect(html);

    expect(result.accepted).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(10_000);
  });
});

describe("検査をすり抜けやすい書き方", () => {
  it("`foreignObject`の中のHTMLリンクも検査する", () => {
    expect(
      inspect(
        documentWith('<svg><foreignObject><a href="x.html">x</a></foreignObject></svg>'),
      ).rejectionCodes,
    ).toEqual(["relative_link"]);
  });

  it("引用符の無い大文字の`meta refresh`も拒否する", () => {
    expect(
      inspect(documentWith("<META HTTP-EQUIV=REFRESH CONTENT=0>")).rejectionCodes,
    ).toEqual(["meta_refresh"]);
  });

  it("名前付き文字参照でschemeを分割しても判定を変えられない", () => {
    expect(
      inspect(documentWith("<a href=javascript&colon;alert(1)>x</a>")).warningCodes,
    ).toEqual(["javascript_url"]);
    expect(
      inspect(documentWith('<a href="&Tab;data:text/html,x">x</a>')).rejectionCodes,
    ).toEqual(["forbidden_link_scheme"]);
  });

  it("`area`、`input formaction`、`html manifest`も検査する", () => {
    expect(
      inspect(documentWith('<map><area href="next.html"></map>')).rejectionCodes,
    ).toEqual(["relative_link"]);
    expect(
      inspect(documentWith('<input formaction="//example.com/p">')).rejectionCodes,
    ).toEqual(["relative_link"]);
    expect(
      inspect('<html manifest="app.manifest"><body>x</body></html>').rejectionCodes,
    ).toEqual(["external_resource"]);
  });

  it("tableの外へ移動される要素(foster parenting)も検査する", () => {
    expect(
      inspect(documentWith('<table><img src="https://example.com/a.png"></table>'))
        .rejectionCodes,
    ).toContain("external_resource");
  });

  it("`srcset`の末尾コンマや記述子の省略でも候補を取りこぼさない", () => {
    expect(
      inspect(
        documentWith('<img srcset=" data:image/png;base64,AAAA, https://example.com/b.png, ">'),
      ).rejectionCodes,
    ).toEqual(["external_resource"]);
  });

  it("`object`の`codebase`・`archive`も検査する", () => {
    expect(
      inspect(
        documentWith(
          '<object codebase="https://example.com/" archive="a.jar b.jar"></object>',
        ),
      ).rejectionCodes,
    ).toEqual(["external_resource"]);
  });

  it("resource属性の`javascript:`は警告として受け付ける", () => {
    const result = inspect(documentWith('<img src="javascript:alert(1)">'));

    expect(result.accepted).toBe(true);
    expect(result.warningCodes).toEqual(["javascript_url"]);
  });

  it("`srcdoc`の段数上限を超えた中身は検査しない(CSPとsandboxに委ねる)", () => {
    const escapeAttribute = (value: string) =>
      value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    const nest = (levels: number) => {
      let html = '<img src="https://example.com/a.png">';
      for (let level = 0; level < levels; level += 1) {
        html = `<iframe srcdoc="${escapeAttribute(html)}"></iframe>`;
      }
      return documentWith(html);
    };

    expect(inspect(nest(5)).rejectionCodes).toEqual(["external_resource"]);
    expect(inspect(nest(7)).rejectionCodes).toEqual([]);
  });

  it("SVGの`xlink:href`による外部resourceも検出する", () => {
    expect(
      inspect(documentWith('<svg><animate xlink:href="https://example.com/a.svg"/></svg>'))
        .rejectionCodes,
    ).toEqual(["external_resource"]);
  });
});

describe("HTMLを書き換えないこと(設計 §6.2, §18.1)", () => {
  it("入力byte列を変更せず、HTMLを返さない", () => {
    const html = documentWith(
      '<a href="https://example.com/a">外部</a><a href="http://example.com/b">平文</a><a href="#top">ページ内</a>',
    );
    const bytes = new TextEncoder().encode(html);
    const copy = Uint8Array.from(bytes);

    const result = inspectHtmlUpload({ fileName: "a.html", bytes }, limits);

    expect(result.accepted).toBe(true);
    expect(Array.from(bytes)).toEqual(Array.from(copy));
    expect(Object.keys(result).sort()).toEqual([
      "accepted",
      "byteSize",
      "displayFileName",
      "rejectionCodes",
      "title",
      "warningCodes",
    ]);
  });
});

describe("結果コードと利用者向けメッセージ", () => {
  it("すべてのコードに短い日本語メッセージがある", () => {
    for (const code of htmlRejectionCodes) {
      expect(htmlRejectionMessage(code).length).toBeGreaterThan(0);
      expect(code.length).toBeLessThanOrEqual(100);
    }
    for (const code of htmlWarningCodes) {
      expect(htmlWarningMessage(code).length).toBeGreaterThan(0);
      expect(code.length).toBeLessThanOrEqual(100);
    }
  });

  it("拒否時は表示用ファイル名を返さない", () => {
    const result = inspect(documentWith('<a href="next.html">x</a>'));

    expect(result.accepted).toBe(false);
    expect(result.displayFileName).toBeNull();
  });

  it("複数の拒否理由をコード定義順で重複なく返す", () => {
    const result = inspect(
      documentWith(
        '<base href="https://example.com/"><a href="next.html">x</a><a href="data:text/html,x">y</a><img src="https://example.com/a.png"><a href="other.html">z</a>',
      ),
      "a.txt",
    );

    expect(result.rejectionCodes).toEqual([
      "invalid_file_extension",
      "base_href",
      "relative_link",
      "forbidden_link_scheme",
      "external_resource",
    ]);
  });

  it("上限値が不正な場合はプログラム上の誤りとして例外にする", () => {
    expect(() =>
      inspectHtmlUpload(
        { fileName: "a.html", bytes: new TextEncoder().encode("<p>a</p>") },
        { maxBytes: 0 },
      ),
    ).toThrow();
  });
});
