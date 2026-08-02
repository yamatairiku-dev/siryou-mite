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

## Easy Auth・Entra ID設定変更

本番は`AUTH_MODE=easyauth`とし、`ENTRA_TENANT_ID`をEasy Authのsingle-tenant issuerと
一致させます。利用許可はエンタープライズアプリの「割り当てが必要」と`User`・`Admin`
App Roleで管理し、メールドメインでは判定しません。

App Roleまたは所属グループの割り当てを変更した場合は、対象利用者の再ログイン後に
`/.auth/me`のclaimsとアプリ画面を確認します。確認時にprincipal、token、Cookie全文を
チケットやログへ貼り付けず、claim typeとマスキングした値だけを共有します。緊急遮断は
Entra IDの割り当て解除・アカウント制御とセッション失効手順を組み合わせます。

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

- Preview Jobは1実行1メッセージ、最大3回試行する
- Migration Jobはdeploy前に1回実行し、失敗時はrevisionを更新しない
- Maintenance Jobは毎日UTC 18:00（JST 03:00）に実行する
- Maintenance JobはBlob削除再試行と、1年経過した監査・削除済みmetadataのpurgeを行う
- `blob_cleanup_pending`の資料metadataはBlob削除完了までpurgeしない
