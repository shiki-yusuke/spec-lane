判定: **修正後可**。現状のまま `2_spec` へ進めてはいけません。

read-only の静的レビューです。対象・関連実装は変更せず、テストや `lane validate` も実行していません。

## 1. 1巡目 Must 9件

1. `D3 / RULE-30・31 / TEST-45 → 解消` → v2 literal への原子的移行、旧 observation の自然除外、SCOPE-5..7 が明記された → 根拠（`spec.md:76-91,321-329,714`）→ 修正なし。SCOPE 承認は別途必要。
2. `RULE-07 / TEST-46・47 → 解消` → 3 counter は明示的な有限整数 `0` のみ clean、欠落・負数・小数・非有限値を拒否する → 根拠（`spec.md:252-258,715-716`）→ 修正なし。
3. `D8・D11 / RULE-15・16・25・33・38 / TEST-19・48・49・62 → 解消` → 全 phase staging/preflight 後に trace、導出、単一 ledger/overlay 書込みとなり、拒否時の3ファイル byte 不変も明記された → 根拠（`spec.md:116-139,276-284,333-352,686-687,717-718,731`）→ 修正なし。
4. `D14・D15 / RULE-23・29・34 / TEST-43・44・50・51 → 解消` → event-id dedup、時刻、ledger 順、correction の優先順位と、classification-only projection が定義された → 根拠（`spec.md:148-169,303-337,712-720`）→ 修正なし。
5. `D17 / TEST-52 → 解消` → recovery が `usage-import → 同一 identity の calibrate` と明記された → 根拠（`spec.md:170-178,516-523,721`）→ 修正なし。
6. `D19 / RULE-12・20 / TEST-24・53・64 → 部分解消` → entry/observation は code+detail、estimate/v2 は code-only という裁定は成立。ただし intent S4 は依然「estimate/v2 に failing condition」と要求する → 根拠（`spec.md:182-189,268-271,293-298,742-746`; `intent.yaml:43-44`）→ intent S4 を Phase 3 ではなく今更新する。
7. `D20 / RULE-32 / TEST-54 → 解消` → field-absent の実形状を `"unknown"` / `null` に単一関数で正規化する → 根拠（`spec.md:190-194,330-332,723`）→ 修正なし。
8. `RULE-28 / TEST-41・57 → 解消` → `producer_version` と `accounting_basis` の双方に同じ長さ・制御文字境界がある → 根拠（`spec.md:315-318,710,726`）→ 修正なし。
9. `F1・F2 / critic 再実行 → 解消` → 実 fixture と field 位置を照合済みで、critic の残理由は scope と記録されている → 根拠（`spec.md:750-764`; `critic.yaml:197-207`; fixture `:3-4,142-154`）→ 修正なし。ただし下記の新規 finding を critic に反映する必要がある。

## 2. D19〜D24 の新しい穴

- `D21 / RULE-30・36 / TEST-59 → Must: reference-table の basis を捏造している` → 4個の手入力値には basis/provenance がないのに、revision write site は一律 v2 を刻印する。すると D22 は同一 basis と誤認して較正する。D21 の「generic table」は「v2 と比較可能」の根拠にならない → 根拠（`packages/cli/src/commands/estimate.ts:154-181`; `packages/core/src/application/estimate-service.ts:202-241`; `spec.md:195-215`）→ reference-table revision は既定 `"unknown"` とし、明示的 basis 指定時だけ v2 を許す。adopt/next 自体は non-goal のままでよい。
- `D22 / RULE-37 / TEST-60・61 → Must: mismatch 時の schema 形状が未定義` → 「`covered_by_p80` を assert しない」とあるが、現 schema は boolean 必須であり、omit/null のどちらも通らない → 根拠（`spec.md:204-215,344-348`; `packages/schemas/src/calibration.ts:68-89`）→ mismatch branch を明示し、`covered_by_p80: null` など一意の形状を RULE/TEST に固定する。
- `D22 / TEST-60 → Must: reason enum 追加は単なる additive ではない` → 古い生成 JSON Schema は `predicted_p50_zero` 以外を拒否し、calibration store は全ファイルを同 schema で parse するため、旧 binary/downgrade consumer は新記録一件で停止する → 根拠（`packages/schemas/generated/calibration.schema.json:337-376`; `packages/cli/src/calibration-store.ts:31-42`）→ schema-version/互換方針を決め、valid differential fixture、生成 schema、downgrade 制約を acceptance に追加する。
- `D19・D24 / RULE-39 / TEST-64 → Must: 「固定 template」が仕様内に存在しない` → tester が spec.md だけから期待文字列・detail 順序を導けない。また D24 は bounded basis の埋込みを許す一方、TEST-64 は payload free-text の substring を全面禁止しており境界が矛盾する → 根拠（`spec.md:227-232,353-355,580-585,733`）→ template 全文、condition の粒度、配列順、`accounting_basis` の許否を列挙する。
- `D23 / RULE-38 / TEST-62 → 新規穴なし` → 拒否時は失敗を `0` として書かず、未記録のまま診断するため「0埋めしない」と両立する。ただし durable record を失う residual は明記済み → 根拠（`spec.md:216-226,818-823,860-863`; `docs/design.md:1233-1236`）→ design.md の deferred-case 更新のみ。
- `D20 → 新規穴なし` → normalization の利用箇所と pre-change shape test は十分具体的 → 根拠（`spec.md:190-194,330-332,723`）→ 修正なし。

## 3. token basis v2 の経路監査

- `TEST-22 / Python parity → 見落としなし、補強推奨` → identity の4引数は不変で既存 differential が直接比較する。ただし private Python 不在時は suite が skip される → 根拠（`packages/core/test/differential/ledger.differential.test.ts:17-49`; `python-harness.ts:35-72`）→ 非 skip の固定 hash vector を1件追加すると強い。
- `RULE-12 / PATH-15 / TEST-25 → Must: migrate-legacy writer を見落としている` → 新規 legacy observation を今後も `eligible_for_knn:true`、basis/reason/detail 欠落で書くため、「every written observation」と矛盾する → 根拠（`spec.md:268-271,633,660-661`; `packages/core/src/migrate-legacy-ledger.ts:160-187`）→ `"unknown"`、`TOKEN_BASIS_MISMATCH`、detail、`eligible_for_knn:false` を書くか、RULE-12/S4 を measured-only に狭める。
- `PATH-12 / TEST-31・59 → ResourceSnapshot の追加 basis gate は不要` → snapshot は品質による全体 suppression にしか使われず、fits/not_fit の計算は adopted prediction と intent budget の比較である → 根拠（`packages/cli/src/commands/next.ts:48-113`; `packages/core/src/application/next-service.ts:60-93`）→ D21 の reference basis 修正だけ行う。
- `RULE-35 / PATH-11 / TEST-58 → Must: evidence export は部分解消` → schema description だけでは出力 JSON に label が現れず、consumer には mixed-basis 合計が通常の total に見える。さらに必要な `lane-evidence.ts` 自体が allowed_paths 外 → 根拠（`packages/core/src/application/evidence-export-service.ts:75-91`; `packages/schemas/src/lane-evidence.ts:62-70`; `packages/cli/test/evidence-export.test.ts:38-56`）→ summary に `accounting_basis_status: "unqualified"` または basis 集合を出力し、schema/service/test を scope に加える。
- `DEP-03・07・10 / schema differential → Must: committed generated schemas が scope 漏れ` → Zod が SSOTでも生成 JSON Schema は commit/publish 対象。calibration/lane-state の変更には再生成が必要 → 根拠（`docs/design.md:48-56`; `packages/schemas/scripts/generate-json-schema.ts:25-40`; `packages/schemas/test/differential.test.ts:55-79`）→ `packages/schemas/generated/**` を allowed_paths と TEST に加える。
- `SCOPE-1..8 → Must: 承認対象が不一致かつ不足` → 本文は「seven」、表と critic は8件、OQ-4 は再び SCOPE-1..7。さらに上記 migrate/evidence/generated/estimate CLI が未列挙 → 根拠（`spec.md:43-58,855-859`; `critic.yaml:99-104`）→ 一つの正規化した scope 一覧へ統合してから人間承認を求める。

## 4. `2_spec` へ進める条件

1. D21 の reference basis、D22 の mismatch 形状・schema evolution、D19/D24 の固定 template、intent S4 を確定する。  
2. migrate-legacy と evidence-export の扱いを RULE/TEST 化し、生成 schema を含む完全な allowed_paths を人間が承認する。  
3. 追加 TEST を反映して critic を再実行し、`decision: pass` を確認する。

