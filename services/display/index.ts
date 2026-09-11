/**
 * Display（HTML表示サービス）のエントリーポイント。
 *
 * 設計: docs/APPLICATION_DESIGN.md §7.2, §7.6
 *
 * 本番での責務（T12 で実装する）:
 *   - Node.js標準HTTPサーバーで `GET /health` と `POST /display` だけを公開する
 *   - hidden formから送られる署名付き表示grantをOrigin検証つきで受け取る
 *   - grantの署名・有効期限・対象資料を検証し、DBで資料が`active`であることを再確認する
 *   - 有効な場合だけBlobからHTMLを取得し、閲覧監査を保存してから返す
 *   - 強制CSPとsandboxを設定したレスポンスヘッダーを付与する
 *   - grant、POST body、principal相当の情報をログへ出さない
 *
 * このファイルはコンテナ起動確認のための最小実装であり、上記の業務ロジックは持たない。
 * Web、Migration、Maintenanceと同じNode.js用Docker imageから、このentryだけを
 * 異なるcommandで起動する（設計 §7.6）。
 */
import { fileURLToPath } from "node:url";

export const SERVICE_NAME = "display" as const;

export function describeService(): string {
  return `${SERVICE_NAME} service placeholder: not yet implemented (see T12)`;
}

function main(): void {
  // eslint相当の理由でconsoleを直接使用。業務ログはT12で構造化ログへ置き換える。
  console.log(describeService());
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
