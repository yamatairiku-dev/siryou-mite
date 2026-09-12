#!/usr/bin/env bash
# 利用上限などで中断しても、待ってから自動で run.sh を再開する。
#   MAX_TASKS=8 MAX_TURNS=120 scripts/agent/loop.sh
#
# 環境変数(run.sh のものに加えて):
#   MAX_ROUNDS   run.sh を起動する回数の上限(既定: 20)
#   RETRY_WAIT   上限解除時刻が読めなかったときの待ち時間(秒、既定: 900)
set -uo pipefail

cd "$(git rev-parse --show-toplevel)"

MAX_ROUNDS="${MAX_ROUNDS:-20}"
RETRY_WAIT="${RETRY_WAIT:-900}"

remaining_tasks() { grep -cE '^### T[0-9]+ \[[ ~]\]' docs/agent/TASKS.md; }

# 「resets 9:10am (Asia/Tokyo)」から再開までの秒数を求める。読めなければ RETRY_WAIT。
wait_seconds() {
  local text="$1" clock target now
  clock="$(sed -nE 's/.*resets ([0-9]{1,2}:[0-9]{2} ?[apAP][mM]).*/\1/p' <<<"$text" | head -n 1)"
  if [ -n "$clock" ]; then
    target="$(date -d "$clock" +%s 2>/dev/null)"
    now="$(date +%s)"
    if [ -n "$target" ]; then
      [ "$target" -le "$now" ] && target="$(date -d "$clock tomorrow" +%s 2>/dev/null)"
      if [ -n "$target" ] && [ "$target" -gt "$now" ]; then
        echo $(( target - now + 60 ))
        return
      fi
    fi
  fi
  echo "$RETRY_WAIT"
}

for (( round = 1; round <= MAX_ROUNDS; round++ )); do
  if [ "$(remaining_tasks)" -eq 0 ]; then
    echo "残りタスクがありません。終了します。"
    break
  fi

  # 中断で差分が残ると run.sh の事前チェックで止まるため、WIP として確定させる
  if [ -n "$(git status --porcelain)" ]; then
    git add -A
    git commit -q -m "chore(wip): 中断時の作業差分を退避"
    echo "未コミットの差分を WIP コミットしました: $(git rev-parse --short HEAD)"
  fi

  echo "===== round ${round}/${MAX_ROUNDS} $(date '+%F %T') ====="
  scripts/agent/run.sh
  status=$?

  log="$(ls -t .agent-logs/run-*.jsonl 2>/dev/null | head -n 1)"
  if [ -n "$log" ] && grep -q "hit your session limit" "$log"; then
    sleep_for="$(wait_seconds "$(grep -o "resets [^\\\\\"]*" "$log" | tail -n 1)")"
    echo "利用上限に達しました。$(date -d "+${sleep_for} seconds" '+%F %T') に再開します。"
    sleep "$sleep_for"
    continue
  fi

  if [ "$status" -ne 0 ]; then
    echo "run.sh が exit ${status} で終了しました。ループを止めます。" >&2
    exit "$status"
  fi
  echo "===== round ${round} 正常終了 ====="
done

echo "ループを終了しました。確認: scripts/agent/status.sh"
