# PR本文の下書き(T21: ドキュメント整合と引き継ぎ)

自律実装(`agent/implementation`ブランチ、T01〜T23とその後の追加対応)の引き継ぎ資料です。司令塔・レビュー
担当はこのまま、または要約してPull Requestの説明として使ってください。

## 概要

「資料みて！」(Entra IDで許可された社内ユーザーが閲覧用HTML資料をアップロードし、
固定URLで安全に共有するアプリ)の初期リリースをT01〜T23で実装しました。

- Web(React Router Framework Mode、SSR、`app/`)
- Display(アップロードされたHTMLを別オリジンで配信するNode.js標準HTTPサーバー、
  `services/display/`)
- Preview Job(Playwright/ChromiumでHTMLの静止画プレビューを生成するQueue駆動Job、
  `services/preview/`)
- Maintenance Job(Blob削除の再試行・保持期間経過後のpurgeを行う定期Job、
  `services/maintenance/`)

の4コンポーネントに加え、DBマイグレーション(`migrations/`、`node-pg-migrate`)を整備し、
単体・結合・E2Eテストを揃えました。設計の正本は`docs/APPLICATION_DESIGN.md`、実装の
判断根拠は各タスクの実装メモ(`docs/agent/TASKS.md`)と`docs/agent/QUESTIONS.md`
(Q-001〜Q-062)に記録しています。

## 実装したタスク一覧

- T01: 依存関係(`parse5`・`pg`・`node-pg-migrate`・`@azure/identity`・
  `@azure/storage-blob`・`@azure/storage-queue`・`@types/pg`)追加とservice用
  ディレクトリ構成・build(`tsconfig.services.json` → `build/services`)を整備
- T02: Web用/service用に分離した環境変数Zodスキーマ(DB・Storage・grant鍵・HMAC鍵・
  §6.1制限値、本番接続文字列禁止のfail closed)を追加
- T03: `documents`・`audit_events`のforward-only DBマイグレーションと、監査を
  `BEFORE UPDATE OR DELETE` triggerで追記専用にする制約を追加
- T04: `app/lib/db/{pool,documents,audit-events}.server.ts`(DB接続・repository・
  keyset pagination・監査INSERTのみ)を実装
- T05: Blob/Queueクライアント(`services/shared/storage.ts`)を実装。Blobキーの決定的
  導出、Queueメッセージの最小化、timeout設定
- T06: 認証・認可を設計へ適合(group overage検出、`tid`固定のfail closed、
  owner/admin認可ヘルパー)
- T07: HTML受け入れ検査(`app/lib/html/`)を純粋関数として実装
- T08: 件数・容量・頻度・同時実行の上限判定(PostgreSQL advisory lock、
  `upload_attempts`テーブル)を実装
- T09: アップロード`POST /documents`(検査→Blob保存→DB登録→Queue送信、失敗時の
  補償処理、アップロード監査)を実装
- T10: 初期画面(アップロードUI・所有資料一覧・cursor追加読込)を実装
- T11: 表示grantのEd25519署名・検証(`services/shared/grant.ts`)を実装
- T12: HTML表示サービス(Display)を実装(Origin検証・grant検証・`active`再確認・
  閲覧監査・CSP/sandboxヘッダー)
- T13: 資料表示画面`/documents/:documentId`(hidden formでのgrant POST、iframe
  sandbox)を実装
- T14: 削除(所有者・管理者、確認画面・監査・Blob削除補償)を実装
- T15: プレビュー状態のresource routeとカード表示の切り替えを実装
- T16: 管理画面`/admin/documents`(検索・閲覧・強制削除導線・管理操作監査)を実装
- T17: 監査履歴画面`/admin/audit`(検索・監査履歴閲覧自体の監査)を実装
- T18: プレビュー生成ワーカー(Preview Job、Playwright/Chromium、専用Docker image)を実装
- T19: 定期保守Job(Maintenance Job、保守専用DB role、purge、孤児Blob掃除)を実装
- T20: Easy Auth principal fixtureによるE2Eテスト(Web・Displayを実起動)を実装
- T22: `documents`一覧cursorをマイクロ秒精度にして、同一ミリ秒の資料の取りこぼしを修正
- T21: `README.md`・`docs/ARCHITECTURE.md`・`docs/OPERATIONS.md`を実装に
  合わせて更新し、本ファイル(`docs/agent/HANDOFF.md`)を作成
- T23: プレビュー画像を認証付きresource route `GET /documents/:documentId/preview`
  で中継して配信(Blobは非公開のまま、Q-030の回答)。読み込み失敗時の代替画像表示は
  hydration前の失敗とsrc変更にも追従する

### T23以降の追加対応

- 確認事項Q-001〜Q-062の回答を`docs/agent/QUESTIONS.md`に記録し、承認した判断を
  `docs/APPLICATION_DESIGN.md`・`docs/OPERATIONS.md`・`docs/RELEASE_CHECKLIST.md`へ反映
- CI(`.github/workflows/ci.yml`)を`npm run verify`へ統一し、PostgreSQL・Azuriteの
  service containerで結合テストとE2Eも実行するようにした(Q-001・Q-061の回答に基づき、
  人のレビュー前提でClaudeが差分を作成)
- `<title>`に`APP_NAME`を反映し、既定のアプリ名を「資料みて！」にした
- WebアプリのHTML文書応答にnonce付きCSPを追加(`app/entry.server.tsx`、
  `unsafe-inline`不使用、`form-action`にEntra IDのログインを許可)

## 追加した production 依存とその理由

詳細な判断根拠(標準APIで代替できない理由・メンテナンス状況・Security Policy・
ライセンス・削除時の影響)は`docs/agent/DEPENDENCIES.md`にあります。要約:

| 依存 | 理由 |
|---|---|
| `parse5` | HTML受け入れ検査(`meta refresh`・`base href`・相対リンク・禁止scheme判定)に仕様準拠のHTMLパーサーが必要。Node.js標準に代替がない |
| `pg` | 設計 §7.4でPostgreSQL接続にORM非導入・`pg`使用が明示されている |
| `node-pg-migrate` | forward-onlyのSQLマイグレーション管理を自前実装するリスクを避けるため。設計 §7.4で明示指定 |
| `@azure/identity` | Managed IdentityでのAzureトークン取得はAzure SDK以外に安全な標準手段がない |
| `@azure/storage-blob` | private Blob Storageへの認証付きアクセスに必要 |
| `@azure/storage-queue` | Storage Queueへの認証付きアクセスに必要 |
| `@types/pg`(開発依存) | `pg`が型定義を同梱しないため |

`playwright-core`(Preview Jobの撮影処理)は**`package.json`・`package-lock.json`を
変更していません**。既存の`@playwright/test`(devDependency)が固定するversionを
`services/preview/capture.ts`が動的importで使い、Preview専用image
(`Dockerfile.preview`)がbrowser binaryをPlaywright公式imageから取得する構成のため、
production dependencyは増えていません。

## 動作確認の方法と結果

devcontainer(PostgreSQL: `postgres:5432`、Azurite: `azurite:10000/10001`)上で以下を
実行し、いずれも成功しました(実行日: 2026-09-27、T23以降の追加対応を含む最終状態)。

```
npm run verify
  - typecheck(Web)・typecheck:services OK
  - test:coverage: 40 test files / 843 tests PASS、カバレッジ Statements 89.09% /
    Branches 86.25% / Functions 81.74% / Lines 89.55%
  - build(Web)・build:services OK

npm run test:integration
  - 16 test files / 175 tests PASS(PostgreSQL・Azuriteへの実接続)

npm run test:e2e
  - 30 tests PASS(Web・DisplayをPlaywrightのwebServerとして実起動、Chromium)
```

同じ内容をCI(`.github/workflows/ci.yml`)でも実行します。

## レビュー担当者に確認してほしい事項

`docs/agent/QUESTIONS.md`のQ-001〜Q-062はすべて回答済み(`[回答済]`)で、承認した判断は
`docs/APPLICATION_DESIGN.md`へ反映しました。レビュー時は特に次の点をご確認ください。

- **Q-052 / Q-053**: 監査(`audit_events`)は追記専用trigger + role権限で保護しつつ、
  1年経過後のpurgeだけを保守専用DB role(`siryou_mite_maintenance`)から許可する構成です。
  **IaC(Bicep)側でこのroleの作成とMaintenance JobのManaged Identityとの対応付けが必要**
  です(未作成のままだとpurgeが失敗します)
- **Q-007〜Q-009**: HTML受け入れ検査は設計に無い拒否理由を追加し、外部resource判定を
  fail closedにしています。検査をすり抜け得る箇所はDisplay側のCSP/sandboxに委ねる
  多層防御です
- **Q-058 / Q-059**: Preview Jobの撮影と実Entra IDログインはE2E対象外で、結合テストと
  staging手動確認(`docs/RELEASE_CHECKLIST.md`)で代替しています
- **Web CSP**: `frame-src`は資料内のtarget省略リンクがiframe内で遷移できるよう
  `https:`/`http:`を許可しています(設計§6.3)。開発サーバーだけHMRのためCSPを付けません

## エージェント対象外で人が対応すべき作業

`docs/agent/TASKS.md`末尾の「エージェントの対象外(人が対応)」に記載のとおりです。

- `.github/workflows/ci.yml`の差分(Claudeが作成済み)のレビューと、GitHub Actions上での
  実行確認
- Bicep(`infra/`)とデプロイworkflow(このリポジトリには`infra/`ディレクトリ自体が
  まだありません)
- Container Apps Job上でのChromium sandbox security spike(設計§21の未決事項の1つ。
  Preview Jobは`chromiumSandbox: true`のまま実装していますが、Container Apps上で
  実際にsandboxが起動できるかの検証は範囲外です)
- 設計書§21の未決事項全般(WebとDisplayの正式ホスト名・証明書・private DNS、Entra ID
  の実セキュリティグループと所属コード発行属性、App Service PlanのSKUとstaging
  callback検証、運用担当者の共有メールアドレスと当番体制、Workload Identity向け
  Conditional Accessの検証、Azureサービスの費用見積もり)

## 既知の制約・残課題

- Maintenance Jobの保守専用DB role(`siryou_mite_maintenance`)はmigrationが
  「roleが存在すればGRANT、存在しなければ何もしない」という設計のため、本番環境では
  IaC側でこのroleを作成し、Maintenance JobのManaged Identityと対応付けない限り、
  1年経過後のpurgeが機能しません。
- Preview JobのChromium sandboxは実装上有効(`chromiumSandbox: true`)ですが、
  Container Apps Job上で実際に起動できるかの検証(security spike)は未実施です
  (設計§21)。
