/**
 * Maintenance Job（定期保守ジョブ）のエントリーポイント。
 *
 * 設計: docs/APPLICATION_DESIGN.md §7.7, §16, §7.6
 *
 * 本番での責務（T19 で実装する）:
 *   - 毎日UTC 18:00（JST 03:00）に実行し、`blob_cleanup_pending` の資料を冪等に再試行する
 *   - 削除済み資料の最小メタデータと監査履歴を、Blob削除完了かつ1年経過後にpurgeする
 *   - Blob削除が完了していない資料メタデータはpurgeしない
 *
 * このファイルはコンテナ起動確認のための最小実装であり、上記の業務ロジックは持たない。
 * Web、Displayと同じNode.js用Docker imageから、このentryだけを異なるcommandで
 * 起動する（設計 §7.6）。
 */
import { fileURLToPath } from "node:url";

export const SERVICE_NAME = "maintenance" as const;

export function describeService(): string {
  return `${SERVICE_NAME} service placeholder: not yet implemented (see T19)`;
}

function main(): void {
  console.log(describeService());
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
