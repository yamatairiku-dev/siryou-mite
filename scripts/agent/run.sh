#!/usr/bin/env bash
# 司令塔エージェントを承認なしで実行する(devcontainer 内専用)。
#
#   MAX_TASKS=5 MAX_TURNS=60 scripts/agent/run.sh
#
# 環境変数:
#   AGENT_BRANCH  作業ブランチ(既定: agent/implementation)
#   MAX_TASKS     この実行で完了させるタスク数の上限(既定: 5)
#   MAX_TURNS     司令塔のターン数の上限(既定: 60)
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

AGENT_BRANCH="${AGENT_BRANCH:-agent/implementation}"
MAX_TASKS="${MAX_TASKS:-5}"
MAX_TURNS="${MAX_TURNS:-60}"

fail() { echo "ERROR: $*" >&2; exit 1; }

# --- 事前チェック -------------------------------------------------------
[ -f /.dockerenv ] || [ -n "${REMOTE_CONTAINERS:-}" ] || [ -n "${DEVCONTAINER:-}" ] \
  || fail "devcontainer の中で実行してください(ホストでの自律実行は禁止)。"
command -v claude >/dev/null || fail "claude コマンドが見つかりません。"
command -v jq >/dev/null || fail "jq が見つかりません。"
[ -f docs/agent/TASKS.md ] || fail "docs/agent/TASKS.md がありません。"
[ -z "$(git status --porcelain)" ] || fail "未コミットの変更があります。コミットまたは退避してから実行してください。"

# ブランチ切り替えで作業ツリー上のファイルが差し替わるため、先に読み込んでおく
fmt="$(cat scripts/agent/format-stream.jq)" || fail "scripts/agent/format-stream.jq がありません。"
base_ref="$(git rev-parse HEAD)"

current="$(git branch --show-current)"
if [ "$current" != "$AGENT_BRANCH" ]; then
  if git show-ref --verify --quiet "refs/heads/$AGENT_BRANCH"; then
    # 古い設定のまま実行すると、切り替えた瞬間にこのスクリプト自身が旧版へ差し替わる
    git merge-base --is-ancestor "$base_ref" "refs/heads/$AGENT_BRANCH" \
      || fail "$AGENT_BRANCH が現在の ${current:-HEAD} を含んでいません。git rebase するか、AGENT_BRANCH に新しい名前を指定してください。"
    git switch "$AGENT_BRANCH"
    git diff --quiet "$base_ref" -- scripts/agent .claude \
      || fail "$AGENT_BRANCH のエージェント設定が ${current:-HEAD} と異なります。"
  else
    git switch -c "$AGENT_BRANCH"
  fi
fi
[ "$(git branch --show-current)" != "main" ] || fail "main ブランチでは実行できません。"

# 依存サービス(PostgreSQL / Azurite)の疎通確認
node -e "require('net').connect(5432,'postgres').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))" \
  || fail "PostgreSQL(postgres:5432)に接続できません。devcontainer の compose サービスを確認してください。"

# --- 実行 ---------------------------------------------------------------
mkdir -p .agent-logs
stamp="$(date +%Y%m%d-%H%M%S)"
log=".agent-logs/run-${stamp}.jsonl"

goal="$(sed -e "s/{{MAX_TASKS}}/${MAX_TASKS}/g" -e "s/{{MAX_TURNS}}/${MAX_TURNS}/g" docs/agent/GOAL.txt | tr '\n' ' ')"

echo "branch=${AGENT_BRANCH} max_tasks=${MAX_TASKS} max_turns=${MAX_TURNS}"
echo "log=${log}"

# サブエージェントの本文(text)もログに流す(v2.1.211以降)
export CLAUDE_CODE_FORWARD_SUBAGENT_TEXT=1

extra_args=()
# 確認待ちになる操作は待たずに拒否して続行させる(v2.1.259以降のみ対応)
if claude --help 2>/dev/null | grep -q -- '--permission-prompts'; then
  extra_args+=(--permission-prompts none)
fi

claude -p "/goal ${goal}" \
  --permission-mode auto \
  --settings .claude/autonomous.settings.json \
  --output-format stream-json --verbose \
  "${extra_args[@]}" \
  | tee "$log" \
  | jq -n -r --unbuffered "$fmt"

echo
echo "完了しました。確認: git log --oneline ${AGENT_BRANCH} / docs/agent/QUESTIONS.md / ${log}"
