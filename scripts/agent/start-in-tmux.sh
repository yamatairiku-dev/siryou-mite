#!/usr/bin/env bash
# ターミナルを閉じても止まらないように tmux のセッション内で run.sh を起動する。
#   scripts/agent/start-in-tmux.sh        # 起動
#   tmux attach -t siryou-agent           # 様子を見る(Ctrl-b d で離脱)
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
session="siryou-agent"
if tmux has-session -t "$session" 2>/dev/null; then
  echo "既に実行中です: tmux attach -t $session"
  exit 1
fi
tmux new-session -d -s "$session" \
  "MAX_TASKS=${MAX_TASKS:-5} MAX_TURNS=${MAX_TURNS:-60} AGENT_BRANCH=${AGENT_BRANCH:-agent/implementation} scripts/agent/run.sh; echo; echo '終了しました。Enterで閉じます'; read"
echo "起動しました: tmux attach -t $session"
