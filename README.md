# 資料みて！

Entra IDで許可された社内ユーザーが、閲覧用HTML資料をアップロードし、固定URLで
安全に共有できる社内Webアプリです。アップロードされたHTMLは信頼せず、アプリ本体とは
別オリジンのHTML表示サービス(Display)で配信し、実行可能な機能(JavaScript)と外部
リソースの自動読み込みをCSPとsandboxで無効化します。

構成の詳細は[アーキテクチャ](docs/ARCHITECTURE.md)、機能・データ・セキュリティの
正本は[アプリケーション設計](docs/APPLICATION_DESIGN.md)を参照してください。

## 構成

React Router Framework Mode(SSR、RSC不使用)のWebに加えて、3つの独立した
Node.jsプロセスで構成します。

| コンポーネント | 役割 |
|---|---|
| Web | React Router BFF。アップロード、資料一覧・表示画面・削除・管理画面(`app/`) |
| Display | アップロードされたHTMLを別オリジンで配信するNode.js標準HTTPサーバー(`services/display/`) |
| Preview Job | Playwright(Chromium)でHTMLの静止画プレビューを生成するQueue駆動Job(`services/preview/`) |
| Maintenance Job | Blob削除の再試行、監査・削除済み資料の保持期間経過後purgeなどを行う定期Job(`services/maintenance/`) |

Web・Display・Migration・Maintenanceは同じNode.js image(`Dockerfile`)を使い、
起動commandだけを切り替えます。Preview JobだけはChromiumを含む専用image
(`Dockerfile.preview`)を使います。

## 前提

- Dev Container(`.devcontainer/`)での開発を前提とします。PostgreSQL(`postgres:5432`)と
  Azurite(`azurite:10000`/`10001`)がdevcontainerのcomposeで併せて起動します
- Node.js `>=24.14.0`(`package.json`の`engines`)
- Preview Jobの結合テスト・ローカル実行にはPlaywrightのChromium browser binaryが
  必要です(devcontainerには導入済み)

## セットアップ

```bash
cp .env.example .env
npm ci
```

`.env`の`GRANT_SIGNING_PRIVATE_KEY`(表示grant署名用Ed25519秘密鍵)と
`LOG_HMAC_KEY`(ログ記録用HMAC鍵)はplaceholderのままでは起動できません。以下で
生成し、`.env`の値を置き換えてください。

```bash
openssl genpkey -algorithm ed25519 -out /tmp/grant-private.pem
cat /tmp/grant-private.pem   # GRANT_SIGNING_PRIVATE_KEY へ設定(実改行のまま)
openssl rand -base64 32      # LOG_HMAC_KEY へ設定
```

DBのマイグレーションを適用します(devcontainerの`DATABASE_URL`を使用)。

```bash
npm run db:migrate
```

Dev Containerを起動するとPostgreSQLと併せてAdminerも常時起動します。Adminerは
`http://localhost:8080`で開き、サーバーには`postgres`を指定してください。

## 開発サーバーの起動

Webはローカルでは`AUTH_MODE=dev`(`.env`既定)により開発ユーザーでログインできます。

```bash
npm run dev
```

Display・Preview Job・Maintenance JobはReact Routerに依存しない独立したスクリプトで、
`services/`配下のTypeScriptを`build/services`へビルドしてから`node`で直接起動します。

```bash
npm run build:services
node build/services/display/index.js       # HTML表示サービス(Display)
node build/services/preview/index.js       # プレビュー生成ワーカー(1回の実行でQueueを1件処理)
node build/services/maintenance/index.js   # 定期保守Job(1回の実行で保守処理をまとめて実行)
```

Display・Preview・Maintenanceの起動には`DATABASE_URL`、Storage接続設定に加え、
Display用の`APP_ORIGIN`・`GRANT_VERIFICATION_KEYS`など個別の環境変数が必要です。
詳細は[運用手順](docs/OPERATIONS.md)の環境変数一覧を参照してください。

## テストの実行

```bash
npm run verify          # typecheck(Web/services)・カバレッジ付き単体テスト・build(Web/services)
npm test                # 単体テストのみ
npm run test:integration  # 結合テスト(要 PostgreSQL・Azurite)
npm run test:e2e        # E2Eテスト(要 PostgreSQL・Azurite・Chromium)
```

`test:integration`と`test:e2e`はdevcontainerが起動する`postgres`・`azurite`サービスへの
接続を前提とします。ローカルPostgreSQL以外(本番相当のホスト名)を指す接続文字列では
安全のため実行時に停止します(§18.2)。`test:e2e`はさらにPlaywrightのChromium browser
binaryを使い、Web・Displayのプロセスを実際に起動して結合的に確認します(Preview Jobは
別コンテナ実行のためE2Eの対象外です)。

## 日常コマンド

```bash
npm run typecheck          # Web
npm run typecheck:services # Display・Preview・Maintenance
npm run build               # Web
npm run build:services      # Display・Preview・Maintenance
npm run db:migrate          # migrations/ を適用
npm run db:migrate:create   # 新しいmigrationファイルの雛形を作成
```

## Docker

Web・Display・Migration・Maintenance共通のimageを構築します。

```bash
docker build --pull -t siryou-mite:検証 .
```

Preview Job専用(Chromium同梱)のimageは別途構築します。

```bash
docker build --pull -f Dockerfile.preview -t siryou-mite-preview:検証 .
```

本番用の環境変数ファイルをシークレット管理機能から用意し、起動します(環境変数ファイルは
Gitへ登録しません)。既定commandはWebで、Display・Maintenanceは起動commandを差し替えます。

```bash
docker run --rm --env-file .env.production -p 8080:8080 siryou-mite:検証
```

別のターミナルから生存確認を行います。

```bash
curl --fail http://127.0.0.1:8080/health
```

## Easy AuthとEntra ID設定

App Service Easy AuthでMicrosoft Entra ID providerを設定します。アプリ登録には
`User`・`Admin` App Roleと、アプリへ割り当てた所属グループだけを返す`groups` claimを
設定します。Graphを使用しないためToken Storeは無効にします。

本番環境へ以下を設定します。

```dotenv
NODE_ENV=production
APP_ORIGIN=https://internal-app.example.com
AUTH_MODE=easyauth
ENTRA_TENANT_ID=...
```

本番の認証フロー、callback、セッションCookieはEasy Authが管理します。アプリは
`X-MS-CLIENT-PRINCIPAL`から`oid`、`tid`、`roles`、複数の`groups`を検証して取得します。
ローカルの`AUTH_MODE=dev`だけは`.env`の`SESSION_SECRET`を使用します。

## GitHub側で別途設定するもの

- Actions、デプロイ、Entra IDなどのSecretsとVariables
- Environmentsと承認者
- チームのアクセス権
- `main`ブランチを保護するRulesets
- 必須レビューと必須status check

認証、セッション、CI、Docker、セキュリティ規約は、理由なく変更しないでください。

## 必ず読む資料

- [アプリケーション設計(機能・データ・セキュリティの正本)](docs/APPLICATION_DESIGN.md)
- [開発規約](docs/DEVELOPMENT_STANDARD.md)
- [アーキテクチャ](docs/ARCHITECTURE.md)
- [セキュリティ規約](docs/SECURITY.md)
- [運用手順](docs/OPERATIONS.md)
- [リリースチェックリスト](docs/RELEASE_CHECKLIST.md)

本番導入前には[リリースチェックリスト](docs/RELEASE_CHECKLIST.md)を使用して、
ステージング確認とロールバック準備を完了してください。
