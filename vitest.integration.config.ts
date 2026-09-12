import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * 結合テスト専用のvitest設定(設計 §18.2)。
 *
 * `vitest.config.ts`(`npm run test`、`npm run verify`が使う単体テスト設定)とは
 * 別ファイルにする。ローカルPostgreSQLへの実接続が必要なため、CIで毎回動く
 * `npm run verify`には含めず、`npm run test:integration`として独立実行する。
 */
export default defineConfig({
  // repository(`app/lib/db/*.server.ts`)は`~`エイリアスでimportし合うため、
  // 単体テスト設定(vitest.config.ts)と同じ解決規則をここでも使う。
  resolve: {
    alias: {
      "~": fileURLToPath(new URL("./app", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/integration/**/*.test.ts"],
    // `app/lib/env.server.ts`のZod検証を通すためのダミー値を先に設定する
    // (`DATABASE_URL`は実際のローカルPostgreSQLの値をそのまま使う)。
    setupFiles: ["./tests/integration/helpers/env.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // node-pg-migrateはcluster全体で共有するadvisory lockを使うため、複数の
    // テストfileが同時にmigrationを実行すると競合する。結合テストはfile単位でも
    // 直列に実行する。
    fileParallelism: false,
    // 単体テストのcoverage閾値(vitest.config.ts)とは無関係。結合テストではcoverageを計測しない。
    coverage: {
      enabled: false,
    },
  },
});
