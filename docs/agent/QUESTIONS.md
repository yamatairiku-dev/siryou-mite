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
- 回答:

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
- 回答:
