判定: 修正後可

read-only。指定範囲のみ確認し、テストは実行していません。親側の検証結果は前提として扱いました。

## 1. 実装と spec の不一致

1. `packages/core/src/estimator-v2.ts:97` → `knn_ineligibility_reasons === undefined` を素通しし、cohort が一致すれば候補になり得る → RULE-13/D5 は欠落を「未評価」として fail-closed にする要求 → 欠落時を明示的に除外する。ただし対応する reason code が未定義なので、既存コードへの誤マッピングはせず、除外表現を spec に追記する必要がある。

2. `packages/core/src/application/calibrate-service.ts:211` → basis mismatch の結果を `actualTokens != null` / `actualCost != null` の内側で作るため、欠測 metric は `error` から省略される → RULE-37 は basis mismatch 時に `tokens` と `cost_usd` の両方を、指定された null 形状で必ず出す → `basisMismatch` 分岐を metric 存在判定より前へ移し、両フィールドを無条件で構築する。同一 basis 時だけ既存の欠測省略を維持する。

3. `packages/cli/src/commands/usage-import.ts:355`、`packages/cli/src/commands/calibrate.ts:249` → done-overlay を entry ごとに複数回書く → D8 は最終的な `ledger_delta` を一度だけ書く設計。複数 agent entry の途中で I/O が失敗すると部分反映が残る → 全 entry をメモリ上で合成し、overlay 全体を一回で置換する bulk writer に渡す。

4. `packages/schemas/src/agent-cost.ts:99` → 3 counter が `z.number().optional()` で、負数・小数を schema が受理する → RULE-01 の「optional non-negative integers」と不一致。一方、厳格化すると RULE-07 の「負数・小数を理由として記録」と両立しない → spec 判断が必要。RULE-07 を優先するなら RULE-01 を「optional number、適格性判定で整数性を検査」に修正するのが最小。RULE-01 を優先するなら `.int().nonnegative()` にし、RULE-07 の不正値は adapter rejection と明記する。

5. `packages/adapters/src/telemetry/agent-cost.ts:15` → 推測: 「control character」を Unicode `Cc` 全体と読む場合、現 regex は C0 と DEL のみで C1（U+0080–U+009F）を通す → RULE-28 → `/\p{Cc}/u` 等へ変更。この解釈を ASCII control 限定とするなら問題なし。

重点箇所で上記以外の食い違いは見つかりませんでした。

- RULE-07: `calibrate-service.ts:47-57` は明示的な整数 `0` だけ clean。欠落・負数・小数・非有限・正整数の分類と T-3〜T-5 は一致。
- RULE-16/33/38: `usage-import.ts:247-280` で全成功 phase を preflight し、競合時は trace 追記前に run 全体を返している。失敗 phase 名も診断に含む。
- RULE-17/19/32: `ledger.ts:332-367` は同一 basis なら履歴を増やさず、異 basis＋flag 時だけ既存履歴へ置換 entry を追加する。
- RULE-25: `calibrate.ts:198-216` の競合 return は `writeCalibrationRecord`（同:223）より前。
- RULE-29: `attribution.ts:347-363` は複数 bind 判定を latest `usage_imported` 参照より先に行う。
- RULE-39: `calibrate-service.ts:90-155` は basis detail → counter の閉集合順 → session_id 順で、T-1〜T-10 の文言とも一致。T-11 も migration 差分と一致。
- RULE-40: `estimate-service.ts:250-255` は `reference_table` の場合だけ宣言値または `"unknown"`、それ以外は current basis。

## 2. 空 projection による provisional build

現実装では、ID / basis が変わる経路や二重計算による副作用はありません。

- ID は `usage-import-service.ts:78-103` で `(laneId, phase, sourceForAgent(agent), rates.catalog_version)` から決まり、projection を参照しない。
- `accounting_basis` / `producer_version` も measurement だけから決まり、projection を参照しない。
- projection が変えるのは `knn_ineligibility_reasons/detail` のみ。
- `totalsByAgent` は毎回新しい `Map` を作り、measurement を変更しない。
- provisional entry は永続化されず、最終 entry は trace 追記後の projection で再構築される。

したがって builder 再利用の判断は現在の依存関係では安全です。ただし `usage-import.ts:346-348` の最終 planner が予想外に `refuse` を返した場合、生 entry を書く fail-open fallback になっています。現状は同一入力・同一既存 ledger なので到達不能ですが、将来の ID 依存追加に備えて `throw`/assert にするのが安全です。

## 3. Schema・design・CHANGELOG

生成 JSON Schema は、差分に含まれる Zod 実装と構造上一致しています。

- `generated/calibration.schema.json`: observation の3 optional field、nullable `covered_by_p80`、追加 reason enum と一致。
- `generated/lane-state.schema.json`: 両 scope の5 optional fieldと `basis_history` が一致。
- `generated/lane-evidence.schema.json`: 実装が常時出力する2 fieldを required としており一致。

文書の不一致:

- `CHANGELOG.md:18` → calibration observation も `producer_version` を持つと読めるが、schema/builder は持たない → observation の列挙から `producer_version` を外す。
- `CHANGELOG.md:49` → RULE-37 の「両 metric に完全な mismatch 形状」という記述は、欠測時に省略する現実装と不一致 → 実装を上記 finding 2 のとおり直す。
- `CHANGELOG.md:85` → k-NN 母集団になるのは `cost_ledger` entry ではなく calibration observation → 主語を置換する。
- `docs/design.md:1258` → 拒否中は対象 session が audit 集合に現れないと断定しているが、過去の `usage_imported` があればその過去状態で現れる → 「今回の failure record は追加されず、過去イベントもなければ集合に現れない」と限定する。