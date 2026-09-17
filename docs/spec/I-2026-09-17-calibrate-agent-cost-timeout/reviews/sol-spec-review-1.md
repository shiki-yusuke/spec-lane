修正後可

## must

- `usage-import` の exit 2 想定が現実装と不一致。計測失敗は `failedPhases` に蓄積され、`matched:false` を記録したうえで exit 0 になります（`packages/cli/src/commands/usage-import.ts:240`, `:255`, `:370`, `:422`）。D6 と TEST-04 は誤りです（`spec.md:78`, `:148`）。既存の部分失敗契約を維持し、`usage-import` 行だけ「exit 0 + `measurement-incomplete` と timeout 詳細」に直してください。fatal 化するなら、その挙動変更と永続化方針を別判断として明記・テストする必要があります。
- cross-check に「各コマンドが adapter エラーをどう終了状態へ変換するか」という軸がありません（`spec.md:186-207`）。この欠落が上記誤認を通しています。DEP-05 として command-level error propagation を追加し、calibrate / emit-metrics / next は exit 2、usage-import は現行の部分失敗契約、と明記してください。
- intent.success 6 が RULE に覆われていません。対応表自身が `— (manual)` です（`intent.yaml:43-45`, `spec.md:244`）。実セッションでの既定 timeout 検証を RULE-08 として定義し、manual verification に対応付けてください。
- RULE-01 は「既定値を使う」だけで、success が要求する「両 adapter が effective timeout を公開する」を規定していません（`intent.yaml:20-23`, `spec.md:75-77`, `:86-87`）。`public readonly timeoutMs` を RULE-01 に含めてください。
- RULE-07 だけ否定側を落とすテストがなく、`diff review` のみです（`spec.md:105-107`, `:219-228`, `:245`）。README と CHANGELOG の必須記述を検査し、変更前に失敗する TEST を追加してください。

## should

- Node 22.23.2 では通常の timeout 時に `killed:true / signal:"SIGTERM" / code:null` となることを実測確認しました。ただし既定 `SIGTERM` を子が無視すると、timeout は実時間の上限にならず、後から exit 0 にもなり得ます。「最大 180 秒で失敗」は不正確です（`spec.md:263`）。「180 秒後に SIGTERM を送る」と記述するか、hard deadline が必要なら `killSignal:"SIGKILL"` を設計してください。
- TEST-03 は回帰テストなので `fails pre-change? = no` で正しいです。ただし CodexBudgetAdapter の missing-binary ケースも加えると、両 catch 経路の ENOENT 非誤分類を直接保証できます（`spec.md:136-147`）。
- TEST-04 の前提は概ね正しいです。emit-metrics は再計測対象となる ledger entry が必要です（`packages/cli/src/commands/emit-metrics.ts:58-61`, `:85-100`）。next は存在し、全必須項目と期間整合性を満たす codex budget YAML が必要です（`packages/adapters/src/budget/codex-budget.ts:45-97`, `:127-167`）。next では利用者の `~/.claude` に依存しないよう、存在しない一時パスを `--claude-rate-limits-path` に明示してください。
- 180,000 ms は観測最大 40.9 秒に対して十分な余裕があり妥当、3,600,000 ms も暴走入力を制限する運用上限として妥当です。ただし「day-long session の plausible growth」は未計測なので、経験則であることを明記してください。
- D4 は現スコープでは許容できますが、公開 adapter に `timeoutMs:0` を直接渡すと timeout 無効化になります。将来 CLI 外の caller が増えた時点で adapter 側 invariant に昇格すべきです。

## Q1 への回答

SCOPE-2 を推奨します。

`describeAgentCostFailure` と既定値は telemetry 固有ではなく、telemetry と budget が共有する subprocess policy です。`budget/codex-budget.ts` から `telemetry/agent-cost.ts` を import すると、分類上の依存方向が不自然になります（`spec.md:65-70`）。

`packages/adapters/src/agent-cost-exec.ts` に constant と classifier を置き、両 adapter から参照してください。公開 constant のため `packages/adapters/src/index.ts` も SCOPE-2 に含め、cross-check に shared module と export surface の PATH を追加するのが明快です。

## 確認済み

- agent-cost を実際に spawn する箇所は `telemetry/agent-cost.ts:78` と `budget/codex-budget.ts:167` の2箇所だけで、第3の経路はありません。
- CLI の adapter 構築経路は calibrate / emit-metrics / usage-import → telemetry、next → budget で正しいです。
- Commander 13.1.0 の `InvalidArgumentError` は、非0終了・option 名入り usage error・action 未実行を満たすことを実測確認しました。
- TEST-01/02/04/05/06/07 の「変更前に失敗」は妥当です。TEST-03 の `no` も回帰ガードとして正しいです。
- `exec sleep 5` は timeout 実試験で `SIGTERM` を直接 sleeper に届ける構成として妥当です。
- SCOPE-1 は必須です。これがなければ `next` の flag は実質 no-op になります。

