import { useEffect, useRef, useState } from "react";
import type { PreviewStatus } from "~/lib/db/documents.server";
import {
  PREVIEW_FALLBACK_IMAGE_SRC,
  previewImageRoute,
  previewImageSrc,
} from "~/lib/format/document-view";

type PreviewImageProps = {
  documentId: string;
  status: PreviewStatus | null;
  alt: string;
  className?: string;
};

/**
 * 資料カードのプレビュー画像(設計 §5.2, §5.3)。
 *
 * `ready`の実画像の取得に失敗した場合(削除直後・Blob取得失敗の404/503など)は、
 * 壊れた画像ではなく共通の代替画像を表示する。失敗の記録は失敗した`src`に
 * ひも付けるため、ポーリングで状態が変わって`src`が変われば記録は自然に無効になる。
 */
export function PreviewImage({
  documentId,
  status,
  alt,
  className,
}: PreviewImageProps) {
  const src = previewImageSrc(documentId, status);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const imageRef = useRef<HTMLImageElement>(null);

  // SSRで描いた<img>がhydrationより前に読み込みに失敗していると、Reactの
  // onErrorは発火しない。mount時に実画像の読み込み結果を1回だけ確かめる。
  // 静的なSVG(処理中・代替画像)は固有サイズを持たずnaturalWidthが0になり得るため、
  // 判定は実画像(JPEG)の経路に限る。
  useEffect(() => {
    const image = imageRef.current;
    if (
      image &&
      image.getAttribute("src") === previewImageRoute(documentId) &&
      image.complete &&
      image.naturalWidth === 0
    ) {
      setFailedSrc(image.getAttribute("src"));
    }
    // mount時(hydration直後)だけ確認する。以降の失敗はonErrorが拾う。
  }, []);

  const shownSrc = failedSrc === src ? PREVIEW_FALLBACK_IMAGE_SRC : src;

  return (
    <img
      ref={imageRef}
      src={shownSrc}
      onError={() => {
        // 代替画像自体の読み込み失敗で差し替えを繰り返さない。
        if (shownSrc !== PREVIEW_FALLBACK_IMAGE_SRC) {
          setFailedSrc(src);
        }
      }}
      alt={alt}
      className={className}
    />
  );
}
