/**
 * E2E(設計 §18.3)で使う固定値。
 *
 * Playwrightのconfig評価(メインプロセス)とtestファイル(workerプロセス)の両方から
 * importされるため、ここに置く値は乱数を含まない定数だけにする。乱数(grant署名鍵・
 * ログHMAC鍵)は`playwright.config.ts`側だけで生成し、Web・Displayの子プロセスへ
 * `webServer.env`として渡す(configとglobalSetupは同じメインプロセスで実行されるが、
 * testはworkerプロセスで動くためメモリを共有できない。乱数鍵はWeb/Display間だけで
 * 一致すればよく、testコードは鍵そのものを必要としない)。
 */

/**
 * Web(react-router-serve)のport。`npm run dev`(3000)や`.env.example`の
 * `DISPLAY_ORIGIN=http://localhost:3100`とportが衝突すると、開発サーバーを
 * 起動したままE2Eを走らせたときに"port is already used"で落ちるため、
 * 開発用途と重ならないport帯(39xx)を使う。
 */
export const WEB_PORT = 3900;
/** Display(HTML表示サービス)のport。 */
export const DISPLAY_PORT = 3910;

export const APP_ORIGIN = `http://127.0.0.1:${WEB_PORT}`;
export const DISPLAY_ORIGIN = `http://127.0.0.1:${DISPLAY_PORT}`;

/** Easy Authのprincipal fixtureとWebの`ENTRA_TENANT_ID`で一致させるtenant。 */
export const ENTRA_TENANT_ID = "e2e-tenant-11111111";
/** 「不正tenant」シナリオ用の、構成値と異なるtenant。 */
export const WRONG_TENANT_ID = "e2e-tenant-99999999-wrong";

/** devとは別のcontainer/queue名にして、devが使うBlob/Queueを汚さない。 */
export const STORAGE_CONTAINER = "documents-e2e";
export const STORAGE_QUEUE_NAME = "preview-generation-e2e";

/**
 * devcontainerの`.devcontainer/docker-compose.yml`の`dev`serviceが設定する値と
 * 同じ既定値(`process.env`から引き継げる場合はそちらを優先する)。
 */
export function resolveDatabaseUrl(): string {
  return (
    process.env.DATABASE_URL ??
    "postgresql://siryou_mite:local-development-password@postgres:5432/siryou_mite"
  );
}

export function resolveStorageConnectionString(): string {
  return (
    process.env.AZURE_STORAGE_CONNECTION_STRING ??
    "DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;BlobEndpoint=http://azurite:10000/devstoreaccount1;QueueEndpoint=http://azurite:10001/devstoreaccount1;"
  );
}
