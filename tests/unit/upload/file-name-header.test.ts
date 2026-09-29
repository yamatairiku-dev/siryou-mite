import { describe, expect, it } from "vitest";
import { decodeFileNameHeader } from "~/lib/upload/upload-request.server";
import { encodeFileNameHeader } from "~/lib/upload/file-name-header";

/**
 * T10 単体テスト: ブラウザ側の`X-File-Name`符号化(設計 §7.1, §13)。
 * サーバー側の復号(`decodeFileNameHeader`)と往復することを確認する。
 */
describe("encodeFileNameHeader", () => {
  it("UTF-8ファイル名をサーバー側の復号と往復するbase64urlへ符号化する", () => {
    const fileName = "設計資料.html";
    const encoded = encodeFileNameHeader(fileName);

    const decoded = decodeFileNameHeader(encoded);

    expect(decoded).toEqual({ ok: true, fileName });
  });

  it("paddingや+, /を含まないcanonicalなbase64urlを返す", () => {
    const encoded = encodeFileNameHeader("a very long file name that needs padding.html");

    expect(encoded).not.toMatch(/[+/=]/);
  });

  it("ASCIIファイル名も往復する", () => {
    const fileName = "report.html";
    expect(decodeFileNameHeader(encodeFileNameHeader(fileName))).toEqual({
      ok: true,
      fileName,
    });
  });
});
