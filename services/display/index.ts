/**
 * Display（HTML表示サービス）のエントリーポイント。
 *
 * 設計: docs/APPLICATION_DESIGN.md §7.2, §7.6, §9.2, §10.3
 *
 * 責務:
 *   - Node.js標準HTTPサーバーで `GET /health` と `POST /display` だけを公開する
 *   - hidden formから送られる署名付き表示grantをOrigin検証つきで受け取る
 *   - grantの署名・有効期限を検証し、DBで資料が`active`であることを再確認する
 *   - 有効な場合だけBlobからHTMLを取得し、閲覧監査を保存してから返す
 *   - 強制CSPとsandboxを設定したレスポンスヘッダーを付与する
 *   - grant、POST body、principal相当の情報をログへ出さない
 *
 * HTTP処理は`server.ts`、外部I/Oの組み立ては`dependencies.ts`にあり、この
 * ファイルは環境変数の検証と起動・終了だけを担う。Web、Migration、Maintenanceと
 * 同じNode.js用Docker imageから、このentryだけを異なるcommandで起動する
 * （設計 §7.6）。
 */
import type { Server } from "node:http";
import { fileURLToPath } from "node:url";
import { createDisplayRuntime } from "./dependencies.js";
import { parseDisplayEnvironment } from "./env.js";
import { createDisplayServer } from "./server.js";

export const SERVICE_NAME = "display" as const;

export function describeService(): string {
  return `${SERVICE_NAME} service: GET /health and POST /display only`;
}

/** 終了時に接続を閉じるまでの猶予(ms)。超えた場合は強制終了する。 */
const SHUTDOWN_TIMEOUT_MS = 10_000;

function startDisplayService(): void {
  // 不正な環境変数はここで例外になり、プロセスが起動しない(fail closed)。
  const env = parseDisplayEnvironment(process.env);
  const runtime = createDisplayRuntime(env);
  const server: Server = createDisplayServer(runtime.dependencies);

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    const timer = setTimeout(() => process.exit(1), SHUTDOWN_TIMEOUT_MS);
    timer.unref();
    server.close(() => {
      void runtime.close().finally(() => process.exit(0));
    });
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  server.listen(env.PORT, () => {
    // 起動ログには設定値・秘密情報を含めない(設計 §9.5)。
    console.log(
      JSON.stringify({
        time: new Date().toISOString(),
        event: "display_started",
        result: "success",
      }),
    );
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startDisplayService();
}
