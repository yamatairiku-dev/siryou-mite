# 開発規約

## 1. 基本原則

- 読みやすさを短さより優先する
- 既存の標準機能で解決できる場合は依存ライブラリを追加しない
- サーバーとブラウザの境界をファイル名で明示する
- 認証、認可、入力検証、ログを業務機能の一部として実装する
- 一時的な調査結果や完了報告をリポジトリ直下へ追加しない

## 2. 技術標準

| 項目 | 標準 |
|---|---|
| UI | React関数コンポーネント |
| フレームワーク | React Router Framework Mode |
| レンダリング | SSR有効 |
| RSC | 使用禁止 |
| 言語 | TypeScript strict |
| 入力検証 | Zod |
| 単体テスト | Vitest |
| E2E | Playwright |
| 実行環境 | Node.js 24、Docker |
| 認証 | Microsoft Entra ID |

## 3. ディレクトリ

```text
app/
  routes/                 route module、resource route
  lib/
    auth/                 認証
    *.server.ts           サーバー専用処理
tests/
  unit/
  e2e/
docs/
```

業務単位が大きくなった場合は`app/features/<機能名>/`を追加し、コンポーネント、
スキーマ、サービスをまとめます。

## 4. route実装

- 読み取りはloader
- 更新はaction
- API、Webhook、health checkはresource route
- 保護対象ではloader/actionの先頭で`requireUser`
- actionでは`assertSameOrigin`
- URLパラメーター、FormData、JSON、外部API応答はZodで検証
- loader/actionから秘密情報を返さない

## 5. 命名

- Reactコンポーネント: `PascalCase`
- 関数、変数: `camelCase`
- 定数: 必要な場合だけ`UPPER_SNAKE_CASE`
- サーバー専用: `*.server.ts`
- テスト: `*.test.ts`、`*.test.tsx`
- route: URLと用途が分かる名前

略語や社内用語だけの名前を避け、初めて担当する人が意味を推測できる名前にします。

## 6. エラー処理

- 利用者には短い日本語メッセージを表示する
- stack trace、内部URL、SQL、外部APIレスポンスを画面へ出さない
- ログには相関ID、処理名、結果を記録する
- 秘密情報と個人情報は記録しない
- 外部APIにはtimeoutを設定する

## 7. 依存関係

production dependency追加時はPRへ以下を記載します。

- 標準APIで代替できない理由
- メンテナンス状況
- Security Policyの有無
- ライセンス
- 削除・置換する場合の影響

React Router関連パッケージは必ず同じバージョンへそろえます。

## 8. テスト

最低限、次をテストします。

- 入力バリデーション
- 権限不足
- 外部APIの成功、timeout、異常応答
- 主要な業務ルール
- ログイン、主要操作、ログアウトのE2E

カバレッジ率だけを目的にせず、金額、権限、状態遷移など事故につながる分岐を優先します。

## 9. Gitとレビュー

- `main`は常にデプロイ可能にする
- 変更はPull Request経由
- 原則1名以上のレビュー
- 認証、認可、シークレット、依存更新は重点レビュー
- PRには目的、影響、試験、ロールバック方法を記載
- 大きな変更は小さなPRへ分割

## 10. 完了条件

- `npm run verify`が成功
- 必要なE2Eが成功
- 環境変数と運用手順が更新済み
- ログに秘密情報が出ない
- ロールバック方法が明確
- 利用部門の受入確認が完了
