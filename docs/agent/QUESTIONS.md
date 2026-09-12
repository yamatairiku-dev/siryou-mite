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
