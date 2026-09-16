判定: **修正後可**。現状のまま `2_spec` へ進めてはいけません。

## 1. 2巡目 Must

- D25 / RULE-40 / TEST-65 → **解消**：reference-table は既定 `"unknown"`、明示指定時のみ指定 basis を記録する → 修正なし。
- D22 / RULE-37 / TEST-60・61 → **解消**：mismatch 時の両 metric が `{relative_error_p50:null, covered_by_p80:null, reason:"token_basis_mismatch"}` に固定された → 修正なし。
- D26 / RULE-41 / TEST-66・67 → **解消**：新 binary の後方読取り、旧 binary の非対応方針、生成 schema と differential fixture が定義された → 修正なし。
- D27 / RULE-39 / TEST-64 → **部分解消**：T-1..T-11 は追加されたが、選択条件と同一 template 内の順序が一部非一意 → 下記3点を修正。
- D28 / RULE-42 / TEST-68 → **解消**：legacy migration は `"unknown"`、T-11、非 eligible を必ず記録する → 修正なし。
- RULE-35 / TEST-58・69 → **部分解消**：status と basis 集合の出力要求は追加されたが、basis 配列の JSON key と空集合時の status が未定義 → 例えば `accounting_bases: string[]`、`single` は要素数1の場合のみ、と固定して TEST-69 に空集合を追加。
- D25〜28 / RULE-35・37・39〜42 / TEST-60・64〜69 → **解消（scope 表記）**：SCOPE-1..13 が単一表に統合され、`publish/spec-lane/package.json` を含め承認済み、open question も閉じている → 修正なし。

## 2. Template の一意性

結論: **まだ一意には導けません。**

- D27 / RULE-39 / TEST-64 → **T-3〜T-5**：複数 counter が同じ template で発火した場合の相互順序がない → `counter_name` を記載済み閉集合の順、または辞書順で並べると明記。
- D27 / RULE-39 / TEST-64 → **T-6・T-8**：「usage はあるが binding なし」と「ledger にあり never bound」が重なる → condition をそれぞれ厳密に `attribution state == unbound` / `== orphan_usage` と固定。
- D27 / RULE-39 / TEST-64 → **T-7**：複数 binding のどの `{task_run_id}` を埋めるか未定義 → 最小修正は `, including {task_run_id}` を削除。
- D27 / RULE-39 / TEST-64 → **T-1・T-2・T-9〜T-11**：入力値が確定すれば一意 → 修正なし。

read-only の静的確認であり、テストや `lane validate` は実行していません。