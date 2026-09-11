# 自律実装の使い方

Claude Code を司令塔＋サブエージェント構成で、承認なしに実装させるための設定です。

## 構成

| ファイル | 役割 |
|---|---|
| `CLAUDE.md` | `AGENTS.md` を読み込み、Claude Code向けの補足を加える |
| `docs/agent/TASKS.md` | 実装タスクの正本(順序・依存・完了条件・進捗) |
| `docs/agent/QUESTIONS.md` | エージェントが迷った点と置いた仮定の記録 |
| `docs/agent/ORCHESTRATOR.md` | 司令塔の手順 |
| `docs/agent/GOAL.txt` | `/goal` に渡す完了条件 |
| `.claude/agents/implementer.md` | 実装担当(既定 sonnet、🔒タスクは opus で起動) |
| `.claude/agents/reviewer.md` | レビュー担当(opus、読み取りのみ) |
| `.claude/autonomous.settings.json` | 自律実行時だけ適用する禁止ルールとコミット前hook |
| `.claude/hooks/verify-before-commit.sh` | main へのコミット禁止と、コミット前の `npm run verify` 強制 |
| `scripts/agent/run.sh` | 自律実行の本体(auto モード＋ `/goal`) |
| `scripts/agent/start-in-tmux.sh` | tmux 内で `run.sh` を起動する |
| `scripts/agent/watch.sh` | 実行ログを司令塔/サブエージェント別に追いかけて表示する |
| `scripts/agent/status.sh` | タスク進捗・作業中タスク・コミット・stash・未回答の確認事項を一覧する |
| `scripts/agent/format-stream.jq` | `watch.sh` と `run.sh` が使うログ整形 |

## 初回だけ

1. devcontainer を再ビルドする(Claude Code の設定 volume を追加したため)
2. コンテナ内で `claude` を起動してログインし、このフォルダを信頼する(trust ダイアログ)
3. `/permissions` などで auto モードが使えることを確認する

## 実行

```bash
# まず小さく試す
MAX_TASKS=1 MAX_TURNS=20 scripts/agent/run.sh

# 夜間など長時間
MAX_TASKS=8 MAX_TURNS=120 scripts/agent/start-in-tmux.sh
tmux attach -t siryou-agent   # 様子を見る。Ctrl-b d で離脱
```

Mac がスリープすると devcontainer も止まるため、長時間実行する間はホスト側で
`caffeinate -dims` を実行しておく。

## 実行中の様子を見る

```bash
scripts/agent/watch.sh    # 別ターミナルで。[main] が司令塔、[implementer:...] がサブエージェント
scripts/agent/status.sh   # 進捗の一覧
```

サブエージェントごとの完全な記録は `$CLAUDE_CONFIG_DIR/projects/<プロジェクト>/<session_id>/subagents/agent-*.jsonl` に残る(既定30日)。
`session_id` は `watch.sh` の先頭行に表示される。

## 実行後に人が確認すること

1. `git log --oneline agent/implementation` でタスクごとのコミットを確認する
2. `docs/agent/QUESTIONS.md` の未回答項目に回答する(`[!]` のタスクはブロック中。`git stash list` に退避された差分がある)
3. 回答を反映したら、該当タスクを `[ ]` に戻して再実行する
4. 問題なければ人が push して Pull Request を作成する

## 自律実行時に禁止していること

- push、リモート操作、ブランチ移動、`reset`・`clean` などの破棄操作、`gh`・`az`・`docker`・`sudo`
- 設計書、`AGENTS.md`、`CLAUDE.md`、`.claude/`、`.github/`、`.devcontainer/`、このスクリプトの変更
- `verify` が通らない状態でのコミット、main へのコミット

deny ルールは `sh -c` などで包まれたコマンドには一致しない。最終的な安全は、コンテナの
隔離・本番認証情報を置かないこと・GitHub の main 保護で担保する。
