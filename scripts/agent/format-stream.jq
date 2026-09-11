# claude -p --output-format stream-json の出力を、司令塔とサブエージェントを区別して表示する。
# 使い方: jq -n -r --unbuffered -f scripts/agent/format-stream.jq < log.jsonl
def who($agents; $parent):
  if $parent == null then "[main]"
  else "[" + ($agents[$parent] // "subagent") + "]" end;

def oneline: tostring | gsub("\\s+"; " ") | .[0:160];

def tool_summary:
  if .name == "Agent" or .name == "Task" then
    "▶ サブエージェント起動: " + ((.input.subagent_type // "general") + " / " + (.input.description // "") | oneline)
  elif .name == "Bash" then "$ " + ((.input.command // "") | oneline)
  elif .name == "Edit" or .name == "Write" or .name == "MultiEdit" then "✎ " + (.input.file_path // "")
  elif .name == "Read" then empty
  else "・" + .name end;

foreach inputs as $m (
  {agents: {}, out: []};
  .out = []
  | if $m.type == "assistant" then
      ($m.parent_tool_use_id) as $p
      | reduce ($m.message.content[]?) as $c (.;
          if $c.type == "tool_use" and ($c.name == "Agent" or $c.name == "Task") then
            .agents[$c.id] = (($c.input.subagent_type // "subagent") + ":" + (($c.input.description // "") | .[0:30]))
          else . end
          | .out += [
              if $c.type == "text" then who(.agents; $p) + " " + $c.text
              elif $c.type == "tool_use" then (who(.agents; $p) + " " + ([$c | tool_summary][0] // empty))
              else empty end ])
    elif $m.type == "user" and $m.parent_tool_use_id == null then
      reduce ($m.message.content[]? | select(type == "object" and .type == "tool_result")) as $r (.;
        if .agents[$r.tool_use_id] then
          .out += ["[main] ◀ 完了: " + .agents[$r.tool_use_id]]
        else . end)
    elif $m.type == "system" and $m.subtype == "init" then
      .out += ["[system] session_id=" + ($m.session_id // "")]
    elif $m.type == "system" and $m.subtype == "permission_denied" then
      .out += ["[system] ⛔ 拒否: " + ($m | tostring | .[0:200])]
    elif $m.type == "result" then
      .out += ["===== RESULT =====", ($m.result // "")]
    else . end;
  .out[]
)
