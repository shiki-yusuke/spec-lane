可

## must

なし。

## should

- timeout テストが同じ adapter を各期待値ごとに再実行しており、1 ケースで subprocess を3回生成しています。拒否結果を一度だけ取得して error 型・全文を検査すると、実行時間とフレーク余地を減らせます。`packages/adapters/test/agent-cost-timeout.test.ts:78-96`
- RULE-04 の `signal` 欠落時の `unknown signal`、RULE-05 の `<original message>` 保持は実装されていますが未テストです。`describeAgentCostFailure` を直接テストし、`{ killed: true }` と `Error("boom")` を追加してください。`packages/adapters/src/agent-cost-exec.ts:33-37`
- 一時ディレクトリを削除していません。`afterEach` で `rmSync(..., { recursive:true, force:true })` し、ローカル `/tmp` の蓄積を防ぐのが望ましいです。`packages/cli/test/cli-argv-agent-cost-timeout.test.ts:123-134`
- `dist/main.js` 不在時は重要な13テストが黙って skip され、単独の `pnpm --filter @lane/cli test` が誤って green に見えます。CI は build→test 順なので今回の22件 pass は有効ですが、pretest build または明示的 failure が望ましいです。`packages/cli/test/cli-argv-agent-cost-timeout.test.ts:16-18`
- README の列挙に `usage-import` がありません。RULE-07 の字面は満たしますが、実装上4番目の利用コマンドなので明記すると運用説明が完全になります。`README.md:98-106`

## 確認済み

- RULE-01: 両 adapter の公開 `readonly timeoutMs`、共有既定値 `180_000`、公開 export を確認。`packages/adapters/src/agent-cost-exec.ts:12`, `packages/adapters/src/telemetry/agent-cost.ts:55-61`, `packages/adapters/src/budget/codex-budget.ts:119-127`
- RULE-02: calibrate / emit-metrics / next / usage-import の全経路で CLI 値が各 adapter の `timeoutMs` まで到達します。`packages/cli/src/main.ts:396-479`, `:643-665`
- RULE-03: 実 CLI で `"1"`、`"3600000"`、`"0100"` は受理、`"3600001"`、`"0"`、`"-5"`、`"1.5"`、`"abc"`、`" 12"`、`"1e3"`、`"0x10"` は option 名入り exit 1。`InvalidArgumentError` の使用も適切です。`packages/cli/src/main.ts:63-75`
- RULE-04: `err.killed === true` を timeout とする spec の分類どおりで、message は verb・timeout・signal・bin を含みます。`signal` が `null`/`undefined` の場合も `unknown signal` にフォールバックします。`packages/adapters/src/agent-cost-exec.ts:33-35`
- RULE-05: ENOENT と非0 exit は generic failure 側に入り、変更前の prefix と元の `err.message` を保持し、`timed out` を含みません。`packages/adapters/src/agent-cost-exec.ts:37`
- RULE-06: option 名・parser・範囲は `withAgentCostOptions` に一度だけ定義され、4コマンドすべてが同 helper を使用しています。`packages/cli/src/main.ts:60-88`
- RULE-07: README は flag・既定値・上限、CHANGELOG は Unreleased 配下で4コマンド・既定値・新 message を記載し、実装と一致します。`README.md:103-109`, `CHANGELOG.md:7-26`
- RULE-09: calibrate / emit-metrics / next は exit 2、usage-import は timeout 詳細付き measurement-incomplete を記録して exit 0、という既存契約を維持しています。`packages/cli/src/commands/calibrate.ts:154-157`, `packages/cli/src/commands/next.ts:58-61`, `packages/cli/src/commands/usage-import.ts:375-377`, `:427`
- `withAgentCostOptions` 化の前後で、4コマンドの既存 option と action 引数に欠落はありません。
- `sleep 5` 対 timeout 200 ms は25倍の余裕があり、`exec sleep` なので shell orphan も避けています。
- `next` テストは一時 config と存在しない rate-limit path を明示しており、開発者の home 環境に依存しません。`packages/cli/test/cli-argv-agent-cost-timeout.test.ts:229-251`
- TEST-06 の subprocess 化は直接呼び出しとの差異ですが、実際の Commander 配線まで検証する強いテストです。予定どおり deviation を記録すれば問題ありません。