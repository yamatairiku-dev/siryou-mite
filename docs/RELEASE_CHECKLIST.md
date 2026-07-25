# リリースチェックリスト

## 変更確認

- [ ] 目的と影響範囲がPRに書かれている
- [ ] 認証・認可への影響を確認した
- [ ] 新しい環境変数を文書化した
- [ ] 新しい依存関係をレビューした
- [ ] ロールバック方法が決まっている

## 自動確認

- [ ] `npm ci`
- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `npm run test:e2e`
- [ ] `npm run build`
- [ ] Docker image build
- [ ] Dependency/Security scan

## ステージング

- [ ] Entra IDログイン
- [ ] セッション期限切れ
- [ ] 権限あり／なし
- [ ] 主要業務フロー
- [ ] 外部API異常時
- [ ] ログアウト
- [ ] ログに秘密情報がない
- [ ] `/health`

## 本番

- [ ] 承認者と実施者を記録
- [ ] Git commit SHA付きimageを使用
- [ ] デプロイ時刻を記録
- [ ] `/health`を確認
- [ ] 5xxと応答時間を確認
- [ ] 利用部門の代表操作を確認
- [ ] 直前imageでロールバック可能
