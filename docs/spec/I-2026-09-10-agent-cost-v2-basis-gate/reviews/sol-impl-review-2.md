判定: 修正後可

read-only・指定範囲のみ確認。テストは未実行で、親側検証結果を前提としました。

## 1. 1巡目の反映状況

| # | 指摘 | 判定 | 根拠 |
|---|---|---|---|
| 1 | reasons 欠落の fail-closed | 解消 | 欠落を `MIXED_OR_UNATTRIBUTED_USAGE` として除外する。`packages/core/src/estimator-v2.ts:97-104` |
| 2 | mismatch 時の両 metric 形状 | 解消 | metric の有無より先に、`tokens`・`cost_usd` を無条件生成する。`packages/core/src/application/calibrate-service.ts:207-237` |
| 3 | overlay の一括書込み | 部分解消 | 両コマンドともメモリで fold 後、一回だけ書く形にはなった。`packages/cli/src/commands/calibrate.ts:271-286`、`packages/cli/src/commands/usage-import.ts:367-401`。ただし後述の lost update が残る。 |
| 4 | RULE-01 と RULE-07 の整合 | 部分解消 | 提示された RULE-01 修正と `z.number().optional()` は整合する。一方コメントがまだ「optional non-negative integers」と記述し、実装説明と矛盾する。`packages/schemas/src/agent-cost.ts:93-101` |
| 5 | Unicode control character | 解消 | `/\p{Cc}/u` を使用し、両フィールドに適用している。`packages/adapters/src/telemetry/agent-cost.ts:14-20,112-115` |

文書4件:

| # | 文書指摘 | 判定 | 根拠 |
|---|---|---|---|
| D1 | observation に `producer_version` があるように読める | 解消 | observation は明示的に例外化された。`CHANGELOG.md:18-22` |
| D2 | mismatch の欠測 metric 省略 | 解消 | 両 metric を無条件で記録すると明記。`CHANGELOG.md:49-54` |
| D3 | k-NN 母集団の主語が ledger entry | 解消 | 母集団・既存 observation を主語に修正。`CHANGELOG.md:41-47` |
| D4 | 拒否時は audit 集合に現れないとの断定 | 解消 | 過去イベントがあれば過去状態で現れ、未記録時だけ現れないと限定。`docs/design.md:1253-1265` |

RULE-01 のコメントだけ、`optional numbers; integer/non-negative eligibility is classified by RULE-07` 相当へ直す必要があります。

## 2. overlay の競合と部分書込み

あります。

- `calibrate` は `readDoneOverlay`（`:274`）から `writeDoneOverlay`（`:286`）までに他プロセスが更新すると、古い snapshot の全体書戻しでその更新を失います。
- `usage-import` も同様です（`:372` → `:401`）。さらに basis preflight は早い時点の effective ledger（`:164-168,249-270`）に対して行われるため、後から同一 ID が別 basis で更新されても、最新 overlay に対する再判定なしで上書きし得ます。
- `calibrate` は observation を先に書き（`:246`）、その後 `planOrThrow` を実行します（`:267,291`）。特に done-overlay が preflight 後に競合更新されると throw は到達可能で、observation だけが残り、`:302-310` の partial write になります。
- `usage-import` の同等の invariant throw（`:349-357`）は trace 追記（`:285-322`）後です。**推測**: 現在の ID/basis 依存では通常到達不能ですが、発火すれば trace の部分書込みは残ります。

最小修正:

1. per-intent のプロセス間排他を done-overlay 層に置き、全 writer が同じロック下で「最新値を read → plan → 全 entry を fold → write 1回」を行う。単なる再読込では TOCTOU が残るため、ロックまたは原子的 CAS が必要です。
2. `planOrThrow` を含む全 planning を最初の永続化より前へ移す。`usage-import` は trace event をまずメモリ上で構築し、その pending event を含む projection から final entries を作って全 plan を完了後、trace と overlay を永続化する。
3. `calibrate` は overlay ロック取得後に最新 ledger で再計画し、throw の可能性を消してから observation → overlay の既存二段 upsert を行う。