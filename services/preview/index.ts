/**
 * Preview Job（プレビュー生成ワーカー）のエントリーポイント。
 *
 * 設計: docs/APPLICATION_DESIGN.md §7.5, §7.6
 *
 * 本番での責務（T18 で実装する）:
 *   - Storage Queueから1メッセージだけを受信し、1実行で1メッセージを処理する
 *   - `dequeueCount` で最大3回まで再試行し、3回失敗した場合はDBの状態を`failed`にする
 *   - JavaScript無効・外部ネットワーク接続なし・Chromium sandbox有効のPlaywrightで
 *     1280x720のJPEGプレビューを撮影する(1MB以下)
 *   - 成否を監査・運用ログへ記録する
 *
 * このファイルはコンテナ起動確認のための最小実装であり、上記の業務ロジックは持たない。
 * 実行にはChromiumを含む専用Dockerfileと専用imageを使う（設計 §7.6）。
 */
import { fileURLToPath } from "node:url";

export const SERVICE_NAME = "preview" as const;

export function describeService(): string {
  return `${SERVICE_NAME} service placeholder: not yet implemented (see T18)`;
}

function main(): void {
  console.log(describeService());
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
