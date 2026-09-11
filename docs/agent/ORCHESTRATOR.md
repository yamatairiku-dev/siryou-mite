# 司令塔エージェントの手順

自律実装の実行(`scripts/agent/run.sh`)では、メインセッションが司令塔になり、この手順に従う。
司令塔はコードを書かない。実装は `implementer`、確認は `reviewer` サブエージェントに任せ、
司令塔は選定・検証・コミット・記録だけを行う。

## 基本ルール

- ユーザーに質問しない。承認も待たない。判断できない点は `docs/agent/QUESTIONS.md` に記録して先へ進む
- 作業ブランチから移動しない。`main` へコミットしない。push・リモート操作をしない
- 設計の正本は `docs/APPLICATION_DESIGN.md`。設計書・`AGENTS.md`・`CLAUDE.md`・`.claude/` は変更しない
- タスクは1つずつ直列に処理する(PostgreSQLとnode_modulesを共有しているため並列にしない)
- サブエージェントの報告をそのまま信用しない。テスト結果は司令塔が自分で実行して確認する

## 1タスクの流れ

1. `docs/agent/TASKS.md`、`docs/agent/QUESTIONS.md`、`git log --oneline -15`、`git status` を確認する
2. `[~]` のタスクがあれば前回の中断。`git status` と差分を確認し、続行するか、`git stash push -m "<ID> interrupted"` で退避して `[ ]` に戻す
3. 依存がすべて `[x]` の `[ ]` タスクのうち、最も上にあるものを選ぶ。なければ「最終確認」へ
4. そのタスクを `[~]` にする
5. `implementer` を起動する。プロンプトには次を必ず含める(サブエージェントは会話履歴を持たない)
   - タスクIDと、`TASKS.md` の該当ブロック全文
   - 読むべき設計の§番号と関連ファイル
   - 関連する `QUESTIONS.md` の回答済み項目
   - 🔒 付きタスクは `model: opus`、それ以外は `model: sonnet` を指定する
6. 報告を受けたら、司令塔が `npm run verify` を実行して結果を確認する
7. `reviewer` を起動し、タスクIDと完了条件を渡して `git diff` をレビューさせる
8. 「要修正」があれば、指摘を渡して `implementer` を再度起動する(最大2回)
9. 成功した場合:
   - `TASKS.md` の該当タスクを `[x]` にし、1行の実装メモを添える
   - `git add -A && git commit -m "feat(<ID>): <要約>"`(コミット前にhookが `npm run verify` を実行する)
10. 2回直しても通らない、または設計判断が必要で進めない場合:
   - `git stash push -u -m "<ID> blocked"` で変更を退避する(`reset` や `checkout -- .` は使わない)
   - `TASKS.md` を `[!]` にし、`QUESTIONS.md` に理由・試したこと・stash名を記録してコミットする
   - このタスクに依存するタスクは飛ばし、次の着手可能なタスクへ進む
11. ターンの最後に、次の形式で状況を出力する(完了判定は会話に出た内容だけで行われる)

```
STATUS: done=<[x]の数> blocked=<[!]の数> remaining=<[ ]の数> this_run=<今回完了した数>
LAST_VERIFY: <成功/失敗>(直近の npm run verify の結果)
GIT_STATUS: <git status --porcelain の出力。空なら clean>
```

## 最終確認(終了前に必ず行う)

1. `npm run verify` を実行する
2. T10以降が完了していれば `npm run test:e2e` も実行し、失敗したら内容を `QUESTIONS.md` に記録する
3. `git status --porcelain` が空であることを確認する
4. 今回完了したタスク、ブロックしたタスク、人に確認してほしい事項を短くまとめて出力する
