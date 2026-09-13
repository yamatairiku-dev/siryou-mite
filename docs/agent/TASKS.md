# 実装タスク一覧(自律実装用)

このファイルは司令塔エージェントが読み書きする実装タスクの正本です。
人が順序や範囲を変更してかまいません。

- 状態: `[ ]` 未着手 / `[~]` 作業中 / `[x]` 完了 / `[!]` ブロック(理由は `QUESTIONS.md`)
- 🔒: セキュリティ上重要なタスク。実装担当は opus で起動し、reviewer のセキュリティ観点を必須とする
- 「設計」の§番号は `docs/APPLICATION_DESIGN.md` の節番号
- 着手できるのは、依存タスクがすべて `[x]` のタスクだけ

## Phase 0: 共通基盤(契約を先に固める。並列化しない)

### T01 [x] 依存関係・ディレクトリ構成・サービス用build
- 実装メモ: 6依存(+`@types/pg`)を追加し、`services/{display,preview,maintenance}/` を `tsconfig.services.json` で `build/services` へ出力、`npm run verify` に service typecheck/build を追加した
- 設計: §7.6, §19.1
- 依存: なし
- 内容:
  - `parse5`、`pg`、`node-pg-migrate`、`@azure/identity`、`@azure/storage-blob`、`@azure/storage-queue` を追加する
  - Display・Preview・Maintenance用のディレクトリ構成を決め(例: `services/<name>/`)、`tsconfig.services.json` で `build/services` へ出力する
  - `npm run verify` にservice typecheck/buildを追加する
  - 構成を `docs/ARCHITECTURE.md` に記録し、各依存の追加理由(開発規約§7の項目)を `docs/agent/DEPENDENCIES.md` に記録する
- 完了条件: `npm run verify` 成功。空のservice entryがbuildされる

### T02 [x] 環境変数スキーマの拡張
- 実装メモ: Web用(`app/lib/env.server.ts`)とservice用(`services/shared/env.ts` + 各`services/<name>/env.ts`)にスキーマを分離し、DB・Storage・grant鍵・HMAC鍵・§6.1の制限値をZodで検証(本番は接続文字列禁止のfail closed)
- 設計: §6.1(制限値), §7.2, §7.3, §9.5
- 依存: T01
- 内容: `DATABASE_URL`、Storage接続設定(ローカルは接続文字列、本番はManaged Identity)、`DISPLAY_ORIGIN`、grant鍵(Ed25519)、ログ用HMAC鍵、各種上限値をZodで検証する。Web用とservice用のスキーマを分ける
- 完了条件: 単体テストで必須・不正値・本番時の制約を検証。`.env.example` と `docs/OPERATIONS.md` を更新

### T03 [x] DBマイグレーション
- 実装メモ: `documents`・`audit_events` をforward-onlyのSQL migrationで作成し、監査は`BEFORE UPDATE OR DELETE` triggerで追記専用を強制、runtime roleは最小権限GRANT。`npm run db:migrate` と結合テスト設定(`vitest.integration.config.ts`)を追加した
- 設計: §7.4, §11, §12
- 依存: T01
- 内容: `node-pg-migrate` で `documents`・`audit_events` を作成する(forward-only)。`npm run db:migrate` を用意する。監査イベントは追記専用とし、runtime用roleで更新・削除できない前提のSQLにする
- 完了条件: devcontainerのPostgreSQLに対してmigrationが成功する。結合テストでテーブルと制約を確認

### T04 [x] DB接続とrepository層(資料・監査) 🔒
- 実装メモ: `app/lib/db/{pool,documents,audit-events}.server.ts` を追加。監査はINSERTのみ・Zod strict + error_category enumで禁止項目を型と実行時の両方で拒否、一覧はkeyset pagination(所有者条件必須)、更新系は`executor`必須で監査と同一transactionを強制。keysetタイブレーカ用indexのmigrationを追加した
- 設計: §7.4, §12, §15.1
- 依存: T02, T03
- 内容: `pg` Pool、`documents` repository、`audit_events` repository(追記のみ)、cursor paginationを実装する。SQLはrepositoryの `.server.ts` に置く。結合テスト用のvitest設定(`tests/integration`、ローカルPostgreSQL使用)を追加する
- 完了条件: 単体・結合テスト成功。監査に禁止項目(本文・ファイル名・token等)を保存しないことをテスト

### T05 [x] Blob・Queueクライアント
- 実装メモ: Blob/Queueの実処理を `services/shared/storage.ts` に集約し、Web は `app/lib/storage.server.ts` の薄いラッパー経由で参照。Blobキーは資料IDのUUID検証つき決定的導出、Queueメッセージは `schemaVersion` と `documentId` のみ(strict検証)、全操作に `abortSignal` timeout。SDK既定のAPIバージョンをAzuriteが拒否するため pipeline policy で `x-ms-version` を固定した
- 設計: §7.3, §7.5
- 依存: T02
- 内容: Blobキーを資料IDから決定的に導出し(`html/{id}/document.html`、`preview/{id}/preview.jpg`)、保存・取得・削除を実装する。Queueメッセージは `schemaVersion` と `documentId` だけ。ローカルはAzurite
- 完了条件: Azuriteに対する結合テスト成功。timeoutを設定している

### T06 [x] 認証・認可の設計適合 🔒
- 実装メモ: group overage(`hasgroups`/`_claim_names`/`_claim_sources`/`groups.link`)の検出と `tid` 未設定の fail closed を `easy-auth.server.ts` へ追加し、App Role 判定を `auth/roles.server.ts`、owner・admin 認可を `auth/authorization.server.ts` へ分離(認可は `oid` のみで判定)
- 設計: §4, §7.1, §7.1.2, §18.1
- 依存: なし
- 内容: 既存の `easy-auth.server.ts` / `session.server.ts` が設計を満たすか確認して不足分を補う(`tid`固定、`User`/`Admin` role、複数groupsと重複除去、overage・所属なしのfail closed、URI形式claim typeのallowlist)。owner・admin判定の認可ヘルパーを追加する
- 完了条件: §18.1の認証・認可系の単体テストがすべてある

## Phase 1: 業務コア

### T07 [x] HTML受け入れ検査 🔒
- 実装メモ: `app/lib/html/{inspection-codes.ts,inspection.server.ts}` にHTMLを書き換えない純粋関数として実装。拡張子・サイズ・UTF-8・空ファイル・`meta refresh`・`base href`・相対リンク・禁止scheme・外部resourceを判定し、文字参照やprotocol-relativeなどの回避策もfail closedで拒否。入れ子/要素数の上限で解析を打ち切る(Q-007〜Q-009)
- 設計: §6.1, §6.2, §6.3, §10.1(5), §18.1
- 依存: T01
- 内容: `parse5` で解析し、拡張子・サイズ・UTF-8・空ファイル、`meta refresh`、`base href`、ページ内以外の相対リンク、禁止scheme、外部resourceを判定する。拒否理由と警告コードを返す純粋関数として実装する(HTMLは書き換えない)
- 完了条件: §18.1のHTML・URL関連の単体テストを網羅

### T08 [x] 件数・容量・頻度・同時実行の制限 🔒
- 実装メモ: `app/lib/db/upload-limits.server.ts` に実装。1 transaction内で利用者→システムの順に `pg_advisory_xact_lock` を取り(システムは固定キーで直列化)、件数・容量・頻度・同時実行を判定する。進行中の予約は `upload_attempts` テーブル(lease方式)で表し、その予約byte数・件数を集計に加算して並行時の上限超過を防ぐ(Q-010〜Q-012)
- 設計: §6.1, §10.1(3)
- 依存: T04
- 内容: PostgreSQLのtransactionとadvisory lockで判定する。Redisなどは追加しない
- 完了条件: 結合テストで各上限と同時実行の競合を確認

### T09 [x] アップロード `POST /documents` 🔒
- 実装メモ: `app/routes/documents.ts`(POST以外は405)と `app/lib/upload/{upload,upload-request}.server.ts` に実装。§10.1の手順順に認証→同一オリジン→上限判定→streaming 10MB上限の検証→HTML検査→Blob保存→DB登録(監査と同一transaction)→Queue送信を行い、失敗時はBlob削除・予約枠解放・失敗監査で補償する。運用ログは `app/lib/log.server.ts`(oidはHMAC化)(Q-013〜Q-017)
- 設計: §7.1, §10.1, §10.2, §13
- 依存: T05, T06, T07, T08
- 内容: `application/octet-stream`、`X-File-Name`(base64url)、streaming中の10MB上限、UUID v4、Blob保存→DB登録→Queue送信、失敗時の補償処理、アップロード監査
- 完了条件: 正常系・各拒否・補償処理の単体/結合テスト

### T10 [x] 初期画面(アップロードUIと所有資料一覧)
- 実装メモ: `app/routes/app.tsx` にドロップ領域・1ファイル制限・警告表示・カード一覧(20件ずつcursor追加読込)を実装。loaderは`requireUser`の`oid`だけで`listDocumentsByOwner`を呼び、cursorはZod strictで検証して所有者条件を迂回できないようにした。日時のJST整形は`app/lib/format/document-view.ts`、`X-File-Name`のbase64urlは`app/lib/upload/file-name-header.ts`。`tests/setup.ts`に`afterEach(cleanup)`を明示登録(`globals: false`のためauto-cleanupが効いていなかった)
- 設計: §5.2, §5.3, §13
- 依存: T09
- 内容: ドロップ領域とファイル選択、1ファイル制限、警告表示、自分の資料だけを新しい順に20件ずつ表示するカード一覧、日時はJST表示
- 完了条件: route/コンポーネントの単体テスト。他人の資料が出ないことをテスト

### T11 [x] 表示grantの署名・検証 🔒
- 実装メモ: 署名・検証の実処理を `services/shared/grant.ts`(環境変数を読まない純粋関数)に集約し、Webは `app/lib/grant.server.ts` から署名のみ利用。`context.header.payload` の3セグメントをdomain separation付きでEd25519署名し、`kid`も署名対象に含める。検証は 形式→header→鍵解決→署名→payload→期限→対象 の順で、署名が通るまでpayloadを信用しない。未知keyId・`exp`超過・`exp-iat>maxAge`はfail closed(時計ずれは未来方向の`iat`に5秒のみ)
- 設計: §7.2, §9.5
- 依存: T02
- 内容: Ed25519、60秒有効、nonce、`keyId`による鍵rotation。grantにBlobキーやファイル名を含めない
- 完了条件: 正常・期限切れ・改ざん・対象不一致・未知keyIdの単体テスト

### T12 [x] HTML表示サービス(Display) 🔒
- 実装メモ: `services/display/{index,server,headers,dependencies}.ts` にNode.js標準HTTPサーバーで実装。`GET /health`・`POST /display` のみ公開し、Origin完全一致・body 8KBのstreaming打ち切り・クエリ文字列拒否・Cookie不使用で入口を絞る。grant検証(`result.valid`を明示判定)→DBで`active`再確認→Blob取得→閲覧監査INSERT→HTML返却の順で、監査保存に失敗したらHTMLを返さない。CSPは設計§9.2の12ディレクティブを記載順・記載値のまま実装し、`frame-ancestors`は`APP_ORIGIN`限定。grant検証失敗は監査を作らず運用ログのみ(Q-021)。あわせてDB・ログの実処理を `services/shared/{db,log}` へ移してDisplayから再利用可能にし(Q-005)、Dockerfileに`build:services`を追加した(Q-002)
- 設計: §7.2, §9.2, §10.3
- 依存: T04, T05, T11
- 内容: Node.js標準HTTPサーバー、`GET /health` と `POST /display` のみ、POST body 8KB上限、Origin検証、DBで `active` を再確認、閲覧監査を保存してから返す、CSPとsandboxのレスポンスヘッダー。grantとbodyをログに出さない
- 完了条件: 単体/結合テスト(grant再利用、期限切れ、削除直後の拒否、CSPヘッダー)

### T13 [x] 資料表示画面 `/documents/:documentId`
- 実装メモ: `app/routes/documents.$documentId.tsx` に実装。`requireUser`の既存`returnTo`(自身のpath+search)で同一URLへ戻し、`documentId`はZodの`z.uuid()`でDBアクセス前に検証、認可は`assertCanViewDocument`(所有者以外も`active`なら閲覧可・削除済みと未存在は同じ404)。grantはloader戻り値からhidden formのPOST bodyだけで`DISPLAY_ORIGIN/display`(クエリ無し)へ送り、URL・`<a href>`・ログには出さない。iframeのsandboxは`allow-popups allow-popups-to-escape-sandbox`のみ。期限切れ対策の`grantExpiresAt`と再取得導線はQ-024、タイトル表示はQ-025
- 設計: §5.4, §7.2, §9.2, §13
- 依存: T11, T12
- 内容: 未ログイン時は同じURLへ戻る、hidden formでgrantをiframeへPOST、iframe sandbox、URLコピー、初期画面へ戻る
- 完了条件: route単体テスト

### T14 [x] 削除(所有者・管理者) 🔒
- 実装メモ: `app/lib/documents/delete.server.ts`(処理本体・依存注入)と `app/routes/documents.$documentId.delete.tsx`(確認画面loader + 削除action)に実装。§10.4の順で`requireUser`→`assertSameOrigin`→Zod(`z.uuid()`)→**transaction内で資料を読み直した直後**に`requireDocumentDeletionScope`→owner/adminのrepository関数→同一txで削除監査(監査失敗はrollback)。Blob削除はcommit後で、HTML・プレビューの両方が成功したときだけ`markBlobCleanupCompleted`を呼び、失敗時は`blob_cleanup_pending`を立てたまま運用ログへ記録(再試行はT19)。初期画面の削除ボタンは確認画面へのGET遷移に変更(§5.5)。監査`action`は削除を一律`delete`に統一(Q-026)、未存在の拒否は`document_id=null`(Q-027)、確認画面の拒否は無監査(Q-028)、成功後は`/app`へ303(Q-029)
- 設計: §5.5, §10.4, §11, §12.1
- 依存: T09
- 内容: 確認画面、`active→deleted`、機微項目の消去、Blob削除失敗時の `blob_cleanup_pending`、削除監査、一般ユーザーによる他人の資料の削除拒否
- 完了条件: 認可・状態遷移・補償の単体/結合テスト

### T15 [x] プレビュー状態 resource route
- 実装メモ: `app/routes/documents.$documentId.preview-status.ts` にloaderのみのresource routeを追加。`requireUser`→`z.uuid()`(DB到達前)→`findDocumentById`→`assertCanViewDocument`の順で、削除済み・未存在・非UUIDは同じ404。応答は`{previewStatus}`だけで`securityHeaders()`(`Cache-Control: no-store`)付き。初期画面は`pending`の資料があるときだけ5秒間隔・最大24回ポーリングし、状態が確定したらtimerとfetchを後片付けして止める(Q-031)。`ready`の実画像配信経路は§13に無いため範囲外(Q-030)、この経路は監査しない(Q-032)
- 設計: §5.3, §13
- 依存: T09
- 内容: `/documents/:documentId/preview-status` と、カードでの処理中・失敗画像の切り替え
- 完了条件: 単体テスト

## Phase 2: 管理機能

### T16 [~] 管理画面 `/admin/documents` 🔒
- 設計: §5.6, §4.2
- 依存: T10, T14
- 内容: 資料ID・オーナーのメール・元ファイル名・日時で検索、閲覧、強制削除。管理操作の監査
- 完了条件: 一般ユーザーの拒否を含む単体テスト

### T17 [ ] 監査履歴画面 `/admin/audit` 🔒
- 設計: §5.7, §15
- 依存: T04, T16
- 内容: 日時・利用者・資料ID・操作・結果で検索。監査履歴の閲覧自体も監査する
- 完了条件: 単体テスト

## Phase 3: 非同期処理

### T18 [ ] プレビュー生成ワーカー(ローカル実行まで) 🔒
- 設計: §7.5
- 依存: T05, T12
- 内容: 1実行1メッセージ、`dequeueCount` 最大3回、JavaScript無効・外部通信なし・Chromium sandbox有効のPlaywright撮影、1280x720 JPEG・1MB以下、失敗時 `failed` と監査。専用Dockerfileを作成する(Container Appsでのsecurity spikeは対象外)
- 完了条件: Azuriteでの結合テスト(重複配信・再試行・timeout)

### T19 [ ] 定期保守Job
- 設計: §7.7, §16
- 依存: T14
- 内容: `blob_cleanup_pending` の冪等な再試行、削除済み資料と監査の1年経過後のpurge(Blob削除未完了はpurgeしない)。あわせてT09でBlob削除の補償自体が失敗した場合の孤児Blob(DBに行が無く回収経路が無い)の掃除と、T08で追加した `upload_attempts` の古い行(`finished_at` または `expires_at` が十分過去)をpurgeする(Q-011。runtime roleへのDELETE権限のGRANTもこのタスクのmigrationで追加する)
- 完了条件: 結合テスト

## Phase 4: 仕上げ

### T20 [ ] E2Eテスト
- 設計: §18.3
- 依存: T10, T13, T14, T16, T17
- 内容: Easy Authのprincipal headerをfixtureで再現する。本番で有効になり得る認証bypassは作らない
- 完了条件: `npm run test:e2e` 成功

### T21 [ ] ドキュメント整合と引き継ぎ
- 依存: T20
- 内容: `README.md`、`docs/ARCHITECTURE.md`、`docs/OPERATIONS.md` を実装に合わせて更新し、PR本文の下書きを `docs/agent/HANDOFF.md` にまとめる
- 完了条件: `npm run verify` と `npm run test:e2e` 成功

## エージェントの対象外(人が対応)

- `.github/workflows` の変更(CIへのPostgreSQL・Azurite service container追加など)。必要な差分は `QUESTIONS.md` に提案として記録する
- Bicep(`infra/`)とデプロイworkflow
- Container Apps Job上でのChromium sandbox security spike
- 設計書 §21 の未決事項
