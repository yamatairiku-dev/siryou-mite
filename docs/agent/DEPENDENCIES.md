# 依存関係の追加理由(開発規約§7)

`docs/DEVELOPMENT_STANDARD.md` §7の記載事項に沿って、production dependency追加時の
判断根拠を記録します。

## T01で追加したもの

### parse5 8.0.1(production dependency)

- 標準APIで代替できない理由: Node.js標準にはHTMLパーサーがなく、`meta refresh`・
  `base href`・相対リンク・禁止schemeなどをDOM構造として安全に検査するには、
  正規表現による文字列処理ではなく仕様準拠のHTMLパーサーが必要(設計 §6.1〜§6.3)
- メンテナンス状況: 活発。jsdomやParcelなど主要OSSが依存しており、既に本リポジトリの
  devDependency(jsdom経由)にも含まれる
- Security Policyの有無: GitHubリポジトリでSecurity Advisoryを受け付けている
- ライセンス: MIT
- 削除・置換する場合の影響: HTML受け入れ検査(T07)の実装を正規表現ベースへ置き換える
  必要があり、誤検知・誤許可のリスクが上がる

### pg 8.23.0(production dependency)

- 標準APIで代替できない理由: Node.js標準にPostgreSQLクライアントはない。設計 §7.4で
  `pg`使用かつORM非導入が明示されている
- メンテナンス状況: node-postgresは長期間活発にメンテナンスされている定番ライブラリ
- Security Policyの有無: GitHubリポジトリでissue経由の脆弱性報告を受け付けている
- ライセンス: MIT
- 削除・置換する場合の影響: repository層(`.server.ts`)とmigrationの接続コードを
  作り直す必要がある

### node-pg-migrate 9.0.0(production dependency)

- 標準APIで代替できない理由: forward-onlyのSQLマイグレーション管理を自前実装すると
  適用順序・適用済み管理の不具合リスクが高い。設計 §7.4で明示的に指定されている
- メンテナンス状況: 活発にメンテナンスされている
- Security Policyの有無: GitHubリポジトリでissue経由の脆弱性報告を受け付けている
- ライセンス: MIT
- 削除・置換する場合の影響: Migration Job(T03)の実行スクリプトと運用手順の作り直しが
  必要
- 備考: CLIとして本番Migration JobのコンテナでもWeb/Displayと同じNode.js imageから
  実行するため、devDependencyではなくdependenciesに置く

### @azure/identity 4.13.2(production dependency)

- 標準APIで代替できない理由: Managed Identityでのtoken取得はAzure SDK以外に安全な
  標準手段がない。設計 §7.4・§9.5でManaged Identity経由のPostgreSQL/Blob/Queue接続が
  必須とされている
- メンテナンス状況: Microsoft公式SDK。活発にメンテナンスされている
- Security Policyの有無: azure-sdk-for-jsリポジトリでSecurity Advisoryを公開している
- ライセンス: MIT
- 削除・置換する場合の影響: Managed Identity認証を自前実装する必要があり、シークレット
  漏洩リスクが上がる

### @azure/storage-blob 12.33.0(production dependency)

- 標準APIで代替できない理由: private Blob Storageへの認証付きアクセスはAzure SDK以外に
  安全な標準手段がない(設計 §7.3)
- メンテナンス状況: Microsoft公式SDK。活発にメンテナンスされている
- Security Policyの有無: azure-sdk-for-jsリポジトリでSecurity Advisoryを公開している
- ライセンス: MIT
- 削除・置換する場合の影響: HTML/プレビューの保存・取得・削除(T05)を独自HTTP実装へ
  置き換える必要がある

### @azure/storage-queue 12.31.0(production dependency)

- 標準APIで代替できない理由: Storage Queueへの認証付きアクセスはAzure SDK以外に
  安全な標準手段がない(設計 §7.5)
- メンテナンス状況: Microsoft公式SDK。活発にメンテナンスされている
- Security Policyの有無: azure-sdk-for-jsリポジトリでSecurity Advisoryを公開している
- ライセンス: MIT
- 削除・置換する場合の影響: プレビュー生成メッセージの送受信(T05, T18)を独自HTTP実装へ
  置き換える必要がある

### @types/pg 8.23.1(development dependency)

- 標準APIで代替できない理由: `pg`本体は型定義を同梱していないため、strict TypeScriptで
  安全に使うには型定義が必要
- メンテナンス状況: DefinitelyTypedで継続的にメンテナンスされている
- Security Policyの有無: 型定義のみでランタイムに影響しないため、DefinitelyTyped全体の
  運用に準ずる
- ライセンス: MIT
- 削除・置換する場合の影響: `pg`呼び出し箇所の型安全性が失われる

`parse5`、`node-pg-migrate`、`@azure/identity`、`@azure/storage-blob`、
`@azure/storage-queue`はTypeScriptの型定義を同梱しているため、追加の`@types/*`は不要。

## T18で確認したもの

### playwright-core 1.61.1(依存追加なし。Preview Jobのruntimeで使用)

- 追加の有無: **`package.json`・`package-lock.json`は変更していない**。`@playwright/test`
  1.61.1(devDependency)が`playwright` → `playwright-core`を同じversionで固定しており、
  `services/preview/capture.ts`は撮影時だけ`playwright-core`を動的importする
- 標準APIで代替できない理由: HTMLを描画してスクリーンショットを撮るには実ブラウザの
  制御が必要で、Node.js標準APIには無い。設計 §7.5がPlaywrightとChromiumを明示している
- 本番での供給方法: Preview専用image(`Dockerfile.preview`)が、`npm ci --omit=dev`で作った
  本番依存に加えて`node_modules/playwright-core`をdev install stageからコピーする。
  browser binaryはPlaywright公式image(`mcr.microsoft.com/playwright:v1.61.1-noble`)の
  ものを使い、`npm ci`時は`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`でダウンロードしない
- Web・Display・Migration・Maintenanceが使う共通imageには入らないため、production
  dependencyは増えていない
- メンテナンス状況: Microsoftが活発にメンテナンスしている
- Security Policyの有無: GitHubリポジトリでSecurity Advisoryを公開している
- ライセンス: Apache-2.0
- 更新時の注意: `@playwright/test`のversionを上げるときは`Dockerfile.preview`のbase image
  tag(`v<version>-noble`)も同じPRで上げる。`@playwright/test`をdevDependencyから外す場合は
  `playwright-core`を明示的な依存として追加する必要がある
