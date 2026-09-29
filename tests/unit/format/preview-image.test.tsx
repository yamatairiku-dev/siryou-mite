import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { PreviewImage } from "~/lib/format/preview-image";

const DOCUMENT_ID = "11111111-1111-4111-8111-111111111111";
const READY_SRC = `/documents/${DOCUMENT_ID}/preview`;

function image(): HTMLImageElement {
  return screen.getByRole("img") as HTMLImageElement;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("PreviewImage", () => {
  it("readyは実画像、pendingは処理中画像、failedは代替画像を表示する", () => {
    const { rerender } = render(
      <PreviewImage documentId={DOCUMENT_ID} status="ready" alt="資料" />,
    );
    expect(image().getAttribute("src")).toBe(READY_SRC);

    rerender(<PreviewImage documentId={DOCUMENT_ID} status="pending" alt="資料" />);
    expect(image().getAttribute("src")).toBe("/preview-processing.svg");

    rerender(<PreviewImage documentId={DOCUMENT_ID} status="failed" alt="資料" />);
    expect(image().getAttribute("src")).toBe("/preview-fallback.svg");
  });

  it("実画像の読み込みに失敗したら代替画像へ切り替え、代替画像の失敗では差し替えを繰り返さない", () => {
    render(<PreviewImage documentId={DOCUMENT_ID} status="ready" alt="資料" />);

    fireEvent.error(image());
    expect(image().getAttribute("src")).toBe("/preview-fallback.svg");

    fireEvent.error(image());
    expect(image().getAttribute("src")).toBe("/preview-fallback.svg");
  });

  it("処理中画像で失敗したあとreadyへ変わっても、実画像を表示し、その失敗でも代替画像へ切り替える", () => {
    const { rerender } = render(
      <PreviewImage documentId={DOCUMENT_ID} status="pending" alt="資料" />,
    );
    fireEvent.error(image());
    expect(image().getAttribute("src")).toBe("/preview-fallback.svg");

    rerender(<PreviewImage documentId={DOCUMENT_ID} status="ready" alt="資料" />);
    expect(image().getAttribute("src")).toBe(READY_SRC);

    fireEvent.error(image());
    expect(image().getAttribute("src")).toBe("/preview-fallback.svg");
  });

  it("hydration前に実画像の読み込みが失敗していた場合(onError未発火)もmount時に代替画像へ切り替える", () => {
    vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(true);
    vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(0);

    render(<PreviewImage documentId={DOCUMENT_ID} status="ready" alt="資料" />);

    expect(image().getAttribute("src")).toBe("/preview-fallback.svg");
  });

  it("mount時に読み込み済みの実画像はそのまま表示する", () => {
    vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(true);
    vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(640);

    render(<PreviewImage documentId={DOCUMENT_ID} status="ready" alt="資料" />);

    expect(image().getAttribute("src")).toBe(READY_SRC);
  });

  it("固有サイズを持たないSVG(処理中画像)はmount時の判定対象にしない", () => {
    vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(true);
    vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(0);

    render(<PreviewImage documentId={DOCUMENT_ID} status="pending" alt="資料" />);

    expect(image().getAttribute("src")).toBe("/preview-processing.svg");
  });
});
