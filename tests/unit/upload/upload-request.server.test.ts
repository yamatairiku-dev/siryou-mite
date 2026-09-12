import { describe, expect, it } from "vitest";
import {
  declaredContentLength,
  decodeFileNameHeader,
  isOctetStreamContentType,
  readBodyWithinLimit,
} from "~/lib/upload/upload-request.server";

/**
 * T09: `POST /documents`のheader・raw bodyの検証(設計 §7.1, §10.1(4))。
 */

describe("isOctetStreamContentType(設計 §7.1)", () => {
  it("application/octet-stream を受け付ける", () => {
    expect(isOctetStreamContentType("application/octet-stream")).toBe(true);
    expect(isOctetStreamContentType("Application/Octet-Stream")).toBe(true);
    expect(isOctetStreamContentType("application/octet-stream; charset=utf-8")).toBe(
      true,
    );
  });

  it("それ以外のContent-Typeを拒否する", () => {
    expect(isOctetStreamContentType(null)).toBe(false);
    expect(isOctetStreamContentType("")).toBe(false);
    expect(isOctetStreamContentType("text/html")).toBe(false);
    expect(isOctetStreamContentType("multipart/form-data; boundary=x")).toBe(false);
  });
});

describe("decodeFileNameHeader(設計 §7.1の`X-File-Name`)", () => {
  it("base64urlのUTF-8ファイル名を復号する", () => {
    const encoded = Buffer.from("設計資料.html", "utf8").toString("base64url");
    expect(decodeFileNameHeader(encoded)).toEqual({
      ok: true,
      fileName: "設計資料.html",
    });
  });

  it("headerが無い場合は拒否する", () => {
    expect(decodeFileNameHeader(null)).toEqual({ ok: false });
  });

  it("base64url以外の文字(標準base64のpadding・記号)を拒否する", () => {
    const standard = Buffer.from("あ".repeat(5) + ".html", "utf8").toString("base64");
    expect(standard).toMatch(/[+/=]/);
    expect(decodeFileNameHeader(standard)).toEqual({ ok: false });
    expect(decodeFileNameHeader("a.html")).toEqual({ ok: false });
    expect(decodeFileNameHeader("")).toEqual({ ok: false });
  });

  it("canonicalでないbase64url(余分な文字)を拒否する", () => {
    const encoded = Buffer.from("a.html", "utf8").toString("base64url");
    expect(decodeFileNameHeader(`${encoded}A`)).toEqual({ ok: false });
  });

  it("UTF-8として読めない値を拒否する", () => {
    const invalid = Buffer.from([0xff, 0xfe, 0x2e, 0x68]).toString("base64url");
    expect(decodeFileNameHeader(invalid)).toEqual({ ok: false });
  });

  it("長すぎるheaderを拒否する", () => {
    const encoded = Buffer.from("a".repeat(3000), "utf8").toString("base64url");
    expect(decodeFileNameHeader(encoded)).toEqual({ ok: false });
  });
});

describe("declaredContentLength(自己申告値。事前検査にだけ使う)", () => {
  function requestWith(headers: HeadersInit): Request {
    return new Request("http://localhost:3000/documents", {
      method: "POST",
      headers,
    });
  }

  it("数値として読める場合だけ返す", () => {
    expect(declaredContentLength(requestWith({ "Content-Length": "120" }))).toBe(120);
    expect(declaredContentLength(requestWith({}))).toBeNull();
    expect(declaredContentLength(requestWith({ "Content-Length": "abc" }))).toBeNull();
    expect(declaredContentLength(requestWith({ "Content-Length": "-1" }))).toBeNull();
  });
});

describe("readBodyWithinLimit(設計 §7.1「streaming中も上限超過で中止」)", () => {
  function streamOf(chunks: Uint8Array[], onPull?: () => void) {
    let index = 0;
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        onPull?.();
        if (index >= chunks.length) {
          controller.close();
          return;
        }
        controller.enqueue(chunks[index] as Uint8Array);
        index += 1;
      },
    });
  }

  it("bodyが無い場合は空のbyte列を返す", async () => {
    await expect(readBodyWithinLimit(null, 10)).resolves.toEqual({
      ok: true,
      bytes: new Uint8Array(0),
    });
  });

  it("上限以内のbodyを結合して返す", async () => {
    const stream = streamOf([new Uint8Array([1, 2]), new Uint8Array([3])]);
    const result = await readBodyWithinLimit(stream, 3);

    expect(result).toEqual({ ok: true, bytes: new Uint8Array([1, 2, 3]) });
  });

  it("上限を超えた時点で読み込みを中断する(全部読んでから判定しない)", async () => {
    let pulls = 0;
    const chunks = Array.from({ length: 100 }, () => new Uint8Array(4));
    const stream = streamOf(chunks, () => {
      pulls += 1;
    });

    const result = await readBodyWithinLimit(stream, 10);

    expect(result).toEqual({ ok: false, reason: "too_large" });
    // 上限(10byte)を超えるのは3チャンク目。残り97チャンクは読まない。
    expect(pulls).toBeLessThan(10);
  });
});
