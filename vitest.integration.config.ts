import { defineConfig } from "vitest/config";

/**
 * 結合テスト専用のvitest設定(設計 §18.2)。
 *
 * `vitest.config.ts`(`npm run test`、`npm run verify`が使う単体テスト設定)とは
 * 別ファイルにする。ローカルPostgreSQLへの実接続が必要なため、CIで毎回動く
 * `npm run verify`には含めず、`npm run test:integration`として独立実行する。
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/integration/**/*.test.ts"],
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
