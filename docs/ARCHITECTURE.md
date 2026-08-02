# アーキテクチャ

## 方針

このアプリは、ブラウザ、App Service Easy Auth、React Router BFF、データサービスを
基本とします。初回表示はSSR、以後の画面遷移はクライアント側で行います。

```mermaid
flowchart LR
  U["社内ユーザー"] --> B["ブラウザ<br>React UI"]
  B --> EA["App Service Easy Auth"]
  EA --> E["Microsoft Entra ID"]
  EA -->|X-MS-CLIENT-PRINCIPAL| RR["React Router BFF<br>loader / action"]
  RR --> API["業務API・DB・SaaS"]
  RR --> L["構造化ログ"]
```

## 境界

### ブラウザ

- 表示と入力を担当する
- APIキー、client secret、アクセストークンを保持しない
- 画面の非表示だけで権限を制御しない

### React Router

- Easy Authが検証したprincipalを取得し、業務認可を行う
- loaderで読み取り、actionで更新を行う
- 外部APIの資格情報をサーバー環境変数から取得する
- 入力検証、認可、監査ログを行う

### 外部サービス

- 業務データの正本を保持する
- React Routerから最小権限でアクセスする

## 認証・ユーザーコンテキスト

1. 未認証ユーザーが`POST /auth/login`を実行する。
2. アプリは安全な戻り先を付けて`/.auth/login/aad`へリダイレクトする。
3. Easy AuthがEntra IDとのOIDCフローとセッションCookieを管理する。
4. 認証済み要求にBase64 JSON形式の`X-MS-CLIENT-PRINCIPAL`を付加する。
5. React RouterはZodでprincipalを検証し、`oid`、`tid`、`roles`、`groups`、表示名、
   メールアドレスを抽出する。
6. `tid`を構成済みtenantと照合し、`roles`と所有者IDで各操作を認可する。

アプリ独自の本番セッションCookie、MSAL、client secret、callback routeは持ちません。
Microsoft Graphは呼ばず、Easy AuthのToken Storeも無効にします。ログアウトはアプリの
同一オリジン検証済みPOST actionから`/.auth/logout`へ遷移します。

`roles`は`User`・`Admin`の業務認可に使います。`groups`は複数値を前提とした所属コードで、
画面表示と監査時点情報に使います。特定のグループ名を操作権限へ直接対応付けません。
有効なApp Roleまたは所属クレームがない場合、アプリはfail closedで拒否します。
グループoverage時にGraphへ自動fallbackせず、Entra側の割り当てを是正します。

ローカル開発だけは`AUTH_MODE=dev`の署名付きCookieを使います。本番では
`AUTH_MODE=easyauth`を必須とし、クライアントが任意に送ったprincipal headerを信頼できる
経路を作りません。

## 適用範囲

向いている用途:

- 認証付きCRUD
- 社内管理画面
- 外部API連携
- 生成AI・RAGのフロント/BFF
- 小規模なワークフロー

別バックエンドを検討する用途:

- 長時間バッチ
- ジョブキュー
- 多数のシステムから共用されるAPI
- 大量データ処理
- 複雑なトランザクション

## 「資料みて！」固有の実行境界

アップロードされたHTMLは信頼せず、アプリ本体とは別オリジンのHTML表示サービスで
配信します。Easy AuthのセッションCookieは表示サービスへ送らず、対象資料、操作利用者、
有効期限を限定した60秒有効のEd25519署名付き表示grantでアクセスを制御します。
grantはアプリJavaScriptがhidden formのPOST bodyでiframeへ送り、URL、Cookie、ログへ
含めません。JavaScript無効時の表示fallbackは設けません。

- HTMLは改変せず、`html/{documentId}/document.html`のprivate Blobとして保存する
- 表示サービスはNode.js標準HTTPサーバーとし、`GET /health`と`POST /display`だけを持つ
- 表示サービスはBlob取得後に閲覧監査を書き、成功してからHTMLを返す
- CSPとsandboxでJavaScript、外部resource、フォーム、ダウンロード、状態保存を無効化する
- `meta refresh`、`base href`、ページ内以外の相対リンク、`data:`、`file:`、
  独自schemeのリンクを含むHTMLは保存前に拒否する
- `http:`、`https:`、ページ内リンクは確認routeへ置き換えない
- 通常リンクはiframe内、`_blank`は新しいタブで開き、`_top`と`_parent`は無効化する
- リンククリック単位の監査とリンク専用データモデルは設けない

WebだけをLinux App Serviceで実行し、Easy Authを有効にします。プレビュー生成はChromiumを
含む別imageのQueue駆動Container Apps Jobで最大3回試行し、JavaScriptと外部ネットワークを
無効化します。Display、Migration、MaintenanceもContainer Appsで実行します。

## データとAzure境界

- PostgreSQLには`pg`で接続し、loader/action、service、repositoryへ分離する
- migrationは`node-pg-migrate`と専用Managed Identityを使い、runtimeへDDL権限を与えない
- HTMLとJPEG previewはprivate Blob、非同期通知はStorage Queueへ保存する
- Web、Display、Preview、Migration、Maintenanceは用途別Managed Identityを使う
- 秘密情報はKey Vault参照で環境変数へ渡し、アプリからKey Vault APIを直接呼ばない
- production、stagingともJapan Eastの単一region、LRS、非ゾーン冗長とする
- applicationとdata planeはprivate networkへ限定する
- ACRだけはGitHub-hosted runnerのpush用に認証付きpublic endpointを使う

Infrastructure as CodeはBicep、CI/CDはGitHub ActionsのOIDCを使います。GitHub-hosted
runnerからprivate data planeへ直接接続せず、migrationとsmoke testはVNet内の
Container Apps Jobとして実行します。production DB migrationはforward-onlyかつ
新旧applicationに互換とし、application rollback時にdown migrationは行いません。
詳細は`docs/APPLICATION_DESIGN.md`で定義します。
