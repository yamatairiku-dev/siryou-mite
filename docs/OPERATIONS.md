# 運用手順

## 役割

| 役割 | 責任 |
|---|---|
| アプリ責任者 | 利用部門調整、リリース承認 |
| 保守担当 | 更新、監視、一次障害対応 |
| レビュー担当 | コード・セキュリティレビュー |
| 基盤担当 | Container Apps Easy Auth、コンテナ、シークレット、ネットワーク |

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
Container AppsのKey Vault参照で渡します。`SESSION_SECRET`はlocal開発
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

### Web(Container Apps)

| 変数 | 内容 | 本番での扱い |
|---|---|---|
| `NODE_ENV` | 実行環境 | 本番・stagingは`production`を必須設定(fail closedの本番制約が働く条件) |
| `PORT` | Webが待受けるport(既定3000) | Container Appsのingressの`targetPort`(8080)に合わせる |
| `APP_NAME` | 画面タイトル等に表示するアプリ名 | 既定値は`資料みて！`。検証環境などで見分けたい場合だけ変更する |
| `APP_ORIGIN` | Webのオリジン | 同一オリジン検証(`assertSameOrigin`)とEasy Auth callbackの基準になる値と一致させる |
| `AUTH_MODE` | 認証方式(`dev`/`easyauth`) | `NODE_ENV=production`のときは`easyauth`必須(`dev`は起動時のZod検証で拒否される) |
| `SESSION_SECRET` | ローカル`AUTH_MODE=dev`専用のセッション署名鍵 | 本番(`AUTH_MODE=easyauth`)では設定しない |
| `SESSION_MAX_AGE_SECONDS` | `AUTH_MODE=dev`セッションの有効期間 | 同上、本番では未使用 |
| `ENTRA_TENANT_ID` | Easy Authと一致させるEntra ID tenant | `AUTH_MODE=easyauth`のとき必須。principalの`tid`照合に使う |
| `DATABASE_URL` | PostgreSQL接続文字列 | Azure上は`postgres://<Managed Identityの名前>@<server>.postgres.database.azure.com:5432/<DB名>`の形でpasswordを書かない(passwordを含めるとZod検証で拒否) |
| `DATABASE_AUTH` | DB認証方式(`password`/`entra`、既定`password`) | 本番・stagingは`entra`必須(`NODE_ENV=production`で`password`はZod検証で拒否)。`entra`ではManaged IdentityのEntra ID access tokenを接続ごとに取得してpasswordに使う |
| `AZURE_CLIENT_ID` | user-assigned Managed IdentityのclientId | DB・Storageへの接続に使うidentityを指定する(`DefaultAzureCredential`が読む)。実行単位ごとに別のidentityを設定する |
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
| Web(Container Apps) | `node node_modules/@react-router/serve/bin.cjs ./build/server/index.js`(imageの既定CMD) |
| Display(Container Apps) | `node build/services/display/index.js` |
| Migration Job | `node build/services/migrate/index.js` |
| Maintenance Job | `node build/services/maintenance/index.js` |
| DB初期設定Job | `node build/services/db-bootstrap/index.js` |

DisplayはWebと同じ`/health`(`GET`のみ)を持つため、imageのHEALTHCHECKは両方で使えます。
Displayは`SIGTERM`・`SIGINT`で待受けを止め、DB接続を閉じてから終了します(猶予10秒)。

#### Preview Job専用image(`Dockerfile.preview`)

Preview JobだけはChromiumを含む専用image(`Dockerfile.preview`)を使います(設計 §7.6。
imageは合計2種類)。起動commandは`node build/services/preview/index.js`です。

- base imageは`mcr.microsoft.com/playwright:v1.63.0-noble`で、tagは`package.json`の
  `@playwright/test`のversionと**必ず一致**させます。`@playwright/test`を更新するときは
  同じPRでbase imageのtagも上げます(不一致だとPreview Jobの起動時にbrowserが見つからず
  失敗します)。一致は単体テスト(`tests/unit/services/preview-image-version.test.ts`)が
  CIで確認するため、Dependabotが`@playwright/test`だけを上げたPRはCIが失敗します。
- ローカルのDocker(既定のseccomp profile)では、Chromium sandbox有効のままだと
  `No usable sandbox!`で起動できません(2026-09-30に確認。`--security-opt seccomp=unconfined`
  なら起動する)。Container Apps上でsandboxが使えるかは設計 §21のsecurity spikeで確認します。
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

Display、Preview Job、Maintenance Jobは`DATABASE_URL`・`DATABASE_AUTH`、Storage接続設定
(`AZURE_STORAGE_CONNECTION_STRING`または`AZURE_STORAGE_ACCOUNT_NAME`、
`AZURE_STORAGE_CONTAINER`)、`LOG_HMAC_KEY`を共通で必要とします。本番での
Managed Identity必須(`DATABASE_AUTH=entra`、`AZURE_CLIENT_ID`)・接続文字列禁止はWebと
同じ制約です。

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
- Azure(staging・production): 専用Managed IdentityのMigration Job
  (`node build/services/migrate/index.js`)がdeploy前に1回実行する(runtime identityには
  DDL権限を与えない、設計 §7.4)。`NODE_ENV=production`・`DATABASE_AUTH=entra`・
  `AZURE_CLIENT_ID`(Migration用identity)を設定し、`DATABASE_URL`の利用者名をMigration用
  identityの名前にする。オプションは`npm run db:migrate`(CLIの既定値)と同じで、
  失敗時は例外の種類とSQLSTATEだけを`migrate_job_failed`として出力する
- Azureでは**DB初期設定Jobを先に実行する**(次節)。roleが無い状態でmigrationを適用すると
  GRANTが飛ばされたまま記録され、forward-onlyのため再適用されない

`documents`・`audit_events`のrole権限分離(設計 §7.4, §12.2):

- runtime用DB role(`siryou_mite_runtime`という名前を仮定)には、`documents`へ
  SELECT/INSERT/UPDATEだけ、`audit_events`へSELECT/INSERTだけを与える
  (`restrict-runtime-role-privileges` migration)。DELETEはどちらにも与えない
  (削除は`documents.status`の更新で表すsoft deleteのため)
- このroleが存在しない環境(ローカル・CI)ではmigrationは何もせず成功する。
  Azureでは、Managed Identityと対応付ける実際のrole作成をDB初期設定Job(次節)が行う
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

### DB初期設定Job(`services/db-bootstrap/`)

各実行単位のManaged IdentityをPostgreSQLの利用者(role)として登録し、最小権限を付ける
Jobです。PostgreSQLはprivate endpointだけで公開するため、VNet内のContainer Apps Jobとして
実行します。環境の構築時と、Managed Identityを追加・作り直したときに実行します(冪等)。

1. 各Managed IdentityのEntra principalを`pgaadauth_create_principal_with_oid`で作る
   (object IDで作るため、名前の付け替えに影響されない)
2. login不可のまとめ役role `siryou_mite_runtime`・`siryou_mite_maintenance`を作り、
   Web・Display・Previewのidentityをruntimeへ、Maintenanceのidentityをmaintenanceへ入れる
3. 業務DBが無ければ作る(このJobのidentityが所有者になる)
4. Migration Jobのidentityへ`public` schemaのUSAGE・CREATEを、まとめ役roleへUSAGEを与える
5. まとめ役roleを今回新しく作ったのに業務DBがmigration済みなら、テーブル権限が欠けて
   いるため失敗(`MigrationsAppliedBeforeRolesError`)にする

| 変数 | 内容 |
|---|---|
| `NODE_ENV` | `production` |
| `DATABASE_URL` | 業務DBの接続文字列。利用者名はPostgreSQLのEntra管理者にした、このJob専用のManaged Identityの名前 |
| `DATABASE_AUTH` | `entra` |
| `AZURE_CLIENT_ID` | このJob専用のManaged IdentityのclientId |
| `DB_BOOTSTRAP_ADMIN_DATABASE` | principalを作る管理用DB(既定`postgres`) |
| `DB_BOOTSTRAP_PRINCIPALS` | 対象identityのJSON配列。`[{"name":"<identity名>","objectId":"<principalId>","role":"runtime"\|"maintenance"\|"migration"}]`。`migration`はちょうど1つ |

ログには役割と件数だけを出し、identity名・object ID・接続先は出しません。
`pgaadauth_create_principal_with_oid`の動作はローカルで再現できないため、結合テスト
(`tests/integration/db-bootstrap.test.ts`)は同名のstub関数で代替し、superuserでない
管理者(CREATEROLE・CREATEDB)で「初期設定 → Migration Jobのidentityでmigration →
用途別の権限確認 → 再実行」を確認しています。Azure上での動作はstagingで確認します。

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
- Container Appsの`authConfigs`をBicepでdeployし、Easy Authのtenant、audience、除外path、Token Storeが
  設計値と一致することを確認する
- staging smoke testでは`/health`が匿名で成功し、業務routeが未認証時にEntra IDへ遷移し、
  実ログイン後に`roles`と複数`groups`を取得できることを確認する

## Azureへのデプロイ(staging・開発用テナント)

最初の検証環境は、会社の正式なテナントとは別の**開発用テナント**に作ります(本番は会社の
テナントで別途構築する)。Bicepは`infra/main.bicep`、stagingの値は
`infra/parameters/staging.bicepparam`です。自動デプロイ(GitHub Actions)は次の段階で
用意するため、ここでは手元のAzure CLIから手動で実行します。

### 構成(設計 §7, §8 とstagingの差分)

- 社内ネットワークが無いため、VNet・サブネット・Private DNSゾーンはこのBicepで新規作成する
- Web・Display・各Jobは同じContainer Apps環境で動かす(設計 §7.6)。環境は内部環境にせず、
  WebとDisplayを公開エンドポイントにし、`SIRYOU_ALLOWED_IP_RANGES`で許可したIPアドレス
  からだけ受け付ける(設計 §8 の「社内ネットワークからだけ到達」の代わり)。ホスト名は
  Azure既定(`*.azurecontainerapps.io`)
- PostgreSQL・Storage(Blob・Queue)・Key Vaultはprivate endpointだけで公開し、
  public network accessは無効(設計どおり)。Storageのアカウントキーと
  PostgreSQLのpassword認証も無効にし、Managed Identityだけで接続する
- Container Apps環境のサブネットはNSGでインターネットへの通信を拒否し、イメージの取得・
  Entra ID・監視に必要な宛先だけを許可する(設計 §8)。新しいVNetには既定の外向き通信が
  無いため、Container Apps環境のサブネットにNAT Gatewayを付ける

概算費用(Japan East、1ドル150円、2026-10時点の公開価格からの目安。正式な見積もりは
設計 §21 の未決事項): Container AppsのWeb(0.5 vCPU・1GiB・最小1レプリカ)約1,800円、
PostgreSQL B1ms+32GB 約2,500円、private endpoint 4個 約4,400円、NAT Gateway+固定IP
約5,500円(+通信量)、ACR Basic 約750円、Log Analytics・Display・各Job(従量)少額で、
合計**月1.5万〜2万円程度**。

### 0. 前提

- Azure CLI(`az`)、開発用テナントのサブスクリプションの所有者権限、Entraのアプリ登録権限
- 開発用テナントのEntra ID P1以上(グループをアプリへ割り当てるために必要。無い場合は
  下の「1.」の注記を参照)

```bash
az login --tenant <開発用テナントのID>
az account set --subscription <サブスクリプションID>
for ns in Microsoft.App Microsoft.ContainerRegistry Microsoft.DBforPostgreSQL \
  Microsoft.KeyVault Microsoft.Network Microsoft.OperationalInsights Microsoft.Storage \
  Microsoft.ManagedIdentity Microsoft.Insights; do
  az provider register --namespace "$ns"
done
```

### 1. Entra IDのアプリ登録(Easy Auth用、設計 §7.1.1, §7.1.2)

```bash
APP_ID=$(az ad app create --display-name "資料みて！(検証)" \
  --sign-in-audience AzureADMyOrg --enable-id-token-issuance true \
  --app-roles @infra/entra/app-roles.json \
  --optional-claims @infra/entra/optional-claims.json --query appId -o tsv)
az ad app update --id "$APP_ID" --set groupMembershipClaims=ApplicationGroup
az ad sp create --id "$APP_ID"
az ad sp update --id "$APP_ID" --set appRoleAssignmentRequired=true
```

- App Role `User`・`Admin`(`infra/entra/app-roles.json`)と、IDトークンの`groups`
  (所属グループ。クラウドのグループは表示名を発行する`cloud_displayname`)を設定する
- client secretは作らない(Easy AuthはIDトークンだけを使い、Token Storeも使わない)
- Entra管理センターの「エンタープライズアプリケーション」→このアプリ→「ユーザーとグループ」で、
  利用者へ`User`または`Admin`を、所属グループ(名前を所属コードにする。例: `ZAA535-A`)を
  アプリへ割り当てる。`ApplicationGroup`は**アプリへ割り当てたグループだけ**を発行する
- 注記: グループのアプリへの割り当てにはEntra ID P1以上が必要。開発用テナントがFreeの場合は
  P2の試用版を有効にするか、検証用に`groupMembershipClaims=SecurityGroup`(利用者が属する
  全セキュリティグループを発行。設計とは異なる)を使う。どちらを使ったかは記録しておく
- リダイレクトURIは手順5でWebのURLが決まってから登録する

### 2. 鍵の生成(リポジトリの外へ)

```bash
node infra/scripts/generate-keys.mjs ~/siryou-mite-stg-keys.env
```

grant署名用Ed25519鍵ペアとログ用HMAC鍵を、所有者だけが読める(600)ファイルへ書き出す
(画面には表示しない)。このファイルはcommit・共有しない。

### 3. 基盤のデプロイ(1段階目)

```bash
RG=rg-siryou-mite-stg
az group create --name "$RG" --location japaneast

export SIRYOU_TENANT_ID=$(az account show --query tenantId -o tsv)
export SIRYOU_ENTRA_CLIENT_ID="$APP_ID"
export SIRYOU_ALLOWED_IP_RANGES="<許可するIP>/32"      # カンマ区切りで複数可
export SIRYOU_ALERT_EMAIL="<通知先メールアドレス>"
set -a; . ~/siryou-mite-stg-keys.env; set +a

az deployment group create --resource-group "$RG" --name siryou-mite-infra \
  --parameters infra/parameters/staging.bicepparam
```

VNet、NAT Gateway、Private DNS、Log Analytics、Managed Identity 6個、Storage、
Key Vault(鍵を登録)、PostgreSQL(Entra管理者はDB初期設定Job用identity)、ACRを作る。

### 4. イメージのbuildとpush

ACR Tasksでクラウド上でbuildする(手元にDockerは不要)。

```bash
ACR=$(az deployment group show -g "$RG" -n siryou-mite-infra \
  --query properties.outputs.registryName.value -o tsv)
TAG=$(git rev-parse --short HEAD)
az acr build --registry "$ACR" --image "siryou-mite:$TAG" --file Dockerfile .
az acr build --registry "$ACR" --image "siryou-mite-preview:$TAG" --file Dockerfile.preview .
```

### 5. アプリとJobのデプロイ(2段階目)

```bash
export SIRYOU_DEPLOY_APPS=true SIRYOU_IMAGE_TAG="$TAG"
az deployment group create --resource-group "$RG" --name siryou-mite-apps \
  --parameters infra/parameters/staging.bicepparam

# Easy AuthのリダイレクトURIをアプリ登録へ追加する
REDIRECT=$(az deployment group show -g "$RG" -n siryou-mite-apps \
  --query properties.outputs.entraRedirectUri.value -o tsv)
az ad app update --id "$APP_ID" --web-redirect-uris "$REDIRECT"
```

### 6. DB初期設定 → マイグレーション

DB初期設定Jobを**先に**実行し、成功してからMigration Jobを実行する。

```bash
az containerapp job start -g "$RG" -n caj-siryou-mite-stg-dbbootstrap
az containerapp job execution list -g "$RG" -n caj-siryou-mite-stg-dbbootstrap \
  --query "[0].properties.status" -o tsv          # Succeeded になるまで確認
az containerapp job start -g "$RG" -n caj-siryou-mite-stg-migrate
az containerapp job execution list -g "$RG" -n caj-siryou-mite-stg-migrate \
  --query "[0].properties.status" -o tsv
```

失敗した場合はLog Analyticsの`ContainerAppConsoleLogs_CL`で`db_bootstrap_failed`・
`migrate_job_failed`(例外の種類とSQLSTATEだけを出力)を確認する。

### 7. 動作確認

`RELEASE_CHECKLIST.md`の「ステージング」を確認する。少なくとも、`<Webのオリジン>/health`が
匿名で成功し、業務画面が未認証時にEntra IDへ遷移し、ログイン後にアップロード・表示・
プレビュー生成ができること。

### stagingで確認が必要な点(未検証)

Bicepは構文・型・lintまで検証済み(CIの`bicep` job)で、Azureへのデプロイはまだ行っていない。
次は構成上の前提で、実際の環境で確認する。

1. WebのEasy Auth(認証sidecar)が、インターネットを拒否したContainer Apps環境のNSG
   (`AzureActiveDirectory`サービスタグだけ許可)のままEntra IDのOIDCメタデータ・署名鍵を取得し、
   ログインできる
2. Container AppsのKey Vault参照(secret。Webのgrant署名鍵を含む)がprivate endpoint経由で解決できる
3. Preview JobのKEDA scaler(azure-queue、Managed Identity)がprivate endpointのみのQueueの長さを読める
4. DB初期設定Jobの`pgaadauth_create_principal_with_oid`と、Entra管理者による業務DB作成・権限付与
5. Container Apps環境のNSG(インターネット拒否)でイメージ取得・Managed Identityのtoken取得ができる
6. Container Apps Job上でChromium sandboxが有効のまま起動できる(設計 §21 のsecurity spike)
7. Container AppsはコンテナのファイルシステムをRead-onlyにする設定を持たないため、設計 §7.5
   「読み取り専用filesystem」は満たせない(`/tmp`だけ書き込み可能にする構成は維持)
8. Job失敗(Preview・Migration・Maintenance)の通知(設計 §17)は未作成。ログの形を確認してから
   Log Analyticsのアラートを追加する
9. Key Vault(public network access無効・`bypass: None`)へ、デプロイ(ARM)で秘密値を
   登録できる(秘密値の登録は管理プレーン経由のため可能な想定)

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

## ローカル開発環境のデータ

E2E(`npm run test:e2e`)はテストが作った資料・監査行・Blobを削除しません。監査履歴は
追記専用で、アップロード監査が残る資料行も物理削除できないためです。テストごとに
ランダムな利用者を使うので結果には影響しませんが、繰り返し実行するとdevcontainerの
PostgreSQLとAzuriteのデータが増え続けます。

データを作り直す場合は、devcontainerの外(ホスト側)で次を実行してvolumeを削除し、
devcontainerを再起動してから`npm run db:migrate`を実行します。ローカルのデータはすべて
消えます。

```sh
docker compose -f .devcontainer/docker-compose.yml down
docker volume rm siryou-mite-local_postgres_data siryou-mite-local_azurite_data
```
