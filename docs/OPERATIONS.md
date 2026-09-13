# 運用手順

## 役割

| 役割 | 責任 |
|---|---|
| アプリ責任者 | 利用部門調整、リリース承認 |
| 保守担当 | 更新、監視、一次障害対応 |
| レビュー担当 | コード・セキュリティレビュー |
| 基盤担当 | App Service Easy Auth、コンテナ、シークレット、ネットワーク |

兼務は可能ですが、リリース承認と実施は可能な限り別担当にします。

## 監視

最低限、以下を監視します。

- `/health`の応答
- HTTP 5xx率
- 応答時間
- コンテナ再起動回数
- Entra認証失敗率
- Easy Auth principal解析失敗、tenant不一致、App Role・groups欠落
- 外部APIのtimeout率
- CPU、メモリ
- Storage Queue長、最古メッセージ、Preview失敗
- Migration・Maintenance Job失敗
- Blob使用量40GB
- PostgreSQL storage使用率70%／85%
- 監査書き込み失敗

health checkは生存確認だけを返し、設定値や依存サービスの詳細を公開しません。
Azure Monitor Action Groupから運用担当者の共有メールアドレスへ通知します。通知先は
環境別Bicepパラメーターで渡し、repositoryへ実値を保存しません。

## 月次メンテナンス

1. Dependabot PRとSecurity Advisoryを確認
2. React Router関連を同じバージョンへ更新
3. Node Docker imageを更新
4. `npm run verify`
5. ステージングへデプロイ
6. ログイン、主要操作、ログアウトを確認
7. 本番へデプロイ
8. `/health`とエラーログを確認
9. 実施日、担当者、バージョンを記録

## 障害対応

1. 影響範囲と開始時刻を記録
2. 直前リリースとの関連を確認
3. シークレットをログへ貼り付けない
4. 復旧を原因調査より優先
5. 必要に応じて直前のコンテナイメージへ戻す
6. 復旧後、原因と再発防止を記録

## ロールバック

- 本番はstagingで検証した同一image digestを昇格する
- 本番イメージにはGit commit SHAをtagとして付ける
- 直前の正常イメージを最低1世代保持する
- DB変更はforward-onlyの互換な2段階変更にする
- 破壊的変更は利用コード除去後の別リリースで行う
- application rollback時にproduction DBのdown migrationを自動実行しない
- ロールバック後も新旧データを読める期間を設ける

## シークレット更新

対象はgrant署名用Ed25519鍵とログ用HMAC鍵です。環境ごとに別の値をKey Vaultへ保存し、
App ServiceまたはContainer AppsのKey Vault参照で渡します。`SESSION_SECRET`はlocal開発
専用で、本番へ設定しません。Easy AuthでGraph Token Storeを使用しないため、このアプリが
管理するEntra ID client secretはありません。

1. 新しいsecretまたは鍵を作成
2. ステージングで確認
3. 本番へ新しい値を登録
4. 新旧値を併用できる機能では移行期間を開始
5. アプリを再デプロイし、ログインと主要機能を確認
6. grant鍵は新しい`keyId`で署名し、旧grantの60秒経過後に旧鍵を無効化
7. 古いsecretまたは鍵を無効化

Easy Auth providerの証明書・secret管理方式をAzure側で変更した場合は、基盤手順を別途更新する。

## 環境変数

環境変数はZodで検証します(`app/lib/env.server.ts`がWeb用、`services/display/env.ts`・
`services/preview/env.ts`・`services/maintenance/env.ts`がDisplay・Preview Job・
Maintenance Job用)。`services/`配下は`app/`をimportせず、共通の検証ロジックだけを
`services/shared/env.ts`へ切り出しています。不正な値がある場合はプロセス起動時に
例外で停止します(fail closed)。

### Web(App Service)

| 変数 | 内容 | 本番での扱い |
|---|---|---|
| `DATABASE_URL` | PostgreSQL接続文字列 | Managed IdentityのEntra ID access tokenを`pg`のpasswordとして使う。値そのものはrepositoryへ保存せず、Key Vault参照で渡す |
| `DISPLAY_ORIGIN` | Display(HTML表示サービス)のオリジン | Web・Displayで一致させる |
| `AZURE_STORAGE_CONNECTION_STRING` | ローカル・開発用Blob/Queue接続文字列 | 本番では設定禁止(設定するとZod検証で拒否) |
| `AZURE_STORAGE_ACCOUNT_NAME` | Storageアカウント名(Managed Identity用) | 本番で必須。`AZURE_STORAGE_CONNECTION_STRING`とは同時指定不可 |
| `AZURE_STORAGE_CONTAINER` | HTML・プレビューを保存するcontainer名(既定`documents`) | 環境間で共有しない値へ変更可 |
| `AZURE_STORAGE_QUEUE_NAME` | プレビュー生成メッセージのqueue名(既定`preview-generation`) | 同上 |
| `GRANT_SIGNING_KEY_ID` | 表示grant署名鍵の`keyId` | Key Vault参照。rotation時に新しい値へ変更する |
| `GRANT_SIGNING_PRIVATE_KEY` | 表示grant署名用Ed25519秘密鍵(PEM) | Key Vault参照。Webだけが秘密鍵を持つ |
| `GRANT_TTL_SECONDS` | 表示grantの有効期間(既定60秒、最大120秒) | 既定値からむやみに延長しない |
| `LOG_HMAC_KEY` | ログ記録用HMAC鍵(base64、32byte以上) | Key Vault参照。ID等をpseudonymize化する用途に限定する |
| `MAX_HTML_UPLOAD_BYTES` ほか§6.1の上限値 | アップロードサイズ・件数・容量・頻度・同時実行の上限 | 既定値は設計の規定値(10MB、100件、500MB、50GB／40GB警告、1分5回、同時1件)と一致 |

`SESSION_SECRET`はlocal開発の`AUTH_MODE=dev`専用で、本番(`AUTH_MODE=easyauth`)では
設定しません。

### コンテナimageと起動command

Web・Display・Migration Job・Maintenance Jobは**同じNode.js image**を使い、起動command
だけを変えます(設計 §7.6)。Dockerfileのbuild stageは`npm run build`(Web)に続けて
`npm run build:services`を実行し、`build/client`・`build/server`・`build/services`を
同じimageへ入れます。コンテナは非root(`USER node`)のまま変更しません。

| 実行単位 | 起動command |
|---|---|
| Web(App Service) | `node node_modules/@react-router/serve/bin.cjs ./build/server/index.js`(imageの既定CMD) |
| Display(Container Apps) | `node build/services/display/index.js` |
| Migration Job | `npm run db:migrate` |
| Maintenance Job | `node build/services/maintenance/index.js` |

DisplayはWebと同じ`/health`(`GET`のみ)を持つため、imageのHEALTHCHECKは両方で使えます。
Displayは`SIGTERM`・`SIGINT`で待受けを止め、DB接続を閉じてから終了します(猶予10秒)。

#### Preview Job専用image(`Dockerfile.preview`)

Preview JobだけはChromiumを含む専用image(`Dockerfile.preview`)を使います(設計 §7.6。
imageは合計2種類)。起動commandは`node build/services/preview/index.js`です。

- base imageは`mcr.microsoft.com/playwright:v1.61.1-noble`で、tagは`package.json`の
  `@playwright/test`のversionと**必ず一致**させます。`@playwright/test`を更新するときは
  同じPRでbase imageのtagも上げます(不一致だとbrowserとPlaywright本体の対応が崩れます)。
- 非rootの`pwuser`で実行します(設計 §7.5「ワーカーは非root」)。
- browser binaryはbase imageの`/ms-playwright`を使い、`npm ci`時は
  `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`でダウンロードしません。本番依存(`npm ci --omit=dev`)に
  加えて`node_modules/playwright-core`だけをdev install stageからコピーします。
- Chromium sandboxを有効にしたまま起動します(`--no-sandbox`は使いません)。Container Apps
  Jobの設定でsandboxが起動できない場合でも、sandboxを無効にする回避はしません(設計 §7.5)。
- Container Apps Job側では**読み取り専用filesystem**、1 vCPU・2GB、最大2件並列、
  `replicaTimeout`はJob実行上限(45秒)に合わせます。Chromiumは書き込み可能な`/tmp`を
  必要とするため、`/tmp`だけをemptyDir相当の書き込み可能volumeにします。
- 再試行はStorage Queueの再配信で行うため、Job側の再試行(`replicaRetryLimit`)は0にします。
  ワーカーは再試行に回した実行だけ終了コード1で終わります(監視用)。

### Display / Preview Job / Maintenance Job

Display、Preview Job、Maintenance Jobは`DATABASE_URL`、Storage接続設定
(`AZURE_STORAGE_CONNECTION_STRING`または`AZURE_STORAGE_ACCOUNT_NAME`、
`AZURE_STORAGE_CONTAINER`)、`LOG_HMAC_KEY`を共通で必要とします。本番での
Managed Identity必須・接続文字列禁止はWebと同じ制約です。

| 変数 | 対象 | 内容 |
|---|---|---|
| `PORT` | Display | Displayが待受けるport(既定8080、Web・Migration・Maintenanceと同じNode.js imageを使う) |
| `APP_ORIGIN` | Display | `POST /display`で許可する唯一のOrigin(Webのオリジン)。scheme+host+portのみ許可 |
| `GRANT_VERIFICATION_KEYS` | Display | 表示grant検証用のEd25519公開鍵(PEM)を`keyId`付きJSON配列で保持する。Displayは公開鍵だけを持ち、新旧`keyId`を併用してrotationできる |
| `GRANT_MAX_AGE_SECONDS` | Display | 受け付けるgrantの最大有効期間(既定60秒、最大120秒) |
| `DISPLAY_MAX_POST_BODY_BYTES` | Display | hidden formのPOST body上限(既定8KB、最大16KB) |
| `AZURE_STORAGE_QUEUE_NAME` | Preview | プレビュー生成メッセージのqueue名 |
| `QUEUE_VISIBILITY_TIMEOUT_SECONDS` | Preview | メッセージのvisibility timeout(既定60秒) |
| `QUEUE_MESSAGE_PROCESSING_TIMEOUT_SECONDS` | Preview | 1メッセージの処理上限(既定30秒) |
| `PREVIEW_JOB_MAX_RUNTIME_SECONDS` | Preview | Job実行上限(既定45秒) |
| `QUEUE_MAX_DEQUEUE_COUNT` | Preview | `dequeueCount`による最大試行回数(既定3回) |
| `MAX_PREVIEW_IMAGE_BYTES` | Preview | プレビュー画像1件あたりの上限(既定1MB) |
| `MAINTENANCE_JOB_MAX_RUNTIME_SECONDS` | Maintenance | Job実行上限(既定900秒)。超えたら新しいバッチを始めずに終了する |
| `MAINTENANCE_BATCH_SIZE` | Maintenance | DBの抽出・削除1回あたりの件数(既定500) |
| `MAINTENANCE_BLOB_LIST_PAGE_SIZE` | Maintenance | Blob一覧1ページの件数(既定200) |
| `MAINTENANCE_ORPHAN_BLOB_GRACE_HOURS` | Maintenance | 孤児Blobと判定するまでの猶予(既定24時間、最小1時間) |
| `MAINTENANCE_UPLOAD_ATTEMPT_RETENTION_DAYS` | Maintenance | `upload_attempts`の古い行を残す日数(既定7日) |

Preview Jobは上記に加えて、1実行で1メッセージだけを処理し、`dequeueCount`が
`QUEUE_MAX_DEQUEUE_COUNT`に達した失敗でプレビュー状態を`failed`にして監査を残します
(設計 §7.5)。`QUEUE_MESSAGE_PROCESSING_TIMEOUT_SECONDS`は
`QUEUE_VISIBILITY_TIMEOUT_SECONDS`以下、`PREVIEW_JOB_MAX_RUNTIME_SECONDS`は
`QUEUE_MESSAGE_PROCESSING_TIMEOUT_SECONDS`以上である必要があり、満たさない場合は
起動時の環境変数検証で失敗します。

Maintenance Jobは上記に加えて、**保守専用のDB role**(`siryou_mite_maintenance`)の
資格情報で`DATABASE_URL`を設定します。runtime role(`siryou_mite_runtime`)には
purge用のDELETE権限を与えていないため、runtime roleの接続では1年経過後のpurge
(設計 §16)が失敗します。保持期間(1年)は設計値のため環境変数にしていません。

各サービスのManaged Identityは用途別に分離し(設計 §7.4)、DB roleとStorageロールは
最小権限にします。Maintenance JobのStorage権限はBlobの一覧・削除が必要です
(HTML・プレビューの削除と孤児Blobの掃除)。

`NODE_ENV`はWeb・Display・Preview・Maintenanceのどれも既定値`development`で、明示的に
設定しない限り本番制約(`AZURE_STORAGE_CONNECTION_STRING`禁止・`AZURE_STORAGE_ACCOUNT_NAME`
必須、Webは`AUTH_MODE=easyauth`必須)が働きません。本番・stagingを問わず、Azure上で
稼働させる全プロセスへ`NODE_ENV=production`を必須で設定します。

## Easy Auth・Entra ID設定変更

本番は`AUTH_MODE=easyauth`とし、`ENTRA_TENANT_ID`をEasy Authのsingle-tenant issuerと
一致させます。利用許可はエンタープライズアプリの「割り当てが必要」と`User`・`Admin`
App Roleで管理し、メールドメインでは判定しません。

App Roleまたは所属グループの割り当てを変更した場合は、対象利用者の再ログイン後に
`/.auth/me`のclaimsとアプリ画面を確認します。確認時にprincipal、token、Cookie全文を
チケットやログへ貼り付けず、claim typeとマスキングした値だけを共有します。緊急遮断は
Entra IDの割り当て解除・アカウント制御とセッション失効手順を組み合わせます。

## DBマイグレーション

`migrations/`配下のSQL migrationを`node-pg-migrate`で適用します。forward-onlyとし、
自動down migrationは行いません(破壊的変更は新しいmigrationファイルを追加する2段階
変更にします、設計 §7.4)。

- ローカル・devcontainer: `npm run db:migrate`(`.devcontainer/docker-compose.yml`が
  設定する`DATABASE_URL`を使い、`postgres`serviceの`public`schemaへ適用する)
- 新しいmigrationファイルの雛形作成: `npm run db:migrate:create -- <名前>`
  (SQL形式で`migrations/`直下に作成される)
- production: 専用Managed IdentityのMigration Jobがdeploy前に1回実行する
  (runtime identityにはDDL権限を与えない、設計 §7.4)。Migration Job用の
  `DATABASE_URL`はManaged IdentityのEntra ID access tokenをpasswordとして使う

`documents`・`audit_events`のrole権限分離(設計 §7.4, §12.2):

- runtime用DB role(`siryou_mite_runtime`という名前を仮定)には、`documents`へ
  SELECT/INSERT/UPDATEだけ、`audit_events`へSELECT/INSERTだけを与える
  (`restrict-runtime-role-privileges` migration)。DELETEはどちらにも与えない
  (削除は`documents.status`の更新で表すsoft deleteのため)
- このroleが存在しない環境(ローカル・CI)ではmigrationは何もせず成功する。
  Managed Identityと対応付ける実際のrole作成・用途別分割はIaC(Bicep)側の
  別タスクで行う
- `audit_events`は追記専用で、`BEFORE UPDATE OR DELETE` triggerがDB role設定に
  関わらずUPDATEを拒否する。DELETEは設計 §16の1年経過後の自動削除だけを通すため、
  `add-maintenance-role-and-purge-support` migrationで「`retain_until`を過ぎた行」
  かつ「保守role(`siryou_mite_maintenance`)またはテーブル所有者からの削除」に限って
  許可する。runtime roleにはDELETEをGRANTしないため、Web・Display・Previewの
  接続からは引き続き削除できない
- 保守role(`siryou_mite_maintenance`)には`documents`へSELECT/UPDATE/DELETE、
  `audit_events`・`upload_attempts`へSELECT/DELETEだけを与える(監査へのINSERT・
  UPDATEは与えない)。runtime roleと同じく、roleが存在しない環境では
  migrationは何もせず成功する

結合テスト`npm run test:integration`(`tests/integration/`)は、ローカルPostgreSQLへ
専用schemaを作ってmigrationを適用し、テーブル・制約・indexと追記専用の拒否動作を
検証します。`npm run test`・`npm run verify`には含まれないため、CIへ組み込む場合は
別途PostgreSQL service containerの起動が必要です。

定期保守Jobの結合テスト(`tests/integration/maintenance-job.test.ts`)は、テスト専用
schemaのPostgreSQLとAzuriteに対して本番と同じ組み立て(`createMaintenanceRuntime`)で
Jobを動かし、Blob削除再試行の冪等性、`blob_cleanup_pending`と1年未満の資料・監査を
purgeしないこと、孤児Blob掃除が猶予内のBlobと想定外のキーに触らないこと、
`upload_attempts`のpurge、そしてruntime roleが`audit_events`をDELETEできないままで
あることを検証します(設計 §7.7, §16, §18.2)。roleごとの挙動は、テスト用に作った
`siryou_mite_runtime`/`siryou_mite_maintenance` roleへ`SET ROLE`して確認します。

Display(HTML表示サービス)の結合テスト(`tests/integration/display-service.test.ts`)は、
テスト専用schemaのPostgreSQLとAzuriteに対して本番と同じ組み立てでDisplayを起動し、
表示grantの正常系・60秒以内の再利用・期限切れ・削除直後の拒否・CSPヘッダーを検証します
(設計 §18.2)。

同じ結合テスト(`tests/integration/blob-queue.test.ts`)はAzuriteへも接続し、
専用container/queueを作ってBlob/Queue操作(保存・取得・削除、送受信、timeout)を
検証します(設計 §7.3, §7.5, §18.2)。`AZURE_STORAGE_CONNECTION_STRING`は
devcontainerの`docker-compose.yml`がAzurite(`azurite:10000`/`10001`)向けの値を
供給し、`tests/integration/helpers/env.ts`はダミー値で上書きしません(実接続文字列が
無いとテストは失敗します)。`tests/integration/helpers/storage.ts`の
`assertLocalStorageConnection`が接続先host(`azurite`/`localhost`/`127.0.0.1`以外)を
検査し、ローカルのAzurite以外を指す接続文字列ではcontainer/queueの作成・削除が
実行される前に例外で止めます(本番Azure Storageへ結合テストが接続しないためのガード)。
CIへ組み込む場合はPostgreSQLと同様に、Azuriteのservice container起動と
`AZURE_STORAGE_CONNECTION_STRING`(Azuriteのホスト名を指す接続文字列)の設定が
別途必要です。

Preview Job(プレビュー生成ワーカー)の結合テストは2本あります。
`tests/integration/preview-worker.test.ts`は、テスト専用schemaのPostgreSQLとAzuriteに
対して本番と同じ組み立て(`createPreviewRuntime`)でワーカーを動かし、重複配信・
再試行(`dequeueCount` 1→2→3)・処理上限(timeout)・削除済み資料・不正メッセージの
扱いを検証します(撮影だけは固定JPEGへ差し替えます)。
`tests/integration/preview-capture.test.ts`は**実際のChromium**を起動し、sandbox有効の
まま1280x720のJPEGを撮影できること、HTMLが参照する外部URLへ1件も接続しないこと
(ローカルHTTPサーバーで観測)、JavaScriptが実行されないこと、上限byte数に収まらない
場合に失敗することを検証します。このテストにはPlaywrightのbrowser binaryが必要で、
devcontainerには導入済みです。CIで実行する場合は
`npx playwright install --with-deps chromium`(`@playwright/test`と同じversion)が
必要です。

## バックアップ

- PostgreSQL point-in-time restoreとBlob soft deleteを7日間保持する
- RPO 24時間、RTO 8時間を目標とする
- production、stagingともLRSを使い、HA、ゾーン冗長、別region複製は行わない
- 利用者削除後もAzure内部の暗号化された復旧用copyへ最大7日残ることを前提とする
- 復元操作は運用管理者に限定し、監査対象とする
- 四半期ごとにstaging相当環境で復元試験を行う

## デプロイ

- Pull Requestでは`npm run verify`、image build、Bicep validationだけを行う
- `main` mergeでstagingへ自動deployする
- GitHub ActionsはOIDC認証のGitHub-hosted runnerを使う
- private PostgreSQLのmigrationとprivate endpointのsmoke testはVNet内のContainer Apps
  Jobとして実行し、GitHub ActionsはAzure管理APIから終了状態だけを確認する
- productionはGitHub Environmentの手動承認後に同じimage digestを昇格する
- ACRは認証付きpublic endpoint、管理者account無効、runtimeは`AcrPull`を使う
- production/non-productionのservice principalとfederated credentialを分離する
- `authsettingsV2`をBicepでdeployし、Easy Authのtenant、audience、除外path、Token Storeが
  設計値と一致することを確認する
- staging smoke testでは`/health`が匿名で成功し、業務routeが未認証時にEntra IDへ遷移し、
  実ログイン後に`roles`と複数`groups`を取得できることを確認する

## 定期Job

- Preview Jobは1実行1メッセージ、最大3回試行する(`dequeueCount`で判定し、3回目の
  失敗でプレビュー状態を`failed`にして監査を保存してからメッセージを削除する)
- Preview Jobは専用image(`Dockerfile.preview`)で動き、Chromium sandbox有効・
  JavaScript無効・外部ネットワーク接続なしで撮影する
- Migration Jobはdeploy前に1回実行し、失敗時はrevisionを更新しない
- Maintenance Jobは毎日UTC 18:00（JST 03:00）に実行し、並列実行しない
  (`parallelism: 1`。同時に2つ動いても結果は壊れないが、無駄な競合を避ける)
- Maintenance Jobは1回の実行で次の5つを順に行う(1つが失敗しても残りは実行する)
  1. `blob_cleanup_pending`の資料のHTML・プレビューBlobを冪等に再試行削除する
  2. `retain_until`(記録から1年)を過ぎた監査履歴をpurgeする
  3. 1年経過した削除済み資料の最小メタデータをpurgeする
  4. DBに行が無い孤児Blobを、最終更新から猶予(既定24時間)を過ぎたものだけ削除する
  5. `upload_attempts`の古い行(既定7日より前)をpurgeする
- `blob_cleanup_pending`の資料metadataはBlob削除完了までpurgeしない
- 監査が残っている資料メタデータはpurgeしない(監査のFK)。監査が先にpurgeされた
  次回以降の実行で対象になる
- 処理ごとに`{"event":"maintenance_task_finished","task":...,"examined":...,
  "succeeded":...,"failed":...}`を1行のJSONで出力する。1件でも失敗があれば
  終了コード1で終わる(設計 §17「Maintenance Jobの失敗」の監視対象)。件数は途中で
  例外が出た場合もそこまでの実績を保つ
- Blobは削除できたのに`blob_cleanup_pending`を下ろせなかった場合は
  `maintenance_blob_cleanup_flag_unchanged`(`errorCategory: database_failed`)を
  出力する。その資料は翌日以降も再試行対象として残るため、継続して出る場合は調査する
- Job実行上限(既定900秒)を超えると新しいバッチを始めずに終了する。すべての処理は
  冪等なので、残りは翌日の実行が続きから処理する
