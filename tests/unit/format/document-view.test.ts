import { describe, expect, it } from "vitest";
import {
  formatByteSize,
  formatJstDateTime,
  formatPreviewStatus,
  PREVIEW_FALLBACK_IMAGE_SRC,
  PREVIEW_PROCESSING_IMAGE_SRC,
  previewImageSrc,
  previewImageRoute,
  replaceWithFallbackPreview,
} from "~/lib/format/document-view";

/** T10 単体テスト: 初期画面カードの表示用フォーマット(設計 §5.2, §5.3)。 */

describe("formatJstDateTime", () => {
  it("UTCの日時を日本時間のYYYY/MM/DD HH:mm形式へ変換する", () => {
    // UTC 15:30 → JST(+9) 翌日00:30
    expect(formatJstDateTime(new Date("2026-01-02T15:30:00.000Z"))).toBe(
      "2026/01/03 00:30",
    );
  });

  it("日付を跨がない時刻もJSTへ変換する", () => {
    expect(formatJstDateTime(new Date("2026-06-15T01:00:00.000Z"))).toBe(
      "2026/06/15 10:00",
    );
  });

  it("Date以外(ISO文字列)も受け付ける", () => {
    expect(formatJstDateTime("2026-01-02T15:30:00.000Z")).toBe(
      "2026/01/03 00:30",
    );
  });
});

describe("formatByteSize", () => {
  it("1024未満はB表記", () => {
    expect(formatByteSize(512)).toBe("512 B");
  });

  it("KB単位に丸める", () => {
    expect(formatByteSize(2048)).toBe("2.0 KB");
  });

  it("MB単位に丸める", () => {
    expect(formatByteSize(5 * 1024 * 1024)).toBe("5.0 MB");
  });

  it("値が無い場合は不明と表示する", () => {
    expect(formatByteSize(null)).toBe("不明");
  });
});

describe("formatPreviewStatus", () => {
  it.each([
    ["pending", "生成中"],
    ["ready", "生成済み"],
    ["failed", "生成失敗"],
  ] as const)("%s を %s と表示する", (status, expected) => {
    expect(formatPreviewStatus(status)).toBe(expected);
  });

  it("nullは不明と表示する", () => {
    expect(formatPreviewStatus(null)).toBe("不明");
  });
});

const DOCUMENT_ID = "11111111-1111-4111-8111-111111111111";

describe("previewImageSrc", () => {
  it("生成済みは認証付きresource routeの実プレビュー画像(T23、Q-030)", () => {
    expect(previewImageSrc(DOCUMENT_ID, "ready")).toBe(
      `/documents/${DOCUMENT_ID}/preview`,
    );
  });

  it("生成中は共通の処理中画像", () => {
    expect(previewImageSrc(DOCUMENT_ID, "pending")).toBe(
      PREVIEW_PROCESSING_IMAGE_SRC,
    );
  });

  it.each(["failed", null] as const)("%s は共通の代替画像", (status) => {
    expect(previewImageSrc(DOCUMENT_ID, status)).toBe(
      PREVIEW_FALLBACK_IMAGE_SRC,
    );
  });
});

describe("previewImageRoute", () => {
  it("資料IDをpath segmentとしてエンコードする", () => {
    expect(previewImageRoute("a/b?c")).toBe("/documents/a%2Fb%3Fc/preview");
  });
});

describe("replaceWithFallbackPreview", () => {
  it("代替画像へ1回だけ切り替える", () => {
    const image = {
      dataset: {} as Record<string, string>,
      src: "/documents/x/preview",
    } as unknown as HTMLImageElement;

    replaceWithFallbackPreview(image);
    expect(image.src).toBe(PREVIEW_FALLBACK_IMAGE_SRC);

    image.src = "/other";
    replaceWithFallbackPreview(image);
    expect(image.src).toBe("/other");
  });
});
