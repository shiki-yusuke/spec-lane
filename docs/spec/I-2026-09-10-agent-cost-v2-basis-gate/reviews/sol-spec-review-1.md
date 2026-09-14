判定: **修正後可**。現状のまま `2_spec` へ進めてはいけません。

現行ワークツリーを基準にレビューしました。対象は未追跡のまま保持し、変更・`lane validate`・advance はしていません。なお現在の spec は提示内容より進んでおり、D16/D17・RULE-29・TEST-44 まであります。

## Must 指摘

1. **D3 / D15 → 既存の 0.1.x calibration observation が KNN に残る。** → `calibrate-service.ts` は producer に関係なく v1 を記録し、適格性を matched/priced だけで決めています。estimator は v1 literal と保存済み `eligible_for_knn` だけを読み、D15 は再計算を禁止しています（`packages/core/src/application/calibrate-service.ts:108-135`, `packages/core/src/estimator.ts:137-160`, `spec.md:64-79,117-122`）。→ **最小の修正:** token basis をこの lane で v2 へ原子的に更新し、旧 v1 observation を自然に除外する。少なくとも `token-basis.ts`、`estimator.ts`、`estimate-service.ts` を scope に追加する。D3 の別 lane 送りは success S2 と両立しません。

2. **RULE-07 → 「全カウンタが zero」の否定側が欠け、欠落値を clean と誤認できる。** → 新カウンタは optional なのに、理由を出す条件は `> 0` だけです（`intent.yaml:13-18`, `spec.md:178-199`）。current basis を名乗りつつカウンタを省略した payload が適格になり得ます。→ **最小の修正:** `conflicting_duplicate_groups`、`missing_dedup_identity_rows`、`source_quality.identity_missing` は明示的な有限整数 `0` のときだけ clean とし、欠落・負値・非整数も `MIXED_OR_UNATTRIBUTED_USAGE` にする。欠落ケースを TEST に追加する。

3. **D8 / D11 → 拒否した usage-import が authoritative trace を変更する。** → spec は basis conflict 検出前の trace 追記を許していますが、その追記は後続の attribution と eligibility を変えます（`spec.md:149-170`, `packages/core/src/trace.ts:183-202`, `packages/core/src/attribution.ts:231-275`）。「ledger は byte 不変」でも拒否操作は副作用なしではありません。→ **最小の修正:** 全 measurement をメモリに staging → entry ID/basis conflict を全件 preflight → 問題なければ trace 追記 → audit 1回 → ledger/overlay 1回書込み、の順にする。拒否時は trace、lane-state、**overlay ファイル全体**を byte 不変にする。

4. **D14 → latest の同順位・event identity・token 合算が未定義。** → `usage_imported` の identity は `(task_run, session, window)` で、`occurred_at` と `matched` は identity 外です。一方、現行 audit は全イベントの tokens を合算します（`packages/core/src/trace.ts:41-49,66-100`, `packages/core/src/attribution.ts:173-184,299-304`）。latest 化は `measurement_incomplete` だけでなく `tokens.total_measured` も変え得ます。→ **最小の修正:** 同一 `event_id` の dedup、同時刻 tie-break、correction/supersedes の優先、latest が tokens も置換するかを RULE 化する。audit の token 契約を変えないなら、latest projection は eligibility 専用に分離する。

5. **D15 / D17 → 「usage-import 再実行で recovery」は KNN observation には効かない。** → usage-import が更新するのは phase ledger だけで、estimator が読むのは calibration store の observation です（`spec.md:108-122,376-380,560-563`, `packages/cli/src/commands/usage-import.ts:220-244`, `packages/cli/src/calibration-store.ts:39-42`, `packages/core/src/estimator.ts:131-160`）。→ **最小の修正:** recovery 手順を「usage-import 後に calibrate を同じ record identity で再実行」に直し、entry と observation の両方を検証する。usage-import 単独で observation が更新される記述は削除する。

6. **S4 / RULE-12・20 → 「reason code plus failing condition」を実装できない。** → entry/observation が保持するのは code 配列だけで、複数の dedup/attribution 条件が同じ `MIXED_OR_UNATTRIBUTED_USAGE` に潰れます。estimate/v2 は候補ごとに排他的 primary reason を一つだけ数えます（`intent.yaml:43-44`, `spec.md:123-129,202-206,232-234`, `packages/core/src/estimator-v2.ts:76-114`）。→ **最小の修正:** human が S4 を「code の可視化」に狭めるか、構造化 detail を追加して estimate/v2 契約の版上げまで行う。現行 S4 のまま code-only 実装は不可です。

7. **D4 / D10 / RULE-16・17 → 既存 entry の basis 欠落ケースが未定義。** → 新フィールドは default なし optional で、v2→v3 migration も欠落を保持しますが、conflict TEST は明示的 `"unknown"` の entry だけです（`spec.md:123-132,326-341`, `packages/schemas/src/lane-state.ts:108-142`）。→ **最小の修正:** 読取り時の basis 欠落を conflict/history/diagnostic 上 `"unknown"`、producer 欠落を `null` と正規化し、実際の pre-change entry 形状で拒否と supersede を試験する。

8. **RULE-28 → `accounting_basis` に同じ境界防御がない。** → producer_version だけ長さ・制御文字を制限していますが、accounting_basis も subprocess 由来で永続化・stderr 出力されます（`spec.md:220-227,254-256`, `packages/adapters/src/telemetry/agent-cost.ts:76-114`）。→ **最小の修正:** 同じ長さ・制御文字制約を両フィールドへ適用する。

9. **critic / F1・F2 → review artifact が現行 spec/fixture より古い。** → critic は precedence、whole-output test、実物 fixture を未解決としていますが、現行 spec には D16/RULE-29/TEST-43/44 があり、fixture も存在します（`critic.yaml:108-133,199-224`, `spec.md:99-116,257-259,504-505`, fixture `:3-4,142-154`）。Falsification が要求するファイル名も実物と違います（`spec.md:522-532`）。→ **最小の修正:** fixture 名を実物へ合わせて F1/F2 を pass と記録し、critic を現行 spec に対して再実行する。

## DEP × PATH

提示された6経路は表には存在します。done overlay/effectiveLedger は spread と schema parse により新 optional fields を保持し、v2→v3 は欠落を捏造せず、legacy migration observation は token_basis 欠落により既に除外されます（`spec.md:430-440`, `done-overlay.ts:222-234`, `lane-state.ts:137-142`, `migrate-legacy-ledger.ts:179-186`）。

ただし軸は不足しています。

- **PATH追加: trace identity/read semantics** — `core/trace.ts`。D14 の latest/dedup/correction と直接衝突します。
- **PATH追加: estimate write/adopt/next chain** — `estimate-service.ts` は estimate/v2 が abstain しても v1 predicted があれば adoption を許し、`lane next` は predicted だけを読みます（`estimate-service.ts:41-54`, `commands/next.ts:85-112`）。basis abstain 後も fits/not_fit が出る経路を裁定すべきです。
- **PATH-11 evidence export** — 現在は basis/reason をすべて落として mixed-basis totals だけを出します（`evidence-export-service.ts:75-91`）。仕様内に残すなら「basis-unqualified summary」と明示するか、quality count を追加してください。
- emit-metrics の basis 非依存は RULE-22 の明示的 non-goal として許容可能ですが、TEST-29 は「安全」を証明せず「既知の gap を固定」する試験だと明記すべきです。

## success 5行の否定側不足

- **S2:** 1 exactly-attributed + 1 non-exact の複数 session ケースがない。「any session」を証明できません（`spec.md:200-201,281-295`）。
- **S2:** `anyMatched=false` の試験がない。TEST-15 は unpriced 側だけです（`spec.md:207-209,474`）。
- **S2:** current basis + dedup counter/identity_missing 欠落の試験がありません。
- **S3:** field 自体を持たない legacy entry、複数 phase 中1件だけ conflict の全体非部分更新がありません。
- **S4:** 複数の failing condition が estimate/v2 の exclusive-primary 集計で欠落する否定試験がなく、現契約では成功条件自体を満たせません。

## 実装リスクと scope

SCOPE-1..4 は現設計を実装するなら全て必要で、CLI 後段で field を付け足す等の代替は責務を重複させるため不適切です。ただし **十分ではありません**。D3 修正には `packages/schemas/src/token-basis.ts`、`packages/core/src/estimator.ts`、`packages/core/src/application/estimate-service.ts` の追加承認が必要です。

実装は、attribution の純粋 projection、measurement staging、basis supersession の純粋 plan 関数、最後の単一 commit/write の順に分けるのが安全です。`--supersede-basis` の main.ts 配線自体は低リスクですが、usage-import/calibrate の双方が同じ supersession planner を使うべきです。

## `2_spec` へ進める条件

1. D3 を撤回し token basis v2 へ原子的に移すか、同等に旧 0.1.x observation を fail-closed 除外する。
2. D8/D11 を preflight-before-trace に直し、D14 の identity・tokens・tie-break を確定する。
3. S4 を human が code-only に狭めるか、構造化 failing-condition 契約を設計する。
4. 上記の否定 TEST と legacy-field-absent TEST を追加し、DEP × PATH に trace/estimate-adopt-next を足す。
5. allowed_paths を再承認し、実物 fixture を反映した critic を更新して `decision: pass` にする。

過去メモは Lane の phase/status 確認手順だけに使用し、設計判断は現行コードと対象 fixture で再検証しました。

