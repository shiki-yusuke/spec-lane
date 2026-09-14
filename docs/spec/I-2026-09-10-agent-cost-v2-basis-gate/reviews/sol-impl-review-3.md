判定: 修正後可

read-only・指定範囲のみ確認。受理済み deviation は除外し、親側検証結果を前提とする。

## 1. 永続化前の planning

### `usage-import`: 不成立

- 早期拒否 `:143-158`、basis conflict `:315-334`：書込み済みファイルなし。
- 最初の永続化は `appendTraceEvent`（`:339`）。
- しかし、その後に `nextLedger` の fold/KPI 再計算（`:347-351`）、overlay 読込み（`:358`）、`ledger_delta` の組立て（`:367-385`）が残る。
- overlay 不在の明示的 `throw`（`:359-362`）時点では、trace ledger は全 pending event を書込み済み、done overlay / `lane-state.json` は未書込み。
- `appendTraceEvent` 自体が途中で throw する場合、trace ledger に先行イベントだけが残る可能性がある。これは I/O 部分失敗であり planning 順序とは別。
- `writeDoneOverlay`（`:387`）または `writeLaneState`（`:392`）の throw 時は、trace ledger は書込み済み。対象 ledger ファイルの低レベルな原子性は、この確認範囲では不明。

したがって `:337` の「every plan ... succeeded」は実装順と一致しない。

### `calibrate`: basis/ledger planning について成立

- 入力・telemetry 拒否／throw（`:124-153`）：書込み済みファイルなし。
- basis conflict の拒否（`:233-238`）：書込み済みファイルなし。
- `planOrThrow`（呼出し `:263`, `:286`）または overlay 不在 throw（`:271-274`）は `:291-295` で処理され、書込み済みファイルなし。
- ledger payload は `:249-290` で完成し、最初の永続化は observation（`:305`）。
- ledger 書込み失敗（`:315-321`）時は、成功していれば calibration observation のみが残る。逆に observation 失敗後も ledger 書込みは試行されるため、overlay / `lane-state.json` のみ残る場合もある。
- **推測**: `evaluatePrediction` / evaluation 書込み（`:345-346`）が throw すれば、observation と overlay / `lane-state.json` は既に書込み済み。ただしこれは2巡目対象の basis supersession plan ではない。

## 2. 残る修正

- `packages/cli/src/commands/usage-import.ts:337-385` → ledger/overlay payload の planning が trace 永続化後に残り、`:360` の throw で trace-only 部分書込みになる → `nextLedger` の fold・KPI再計算・必要な overlay 読込み・`ledger_delta` 組立てをすべて `appendTraceEvent` より前へ移し、完成済み payload のみを永続化する。

加えて、2巡目で残した `packages/schemas/src/agent-cost.ts:93-101` の RULE-01 コメント修正は提示差分に含まれず、今回の限定範囲では解消確認不能。上記 `usage-import` の順序修正と、この既指摘の解消確認後に PR 可。