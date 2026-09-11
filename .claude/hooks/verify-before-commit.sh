#!/usr/bin/env bash
# 自律実行時の品質ゲート: git commit の前に npm run verify を必ず通す。
# exit 2 でコミットを止め、stderr の内容がエージェントへのフィードバックになる。
set -uo pipefail

input="$(cat)"
command="$(printf '%s' "$input" | jq -r '.tool_input.command // ""')"

# "if" による絞り込みはベストエフォートのため、ここでも判定する
case "$command" in
  *"git commit"*) ;;
  *) exit 0 ;;
esac

cd "${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}" || exit 2

branch="$(git branch --show-current)"
if [ "$branch" = "main" ] || [ "$branch" = "master" ] || [ -z "$branch" ]; then
  echo "main ブランチ(または detached HEAD)へのコミットは禁止です。作業ブランチでコミットしてください。" >&2
  exit 2
fi

# タスク状態の記録(docs/agent/ 配下だけ)の変更なら verify を省略する
changed="$(git status --porcelain --untracked-files=all | awk '{print $NF}')"
if [ -n "$changed" ] && ! printf '%s\n' "$changed" | grep -qv '^docs/agent/'; then
  exit 0
fi

if ! output="$(npm run verify 2>&1)"; then
  {
    echo "npm run verify が失敗したためコミットを中止しました。原因を直してから再度コミットしてください。"
    echo "----- npm run verify(末尾80行) -----"
    printf '%s\n' "$output" | tail -n 80
  } >&2
  exit 2
fi

exit 0
