/**
 * HTML受け入れ検査の結果コード(設計 §6.1, §6.2, §6.3, §10.2)。
 *
 * コードは監査・テスト・UIで使い回す安定した識別子とし、利用者向けメッセージとは
 * 分離する。`parse5`へ依存しないため、ブラウザ側の結果表示からも読み込める。
 * 値は`documents.warning_codes`(1要素100文字以内)へそのまま保存できる長さに保つ。
 */

/** 保存せずにアップロードを拒否する理由(設計 §10.2)。 */
export const htmlRejectionCodes = [
  "invalid_file_name",
  "file_name_too_long",
  "invalid_file_extension",
  "empty_file",
  "file_too_large",
  "invalid_utf8",
  "html_parse_failed",
  "excessive_complexity",
  "meta_refresh",
  "base_href",
  "relative_link",
  "forbidden_link_scheme",
  "external_resource",
] as const;

export type HtmlRejectionCode = (typeof htmlRejectionCodes)[number];

/** 受け入れるが、表示時に無効化される機能(設計 §6.2)。 */
export const htmlWarningCodes = [
  "script",
  "inline_event_handler",
  "javascript_url",
  "embedded_content",
  "form_submission",
  "download_link",
  "frame_navigation_disabled",
  "html_syntax_error",
] as const;

export type HtmlWarningCode = (typeof htmlWarningCodes)[number];

/** 拒否理由の短い日本語メッセージ(設計 §10.2)。原因のHTML断片は含めない。 */
const rejectionMessages: Record<HtmlRejectionCode, string> = {
  invalid_file_name: "ファイル名に使用できない文字が含まれています。",
  file_name_too_long: "ファイル名が長すぎます。",
  invalid_file_extension:
    "拡張子が「.html」または「.htm」のファイルをアップロードしてください。",
  empty_file: "ファイルが空です。",
  file_too_large: "ファイルサイズの上限を超えています。",
  invalid_utf8: "UTF-8として読み取れないファイルです。",
  html_parse_failed: "HTMLとして解析できないファイルです。",
  excessive_complexity:
    "要素の入れ子が深い、または要素数が多すぎるHTMLはアップロードできません。",
  meta_refresh: "自動転送(meta refresh)を含むHTMLはアップロードできません。",
  base_href: "base要素のhrefを含むHTMLはアップロードできません。",
  relative_link:
    "ページ内リンク以外の相対リンクを含むHTMLはアップロードできません。",
  forbidden_link_scheme:
    "data:、file:などのリンクを含むHTMLはアップロードできません。",
  external_resource:
    "外部の画像・CSS・font・mediaなどを読み込むHTMLはアップロードできません。",
};

/** 警告の短い日本語メッセージ(設計 §5.3)。 */
const warningMessages: Record<HtmlWarningCode, string> = {
  script: "JavaScriptは実行されません。",
  inline_event_handler: "要素に書かれたイベント処理は実行されません。",
  javascript_url: "javascript:リンクは動作しません。",
  embedded_content: "iframe、object、embedの埋め込み内容は表示されません。",
  form_submission: "フォームは送信できません。",
  download_link: "ダウンロードリンクは動作しません。",
  frame_navigation_disabled:
    "target=\"_top\"、target=\"_parent\"のリンクは同じ画面内で開きます。",
  html_syntax_error: "HTMLの構文に誤りがあり、表示が崩れる場合があります。",
};

export function htmlRejectionMessage(code: HtmlRejectionCode): string {
  return rejectionMessages[code];
}

export function htmlWarningMessage(code: HtmlWarningCode): string {
  return warningMessages[code];
}
