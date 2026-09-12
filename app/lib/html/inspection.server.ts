/**
 * アップロードされたHTMLの受け入れ検査(設計 §6.1, §6.2, §6.3, §10.1(5), §10.2)。
 *
 * I/Oを持たない純粋関数として実装する。DB、Blob、環境変数へ触れず、上限値は
 * 引数で受け取る(呼び出し側が`app/lib/env.server.ts`の検証済み値を渡す)。
 * HTMLは**書き換えず**、拒否理由コードと警告コードだけを返す。
 * 例外メッセージにもHTML本文・ファイル名を含めない(設計 §9.5)。
 */
import { defaultTreeAdapter, parse } from "parse5";
import type { DefaultTreeAdapterMap, DefaultTreeAdapterTypes, TreeAdapter } from "parse5";
import { z } from "zod";
import {
  htmlRejectionCodes,
  htmlWarningCodes,
  type HtmlRejectionCode,
  type HtmlWarningCode,
} from "~/lib/html/inspection-codes";

type Node = DefaultTreeAdapterTypes.Node;
type ParentNode = DefaultTreeAdapterTypes.ParentNode;
type Element = DefaultTreeAdapterTypes.Element;

const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

/**
 * `iframe srcdoc`の中身も文書として検査する。解析量が入力サイズに比例したままに
 * なるよう、入れ子の段数と解析する合計文字数に上限を設ける。
 */
const MAX_SRCDOC_DEPTH = 5;
const MAX_SRCDOC_DOCUMENTS = 1_000;
const SRCDOC_PARSE_BUDGET_FACTOR = 3;

/**
 * 入れ子の深さの上限。`parse5`の終了タグ処理はopen element stackを走査するため、
 * 深さに対して計算量が二次的に増える。上限を設けないと数MBの`<div>`の羅列だけで
 * 検査が終わらなくなるため、ブラウザの実装上限と同程度の値で打ち切る。
 */
const DEFAULT_MAX_NESTING_DEPTH = 512;

/**
 * 解析する要素数の上限。treeはメモリ上に構築されるため、上限を設けないと
 * 上限サイズのHTMLでも要素数次第で大量のメモリを使う。
 */
const DEFAULT_MAX_ELEMENT_COUNT = 500_000;

/** 解析量の上限を超えたため解析を打ち切ったことを示す内部例外。 */
class ParseLimitExceededError extends Error {
  constructor() {
    super("HTMLの構造が複雑すぎます");
    this.name = "ParseLimitExceededError";
  }
}

/** 複数の文書(`iframe srcdoc`)にまたがって数える解析量。 */
type ParseBudget = {
  elementCount: number;
};

/**
 * 深さと要素数を数えながらtreeを組み立てるtree adapter。上限を超えた時点で
 * 解析を打ち切る。既定のtree adapterの動作自体は変えないため、判定結果は同じになる。
 */
function createLimitedTreeAdapter(
  limits: { maxNestingDepth: number; maxElementCount: number },
  budget: ParseBudget,
): TreeAdapter<DefaultTreeAdapterMap> {
  const depthByNode = new WeakMap<object, number>();

  function trackDepth(parentNode: object, newNode: object): void {
    const depth = (depthByNode.get(parentNode) ?? 0) + 1;
    if (depth > limits.maxNestingDepth) {
      throw new ParseLimitExceededError();
    }
    depthByNode.set(newNode, depth);
  }

  return {
    ...defaultTreeAdapter,
    createElement(tagName, namespaceURI, attrs) {
      budget.elementCount += 1;
      if (budget.elementCount > limits.maxElementCount) {
        throw new ParseLimitExceededError();
      }
      return defaultTreeAdapter.createElement(tagName, namespaceURI, attrs);
    },
    appendChild(parentNode, newNode) {
      trackDepth(parentNode, newNode);
      defaultTreeAdapter.appendChild(parentNode, newNode);
    },
    insertBefore(parentNode, newNode, referenceNode) {
      trackDepth(parentNode, newNode);
      defaultTreeAdapter.insertBefore(parentNode, newNode, referenceNode);
    },
    setTemplateContent(templateElement, contentElement) {
      trackDepth(templateElement, contentElement);
      defaultTreeAdapter.setTemplateContent(templateElement, contentElement);
    },
  };
}

/** `background`属性で実際に画像を読み込む要素(設計 §6.2の外部resource判定)。 */
const backgroundElements = new Set([
  "body",
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "td",
  "th",
]);

const limitsSchema = z
  .object({
    /** 設計 §6.1 の最大サイズ。`MAX_HTML_UPLOAD_BYTES`を渡す想定。 */
    maxBytes: z.number().int().positive(),
    /** 表示用文字列としてのファイル名の長さ上限(設計 §6.1)。 */
    maxFileNameLength: z.number().int().positive().max(1000).default(255),
    /** 表示用文字列としての`title`の長さ上限(設計 §6.1)。 */
    maxTitleLength: z.number().int().positive().max(1000).default(200),
    /** 解析を打ち切る入れ子の深さ(設計に規定は無く、DoS対策の実装上の上限)。 */
    maxNestingDepth: z
      .number()
      .int()
      .positive()
      .max(10_000)
      .default(DEFAULT_MAX_NESTING_DEPTH),
    /** 解析を打ち切る要素数(設計に規定は無く、DoS対策の実装上の上限)。 */
    maxElementCount: z
      .number()
      .int()
      .positive()
      .max(5_000_000)
      .default(DEFAULT_MAX_ELEMENT_COUNT),
  })
  .strict();

export type HtmlInspectionLimits = z.input<typeof limitsSchema>;

export type HtmlInspectionInput = {
  /** `X-File-Name`から取り出した申告ファイル名。内容は信用しない(設計 §6.1)。 */
  fileName: string;
  /** アップロードされたbyte列。検査中に書き換えない。 */
  bytes: Uint8Array;
};

export type HtmlInspectionResult = {
  /** 拒否理由が1つも無い場合だけ`true`。 */
  accepted: boolean;
  rejectionCodes: HtmlRejectionCode[];
  warningCodes: HtmlWarningCode[];
  /** 長さ・文字種を検査済みの表示用ファイル名。拒否時は`null`。 */
  displayFileName: string | null;
  /** 表示用に空白を正規化し、長さを制限した`title`。無い場合は`null`。 */
  title: string | null;
  byteSize: number;
};

/** 検出結果の集約。コードは重複させず、定義順で返す。 */
class Findings {
  private readonly rejections = new Set<HtmlRejectionCode>();
  private readonly warnings = new Set<HtmlWarningCode>();

  reject(code: HtmlRejectionCode): void {
    this.rejections.add(code);
  }

  warn(code: HtmlWarningCode): void {
    this.warnings.add(code);
  }

  rejectionList(): HtmlRejectionCode[] {
    return htmlRejectionCodes.filter((code) => this.rejections.has(code));
  }

  warningList(): HtmlWarningCode[] {
    return htmlWarningCodes.filter((code) => this.warnings.has(code));
  }
}

/**
 * HTMLのURL属性値をブラウザと同じ前処理で正規化する。
 * 前後のC0制御文字・空白を取り除き、内部のtab・改行を取り除く(URL Standard)。
 * 文字参照は`parse5`が復号済みのため、ここでは復号しない(二重復号を避ける)。
 */
function normalizeUrlValue(value: string): string {
  let start = 0;
  let end = value.length;

  while (start < end && value.charCodeAt(start) <= 0x20) {
    start += 1;
  }
  while (end > start && value.charCodeAt(end - 1) <= 0x20) {
    end -= 1;
  }

  return value.slice(start, end).replace(/[\t\n\r]/g, "");
}

type ClassifiedUrl =
  | { kind: "empty" }
  | { kind: "fragment" }
  | { kind: "relative" }
  | { kind: "absolute"; protocol: string; normalized: string };

/**
 * 標準のURLパーサーでscheme名を判定する。scheme名の大文字小文字、前後の空白、
 * 制御文字は`URL`と`normalizeUrlValue`が正規化するため、`JaVaScRiPt:`や
 * `da<tab>ta:`のような偽装では判定を変えられない(設計 §6.3)。
 */
function classifyUrl(rawValue: string): ClassifiedUrl {
  const value = normalizeUrlValue(rawValue);

  if (value === "") {
    return { kind: "empty" };
  }
  if (value.startsWith("#")) {
    return { kind: "fragment" };
  }

  try {
    // 相対URLは基準URLを渡さないと解析に失敗する。この失敗を相対参照の判定に使う
    // (`//example.com/x`のようなprotocol-relative URLもここで相対と判定される)。
    const url = new URL(value);
    return { kind: "absolute", protocol: url.protocol, normalized: value };
  } catch {
    return { kind: "relative" };
  }
}

/** 空白・コンマ区切りのURLリスト(`ping`、`archive`)を分解する。 */
function splitUrlList(value: string): string[] {
  return value.split(/[\s,]+/).filter((item) => item !== "");
}

/**
 * `srcset`の候補URLを取り出す(HTML標準の解析手順を簡略化したもの)。
 * URLは空白で区切られ、末尾のコンマで候補が終わるため、`data:`URLに含まれる
 * コンマでは分割されない。
 */
function parseSrcset(value: string): string[] {
  const urls: string[] = [];
  let position = 0;

  while (position < value.length) {
    while (position < value.length && /[\s,]/.test(value[position] ?? "")) {
      position += 1;
    }

    const start = position;
    while (position < value.length && !/\s/.test(value[position] ?? "")) {
      position += 1;
    }

    const token = value.slice(start, position);
    if (token === "") {
      continue;
    }

    const url = token.replace(/,+$/, "");
    if (url !== "") {
      urls.push(url);
    }
    if (token.endsWith(",")) {
      continue;
    }

    // 記述子(`2x`、`640w`など)は次のコンマまで読み飛ばす。
    const nextComma = value.indexOf(",", position);
    position = nextComma === -1 ? value.length : nextComma + 1;
  }

  return urls;
}

// 巨大な入力でも線形時間で走査できるよう、後戻りの起きない単純なパターンにする。
const cssUrlPattern = /url\(([^)]*)\)/gi;
const cssImportPattern = /@import\s+["']([^"']*)["']/gi;

/** 引用符と前後の空白を取り除く。 */
function unquoteCssValue(value: string): string {
  const trimmed = value.trim();
  const first = trimmed.slice(0, 1);

  if ((first === '"' || first === "'") && trimmed.endsWith(first)) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * CSS(`style`属性・`style`要素)から`url()`と`@import`の参照先を取り出す。
 * CSSのescape(`\68 ttps:`など)は復号しないが、復号しない値は相対参照として
 * 判定されるため、外部resourceの検出がすり抜けることはない。
 */
function extractCssUrls(css: string): string[] {
  const urls: string[] = [];

  for (const match of css.matchAll(cssUrlPattern)) {
    const url = unquoteCssValue(match[1] ?? "");
    if (url !== "") {
      urls.push(url);
    }
  }
  for (const match of css.matchAll(cssImportPattern)) {
    const url = (match[1] ?? "").trim();
    if (url !== "") {
      urls.push(url);
    }
  }

  return urls;
}

function isElement(node: Node): node is Element {
  return "tagName" in node && Array.isArray((node as Element).attrs);
}

function childrenOf(node: Node): Node[] {
  const children = (node as ParentNode).childNodes;
  return Array.isArray(children) ? children : [];
}

/** 子のテキストノードだけを連結する(`title`と`style`の中身を読む)。 */
function textContentOf(element: Element): string {
  return childrenOf(element)
    .map((child) =>
      "value" in child && typeof child.value === "string" ? child.value : "",
    )
    .join("");
}

function attributeValue(element: Element, name: string): string | undefined {
  return element.attrs.find((attribute) => attribute.name === name)?.value;
}

/** 検査対象の1文書。`iframe srcdoc`の中身は別文書として続けて検査する。 */
type PendingDocument = {
  html: string;
  /** 最上位は0。`iframe srcdoc`の中身は1段深い。 */
  depth: number;
};

class HtmlDocumentInspector {
  private readonly findings: Findings;
  private readonly limits: { maxNestingDepth: number; maxElementCount: number };
  private readonly budget: ParseBudget = { elementCount: 0 };
  private readonly nested: PendingDocument[] = [];
  private currentDepth = 0;
  title: string | null = null;

  constructor(
    findings: Findings,
    limits: { maxNestingDepth: number; maxElementCount: number },
  ) {
    this.findings = findings;
    this.limits = limits;
  }

  /** 文書とその`srcdoc`を順に解析する。解析できない場合は拒否する。 */
  inspect(html: string): void {
    const queue: PendingDocument[] = [{ html, depth: 0 }];
    let budget = html.length * SRCDOC_PARSE_BUDGET_FACTOR;

    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) {
        break;
      }
      if (current.depth > 0) {
        if (current.depth > MAX_SRCDOC_DEPTH || current.html.length > budget) {
          // 検査しなかった`srcdoc`の中身は表示時にCSPとsandboxで遮断される(設計 §6.2)。
          continue;
        }
        budget -= current.html.length;
      }

      let document: ParentNode;
      try {
        document = parse<DefaultTreeAdapterMap>(current.html, {
          // 表示時はsandboxでJavaScriptを無効化するため、`noscript`の中身も
          // markupとして解釈される。同じ条件で外部resourceを検出する。
          scriptingEnabled: false,
          treeAdapter: createLimitedTreeAdapter(this.limits, this.budget),
          onParseError: () => {
            // 通常のHTML構文誤りは警告(設計 §10.1(5))。位置と内容は残さない。
            this.findings.warn("html_syntax_error");
          },
        });
      } catch (error) {
        // 失敗の詳細はHTML本文を含み得るため残さない(設計 §9.5)。
        this.findings.reject(
          error instanceof ParseLimitExceededError
            ? "excessive_complexity"
            : // parserの致命的失敗は拒否する(設計 §10.1(5))。
              "html_parse_failed",
        );
        return;
      }

      this.currentDepth = current.depth;
      this.walk(document, current.depth === 0);
      // 展開(`...`)で渡すとsrcdocが多い入力でcall stackを超えるため、1件ずつ積む。
      for (const nestedDocument of this.nested.splice(0)) {
        if (queue.length >= MAX_SRCDOC_DOCUMENTS) {
          break;
        }
        queue.push(nestedDocument);
      }
    }
  }

  /** 明示的なstackで走査する(深い入れ子でも再帰しない)。 */
  private walk(root: ParentNode, isTopLevel: boolean): void {
    const stack: Node[] = [root];

    while (stack.length > 0) {
      const node = stack.pop();
      if (!node) {
        break;
      }

      if (isElement(node)) {
        this.inspectElement(node, isTopLevel);

        const content = (node as DefaultTreeAdapterTypes.Template).content;
        if (content) {
          stack.push(content);
        }
      }

      // stackはLIFOのため、文書順で処理されるよう子は逆順に積む
      // (例: `<title>A</title><title>B</title>`ではAを先に見つける必要がある)。
      const children = childrenOf(node);
      for (let i = children.length - 1; i >= 0; i -= 1) {
        stack.push(children[i] as Node);
      }
    }
  }

  private inspectElement(element: Element, isTopLevel: boolean): void {
    const tagName = element.tagName;
    const isHtmlElement = element.namespaceURI === HTML_NAMESPACE;
    const isSvgElement = element.namespaceURI === SVG_NAMESPACE;

    if (isHtmlElement) {
      switch (tagName) {
        case "meta": {
          const httpEquiv = attributeValue(element, "http-equiv");
          if (
            httpEquiv !== undefined &&
            httpEquiv.trim().toLowerCase() === "refresh"
          ) {
            this.findings.reject("meta_refresh");
          }
          break;
        }
        case "base": {
          if (attributeValue(element, "href") !== undefined) {
            this.findings.reject("base_href");
          }
          break;
        }
        case "form": {
          this.findings.warn("form_submission");
          break;
        }
        case "iframe":
        case "frame":
        case "frameset":
        case "object":
        case "embed": {
          this.findings.warn("embedded_content");
          break;
        }
        case "title": {
          if (isTopLevel && this.title === null) {
            this.title = textContentOf(element);
          }
          break;
        }
        default:
          break;
      }
    }

    if (tagName === "script") {
      // JavaScriptを含むこと自体は拒否理由ではない(設計 §6.2)。外部srcは属性側で判定する。
      this.findings.warn("script");
    }
    if (tagName === "style") {
      this.inspectCss(textContentOf(element));
    }

    for (const attribute of element.attrs) {
      this.inspectAttribute(element, attribute.name, attribute.value, {
        isHtmlElement,
        isSvgElement,
      });
    }
  }

  private inspectAttribute(
    element: Element,
    name: string,
    value: string,
    namespace: { isHtmlElement: boolean; isSvgElement: boolean },
  ): void {
    const tagName = element.tagName;

    if (/^on[a-z]+$/.test(name)) {
      this.findings.warn("inline_event_handler");
      return;
    }

    switch (name) {
      case "href": {
        if (namespace.isHtmlElement && tagName === "base") {
          return; // `base href`は要素側で拒否済み。
        }
        const isLink = namespace.isSvgElement
          ? tagName === "a"
          : !(namespace.isHtmlElement && tagName === "link");
        if (isLink) {
          this.inspectLinkUrl(value);
        } else {
          this.inspectResourceUrl(value);
        }
        return;
      }
      case "src": {
        this.inspectResourceUrl(value);
        return;
      }
      case "srcset":
      case "imagesrcset": {
        for (const url of parseSrcset(value)) {
          this.inspectResourceUrl(url);
        }
        return;
      }
      case "poster": {
        this.inspectResourceUrl(value);
        return;
      }
      case "data": {
        if (namespace.isHtmlElement && tagName === "object") {
          this.inspectResourceUrl(value);
        }
        return;
      }
      case "codebase":
      case "archive": {
        if (
          namespace.isHtmlElement &&
          (tagName === "object" || tagName === "applet")
        ) {
          for (const url of splitUrlList(value)) {
            this.inspectResourceUrl(url);
          }
        }
        return;
      }
      case "background": {
        if (namespace.isHtmlElement && backgroundElements.has(tagName)) {
          this.inspectResourceUrl(value);
        }
        return;
      }
      case "manifest": {
        if (namespace.isHtmlElement && tagName === "html") {
          this.inspectResourceUrl(value);
        }
        return;
      }
      case "ping": {
        if (namespace.isHtmlElement && (tagName === "a" || tagName === "area")) {
          for (const url of splitUrlList(value)) {
            this.inspectResourceUrl(url);
          }
        }
        return;
      }
      case "action": {
        if (namespace.isHtmlElement && tagName === "form") {
          this.inspectLinkUrl(value);
        }
        return;
      }
      case "formaction": {
        if (
          namespace.isHtmlElement &&
          (tagName === "button" || tagName === "input")
        ) {
          this.inspectLinkUrl(value);
        }
        return;
      }
      case "download": {
        if (namespace.isHtmlElement && (tagName === "a" || tagName === "area")) {
          this.findings.warn("download_link");
        }
        return;
      }
      case "target": {
        const target = value.trim().toLowerCase();
        if (target === "_top" || target === "_parent") {
          this.findings.warn("frame_navigation_disabled");
        }
        return;
      }
      case "srcdoc": {
        if (namespace.isHtmlElement && tagName === "iframe") {
          this.nested.push({ html: value, depth: this.currentDepth + 1 });
        }
        return;
      }
      case "style": {
        this.inspectCss(value);
        return;
      }
      default:
        return;
    }
  }

  private inspectCss(css: string): void {
    for (const url of extractCssUrls(css)) {
      this.inspectResourceUrl(url);
    }
  }

  /** 利用者がクリックする遷移先の判定(設計 §6.3)。 */
  private inspectLinkUrl(rawValue: string): void {
    const classified = classifyUrl(rawValue);

    switch (classified.kind) {
      case "fragment":
        return; // 同一ページ内リンクは許可し、書き換えない。
      case "empty":
      case "relative":
        this.findings.reject("relative_link");
        return;
      case "absolute": {
        if (
          classified.protocol === "https:" ||
          classified.protocol === "http:"
        ) {
          return; // 許可リストなしで許可し、書き換えない。
        }
        if (classified.protocol === "javascript:") {
          // 受け付けるが、CSPとsandboxで動作させない(設計 §6.3)。
          this.findings.warn("javascript_url");
          return;
        }
        this.findings.reject("forbidden_link_scheme");
        return;
      }
    }
  }

  /** 自動的に読み込まれる参照の判定(設計 §6.2)。自己完結HTMLを前提とする。 */
  private inspectResourceUrl(rawValue: string): void {
    const classified = classifyUrl(rawValue);

    switch (classified.kind) {
      case "empty":
        return; // 参照先が無く、外部への読み込みは発生しない。
      case "fragment":
        return; // `<use href="#id">`などの同一文書内参照。
      case "relative":
        this.findings.reject("external_resource");
        return;
      case "absolute": {
        if (classified.protocol === "data:") {
          return; // 自己完結HTMLが前提とするData URL(設計 §6.2)。
        }
        if (classified.protocol === "javascript:") {
          this.findings.warn("javascript_url");
          return;
        }
        if (classified.normalized.toLowerCase() === "about:blank") {
          return; // 空文書。外部への読み込みは発生しない。
        }
        this.findings.reject("external_resource");
        return;
      }
    }
  }
}

/** 表示用文字列として空白を正規化し、長さを制限する(HTMLとして解釈しない)。 */
function toDisplayText(value: string, maxLength: number): string | null {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized === "") {
    return null;
  }
  return Array.from(normalized).slice(0, maxLength).join("");
}

/** 拡張子・文字種・長さを検査する(設計 §6.1)。ファイル名はHTMLとして解釈しない。 */
function inspectFileName(
  fileName: string,
  limits: { maxFileNameLength: number },
  findings: Findings,
): string | null {
  const trimmed = fileName.trim();
  // 制御文字(C0とDEL)、パス区切りを含むファイル名は表示用文字列として受け付けない。
  const hasControlCharacter = Array.from(fileName).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f;
  });

  if (trimmed === "" || hasControlCharacter || /[/\\]/.test(trimmed)) {
    findings.reject("invalid_file_name");
    return null;
  }
  if (Array.from(trimmed).length > limits.maxFileNameLength) {
    findings.reject("file_name_too_long");
    return null;
  }
  if (!/\.html?$/i.test(trimmed)) {
    findings.reject("invalid_file_extension");
    return null;
  }

  return trimmed;
}

/**
 * アップロードされたHTMLを検査する。HTMLは書き換えず、拒否理由と警告だけを返す。
 * 空ファイル、サイズ超過、UTF-8不正が確定した場合はHTMLを解析しない。
 */
export function inspectHtmlUpload(
  input: HtmlInspectionInput,
  limits: HtmlInspectionLimits,
): HtmlInspectionResult {
  const parsedLimits = limitsSchema.parse(limits);
  const findings = new Findings();
  const byteSize = input.bytes.byteLength;

  const displayFileName = inspectFileName(
    input.fileName,
    parsedLimits,
    findings,
  );

  let html: string | null = null;
  if (byteSize === 0) {
    findings.reject("empty_file");
  } else if (byteSize > parsedLimits.maxBytes) {
    findings.reject("file_too_large");
  } else {
    try {
      html = new TextDecoder("utf-8", { fatal: true }).decode(input.bytes);
    } catch {
      findings.reject("invalid_utf8");
    }

    if (html === "") {
      // BOMだけのファイルなど、内容が無い場合は空ファイルとして扱う。
      findings.reject("empty_file");
      html = null;
    }
  }

  let title: string | null = null;
  if (html !== null) {
    const inspector = new HtmlDocumentInspector(findings, parsedLimits);
    inspector.inspect(html);
    title =
      inspector.title === null
        ? null
        : toDisplayText(inspector.title, parsedLimits.maxTitleLength);
  }

  const rejectionCodes = findings.rejectionList();

  return {
    accepted: rejectionCodes.length === 0,
    rejectionCodes,
    warningCodes: findings.warningList(),
    displayFileName: rejectionCodes.length === 0 ? displayFileName : null,
    title,
    byteSize,
  };
}
