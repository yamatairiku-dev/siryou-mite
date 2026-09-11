@AGENTS.md

## Claude Code向けの補足

- 業務機能の仕様の正本は `docs/APPLICATION_DESIGN.md`。`docs/ラフ仕様.md` は初期メモ
- 実装タスクの一覧と進捗は `docs/agent/TASKS.md`、確認事項は `docs/agent/QUESTIONS.md`
- 自律実行(`scripts/agent/run.sh`)のときは `docs/agent/ORCHESTRATOR.md` の手順に従う
- ローカルの依存サービス: PostgreSQL は `postgres:5432`、Azurite は `azurite:10000/10001`(devcontainer の compose で起動済み)
