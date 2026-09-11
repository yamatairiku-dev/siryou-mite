#!/usr/bin/env bash
# 実行中(または直近)の自律実行ログを、司令塔/サブエージェント別に追いかけて表示する。
#   scripts/agent/watch.sh            # 最新のログ
#   scripts/agent/watch.sh <logfile>  # 指定したログ
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
log="${1:-$(ls -t .agent-logs/run-*.jsonl 2>/dev/null | head -n 1)}"
[ -n "$log" ] && [ -f "$log" ] || { echo "ログがありません(.agent-logs/)" >&2; exit 1; }
echo "watching: $log (Ctrl-C で終了)"
tail -n +1 -F "$log" | jq -n -r --unbuffered -f scripts/agent/format-stream.jq
