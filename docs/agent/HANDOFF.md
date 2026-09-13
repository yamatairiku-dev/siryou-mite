# PR本文の下書き(T21: ドキュメント整合と引き継ぎ)

自律実装(`agent/implementation`ブランチ、T01〜T22)の引き継ぎ資料です。司令塔・レビュー
担当はこのまま、または要約してPull Requestの説明として使ってください。

## 概要

「資料みて！」(Entra IDで許可された社内ユーザーが閲覧用HTML資料をアップロードし、
固定URLで安全に共有するアプリ)の初期リリースをT01〜T22で実装しました。

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
- T21(本タスク): `README.md`・`docs/ARCHITECTURE.md`・`docs/OPERATIONS.md`を実装に
  合わせて更新し、本ファイル(`docs/agent/HANDOFF.md`)を作成

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
実行し、いずれも成功しました(実行日: 2026-09-13)。

```
npm run verify
  - typecheck(Web) OK
  - typecheck:services OK
  - test:coverage: 全テストPASS、カバレッジ Statements 89.72% / Branches 87.38% /
    Functions 82.21% / Lines 90.16%
  - build(Web) OK
  - build:services OK

npm run test:integration
  - 15 test files / 170 tests PASS(PostgreSQL・Azuriteへの実接続)

npm run test:e2e
  - 29 tests PASS(Web・DisplayをPlaywrightのwebServerとして実起動、Chromium)
```

## レビュー担当者に確認してほしい事項

`docs/agent/QUESTIONS.md`にQ-001〜Q-062を記録しました。**Q-002以外はすべて
`[未回答]`のままです**。実装は各Qに書いた「置いた仮定」で進めているため、下記は
特に判断をお願いしたいものを分類したものです(全項目の確認を推奨します)。

### CI・エージェント対象外の確定差分(最優先)

- **Q-001 / Q-061**: `.github/workflows/ci.yml`は`typecheck`/`test:coverage`/`build`を
  個別実行しており、T01の`typecheck:services`/`build:services`と、T03以降で必要に
  なった結合テスト・E2E(PostgreSQL・Azurite service container、`DATABASE_URL`・
  `AZURE_STORAGE_CONNECTION_STRING`のCI向け値、Chromiumのinstall)がCIに反映されて
  いません。Q-061に具体的なYAML差分案を記載しています。`.github/`はエージェント対象外
  のため、レビュー担当者(人)が適用してください。ローカル(devcontainer)では
  `npm run verify`・`npm run test:integration`・`npm run test:e2e`すべて成功しています。

### 監査(audit_events)関連

- **Q-003**: `error_category`の15分類(`validation_failed`、`html_inspection_failed`、
  `quota_exceeded`など)は設計書に一覧が無いため、§6・§7.2・§7.5・§10の失敗パターンから
  実装側で起こした暫定の列挙です。分類の過不足がないかご確認ください。
- **Q-052 / Q-053**: 監査(`audit_events`)は追記専用trigger + role権限で保護しつつ、
  設計§16が求める1年経過後のpurgeだけを保守専用DB role(`siryou_mite_maintenance`)から
  許可する構成にしました。**IaC(Bicep)側でこのroleの作成とMaintenance JobのManaged
  Identityとの対応付けが必要**です(未作成のままだとMaintenance Jobのpurgeが失敗します)。
  また、保守Job自体は監査を書かない設計にしています(purgeのたびに監査を書くと、その
  監査自体が新たな1年保持対象になり増え続けるため)。この判断の妥当性をご確認ください。

### HTML受け入れ検査の割り切り

- **Q-007〜Q-009**: 設計に無い拒否理由(`excessive_complexity`、`invalid_file_name`、
  `file_name_too_long`)を追加したこと、外部resource判定をfail closed(`data:`・
  同一文書内・値なし・`about:blank`以外はすべて拒否)にしたこと、inline CSSのescapeや
  `<object><param value>`など検査をすり抜け得る箇所はDisplay側のCSP/sandboxに委ねる
  多層防御の割り切りにしたことを記録しています。誤検知・誤許可のリスク評価をお願いします。

### E2Eの対象外範囲

- **Q-058**: プレビュー生成(timeout・再試行・失敗時の代替画像)はPreview Jobが別
  コンテナ(Chromium)実行のためE2E対象外とし、結合テスト(`tests/integration/
  preview-worker.test.ts`・`preview-capture.test.ts`)で代替検証しています。
- **Q-059**: `/.auth/me`と実Entra IDログインは Easy Auth platform機能のためE2E対象外
  とし、複数所属コードの一致確認は監査履歴画面での確認で代替しています。実Entra ID
  経路の確認はstaging環境での手動確認に委ねています。
- **Q-060**: E2Eは`documents`・`audit_events`の破壊的クリーンアップを行いません
  (追記専用triggerとFKにより、アップロード監査のある資料行は物理削除できないため)。
  devcontainerの共有DB・Azuriteにテストデータが蓄積し続けるため、長期反復実行時は
  `docker compose down -v`等でvolumeを作り直す運用が必要になり得ます。

### その他、判断が分かれ得る主な仮定

- Q-013〜Q-017(アップロードの実行順、未認証拒否を監査しない判断、応答形式・
  ステータスコード、メールアドレス形式不一致時は`null`保存)
- Q-018〜Q-020(grantへの`actorTenantId`追加、有効期限内のgrant再利用許容、
  メールアドレスnullable化)
- Q-026〜Q-029(削除監査の`action`統一、拒否時の監査有無、削除成功後の遷移先)
- Q-033〜Q-039(管理画面・監査履歴画面の検索仕様、監査粒度、画面間導線)
- Q-040〜Q-051(プレビュー生成の監査引き継ぎ、冪等性、timeout多重化の設計)
- Q-054〜Q-057(孤児Blob掃除の条件、`upload_attempts`のpurge条件、Job実行上限)
- Q-062(cursorの旧形式(ミリ秒精度)を経過措置としてfail closedにしていない判断)

全項目の詳細と影響範囲は`docs/agent/QUESTIONS.md`を参照してください。

## エージェント対象外で人が対応すべき作業

`docs/agent/TASKS.md`末尾の「エージェントの対象外(人が対応)」に記載のとおりです。

- `.github/workflows`の変更(CIへのPostgreSQL・Azurite service container追加、
  `npm run verify`への統一、E2E実行に必要な環境変数の追加。具体案はQ-001・Q-061)
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

- `app/root.tsx`の`<title>`(`meta`関数)と`.env.example`の`APP_NAME`既定値は
  汎用テンプレート名(「社内Webアプリ」)のままです。E2E(`playwright.config.ts`)では
  `APP_NAME=資料みて！`を明示的に注入して確認していますが、`app/root.tsx`の`meta`
  自体は静的な文字列(`社内Webアプリ`)を返しており、`APP_NAME`環境変数を反映していません。
  `app/`はこのタスクの変更範囲外のため直していません(コードを直さずに記録する、
  というタスクのルールに従っています)。ブランド表示を統一する場合は別タスクとして
  `app/root.tsx`の`meta`と`.env.example`の既定値を更新してください。
- `docs/agent/QUESTIONS.md`のQ-001〜Q-062はQ-002を除きすべて`[未回答]`です。人が
  確認後に「回答」欄を埋める運用を想定しています。
- 結合テスト・E2Eはローカル(devcontainer)のPostgreSQL・Azuriteに依存し、CIでは
  現状実行されません(Q-001・Q-061)。
- Maintenance Jobの保守専用DB role(`siryou_mite_maintenance`)はmigrationが
  「roleが存在すればGRANT、存在しなければ何もしない」という設計のため、本番環境では
  IaC側でこのroleを作成し、Maintenance JobのManaged Identityと対応付けない限り、
  1年経過後のpurgeが機能しません。
- Preview JobのChromium sandboxは実装上有効(`chromiumSandbox: true`)ですが、
  Container Apps Job上で実際に起動できるかの検証(security spike)は未実施です
  (設計§21)。
