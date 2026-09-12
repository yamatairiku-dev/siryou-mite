/**
 * 初期画面の資料カード表示用フォーマット(設計 §5.2)。
 *
 * サーバー(SSR)とブラウザの両方から呼ぶため`.server.ts`にはしない。DBや環境変数へは
 * 触れない純粋関数だけを置く。
 */
import type { PreviewStatus } from "~/lib/db/documents.server";

/**
 * 日本時間で`YYYY/MM/DD HH:mm`形式に整形する(設計 §5.2「DBにはUTCで保存する」)。
 * `Intl.DateTimeFormat`の`timeZone: "Asia/Tokyo"`を使い、依存を追加しない。
 */
export function formatJstDateTime(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  const parts = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    // `hour12: false`だけでは深夜0時が"24"になる実装があるため、0-23表記を明示する。
    hourCycle: "h23",
  }).formatToParts(date);

  const map = new Map(parts.map((part) => [part.type, part.value]));
  const year = map.get("year") ?? "----";
  const month = map.get("month") ?? "--";
  const day = map.get("day") ?? "--";
  const hour = map.get("hour") ?? "--";
  const minute = map.get("minute") ?? "--";
  return `${year}/${month}/${day} ${hour}:${minute}`;
}

const byteUnits = ["KB", "MB", "GB", "TB"] as const;

/** ファイルサイズの表示用整形。値が無い場合は「不明」とする。 */
export function formatByteSize(byteSize: number | null): string {
  if (byteSize === null || Number.isNaN(byteSize)) {
    return "不明";
  }
  if (byteSize < 1024) {
    return `${byteSize} B`;
  }

  let value = byteSize;
  let unitIndex = -1;
  do {
    value /= 1024;
    unitIndex += 1;
  } while (value >= 1024 && unitIndex < byteUnits.length - 1);

  const unit = byteUnits[unitIndex] ?? "TB";
  return `${value.toFixed(1)} ${unit}`;
}

const previewStatusLabels: Record<PreviewStatus, string> = {
  pending: "生成中",
  ready: "生成済み",
  failed: "生成失敗",
};

/** プレビュー状態の表示用ラベル(設計 §5.2, §5.3)。 */
export function formatPreviewStatus(status: PreviewStatus | null): string {
  return status === null ? "不明" : previewStatusLabels[status];
}

/** 共通の処理中画像(設計 §5.3)。実際のプレビュー画像取得はT15の範囲。 */
export const PREVIEW_PROCESSING_IMAGE_SRC = "/preview-processing.svg";
/** 共通の代替画像(生成失敗時。設計 §5.2, §5.3)。 */
export const PREVIEW_FALLBACK_IMAGE_SRC = "/preview-fallback.svg";

/**
 * カードに表示するプレビュー画像。
 *
 * 実画像の取得(`ready`状態でHTMLから生成した画像を表示する処理)はT15
 * (プレビュー状態resource route)・T18(生成ワーカー)の範囲のため、ここでは
 * 「生成中」と「それ以外(生成済み・失敗・不明)」の2状態の切り替えだけを行う。
 */
export function previewImageSrc(status: PreviewStatus | null): string {
  return status === "pending"
    ? PREVIEW_PROCESSING_IMAGE_SRC
    : PREVIEW_FALLBACK_IMAGE_SRC;
}
