#!/usr/bin/env bash
# タスクの進捗・作業中タスク・直近コミット・未コミット差分をまとめて表示する。
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
t=docs/agent/TASKS.md
count() { grep -cE "^### T[0-9]+ \[$1\]" "$t" || true; }
echo "== タスク: 完了 $(count x) / 作業中 $(count '~') / ブロック $(count '!') / 未着手 $(count ' ')"
grep -E '^### T[0-9]+ \[[~!]\]' "$t" | sed 's/^### /   /' || true
echo "== ブランチ: $(git branch --show-current)"
echo "== 直近のコミット"; git log --oneline -8 | sed 's/^/   /'
echo "== 未コミットの変更"; git status --short | sed 's/^/   /'
echo "== 退避(stash)"; git stash list | sed 's/^/   /'
q=$(awk '/^## 記録/{f=1} f && /^### Q-[0-9]+ \[未回答\]/{n++} END{print n+0}' docs/agent/QUESTIONS.md)
echo "== 未回答の確認事項: ${q} 件(docs/agent/QUESTIONS.md)"
