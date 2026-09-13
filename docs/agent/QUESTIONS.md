# 確認事項・仮定の記録

自律実装中に設計書だけでは決められなかった点を記録します。
エージェントは質問で止まらず、ここに記録してから次の作業へ進みます。人は確認後に「回答」を埋めてください。

## 書式

```
### Q-001 [未回答] T07: <短い見出し>
- 状況: 何が曖昧だったか(該当する設計の§番号)
- 置いた仮定: どう実装したか / 実装を止めたか
- 影響範囲: 変更したファイル、stashした場合はstash名
- 回答:
```

## 記録

### Q-001 [未回答] T01: CIワークフローが `npm run verify` を呼んでいない(エージェント対象外の提案)
- 状況: `.github/workflows/ci.yml` は `typecheck` / `test:coverage` / `build` を個別に実行しており、T01で追加した `typecheck:services` / `build:services` がCIでゲートされない(設計§19.1「`npm run verify`にservice typecheck/buildを含める」)。`.github/` はエージェントの対象外
- 置いた仮定: ローカルの `npm run verify` には含めた。CI側は変更していない
- 影響範囲: 提案する差分は `ci.yml` の3ステップを `npm run verify` 1本に置き換えるだけ(後続タスクでPostgreSQL・Azuriteのservice containerが必要になった際に合わせて対応するのが効率的)
- 回答:

### Q-002 [未回答] T01: 共有Node.js imageに `build/services` が含まれていない
- 状況: 設計§7.6ではWebとDisplay・各Jobで同じNode.js imageを使うが、現在の `Dockerfile` のbuild stageは `npm run build`(Web)だけを実行している
- 置いた仮定: T01の完了条件は「空のservice entryがbuildされる」ことなのでDockerfileは変更していない。Displayを実装するT12(またはT19)でDockerfileに `npm run build:services` と成果物のコピーを追加する
- 影響範囲: `Dockerfile`。T12着手時に対応する
- 回答: (司令塔判断・T12で対応済み)build stageを `npm run build && npm run build:services` にし、既存の `COPY --from=build /app/build ./build` で `build/services` も最終imageへ入るようにした。非root(`USER node`)は維持。起動commandでWeb/Displayを切り替える形を `docs/OPERATIONS.md` に記載した

### Q-003 [未回答] T04: 監査イベントの`error_category`の分類一覧が設計に無い
- 状況: 設計§12.2は`error_category`を「秘密情報を含まない分類」とだけ定め、§14も分類の一覧を持たない。DBのカラムは自由記述TEXTのため、エラーメッセージや外部サービス応答がそのまま保存され得る
- 置いた仮定: `app/lib/db/audit-events.server.ts`の`auditErrorCategories`(Zod enum)として15分類を定義し、それ以外は保存できないようにした(`validation_failed`、`html_inspection_failed`、`quota_exceeded`、`rate_limited`、`not_authenticated`、`not_authorized`、`document_not_found`、`grant_invalid`、`grant_expired`、`storage_failed`、`queue_failed`、`preview_timeout`、`preview_failed`、`database_failed`、`internal_error`)。設計§6・§7.2・§7.5・§10の失敗パターンから起こした暫定の一覧
- 影響範囲: `app/lib/db/audit-events.server.ts`、`tests/unit/db/audit-events.server.test.ts`。分類名を変えるとT09・T11・T12・T17・T18の監査呼び出し側も変わる(DBのCHECK制約は追加していないため、migrationは不要)
- 回答:

### Q-004 [未回答] T04: Poolのサイズとtimeoutをアプリコードのconstantにした
- 状況: 設計§7.4は`pg`の使用とDB roleの最小権限を定めるが、接続数上限・statement timeoutの値を定めていない。実装担当の制約上、新しい環境変数(共通の契約)を勝手に追加できない
- 置いた仮定: `app/lib/db/pool.server.ts`の`poolSettings`に固定値を置いた(最大接続10、接続timeout 5秒、idle 30秒、statement timeout 10秒、client側query timeout 12秒)。production DBが2 vCoreで、Web・Display・Preview・Maintenanceが同じサーバーへ接続する前提での暫定値
- 影響範囲: `app/lib/db/pool.server.ts`。環境ごとに変えたい場合は`DB_POOL_MAX`等の環境変数をT02のschemaへ追加し、`.env.example`と`docs/OPERATIONS.md`の更新が必要
- 回答:

### Q-005 [未回答] T04: Display・Preview・MaintenanceからDB repositoryを再利用できない
- 状況: repositoryは`app/lib/db/*.server.ts`に置いたが、`services/`配下は`app/`をimportできない(`tsconfig.services.json`の`rootDir: services`、docs/ARCHITECTURE.md)。Display(閲覧監査の保存)、Preview(プレビュー状態更新)、Maintenance(purge)も同じテーブルを触る
- 置いた仮定: T04の範囲はWeb用(`app/lib/db/`)に限定し、`services/`側は実装していない。環境変数と同じく「意図した重複」にするか、repositoryを`services/shared/db/`へ移してWeb側から参照する方式にするかは未決
- 影響範囲: T12(Display)、T18(Preview)、T19(Maintenance)の着手時に方式を決める必要がある。移動する場合は`app/lib/db/`のimport元(T08・T09・T11・T17)も変わる
- 回答: (司令塔判断・T12で対応済み)T05のBlob/Queueと同じ形に揃え、実処理を `services/shared/db/{pool,documents,audit-events}.ts` と `services/shared/log.ts` へ移し、`app/lib/db/*.server.ts`・`app/lib/log.server.ts` は再exportする薄いラッパーにした。`pool.ts` は環境変数を読まず接続設定を引数で受け取る(Webは`app/lib/env.server.ts`、Displayは`services/display/env.ts`から渡す)。公開API・シグネチャ・`auditErrorCategories`は不変で、更新系の`executor`必須(監査と同一transaction)も維持。`upload-limits.server.ts` はWeb専用のため `app/lib/db/` に残した

### Q-006 [未回答] T05/T06: 結合テストのtimeout検証がタイミング依存で稀に落ちる
- 状況: `tests/integration/blob-queue.test.ts` の timeout 系テストは `timeoutMs: 1` で `AbortError`/`TimeoutError` を期待する。T06の実装中に1度だけ失敗が観測された(再実行で成功)。司令塔が3回連続実行したときは再現しなかったが、CIの遅いrunnerでは1msの間に処理が完了せず期待どおり中断する保証と、逆に別要因のエラーになる可能性の両方がある
- 置いた仮定: T05 の完了条件(timeoutを設定している)の検証としてはこのままとし、アサーションは `name` が `AbortError`/`TimeoutError` であることまで確認する形へ強化済み。値の見直しはしていない
- 影響範囲: `tests/integration/blob-queue.test.ts`。CIで flaky になる場合は、実時間に依存しない検証(渡された `abortSignal` を確認する単体テスト側)へ寄せる判断が必要
- 回答: (司令塔判断・T12で対応済み)T12の最終確認で3回連続failしたため、記録どおり実時間非依存の検証へ置換した。結合テストは `AbortSignal.timeout` をspyで既に中断済みのsignalへ差し替え、(a)エラー`name`、(b)呼び出し側の`timeoutMs`がsignal生成へ渡ること、(c)spyを戻せば同じ操作が成功すること(他要因の失敗を合格にしない)を検証する。加えて `tests/unit/services/storage.test.ts` にBlob/Queue全9操作×既定/明示指定で、SDKへ渡る`abortSignal`が当該timeout由来のsignalそのものであること(`toBe`)を検証するテストを追加した。`services/shared/storage.ts` は未変更

### Q-007 [未回答] T07: 設計に無い拒否理由コードを2つ足した
- 状況: 設計§6・§10.2の拒否理由は「形式不正、`meta refresh`、`base href`、ページ内以外の相対リンク、禁止scheme、外部resource」だが、`parse5`の解析は入れ子の深さに対して計算量が二次的に増える(終了タグごとにopen element stackを走査する)。上限を設けないと、10MB以内でも`<div>`を並べただけのHTMLで検査が終わらず、treeのメモリも増え続ける
- 置いた仮定: `app/lib/html/inspection-codes.ts`に`excessive_complexity`(入れ子512段・要素50万を超えたら解析を打ち切って拒否)を追加した。合わせて、設計§6.1の「ファイル名は表示用文字列として長さを制限する」から`invalid_file_name`(制御文字・パス区切り)と`file_name_too_long`も拒否理由として起こした。上限値はすべて`inspectHtmlUpload()`の引数(既定値あり)で、環境変数は追加していない
- 影響範囲: `app/lib/html/inspection-codes.ts`、`app/lib/html/inspection.server.ts`。分類名を変えるとT09のエラー表示・監査呼び出しも変わる
- 回答:

### Q-008 [未回答] T07: 外部resource判定でfail closedにした箇所
- 状況: 設計§6.2は「HTML属性で検出できる外部画像、stylesheet、font、media、`iframe`などの外部resource参照は拒否する」とだけ定め、個々の属性の扱いまでは定めていない
- 置いた仮定: 自己完結HTMLが前提(設計§6.2)であることから、resource系URLは`data:`・同一文書内(`#id`)・値なし・`about:blank`だけを許可し、それ以外(`http(s):`、protocol-relative、相対、その他scheme)はすべて`external_resource`として拒否した。`<link href>`はrelの種類を問わず対象にしているため、`rel="canonical"`のような読み込みを伴わない参照も拒否される。`<form action>`と`formaction`はリンク規則(相対と禁止schemeを拒否)で判定した
- 影響範囲: `app/lib/html/inspection.server.ts`。利用者の実ファイルで誤検知が出た場合は、relによる絞り込みなどの緩和を検討する
- 回答:

### Q-009 [未回答] T07: 検査しきれない箇所はCSP・sandbox前提で割り切った
- 状況: 設計§6.2は「inline CSS内など検査をすり抜けた外部resourceはCSPで遮断する」としている。属性・`style`要素のCSSは`url()`と`@import`のテキスト抽出で見るが、CSSのescape(`\68 ttps:`)の復号、`<object><param value>`、JavaScriptが組み立てるURLまでは判定していない(CSSのescapeは復号しない結果として相対参照扱いになり、拒否側へ倒れる)
- 置いた仮定: 検査は多層防御の1層目と位置づけ、表示サービスのCSPとsandbox(T12)で遮断する前提にした。`iframe srcdoc`の中身も文書として検査するが、段数(5)、文書数(1000)、合計文字数(元HTMLの3倍)の上限を超えた分は検査せず、CSPに委ねる
- 影響範囲: `app/lib/html/inspection.server.ts`、T12(表示サービスのCSP)。T12でCSPが設計どおり効いていることを必ず確認する
- 回答:

### Q-010 [未回答] T08: 頻度窓・lease・lock待ちtimeoutを環境変数にしていない
- 状況: 設計§6.1は「制限値は環境設定で変更可能とする」と定めるが、T08で必要になった3つの値(頻度判定の窓、同時実行予約のlease、advisory lock待ちのtimeout)は§6.1の制限値一覧に無く、T02で追加した環境変数にも対応するものが無い
- 置いた仮定: `app/lib/db/upload-limits.server.ts` の既定値(頻度窓60秒、lease 120秒、lock待ち5秒)とし、引数で上書きできる形にした。環境変数は追加していない。lock待ちは `poolSettings.statementTimeoutMillis`(10秒)以下であることをZodで強制している
- 影響範囲: `app/lib/db/upload-limits.server.ts`。env化する場合はT02のschema・`.env.example`・`docs/OPERATIONS.md`の更新が必要。lease値はT09のBlob保存〜DB登録の所要時間より十分長い必要がある(超えると予約が失効し、同時実行数×10MBの上限超過の窓が開く)
- 回答:

### Q-011 [未回答] T08: `upload_attempts` の定期purgeが設計§7.7のJobの責務に無い
- 状況: T08で頻度・同時実行の判定用に `upload_attempts` テーブルを追加した(§6.1「判定はPostgreSQLを使いRedisなどは追加しない」)。設計§7.7の定期保守Jobの責務は `blob_cleanup_pending` の再試行と1年経過後のpurgeだけで、この新テーブルの古い行の削除先が無い
- 置いた仮定: runtime roleにはSELECT/INSERT/UPDATEのみをGRANTし、DELETEは与えていない。purgeはT19(定期保守Job)の作業項目として `TASKS.md` のT19へ追記した(DELETE権限のGRANTもT19のmigrationで追加する想定)
- 影響範囲: `migrations/1789208206678_add-upload-attempts-table.sql`、T19
- 回答:

### Q-012 [未回答] T08: 予約枠の解放タイミングがT09の実装に依存する
- 状況: T08の上限判定は「進行中の予約(`upload_attempts`)のbyte数・件数を `documents` の集計に加算する」ことで並行アップロード時の超過を防いでいる。この安全性は、T09が資料レコードのINSERTをcommitした**後**に `releaseUploadSlot()` を呼ぶことに依存する。設計§10.1は解放のタイミングまで定めていない
- 置いた仮定: `reserveUploadSlot()` / `reserveUploadSlotWithin()` のdocstringに契約として明記した。T09では `finally` での素朴な解放(成功時にcommit前へ回りやすい)を避け、「登録commit後に解放」を検証するテストを入れる。また `reserveUploadSlot` に渡すbyte数は、Content-Lengthのような自己申告値ではなくstreaming上限で強制した実byte数を使う
- 影響範囲: `app/lib/db/upload-limits.server.ts`、T09。`releaseUploadSlot` は attemptId 不正時は `false` を返す一方 `ownerSubjectId` 不正時は例外を投げるため、T09の後始末から呼ぶ際は元の処理結果を覆わないよう注意が必要
- 回答:

### Q-013 [未回答] T09: 上限判定(設計§10.1(3))とbody読み込み(同(4))の実行順
- 状況: 設計§10.1は「3. 上限判定 → 4. raw bodyと`X-File-Name`の検証」の順だが、上限判定に渡すbyte数はContent-Lengthのような自己申告値ではなく実byte数でなければならない(Q-012)。実byte数はbodyを読み切るまで分からない
- 置いた仮定: bodyをstreaming上限(10MB)付きで読み切った直後に上限判定を行い、以降(HTML受け入れ検査、Blob保存、DB登録)は設計どおりの順にした。10MB超過・Content-Type不正・`X-File-Name`不正はDBへ触れる前に拒否されるため、上限判定より前に読むのは「上限10MBのbodyをメモリへ読む」ところまで
- 影響範囲: `app/lib/upload/upload.server.ts`。Content-Lengthによる事前拒否(設計§7.1)は残しているが、これだけでは信用していない
- 回答:

### Q-014 [未回答] T09: 未認証のアップロード拒否を監査へ残していない
- 状況: 設計§15.1は「成功、拒否、失敗を記録」とするが、`audit_events.actor_subject_id`はNOT NULL(設計§12.2)で、未認証の要求には記録できる利用者識別子が無い。`requireUser`は認証前にredirect/403をthrowする
- 置いた仮定: 未認証(および`requireUser`が弾くApp Role・所属なし)の拒否は監査へ残さず、`requireUser`の既定動作(ログイン画面へのredirect / 403)のままにした。認証後の拒否(cross-origin、入力検証、HTML検査、上限超過)と失敗はすべて監査している
- 影響範囲: `app/lib/upload/upload.server.ts`。認証失敗自体を監査したい場合は、`audit_events`のNOT NULL制約か「未認証利用者」を表す値の決めが必要(migrationを伴う)
- 回答:

### Q-015 [未回答] T09: 応答形式(JSON)とHTTPステータスが設計に無い
- 状況: 設計§10.1(10)は「資料表示画面へ案内する」、§14は「短い日本語メッセージと相関IDを表示する」とだけ定め、`POST /documents`の応答形式・ステータスは定めていない。アップロードは`application/octet-stream`のraw bodyで送るためHTML formからは送れず、画面側のJavaScriptが`fetch`で送る前提になる
- 置いた仮定: 成功は`201`でJSON(`documentId`、`documentUrl`=`/documents/{id}`、`previewStatus`、警告コードとメッセージ、`correlationId`)を返し、`Location`ヘッダーにも資料表示画面のpathを入れた。拒否は`400`(入力・HTML検査)、`403`(cross-origin)、`413`(サイズ超過)、`415`(Content-Type不正)、`409`(件数・容量上限)、`429`(頻度・同時実行。`Retry-After`付き)、失敗は`500`/`503`で、いずれもJSON(`message`、`correlationId`、拒否理由コード)を返す。画面遷移はT10のUIが`documentUrl`で行う
- 影響範囲: `app/lib/upload/upload.server.ts`、T10(初期画面のアップロードUI)
- 回答:

### Q-016 [未回答] T09: 監査・`documents`へ保存するメールアドレスの扱い
- 状況: 設計§12.1・§12.2はアップロード時・操作時点のメールアドレスを保存すると定めるが、Easy Authの`email`/`preferred_username` claimはメールアドレス形式とは限らない(UPNなど)。repository側のZodは`z.email()`で検証するため、形式が違うと保存に失敗し、アップロード全体が失敗する
- 置いた仮定: メールアドレス形式として解釈できない場合は`null`として保存し、アップロード自体は成功させた(認可・owner判定には`oid`だけを使うため業務影響は無い)
- 影響範囲: `app/lib/upload/upload.server.ts`。厳密に保存を要求する場合はclaim側の運用(mail claimの発行)を決める必要がある
- 回答:

### Q-017 [未回答] T09: `documents` repositoryへプレビュー状態の更新関数を追加した
- 状況: 設計§10.1(9)はQueue送信失敗時にプレビュー状態を`failed`へ変更すると定めるが、T04時点の`app/lib/db/documents.server.ts`にはプレビュー状態だけを更新する関数が無かった
- 置いた仮定: 既存関数の契約は変えず、`updateDocumentPreviewStatus({ documentId, previewStatus }, executor)`を追加した(`status`は変更せず、`active`かつ`preview_status`がNULLでない資料だけを更新する)。T15(プレビュー状態resource route)・T18(プレビュー生成ワーカー)も同じ関数を使える
- 影響範囲: `app/lib/db/documents.server.ts`、`tests/unit/db/documents.server.test.ts`
- 回答:

### Q-018 [未回答] T11: grantに`actorTenantId`を追加した(設計§7.2の列挙に無い)
- 状況: 設計§7.2はgrantの内容を「資料ID、操作利用者の`oid`、操作時点のメールアドレス、有効期限、ランダムnonce、`keyId`」と列挙するが、T12(Display)が保存する閲覧監査の`actor_tenant_id`は`audit_events`でNOT NULL相当の必須項目(設計§12.2、`app/lib/db/audit-events.server.ts`)。Displayはセッションを受け取らない(設計§7.2)ため、grant以外に操作利用者のtenantを知る手段が無い
- 置いた仮定: payloadへ`actorTenantId`を追加した。tenant IDは組織識別子であり個人データではないと判断。Blobキー・ファイル名を含めない制約(§7.2)は守っている
- 影響範囲: `services/shared/grant.ts`、`app/lib/grant.server.ts`、T12(閲覧監査)。tenantをgrantへ入れたくない場合は、Displayが`documents`から引くか、監査側のtenant必須を見直す必要がある
- 回答:

### Q-019 [未回答] T11: 有効期限内のgrant再利用を「許容」と解釈した
- 状況: 設計§18.2の結合テスト項目は「表示grantの正常、60秒以内の再利用、期限切れ、対象資料不一致」と並べるだけで、「60秒以内の再利用」が成功すべきか拒否すべきかを定めていない。§7.2にも単回使用の記述は無い
- 置いた仮定: **有効期限内であれば再利用可能**とした。iframeのリロードや再表示で同じgrantが再POSTされるため、単回使用にすると正常系のUXが壊れる。§18.2の当該項目は「成功することを確認する試験」と解釈した。そのためT11・T12で使用済みnonceの保存先(新テーブル)は作らず、nonceはgrantの一意性と監査の相関用としてpayloadに残すだけにした
- 影響範囲: `services/shared/grant.ts`、T12(Display)、T20(E2E)。単回使用にする場合は使用済みnonceの保存先(新テーブルまたは既存テーブルの流用)とgrant再発行フローの設計が必要で、migrationを伴う
- 回答:

### Q-020 [未回答] T11: grantのメールアドレスをnullable にした
- 状況: 設計§7.2はgrantに「操作時点のメールアドレス」を含めると定めるが、Q-016のとおりEasy Authの`email`/`preferred_username` claimはメールアドレス形式とは限らない。形式検証を必須にするとgrant発行(=資料表示)が失敗する
- 置いた仮定: T09の`documents`・監査と同じ扱いに揃え、メールアドレス形式として解釈できない場合は`null`をgrantへ入れる(表示自体は成功させる)。認可・owner判定には`oid`だけを使う
- 影響範囲: `services/shared/grant.ts`、`app/lib/grant.server.ts`、T12の閲覧監査(`actor_email_at_event`が`null`になり得る)
- 回答:

### Q-021 [未回答] T12: grant検証に失敗した要求を監査へ残していない(設計§10.3との差分)
- 状況: 設計§10.3末尾は「認証拒否、資料不存在、grant不正、Blob取得失敗は、発生した境界で `denied` または `failed` として監査する」と定めるが、実装は**grant不正・期限切れだけ監査行を作らず**、運用ログ(相関ID・`event`・`result=denied`・`error_category`)のみに記録している
- 置いた仮定: 監査へ残さない。`audit_events` は `actor_subject_id`・`actor_tenant_id` がNOT NULLの追記専用テーブル(設計§12.2)で、署名検証が通っていないgrantの利用者情報は攻撃者が自由に指定できる。これを保存すると (1)任意の利用者になりすました監査行を作れる (2)Displayへ到達できる相手が無制限に追記でき監査領域を枯渇させられる、の2点で監査の信頼性そのものを損なう。T09のQ-014(検証前のprincipalを監査へ書かない)と同じ考え方。**署名検証が通った後**の拒否・失敗(削除済み=`denied`/`document_not_found`、Blob失敗=`failed`/`storage_failed`)は設計どおり監査している
- 影響範囲: `services/display/server.ts`、`docs/ARCHITECTURE.md`(理由を記載済み)。grant不正も監査したい場合は、`audit_events`のNOT NULL制約の見直しか「未認証利用者」を表す値の決め、および追記量の上限(rate limit)が必要でmigrationを伴う
- 回答:

### Q-022 [未回答] T12: Displayの閲覧監査を単独INSERT(自動commit)で保存している
- 状況: 設計§15.1は「業務更新と監査を同じDBトランザクションで保存する」と定めるが、Displayは業務更新(資料の状態変更)を伴わない閲覧のみ
- 置いた仮定: §15.1の要件はupload・削除・管理操作に対するものと解釈し、閲覧監査はPoolを`Queryable`として渡した単独INSERT(自動commit)で保存した。「監査を保存してからHTMLを返す」(設計§7.2)は満たしている(保存失敗時はHTMLを返さない)
- 影響範囲: `services/display/server.ts`
- 回答:

### Q-023 [未回答] T12: 設計に無いfail closed・timeout値を追加した
- 状況: 設計§7.2はPOST bodyの上限とOrigin許可までを定めるが、クエリ文字列付き要求の扱い、Blob取得・HTTPのtimeout値は定めていない
- 置いた仮定: (1)`POST /display` にクエリ文字列が付いた要求は、bodyを読まずに400で拒否する(grantがingressログへ残る経路を作らないため)。(2)Blob取得timeout 5秒、HTTPの`requestTimeout` 15秒・`headersTimeout` 10秒をコード内定数として明示した。(3)削除済みと未存在は同一の404表示にして存在有無を漏らさない
- 影響範囲: `services/display/server.ts`。timeout値を環境ごとに変えたい場合は環境変数の追加(T02のschema・`.env.example`・`docs/OPERATIONS.md`の更新)が必要
- 回答:

### Q-024 [未回答] T13: grant期限切れの再取得手段が設計に無い
- 状況: 設計§7.2はgrantの有効期間を60秒と定めるが、資料表示画面を開いたまま時間が経った場合の再取得手段(§5.4の画面要素にも記載が無い)を定めていない。Displayのiframeは別オリジン・sandboxのため、表示が失敗したことをアプリ側のJavaScriptから検出できない
- 置いた仮定: loaderが`issueDisplayGrant`と同じ基準時刻から計算した`grantExpiresAt`をクライアントへ渡し、hydration遅延などで期限切れ間際ならPOSTせず`useRevalidator`でloaderを再実行して新しいgrantを取り直す。加えて、自動検出できない失敗のために「表示をやり直す」ボタン(revalidateのみ)を§5.4に無い追加UIとして置いた。`grantExpiresAt`はepoch msで、grant本体の署名対象ではない
- 影響範囲: `app/routes/documents.$documentId.tsx`、`tests/unit/routes/documents.$documentId.test.tsx`。ボタンが不要と判断される場合は、期限切れ時の利用者導線(再読込の案内など)を§5.4で決める必要がある
- 回答:

### Q-025 [未回答] T13: 資料表示画面に資料タイトルを表示した
- 状況: 設計§5.4は画面上部の要素として「URLをコピー」「初期画面へ戻る」だけを挙げ、資料タイトルの表示を定めていない
- 置いた仮定: 見出しに`title ?? originalFileName ?? "資料"`を表示した(初期画面§5.2のカードと同じ情報で、所有者以外にも見える)。ファイル名は表示用文字列としてT07で長さ・制御文字を検査済み。grant・監査には影響しない
- 影響範囲: `app/routes/documents.$documentId.tsx`。所有者以外にファイル名を見せたくない場合は§5.4の決めが必要
- 回答:

### Q-026 [未回答] T14: 削除監査の`action`を一律`delete`にした(管理者の強制削除も)
- 状況: 設計§12.2は`action`を「upload、view、delete、admin operationなど」と例示するだけで、管理者による他人の資料の強制削除(§5.6)をどちらにするかを定めていない
- 置いた仮定: (司令塔判断)成功・拒否・失敗を問わず削除は一律`delete`にした。実装当初は管理者の強制削除だけ`admin_operation`だったが、認可拒否は「オーナーでも管理者でもない」ため拒否時にスコープが決まらず、拒否・失敗だけ`delete`に寄る非対称が生じる。T17の監査履歴画面で`action = delete`を絞ったときに管理者削除が抜け落ちる方が実害が大きいと判断した。管理者による強制削除は`actor_roles`と、`documents.owner_subject_id`(削除後も1年保持、§10.4(6))と`actor_subject_id`の不一致で判別できる。`admin_operation`はT16・T17の管理操作(検索・監査閲覧)に取っておく
- 影響範囲: `app/lib/documents/delete.server.ts`、`tests/unit/routes/documents.$documentId.delete.test.tsx`、T16・T17(監査の絞り込み条件)。DBのカラム・enum値は追加していないためmigrationは不要
- 回答:

### Q-027 [未回答] T14: 未存在・削除済みの拒否監査を`document_id = null`で保存している
- 状況: 設計§12.2は`document_id`を「対象資料ID」とするが、`audit_events.document_id`は`documents`へのFKのため、存在しない資料IDをそのまま保存できない
- 置いた仮定: 未存在の資料IDに対する拒否監査は`document_id = null`で保存した。削除済み資料の場合も同じ扱いにして、監査行の形からも存在有無を区別できないようにしている(§10.4末尾の「一般利用者には削除済みと未存在を同じ表示にする」と同じ考え方)
- 影響範囲: `app/lib/documents/delete.server.ts`。T17の監査検索で「資料IDで絞る」と、その資料に対する未存在扱いの拒否行は拾えない
- 回答:

### Q-028 [未回答] T14: 削除確認画面(GET loader)の拒否を監査していない
- 状況: 設計§15.1は「成功、拒否、失敗を記録」とするが、削除確認画面の表示(GET)は削除操作そのものではない
- 置いた仮定: 確認画面loaderの拒否(403・404)は監査へ残さず、拒否の監査は削除action側だけで行う。ログイン済み利用者がGETを繰り返すだけで追記専用の監査領域を増やせる状態を作らないため(T09 Q-014・T12 Q-021と同じ考え方)。その結果 `/documents/:id/delete` へのGETは所有関係を示すオラクルになり得るが、資料IDはUUID v4で推測困難であり、閲覧自体は全ログイン利用者に開放されている(§4.2、§5.4)ため実害は小さいと判断した
- 影響範囲: `app/routes/documents.$documentId.delete.tsx`
- 回答:

### Q-029 [未回答] T14: 削除成功後の遷移先が設計に無い
- 状況: 設計§5.5は確認画面の要素だけを定め、削除成功後の遷移先を定めていない
- 置いた仮定: 初期画面`/app`へ303でredirectした(POST→GETの遷移として303)。削除済み資料の表示画面は404になるため、一覧が更新される初期画面へ戻すのが自然と判断
- 影響範囲: `app/lib/documents/delete.server.ts`。T16(管理画面)から強制削除する導線を作る場合、戻り先を管理画面にしたければそこで分岐が必要(実装者からのOPEN_ISSUEとして記録)
- 回答:

### Q-030 [未回答] T15: `ready`時の実プレビュー画像の配信経路が設計に無い
- 状況: 設計§5.2はカードに「プレビュー画像。生成失敗時は共通の代替画像」を表示するとし、§7.3はプレビュー画像を`preview/{id}/preview.jpg`へ保存すると定めるが、§13のルート一覧に**画像を配信する経路が無い**。Blobは公開せず(§7.3・§9.1)、SAS URLの発行も設計に無い
- 置いた仮定: (司令塔判断)T15の範囲はTASKS.mdの「内容」どおり状態resource routeとカードの処理中・失敗画像の切り替えだけとし、実画像の配信経路は新設しなかった。`ready`も暫定的に共通の代替画像へフォールバックしている(`app/lib/format/document-view.ts`の`previewImageSrc`)
- 影響範囲: `app/lib/format/document-view.ts`、`app/routes/app.tsx`、T18(プレビュー生成ワーカー)。配信方法(認証付きresource routeでBlobを中継するか、短期SASを発行するか)を決める必要がある。認証付き中継が既存の方針(Blobを公開しない、grantにBlobキーを含めない §7.2)と整合しやすい
- 回答:

### Q-031 [未回答] T15: プレビュー状態のポーリング間隔・上限が設計に無い
- 状況: 設計§5.3は「プレビュー画像はバックグラウンドで生成する」「生成中は共通の処理中画像」とだけ定め、画面が状態の変化をどう知るか(ポーリング間隔・打ち切り条件)を定めていない
- 置いた仮定: 間隔5秒・資料あたり最大24回(約2分)で打ち切る。打ち切り後は要求を止めるだけで表示は処理中画像のまま。画面に`pending`の資料が無いときはポーリングしない。fetch失敗・非200は静かに次回まで待ち、利用者へは通知しない。定数は`app/routes/app.tsx`内に置き、環境変数は追加していない
- 影響範囲: `app/routes/app.tsx`、`tests/unit/routes/app.test.tsx`。T18でプレビュー生成の実所要時間が判明したら値の見直しが必要(2分を超えると、生成成功しても再読込するまでカードが処理中のままになる)
- 回答:

### Q-032 [未回答] T15: プレビュー状態の参照を監査していない
- 状況: 設計§15.1の監査対象は「アップロード、閲覧、削除、管理操作」。プレビュー状態resource routeはHTML本文を返さずメタ情報だけを返す高頻度ポーリング用の読み取り経路
- 置いた仮定: §15.1の「閲覧」(§10.3ではDisplayがHTMLを返す直前に保存する監査)には該当しないと解釈し、監査行を作らない。作ると5秒ごとの追記で監査領域が膨らみ、監査履歴(§5.7)の可読性も落ちる
- 影響範囲: `app/routes/documents.$documentId.preview-status.ts`
- 回答:

### Q-033 [未回答] T16: 検索の一致方法・1ページ件数・日時の粒度と境界が設計に無い
- 状況: 設計§5.6は検索条件を「資料ID／オーナーのメールアドレス／元ファイル名／アップロード日時」と挙げるだけで、完全一致か部分一致か、1ページの件数、日時入力の粒度と上下限の境界を定めていない
- 置いた仮定: 資料IDはUUIDの完全一致、オーナーのメールアドレスと元ファイル名は大文字小文字を区別しない部分一致(`ILIKE`。`%`・`_`はrepositoryでエスケープし、利用者の入力をパターンとして扱わない)。アップロード日時は画面表示(§5.2)と同じ日本時間の分単位(`datetime-local`)で受け取り、開始は指定した分を含み、終了も指定した分の終わりまで含める(SQLは`created_at < 上限`のため、1分進めたUTC値を渡す)。1ページは§5.2と同じ20件で、同じkeyset paginationを使う
- 影響範囲: `app/lib/admin/document-search.server.ts`、`services/shared/db/documents.ts`、`migrations/1789246283802_add-admin-document-search-index.sql`(`(created_at DESC, id DESC)`のindexへ置き換え)
- 回答:

### Q-034 [未回答] T16: 管理画面の検索・一覧閲覧をどの粒度で監査するかが設計に無い
- 状況: 設計§5.6は「管理者による閲覧と削除も監査履歴へ記録する」とし、§12.2は検索条件になり得るメールアドレス・ファイル名を監査へ保存しないと定めるが、記録の単位と`document_id`の扱いは定めていない
- 置いた仮定: 検索(1ページの表示)1回につき`action = admin_operation`・`result = success`を1行、検索と同じDBトランザクションで保存する(§15.1。監査保存に失敗した検索結果は画面へ返さない)。検索条件そのものは保存せず、`document_id`は資料IDで1件に定まったときだけ残す(FK制約のためQ-027と同じ扱い)。`Admin`でない利用者の拒否(403)と入力検証エラー(400)は監査へ残さず運用ログだけに記録する(Q-014・Q-028と同じ考え方で、GETの繰り返しで追記専用の監査領域を増やさないため)。管理者の強制削除は削除経路が一律`delete`で記録する(Q-026)
- 影響範囲: `app/lib/admin/document-search.server.ts`、T17の監査履歴画面(`admin_operation`は管理画面の検索・監査閲覧だけを指す前提になる)
- 回答:

### Q-035 [未回答] T16: 管理画面から強制削除したあとの戻り先
- 状況: Q-029で削除成功後は初期画面`/app`へredirectしている。管理画面から強制削除すると、管理者は自分の資料一覧へ戻る
- 置いた仮定: T14の挙動をそのまま使い、遷移元による分岐は入れていない(戻り先をクエリ文字列で受け取るとopen redirectの検討が増えるため)
- 影響範囲: `app/lib/documents/delete.server.ts`、`app/routes/admin.documents.tsx`。管理画面へ戻したい場合は§5.5で戻り先を決める必要がある
- 回答:

### Q-036 [未回答] T16: 初期画面から管理画面への導線が設計に無い
- 状況: 設計§13に`/admin/documents`はあるが、§5.2の初期画面の要素に管理画面へのリンクが無く、管理者がURLを直接入力する以外の導線が定義されていない
- 置いた仮定: 初期画面`/app`に管理者だけへ見えるリンクを置いた(`canUseAdminScreen`)。これは表示制御であって認可ではなく、`/admin/documents`のloaderが`requireAdmin`で必ず判定し直す(設計§4.2)
- 影響範囲: `app/routes/app.tsx`、`tests/unit/routes/app.test.tsx`
- 回答:

### Q-037 [未回答] T17: 監査履歴の「利用者」をどの列で検索するかが設計に無い
- 状況: 設計§5.7は検索条件を「日時、利用者、資料ID、操作、結果」と挙げるだけで、「利用者」が`actor_subject_id`(Entraの`oid`)なのか`actor_email_at_event`(監査時点のメールアドレス)なのかを定めていない。§4.2は「メールアドレスを認可判定に使わない」と定めるが、検索条件としての可否には触れていない
- 置いた仮定: 検索欄を2つに分け、「利用者のメールアドレス」は`actor_email_at_event`の部分一致(`ILIKE`。`%`・`_`はrepositoryでエスケープ)、「利用者ID」は`actor_subject_id`の完全一致にした。管理者が実際に手元に持つのはメールアドレスであることが多く、一方で同じ人物でもメールアドレスは変わり得るため、変わらない識別子でも追える両方を用意した。どちらも**検索条件にしか使わず認可判定には使わない**(認可は`requireAdmin`のApp Roleだけで決まる)。一致方法・1ページ20件・日時は日本時間の分単位で「開始は含む・終了は指定した分の終わりまで含む」はT16(Q-033)と同じ規則にそろえた
- 影響範囲: `services/shared/db/audit-events.ts`、`app/lib/admin/audit-search.server.ts`、`app/routes/admin.audit.tsx`。`actor_email_at_event`の部分一致に使えるindexは無い(既存indexは`occurred_at`・`actor_subject_id`・`action`・`result`・`document_id`)。保存期間1年分の規模では、日時範囲と併用すれば`audit_events_occurred_at_id_idx`を辿れるため新しいindexは追加していない。メールアドレス単独での全期間検索が遅い場合は`pg_trgm`のindex追加(拡張の有効化が必要)を検討する
- 回答:

### Q-038 [未回答] T17: keyset paginationのcursorが`Date`のミリ秒までしか持てない
- 状況: PostgreSQLの`timestamptz`はマイクロ秒まで保持するが、`pg`が返す`Date`はミリ秒までしか持てない。`Date`からcursorを作ると、同じミリ秒に発生した行が行値比較`(occurred_at, id) < (cursor)`から外れて**取りこぼされる**。監査履歴は同一ミリ秒に複数行が入り得る(結合テストで実際に再現した)
- 置いた仮定: 監査履歴の検索SQLでcursor専用に`to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`を取得し、その値でcursorを組み立てた(表示用の`occurredAt`は従来どおり`Date`)。同一時刻3件をcursorで全件たどれることを結合テストで確認している
- 影響範囲: `services/shared/db/audit-events.ts`、`tests/integration/audit-events-repository.test.ts`。**`documents`側(`encodeDocumentCursor`。T04の所有者別一覧とT16の管理画面検索)には同じ問題が残っている**。同一ミリ秒に複数件アップロードされた場合に一覧で取りこぼす可能性があり、T17の範囲外のため修正していない(修正する場合は`services/shared/db/documents.ts`の`documentColumns`へ同じ`to_char`列を足す)
- 回答:

### Q-039 [未回答] T17: 初期画面から監査履歴画面への導線が設計に無い
- 状況: 設計§13に`/admin/audit`はあるが、§5.2の初期画面の要素に監査履歴画面へのリンクが無く、管理者がURLを直接入力する以外の導線が定義されていない(T16のQ-036と同じ状況)
- 置いた仮定: Q-036で追加した管理者だけに見えるリンクの隣に「監査履歴」リンクを置いた(`canUseAdminScreen`)。これは表示制御であって認可ではなく、`/admin/audit`のloaderが`requireAdmin`で必ず判定し直す(設計§4.2)
- 影響範囲: `app/routes/app.tsx`、`tests/unit/routes/app.test.tsx`
- 回答:

### Q-040 [未回答] T18: プレビュー生成監査の操作者をアップロード監査から引き継いだ
- 状況: 設計§12.2の`audit_events`は`actor_subject_id`・`actor_tenant_id`がNOT NULLだが、プレビュー生成はJobの処理で操作者がいない。`documents`にtenantの列は無く、Preview用の環境変数にもtenant IDは無い(`ENTRA_TENANT_ID`はWeb専用・任意)
- 置いた仮定: 同じ資料の**アップロード監査**(`action = upload`・`result = success`。設計§15.1によりアップロードと同一トランザクションで必ず保存される)を`searchAuditEvents`で1件引き、その`actor_subject_id`・`actor_tenant_id`をプレビュー監査へ引き継いだ。`actor_email_at_event`・`actor_group_values`・`actor_roles`は`null`にして個人データを増やさない。アップロード監査が見つからない場合(1年経過でpurge済みなど想定外)は監査行を作らず、`preview_audit_actor_unresolved`を運用ログへ記録して状態更新だけを確定させる
- 影響範囲: `services/preview/dependencies.ts`。tenantを環境変数で持ちたい場合は`services/preview/env.ts`・`.env.example`・`docs/OPERATIONS.md`の追加が必要
- 回答:

### Q-041 [未回答] T18: プレビュー生成の監査`action`を`upload`にした
- 状況: 設計§10.2は「処理の成功・失敗は監査履歴へ残す」と定めるが、`audit_events.action`のenum(`upload`/`view`/`delete`/`admin_operation`。migrationのCHECK制約)にプレビュー生成に対応する値が無い
- 置いた仮定: プレビュー生成はアップロード処理の続き(設計§10.1(9)、§10.2)と解釈し、`action = upload`で記録した(成功=`result: success`、恒久失敗=`result: failed` + `error_category`)。enumを増やすとmigration・CHECK制約・T17の監査履歴画面の選択肢まで波及するため追加していない。`admin_operation`はQ-034のとおり管理画面の操作に取っておく。同じ資料の`upload`監査は「アップロード」「プレビュー結果」で最大2行になり、後者は`actor_email_at_event`が`null`である点で区別できる
- 影響範囲: `services/preview/dependencies.ts`(`PREVIEW_AUDIT_ACTION`)、T17の監査履歴画面の見え方
- 回答:

### Q-042 [未回答] T18: 検証できないQueueメッセージは監査を残さず削除する
- 状況: 設計§7.5は`schemaVersion`と`documentId`だけを含むメッセージを前提とするが、schemaに合わない本文を受け取った場合の扱いを定めていない
- 置いた仮定: 資料IDが分からずDB更新も監査(NOT NULLの操作者)も行えないため、`validation_failed`を運用ログへ記録してメッセージを削除する(恒久失敗扱い)。削除しないと同じ本文が最大7日間再配信され続け、正常なメッセージの処理枠を奪うため。本文そのものはログへ出さない。`services/shared/storage.ts`には検証失敗でも`messageId`・`popReceipt`を返す`receivePreviewGenerationEnvelopes`を追加した(既存の`receivePreviewGenerationMessages`は例外にする挙動のまま残している)
- 影響範囲: `services/shared/storage.ts`、`services/preview/worker.ts`
- 回答:

### Q-043 [未回答] T18: `preview_status`が`pending`でない資料は撮影し直さない
- 状況: 設計§7.5は「同じメッセージを複数回受け取っても結果が壊れないようにする」と定めるが、既に`ready`・`failed`の資料へ重複配信された場合の動作を定めていない
- 置いた仮定: `ready`は撮影済み、`failed`は試行を使い切った資料(設計§10.2「手動再実行は設けない」)のため、どちらも**撮影せず状態も監査も変えずにメッセージを削除**する。撮影し直すとChromium起動とBlob書き込みが無駄に発生し、`failed`の資料が後から`ready`に変わって§10.2の「3回失敗したら代替画像」と矛盾する
- 影響範囲: `services/preview/worker.ts`。将来「失敗した資料の再生成」機能を入れる場合は、この分岐と`preview_status`の戻し方を決める必要がある
- 回答:

### Q-044 [未回答] T18: 上限byte数超過は試行回数を使い切らずに`failed`にする
- 状況: 設計§7.5は「品質を下げても1MB以下にならない場合は`failed`とする」と定める一方、「最大3回試行し、3回失敗した場合は`failed`」とも定めており、どちらを優先するかが読み取れない
- 置いた仮定: 上限byte数超過は同じHTMLを撮り直しても結果が変わらない決定的な失敗のため、`dequeueCount`に関係なく1回目で`failed`にしてメッセージを削除する(`isDeterministicFailure`)。一時障害(Blob・DB・Chromiumのエラーやtimeout)だけを3回まで再試行する
- 影響範囲: `services/preview/worker.ts`
- 回答:

### Q-045 [未回答] T18: Playwrightを本番dependencyへ移さず、`playwright-core`と専用imageで賄う
- 状況: ワーカーは本番でPlaywrightを必要とするが、`@playwright/test`はdevDependencyで、production dependencyを増やさない制約がある。`playwright`パッケージをdependenciesへ入れると、Web・Display・Migration・Maintenanceが使う共通imageにもbrowserダウンロード付きの依存が入る
- 置いた仮定: production dependencyを増やさず、撮影時だけ`playwright-core`(`@playwright/test` 1.61.1 が package-lock.json で同じversionに固定している推移的依存)を動的importする。Preview専用image(`Dockerfile.preview`)は、`npm ci --omit=dev`で作った本番依存に加えて`node_modules/playwright-core`だけをdev installのstageからコピーする。browser binaryはPlaywright公式image(`mcr.microsoft.com/playwright:v1.61.1-noble`、`@playwright/test`と同じversion)のものを使い、`npm ci`時は`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`でダウンロードしない。`package.json`・`package-lock.json`は変更していないため`docs/agent/DEPENDENCIES.md`には「新規追加」ではなく利用方針として追記した
- 影響範囲: `Dockerfile.preview`、`services/preview/capture.ts`。`@playwright/test`を更新するときは**base imageのtagも同時に上げる**必要がある(不一致だとbrowserとPlaywright本体の対応が崩れる)。`playwright-core`を直接importしているため、将来`@playwright/test`をdevDependencyから外す場合は`playwright-core`を明示的な依存として追加する必要がある
- 回答:

### Q-046 [未回答] T18: 外部ネットワーク遮断を4重(setContent・route abort・offline・JS無効)で実装した
- 状況: 設計§7.5は「プレビュー生成ブラウザはJavaScript無効、外部ネットワーク接続なしで実行する」と定めるが、実現方法は定めていない。JavaScriptを無効にしても`<img src="https://...">`やCSSの`url()`は読みに行く
- 置いた仮定: (1)HTMLはBlobから取得した文字列を`page.setContent`で流し込み、ページ取得自体にネットワークも`file://`も使わない (2)context単位で`route("**/*")`を登録し、すべてのsubresource要求を`abort("blockedbyclient")`する (3)contextを`offline: true`にする (4)`javaScriptEnabled: false`でスクリプト経由の通信を発生させない (5)Chromium起動引数でtelemetry・component update・Safe Browsingの背景通信を止める。中止した要求のURLはログへ出さない(設計§15.2)。本番ではこれに加えてネットワーク側でegressを禁止する(設計§8)
- 影響範囲: `services/preview/capture.ts`。ローカルHTTPサーバーが撮影中に1件も要求を受けないことを`tests/integration/preview-capture.test.ts`で確認している
- 回答:

### Q-047 [未回答] T18: Jobの終了コードとContainer Apps側の再試行
- 状況: 設計§7.5はJob実行上限45秒と1実行1メッセージを定めるが、実行の終了コードを定めていない
- 置いた仮定: 再試行に回した場合(`retry_scheduled`)だけ終了コード1、それ以外(処理完了・撮影不要・恒久失敗・メッセージ無し)は0にした。再試行はQueueの再配信で行うため、Container Apps Job側の再試行回数(`replicaRetryLimit`)は0にする想定を`docs/OPERATIONS.md`へ記載した。Job実行上限(45秒)の超過時は`preview_job_timeout`を記録して終了コード1で強制終了し、メッセージは削除しない(visibility timeout経過後に再配信される)
- 影響範囲: `services/preview/index.ts`、`docs/OPERATIONS.md`。Container Apps Jobのマニフェスト(Bicep)は人が作成する
- 回答:

### Q-048 [未回答] T18: 撮影中に資料が削除された場合は保存済みプレビューを削除する
- 状況: 撮影とBlob保存の途中で資料が削除されると、削除処理(設計§10.4(4))のBlob削除が先に走り終えている可能性があり、あとから保存されたプレビュー画像が回収経路の無い孤児Blobになる
- 置いた仮定: `ready`更新(`active`かつ`preview_status IS NOT NULL`の資料だけを更新する)が0行だった場合は、保存したプレビューBlobを削除してからメッセージを削除する。`preview_status`がNULL(=削除済み)の資料はそもそも撮影しない
- 影響範囲: `services/preview/worker.ts`、`services/preview/dependencies.ts`。T19の孤児Blob掃除とは独立した即時の後始末
- 回答:

### Q-049 [未回答] T18: 結合テストでvisibility timeoutの経過を実時間で待たない
- 状況: `dequeueCount`が1→2→3と増える経路を検証するには再配信が必要だが、visibility timeoutの経過を実時間で待つテストは遅く不安定になる(Q-006と同じ問題)
- 置いた仮定: ワーカーが残したメッセージを、テスト側から`queueClient.updateMessage(..., visibilityTimeout: 0)`で即座に再表示してから次の実行を行う。`dequeueCount`の増加は実際の受信で起きるため、判定そのものは本番と同じ経路を通る。処理上限(30秒)の検証はQ-006と同じ`AbortSignal.timeout`のspy差し替え方式で、(a)指定した30秒がsignal生成へ渡ること (b)中断が`preview_timeout`として扱われDBもqueueも変わらないこと (c)差し替えを戻すと同じメッセージの処理が成功すること、を確認している
- 影響範囲: `tests/integration/preview-worker.test.ts`
- 回答:

### Q-050 [未回答] T18: 処理上限を超えたあとの後始末・恒久失敗の記録は別timeoutで行う
- 状況: 設計§7.5は「1メッセージの処理上限は30秒」と「3回目の失敗でDBを`failed`へ更新して監査を保存した後、メッセージを削除する」の両方を定めるが、**処理上限を超えた試行**での`failed`更新・監査・メッセージ削除の扱いを定めていない。処理上限の`AbortSignal`をそのまま使うと、これらの書き込みも中断されて何も残らない
- 置いた仮定: 処理上限のsignalは`processMessage`(資料の確認・HTML取得・撮影・プレビュー保存・`ready`更新)にだけ適用し、「期限を過ぎてから新しい撮影・業務処理を始めない」という意味に限定した。結果が確定したあとの書き込み(恒久失敗の`failed`更新と監査、メッセージ削除、`ready`更新が0行だった場合の孤児プレビュー削除)は、期限切れのsignalを流用せず`PREVIEW_FINALIZE_TIMEOUT_MS`(10秒)の独立したsignalで実行する。そのまま中断すると、資料が`pending`のまま残って表示が代替画像へ切り替わらない(設計§10.2)、メッセージが最大7日間再配信され続ける、回収経路の無い孤児Blobが残る、のいずれかになるため。10秒はBlob/Queue操作とDBの`statement_timeout`と同じ値で、visibility timeout(60秒)の残り時間に収まる
- 補足(実体との対応): DB書き込み(`recordPreviewResult`)は`pg`が`AbortSignal`での中断に対応していないため、`PREVIEW_FINALIZE_TIMEOUT_MS`(10秒)は効かず、実際の上限はpoolの`query_timeout`(12秒、`services/shared/db/pool.ts`)。10秒のsignalが効くのはBlob・Queue操作(メッセージ削除・孤児プレビュー削除)。環境変数schemaの不変条件には安全側として大きい方(`PREVIEW_FINALIZE_BUDGET_SECONDS` = 12秒)を使い、`処理上限 + 12秒 ≤ Job実行上限` かつ `処理上限 + 12秒 ≤ visibility timeout`を検証する(既定30/45/60で成立)。後続のメッセージ削除(最大10秒)はこの見込みに含めない。削除に失敗しても再配信で冪等にやり直せるため
- 影響範囲: `services/preview/worker.ts`(`PREVIEW_FINALIZE_TIMEOUT_MS`)、`services/preview/env.ts`(`PREVIEW_FINALIZE_BUDGET_SECONDS`)、`tests/unit/services/preview-worker.test.ts`、`tests/unit/services/preview-env.test.ts`
- 回答:

### Q-051 [未回答] T18: 確定した`ready`を後続の配信が`failed`で上書きしないようにした
- 状況: 設計§7.5は「3回失敗したら`failed`」と「同じメッセージを複数回受け取っても結果が壊れない」を両方求めるが、**`ready`が確定したあとに`dequeueCount`が上限を超えた配信が届いた場合**の扱いを定めていない。メッセージ削除の失敗は握りつぶす仕様(結果を巻き戻さないため)なので、削除が続けて失敗すると4回目の配信が届き得る
- 置いた仮定: `updateDocumentPreviewStatus`のUPDATE条件に「`failed`を書けるのは`preview_status = 'pending'`の資料だけ」を追加し(`ready`への更新は現状維持)、更新0行のときは`failPermanently`が状態も監査も変えずにメッセージだけ削除して`skipped`を返すようにした。読み取りで判定せずUPDATEの条件で判定するのは、Preview Jobが最大2件並列(設計§7.6)で動くため読み取りと更新の間に状態が変わり得るため。アップロード時のQueue送信失敗で`failed`を書く経路(`app/lib/upload/upload.server.ts`)は直前に`pending`で作成した資料が対象のため影響しない
- 影響範囲: `services/shared/db/documents.ts`(共有モジュール。Web・Preview両方が使う)、`services/preview/worker.ts`、`tests/unit/db/documents.server.test.ts`、`tests/unit/services/preview-worker.test.ts`、`tests/integration/preview-worker.test.ts`
- 回答:
