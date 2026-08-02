# 社内Webアプリ標準テンプレート

情報システム部門が小規模な社内Webアプリを継続保守するための、React Router
Framework Mode標準スターターです。

## 標準構成

- React Router v8、SSR有効、RSC不使用
- React、TypeScript、Node.js 24
- App Service Easy AuthによるMicrosoft Entra ID認証
- App Role認可とグループクレームによる所属情報
- Vitest、Playwright
- Docker、GitHub Actions、Dependabot
- Zodによる環境変数検証

## このテンプレートから新規アプリを作成する

1. GitHubでこのテンプレートリポジトリを開く
2. `Use this template`から`Create a new repository`を選ぶ
3. 会社のOrganization、リポジトリ名、公開範囲を指定して作成する
4. 作成されたリポジトリをローカルへcloneする

テンプレートから作成したリポジトリは、テンプレートとは独立した履歴を持ちます。
テンプレートの後日の変更は、作成済みのアプリへ自動反映されません。

## ローカル初期設定

```bash
cp .env.example .env
npm ci
npm run verify
npm run dev
```

ローカルでは`.env`の`AUTH_MODE=dev`により開発ユーザーでログインできます。
本番環境では`AUTH_MODE=easyauth`以外では起動しません。

Dev Containerを起動するとPostgreSQLと併せてAdminerも常時起動します。Adminerは
`http://localhost:8080`で開き、サーバーには`postgres`を指定してください。

## アプリ作成時の必須作業

- `package.json`の`name`を変更する
- `.env`の`APP_NAME`を変更する
- READMEをアプリ固有の概要、担当部署、連絡先へ書き換える
- ホーム画面と`/app`を業務内容に合わせて変更する
- Entra IDのアプリ登録、App Role、所属グループクレームを設定する
- App Service Easy AuthをBicepで設定する
- 本番用の業務シークレットをシークレット管理機能へ登録する
- 業務データに応じた認可、監視、バックアップ、RTO/RPOを決定する

認証、セッション、CI、Docker、セキュリティ規約は、理由なく変更しないでください。

## GitHub側で別途設定するもの

GitHub ActionsのワークフローファイルとDependabot設定はテンプレートから引き継がれます。
一方、次のGitHub設定は新しいアプリ用リポジトリまたはOrganization側で設定します。

- Actions、デプロイ、Entra IDなどのSecretsとVariables
- Environmentsと承認者
- チームのアクセス権
- `main`ブランチを保護するRulesets
- 必須レビューと必須status check

## Easy AuthとEntra IDの設定

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

## 日常コマンド

```bash
npm run typecheck
npm test
npm run test:e2e
npm run build
npm run verify
```

## Docker

イメージを構築します。

```bash
docker build --pull -t 社内アプリ名:検証 .
```

本番用の環境変数ファイルをシークレット管理機能から用意し、起動します。
環境変数ファイルはGitへ登録しないでください。

```bash
docker run --rm \
  --env-file .env.production \
  -p 8080:8080 \
  社内アプリ名:検証
```

別のターミナルから生存確認を行います。

```bash
curl --fail http://127.0.0.1:8080/health
```

## 新しい業務画面

1. `app/routes/example.tsx`を作る
2. `app/routes.ts`へrouteを追加する
3. loaderの先頭で`requireUser(request)`を呼ぶ
4. 入力はZodで検証する
5. 更新はactionに実装し、`assertSameOrigin(request)`を呼ぶ
6. unitまたはE2Eテストを追加する

## 必ず読む資料

- [開発規約](docs/DEVELOPMENT_STANDARD.md)
- [アーキテクチャ](docs/ARCHITECTURE.md)
- [セキュリティ規約](docs/SECURITY.md)
- [運用手順](docs/OPERATIONS.md)
- [リリースチェックリスト](docs/RELEASE_CHECKLIST.md)

本番導入前には[リリースチェックリスト](docs/RELEASE_CHECKLIST.md)を使用して、
ステージング確認とロールバック準備を完了してください。
