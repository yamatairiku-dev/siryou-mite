# セキュリティ規約

## 必須事項

1. 認証はEntra IDに統一する
2. 認可はloader、action、API、データアクセス直前で実施する
3. 画面を隠すだけの認可は禁止する
4. cookie認証の更新処理は同一オリジンを検証する
5. すべての外部入力を検証する
6. 秘密情報をブラウザへ送らない
7. productionではApp Service Easy Authを迂回できる経路と`AUTH_MODE=dev`を使用しない
8. High/Critical脆弱性を放置しない

## シークレット

- `.env`をGitへ登録しない
- 本番はAzure Key Vaultなどのシークレット管理機能を使用する
- client secret、APIキー、SESSION_SECRETをログへ記録しない
- 定期ローテーションと緊急ローテーション手順を用意する
- 環境ごとに異なる値を使う

## Cookie

アプリが発行するCookieは以下を必須とします。本番の認証セッションCookieはEasy Authが
管理し、アプリ独自の認証Cookieは発行しません。

- `HttpOnly`
- `Secure`
- `SameSite=Lax`以上
- `__Host-`prefix
- 明示的な有効期限
- 32文字以上のランダムな署名secret

セッションCookieは署名されていますが暗号化されません。アクセストークン、client
secret、機微な個人情報を保存してはいけません。

## CSRF、XSS、redirect

- actionで`assertSameOrigin(request)`を呼ぶ
- logoutをGETで実行しない
- redirect先は`safeInternalPath`で検証する
- ユーザー入力を`dangerouslySetInnerHTML`へ渡さない
- 外部URLは`http:`、`https:`など許可方式を限定する
- Markdown／HTML表示機能を追加する場合は個別に脅威分析する

## 認証と認可

- OAuth stateとPKCEはEasy Authに管理させ、アプリ独自の不完全な認証フローを併設しない
- Entraのtenantを固定する
- `X-MS-CLIENT-PRINCIPAL`はEasy Authを迂回できない経路でだけ信頼し、構造と必須claimを検証する
- Entraログイン成功を業務権限の付与と同一視しない
- `roles`、所属情報の有無、対象データ単位の権限をサーバーで確認する
- `groups`を`roles`として発行せず、所属表示とApp Role認可を分離する
- 管理者機能は一般ユーザー機能と明確に分離する

## 外部通信

- 接続先URLを環境変数で管理する
- timeoutを設定する
- TLS証明書検証を無効化しない
- 応答を信頼せずスキーマ検証する
- APIキーはサーバー側のみで使用する

## ログ

記録してよいもの:

- 相関ID
- 時刻
- 操作名
- 成否
- エラー分類
- 必要最小限のユーザー識別子

記録禁止:

- password
- client secret
- APIキー
- access/refresh token
- authorization code
- Cookie全文
- `X-MS-CLIENT-PRINCIPAL`全文と`X-MS-TOKEN-AAD-*`
- RAGの質問・回答全文などの業務情報（承認された場合を除く）

## 脆弱性対応

- Dependabotを週次実行する
- React Router Security Advisoryを購読する
- Critical: 原則24時間以内に評価、72時間以内に修正
- High: 3営業日以内に評価、10営業日以内に修正
- Medium/Low: 月次メンテナンスで対応
- 修正困難な場合はWAF、機能停止、アクセス制限などの暫定対策を記録する

`npm audit`だけで安全を判断せず、フレームワークのSecurity Advisoryと変更履歴を確認します。

## 定期点検

四半期ごとに以下を確認します。

- EntraアプリとEasy Authのredirect URI、issuer、allowed audience
- Easy AuthのToken Storeが不要なアプリで無効であること
- 利用していない権限
- 退職者・異動者の権限反映
- Cookie設定
- 外部公開endpoint
- npm依存関係
- Docker base image
- バックアップと復旧試験
