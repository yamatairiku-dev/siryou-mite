# 確認事項・仮定の記録

自律実装中に設計書だけでは決められなかった点を記録します。
エージェントは質問で止まらず、ここに記録してから次の作業へ進みます。人は確認後に「回答」を埋めてください。

## 書式

```
### Q-001 [未回答] T07: <短い見出し>
- 状況: 何が曖昧だったか(該当する設計の§番号)
- 置いた仮定: どう実装したか / 実装を止めたか
- 影響範囲: 変更したファイル、stashした場合はstash名
- 回答:
```

## 記録

### Q-001 [未回答] T01: CIワークフローが `npm run verify` を呼んでいない(エージェント対象外の提案)
- 状況: `.github/workflows/ci.yml` は `typecheck` / `test:coverage` / `build` を個別に実行しており、T01で追加した `typecheck:services` / `build:services` がCIでゲートされない(設計§19.1「`npm run verify`にservice typecheck/buildを含める」)。`.github/` はエージェントの対象外
- 置いた仮定: ローカルの `npm run verify` には含めた。CI側は変更していない
- 影響範囲: 提案する差分は `ci.yml` の3ステップを `npm run verify` 1本に置き換えるだけ(後続タスクでPostgreSQL・Azuriteのservice containerが必要になった際に合わせて対応するのが効率的)
- 回答:

### Q-002 [未回答] T01: 共有Node.js imageに `build/services` が含まれていない
- 状況: 設計§7.6ではWebとDisplay・各Jobで同じNode.js imageを使うが、現在の `Dockerfile` のbuild stageは `npm run build`(Web)だけを実行している
- 置いた仮定: T01の完了条件は「空のservice entryがbuildされる」ことなのでDockerfileは変更していない。Displayを実装するT12(またはT19)でDockerfileに `npm run build:services` と成果物のコピーを追加する
- 影響範囲: `Dockerfile`。T12着手時に対応する
- 回答:
