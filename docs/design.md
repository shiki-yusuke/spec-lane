# lane 設計文書 (M0 rev2 — sol レビュー反映版)

- 対象: `lane`（Python 参照実装の TypeScript 再構築版 + 4 進化機能）
- 位置づけ: `~/.claude/plans/https-github-com-shiki-yusuke-users-a137-snug-barto.md` Track G の M0 成果物。
  **本 rev2 は `docs/reviews/2026-07-31-m0-sol-review.md`（gpt-5.6-sol、判定: 条件付き No-Go）の指摘をすべて反映した版**。
  rev1 との差分は各節に明記する。M1 着手はこの版が前提。
- 参照元: Python 参照実装 v0.7.8（ローカルの private checkout。schemas / orchestrator.py / resources.py / CHANGELOG.md）、agent-cost（`facts.py`）、`~/.claude/statusline.sh`、ai-agent-skills-playbook（impact-scan 規約）

---

## 1. スコープと非スコープ

### スコープ（v1、9月末まで）

1. Python 参照実装（orchestrator.py 3,814行）の TypeScript pnpm モノレポへの移植。丸移植ではなく後述「返済する負債」を解消した再設計。
2. 4 進化機能をすべて実装。ただし **§8 の v1 スコープ削減**を適用した縮小版で実装する（sol レビュー: 9月末制約下でフル機能を狙うとどれも中途半端になるため、各機能の核だけを固める）。
3. core/ports で定義する Tracker / Telemetry / Budget の port interface と GitHub 実装 1 本。
4. サルベージした旧時代の ledger・memories を較正母集団・知見種データとして取り込む **一度限りの importer**（§7、汎用 migration CLI にはしない）。

### 非スコープ（v1で捨てるもの）

| 捨てるもの | 理由 |
|---|---|
| 回帰ベース推定器 | 較正データ 30 件超で v2 判断。v1 は Gower 距離 + k-NN 分位点のみ（§5.1, §3.5） |
| Linear / Jira adapter | Tracker port で吸収可能。GitHub 実装 1 本で開始 |
| Codex 残枠の精密推定 | API が無く原理的に不可能。低信頼の計算値であることを表示で明示する設計に留める（§5.2） |
| Web UI・daemon | CLI ローカル運用のみ |
| per-phase skill 互換群 | Python 参照実装 の「skill 3重管理」負債を再現しない。`lane` 一本 + `lane-finish` に統合 |
| マルチユーザー同期 | 既存の社内ダッシュボード/Notion 連携も含め、team 集計は今回作らない |
| webhook emitter / 汎用 migration framework | v1 スコープ削減（§8） |

### 公開方針との関係

個人 private 開発。法務確認後に OSS 公開判断。runtime データと committable profile を物理的に分離する設計にした（§7.2）。

**M4（公開前）タスクメモ（team review、2026-07-31）**: コード/コメント中の移植元プロジェクトの実名参照は、参照実装が現時点でまだ存在し differential test の対象として直接参照する必要があるため M1〜M3 では残していた。ただしその移植元リポジトリ自体は将来的に廃棄予定であり、公開時にはリンク切れ・文脈不明な参照になる。**M4（公開前）で「参照実装呼称の一般化」スイープを実施すること**: コメント中の実名参照を "the Python reference implementation (v0.7.8)" 等の一般名称に置き換える（enum 値・schema フィールド名等のデータ契約は M1 で既に中立化済み、§12 参照）。

**M4 実装ノート（2026-07-31、着手時点）**: 上記スイープを実施した。git 追跡ファイル全体で移植元プロジェクトの実名（および社内文脈を示す他の識別子）がゼロであることを確認済み。唯一の例外は `packages/core/test/differential/python_harness.py` の `from qureo_lane import orchestrator as o` の1行（と、それを補助するコメント1行）— これは private な参照実装パッケージを実際にインポートして呼び出す唯一の技術的手段であり、実名を使わずには機能しない。この harness は差分テスト（`packages/core/test/differential/`）専用の fixture であり、参照実装が存在しない環境（公開後の CI・新規 clone 等）では `isPythonReferenceAvailable()` により自動的に skip される（M4 item 3）。

**Gate-port review 追記（2026-08-06）**: 同じ技術的例外を、normalize_criterion の移植に伴い2箇所へ拡張した。①`python_harness.py` に `from qureo_lane import validate as v`（既存の `orchestrator as o` importの隣）を追加、② maintainer 専用の golden fixture 生成スクリプト `packages/core/test/differential/generate-normalize-criterion-golden.py` の `from qureo_lane.validate import normalize_criterion`。後者は公開 CI では一切実行されない（golden fixture 自体は commit 済みの静的 JSON で、public CI が実際に読むのはそれだけ）。いずれも同じ「private な参照実装を実際に呼び出す以外に技術的手段が無い」という条件に該当する。

---

## 2. schemas 7本の定義

置き場所は `packages/schemas/src/*.ts`（zod）+ 生成 JSON Schema。

**rev1 → rev2 の方針変更（sol 裁定 c、§11 参照）**: zod を SSOT とすることは条件付き妥当と裁定された。条件として、生成した JSON Schema を **commit/publish** し、「zod parse」と「JSON Schema validate」が同じ fixture に対して同じ判定を返すことを保証する **differential fixture test** を CI に必須で入れる（Python pivot 後も生成済み JSON Schema だけで検証を続行できるようにするため）。

**重要な限界（M1 実装時に判明、Codex M1 レビュー nit、必ず読むこと）**: 生成 JSON Schema は zod の `.refine()` によるクロスフィールド不変条件（例: estimate の `p50<=p80`、verification の digest 束縛、knowledge の scope=global 明示ルール、critic の per_lens 整合性等）を **含まない**（zod-to-json-schema がこれらの predicate をドロップするため、JSON Schema 表現に変換不能）。したがって生成 JSON Schema と zod schema は「構造的制約（型・enum・pattern・required・min/max・union）」についてのみ等価であり、単独で zod schema の完全な代替にはならない。上記 differential fixture test も構造制約のみを対象にしており、refine 専用の不変条件は各 schema の zod-only unit test（例: `test/estimate.test.ts`、`test/verification.test.ts`）で別途検証する。Python pivot 後に生成 JSON Schema だけで検証を続行する場合、この限界を踏まえて refine 相当のチェックを別途 Python 側に実装する必要がある。

```
packages/schemas/
├── src/*.ts              # zod SSOT
├── generated/*.schema.json  # zod-to-json-schema の出力。commit 対象
└── test/schema-fixtures/*.json + differential.test.ts
```

### 2.1 PHASE_ORDER / PhaseSchema は schemas 層に配置（依存方向の修正）

rev1 では `phase.ts` を core 側に置き、schemas 側の `lane-state.ts` がそこから `PhaseSchema` を import する設計にしていたが、これは **schemas ⇔ core の循環依存**になっていた（sol 課題3裁定）。rev2 では依存方向を次のように固定する。

```
schemas → (依存先なし)
core     → schemas
adapters → core, schemas
cli      → core, adapters, schemas
```

`PHASE_ORDER` と `PhaseSchema` は最下層の `schemas` に置く。

```ts
// packages/schemas/src/phase.ts
export const PHASE_ORDER = ["1_intent", "2_spec", "3_implement", "4_verify", "5_done"] as const;
export const PhaseSchema = z.enum(PHASE_ORDER);
export type Phase = typeof PHASE_ORDER[number];

export const PHASE_TRANSITIONS: Record<Phase, readonly Phase[]> = {
  "1_intent": ["2_spec"],
  "2_spec": ["3_implement", "1_intent"],
  "3_implement": ["4_verify", "2_spec"],
  "4_verify": ["5_done", "3_implement"],
  "5_done": [],
};
```

`core/phase.ts` は `PHASE_TRANSITIONS` を使う純粋関数（`isValidTransition` 等）だけを持ち、定義そのものは schemas から import する。CI では `tsc -b`（project references）に加えて **dependency-cruiser** を必須にし、上記依存方向の逆流と package cycle をビルド時に機械検出する（§6, §9 checkpoint 4）。

### 2.2 intent.schema

- `linear_id`/`target_issue` → 汎用な `tracker_id`/`tracker_url`（Tracker port が付与、pattern 検証はadapter側）。
- **budget は provider 非依存の制約配列に変更**（sol「USD だけでは next と接続不可」裁定）。
- **estimate は intent 内に持たず、参照のみ**（sol 課題1裁定 — rev1 の `intent.estimate` コピーを廃止）。
- **risk_level → declared_risk に改名し immutable 運用を明文化**（sol 課題5裁定）。gate 評価時の実効値は lane-state 側の `effective_risk_log` に記録し、intent の declared_risk 自体は書き換えない。

```ts
// packages/schemas/src/intent.ts
export const RiskLevel = z.enum(["low", "medium", "high"]);
export const Confidence = z.enum(["high", "medium", "low"]);

export const BudgetConstraintSchema = z.object({
  provider: z.enum(["claude", "codex", "any"]),
  unit: z.enum(["usd", "credits"]),
  limit: z.number().positive(),
});

export const IntentSchema = z.object({
  schema_version: z.string().regex(/^\d+\.\d+(\.\d+)?$/),
  intent_id: z.string().regex(/^I-\d{4}-\d{2}-\d{2}-[a-z0-9-]+$/),
  tracker_id: z.string().optional(),
  tracker_url: z.string().optional(),
  target_pr: z.string().regex(/^[a-z0-9-]+\/[a-z0-9-]+#\d+$/).optional(),
  execution_mode: z.enum(["manual", "semi_auto", "auto"]).default("manual"),
  budget: z.array(BudgetConstraintSchema).default([]),
  estimate_ref: z.string().optional()
    .describe("estimate.json のパス（docs/spec/<intent-id>/estimate.json）"),
  baseline_estimate_revision_id: z.string().optional()
    .describe("採用した EstimateRevision の ID。lane next 等はこれだけを参照する"),
  // M2 実装レビュー追加（2026-07-31、must-2）: baseline_estimate_revision_id が「いつ」
  // 採用されたかの監査記録。adoptBaselineRevision() のみが両フィールドを一緒に書く。
  baseline_adopted_at: Iso8601Schema.optional()
    .describe("baseline_estimate_revision_id が最後に採用された時刻"),
  intent: z.object({
    business_goal: z.string().min(10),
    user_visible_intent: z.string().min(10),
    success: z.array(z.string()).min(1),
    non_goal: z.array(z.string()).default([]),
    constraints: z.array(z.string()).default([]),
    primary_user: z.string(),
    state_segments: z.array(z.string()).default([]),
    known_affected_behavior: z.array(z.string()).default([]),
    declared_risk: RiskLevel, // 旧 risk_level。immutable、gate 側で downgrade しない（§3.4）
  }),
  ai_inferred_scope: z.object({
    affected_layers: z.array(z.string()).min(1),
    related_files: z.array(z.string()).default([]),
    required_docs: z.array(z.string()).default([]),
    confidence: Confidence,
    open_questions: z.array(z.string()).default([]),
    allowed_paths: z.array(z.string()).min(1),
    forbidden_paths: z.array(z.string()).default([]),
  }),
});
export type Intent = z.infer<typeof IntentSchema>;
```

### 2.3 critic.schema

sol 裁定に基づき refine を追加する（rev1 は enum だけで整合性を検証していなかった）。

```ts
// packages/schemas/src/critic.ts（抜粋）
const PerLensSchema = z.object({
  lens_id: z.string(),
  result: z.enum(["applicable", "not_applicable", "unknown"]),
  finding: z.string().nullable().default(null),
  taxonomy: KnowledgeTaxonomy.nullable().default(null),
  open_question: z.string().nullable().default(null),
  evidence: z.string().nullable().default(null),
  knowledge_candidates: z.array(KnowledgeRefSchema).default([])
    .describe("query で提示された候補（引用したかは問わない）"),
  knowledge_refs: z.array(KnowledgeRefSchema).default([])
    .describe("実際に finding/open_question の根拠として引用した候補のサブセット"),
}).refine(
  (l) => l.result !== "applicable" || (l.finding && l.taxonomy),
  { message: "result=applicable は finding と taxonomy が必須" },
).refine(
  (l) => l.result !== "unknown" || l.open_question,
  { message: "result=unknown は open_question が必須" },
);

export function buildCriticSchema(profile: Profile) {
  const allowedLensIds = new Set([...CORE_9_LENSES, ...profile.extra_lenses.slice(0, 3)]);
  return z.object({
    schema_version: z.string(),
    intent_id: z.string(),
    risk_class: RiskLevel.optional(),
    decision: z.enum(["pass", "needs_revision", "blocked"]),
    confidence: Confidence,
    per_lens: z.array(PerLensSchema).min(1),
    halt_triggers: z.array(HaltTriggerSchema).default([]),
    missing_scenarios: z.array(MissingScenarioSchema).default([]),
    wrong_assumptions: z.array(z.string()).default([]),
    open_questions: z.array(z.string()).default([]),
    required_actions: z.array(z.string()).default([]),
  })
    .refine((c) => {
      const ids = c.per_lens.map((l) => l.lens_id);
      return new Set(ids).size === ids.length; // lens ID 重複禁止
    }, { message: "per_lens.lens_id が重複している" })
    .refine((c) => c.per_lens.every((l) => allowedLensIds.has(l.lens_id)),
      { message: "core 9 lens + extra_lenses(最大3) 以外の lens_id が含まれている" })
    .refine((c) => c.decision !== "blocked" || c.halt_triggers.some((h) => h.triggered),
      { message: "decision=blocked には triggered=true の halt_trigger が必須" })
    .refine((c) => c.halt_triggers.every((h) => !h.triggered) || c.decision === "blocked",
      { message: "triggered な halt_trigger があるのに decision が blocked でない" });
}
```

`CORE_9_LENSES` は Python 参照実装 の9 lens（lifecycle_management / error_handling / security / performance / a11y / i18n / architecture / test_coverage / documentation）をそのまま定数化する。

### 2.4 verification.schema — spec_consensus の実装可能化

rev1 の `spec_consensus`（disposition のみ）は sol レビューで「gate が読む対象の state が実在しない」「digest 管理が無く内容変更を検知できない」と指摘された。rev2 で以下に変更する。

- 旧 rev1 案にあった外部ダッシュボード連携用フィールドと `calibration_verdict` は rev1 と同様に削除（sol 裁定 b: 妥当）。
- `deviation.disposition` を `action`（accept/fix/update_spec）+ `status`（pending/resolved）に分離。`status=resolved` は `action=accept` でも rationale 必須。
- `spec_digest` / `verification_digest`（sha256）を追加し、`reviewer_ack` がその digest を束縛する。内容変更で ack が自動失効する。
- `reviewer_ack.reviewer_kind`（self/independent_agent/human）を追加。

```ts
// packages/schemas/src/verification.ts（抜粋）
export const DeviationSchema = z.object({
  spec_ref: z.string(),
  actual: z.string(),
  action: z.enum(["accept", "fix", "update_spec"]),
  status: z.enum(["pending", "resolved"]),
  rationale: z.string().optional(),
  evidence_ref: z.string().optional(),
}).refine(
  (d) => d.status !== "resolved" || (!!d.rationale && d.rationale.length > 0),
  { message: "status=resolved には rationale が必須（action=accept でも理由必須）" },
);

export const ReviewerAckSchema = z.object({
  reviewer_kind: z.enum(["self", "independent_agent", "human"]),
  reviewer_id: z.string(),
  acked_at: z.string().datetime(),
  spec_sha256: z.string(),
  verification_sha256: z.string(),
  evidence_ref: z.string().optional(),
  note: z.string().optional(),
  override_reason: z.string().optional()
    .describe("risk_class(effective)=high で reviewer_kind=self を使う場合は必須（監査 override）"),
});

export const SpecConsensusSchema = z.object({
  spec_ssot_ref: z.string(),
  spec_digest: z.string(),
  verification_digest: z.string(),
  deviations: z.array(DeviationSchema).default([]),
  reviewer_ack: ReviewerAckSchema.nullable().default(null),
}).refine(
  (sc) => !sc.reviewer_ack ||
    (sc.reviewer_ack.spec_sha256 === sc.spec_digest && sc.reviewer_ack.verification_sha256 === sc.verification_digest),
  { message: "reviewer_ack の digest が現在の spec/verification と不一致（内容変更で自動失効扱い）" },
);
```

low/medium risk は `reviewer_kind: self` を既定で許容する。high risk は `independent_agent`/`human` を既定とし、`self` を使う場合は `override_reason` 必須（監査記録として残る）。

### 2.5 lane-state.schema — 「変更なし移植」不可

sol レビューで、rev1 が Python 参照実装 の lane-state をそのまま移植する前提だったこと自体が指摘された。実際に Python 参照実装 の schema は `phase_history.result` の enum に `"in_progress"` を含めておらず、実行中フェーズの状態を表現できないという **schema/実装の乖離バグ**があった（advance 前の running なフェーズが `phase_history` に記録される際、どの result 値で表現していたか schema 上定義が無い）。これを修正して移植する。また `cost_ledger` / `usage_import_attempts` / gate overrides / effective mode / risk 実効値 / PR provenance は Python 参照実装 では ad-hoc な dict として書き込まれ、schema で型付けされていなかった。rev2 ではすべて正式 schema 化する。

```ts
// packages/schemas/src/lane-state.ts（抜粋）
export const PhaseHistoryEntrySchema = z.object({
  phase: PhaseSchema,
  started_at: z.string().datetime(),
  ended_at: z.string().datetime().optional(),
  result: z.enum(["in_progress", "completed", "halted", "needs_revision", "aborted"]), // in_progress を追加
  retry_count: z.number().int().nonnegative().default(0),
});

export const LedgerEntrySchema = z.object({
  ledger_entry_id: z.string(),
  lane_id: z.string().nullable(),
  phase: PhaseSchema,
  source: z.enum(["manual", "claude_jsonl_auto", "codex_sqlite_auto"]),
  scope: z.enum(["phase", "lane"]),
  session_ids: z.array(z.string()).default([]), // 差し戻し union 対応（§3.6）
  data_state: z.enum(["no_data", "zero_tokens", "has_usage", "import_failed", "superseded"]),
  confidence: z.enum(["imported_windowed", "imported_lane", "estimated", "manual"]),
  included_in_kpi: z.boolean(),
  tokens: z.number().nonnegative().nullable(),
  turns: z.number().int().nonnegative().nullable(),
  cost_usd: z.number().nonnegative().nullable(),
  cost_credits: z.number().nonnegative().nullable(),
  pricing_version: z.string().nullable(),
  pricing_as_of: z.string().datetime().nullable(),
  imported_at: z.string().datetime(),
});

export const UsageImportAttemptSchema = z.object({
  lane_id: z.string().nullable(),
  phase: PhaseSchema,
  scope: z.enum(["phase", "lane"]),
  source: z.enum(["claude_jsonl_auto", "codex_sqlite_auto"]),
  exit_status: z.enum(["success", "failed"]),
  data_state: z.string(),
  attempted_at: z.string().datetime(),
});

export const GateOverrideSchema = z.object({
  gate_id: z.string(), reason: z.string(), actor: z.string(), overridden_at: z.string().datetime(),
});

export const EffectiveRiskEvaluationSchema = z.object({
  gate_id: z.string(),
  effective_risk: RiskLevel,
  applied_rule_ids: z.array(z.string()),
  profile_digest: z.string(),
  evaluated_at: z.string().datetime(),
}); // §3.4 の risk 実効値監査ログ

export const ModeResolutionSchema = z.object({
  requested_mode: z.enum(["manual", "semi_auto", "auto"]),
  effective_mode: z.enum(["manual", "semi_auto", "auto"]),
  applied_rule_id: z.string().nullable(),
  resolved_at: z.string().datetime(),
});

export const LaneStateSchemaV2 = z.object({
  schema_version: z.literal("2.0"),
  intent_id: z.string(),
  tracker_url: z.string().nullable(),
  pr_url: z.string().nullable(),
  pr_provenance: z.enum(["advance", "done_overlay", "sync_done"]).nullable().default(null),
  owner: z.string().nullable(),
  current_phase: PhaseSchema,
  status: z.enum(["pending", "running", "paused", "completed", "aborted"]),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime().optional(),
  phase_history: z.array(PhaseHistoryEntrySchema).default([]),
  halt_info: HaltInfoSchema.nullable().default(null),
  retry_log: z.array(RetryLogEntrySchema).default([]),
  effective_risk_log: z.array(EffectiveRiskEvaluationSchema).default([]),
  mode_resolution_log: z.array(ModeResolutionSchema).default([]),
  cost_ledger: z.array(LedgerEntrySchema).default([]),
  usage_import_attempts: z.array(UsageImportAttemptSchema).default([]),
  usage_import_gate_overrides: z.array(GateOverrideSchema).default([]),
  metrics: MetricsSchema.optional(),
}).passthrough();
// passthrough の理由: 将来のフィールド追加で「知らないキーを黙って strip する」ことによる
// 過去データの実質的破壊を防ぐ。既知フィールドは上記で厳格に型検証し、未知キーは
// そのまま保持して読み書きする（.strict() は使わない）。

export function parseLaneState(raw: unknown): LaneState {
  const version = (raw as { schema_version?: string })?.schema_version;
  if (version === "1.0" || version == null) {
    return migrateLaneStateV1ToV2(LaneStateSchemaV1.parse(raw)); // version dispatcher + migration
  }
  return LaneStateSchemaV2.parse(raw);
}
```

**MP-8 実装修正（2026-08-08、sol 裁定）**: 実タスクで `lane calibrate` が実測（token/cost）を
observation として記録しても `cost_ledger` には一切書き込まず、`lane emit-metrics` が
`no_data` を返す欠測が実際に発生することを確認した（このタスク自身の Intent
`I-2026-08-08-measurement-path-fix` の premise_evidence に、104.8M トークン/$28.34 の
再現ログを記録済み）。根本原因は `LedgerEntrySchema.phase` が `scope` の値に関わらず常に
必須だったこと ── `scope:"lane"`（レーン全体を計測する entry）には収める先の `phase` が
無く、`deriveIncludedInKpi` 側にその分岐が用意されていたにもかかわらず、実際に
`scope:"lane"` entry を生成する経路がリポジトリ全体に一つも存在しなかった。

修正: `LedgerEntrySchema` を `scope` で discriminate する union へ変更
（`scope:"phase"` → `phase` 必須 / `scope:"lane"` → `phase: null`）。両分岐に
`since`/`until`/`agents`（この entry を生成した agent-cost 問い合わせの selector そのもの、
`lane emit-metrics` が同じ window で再照会するために保持）を追加。`LaneStateSchemaV2`
（旧定義、`"2.0"`）は migration-source 専用として維持し、フィールド追加後の現行スキーマは
`LaneStateSchemaV3`（`"3.0"`）。既存の v1→v2 と同じ「透過的に read 時 upgrade する」
方針を v2→v3 にも適用（sol 裁定: 既存の v2 実ファイル ── phase-scoped entry や
done overlay を持つ実運用中の lane ── を拒否したり明示 migrate を要求したりしない）。

`lane calibrate` は observation と同じ measurement から `scope:"lane"` の
`LedgerEntry`（`phase: null`, `source: "claude_jsonl_auto"`, `confidence: "imported_lane"`）
を同時に構築し、両方を冪等 upsert する（片方だけ成功した場合は非0終了で「再実行で修復可能」
と明記）。`lane emit-metrics` は `scope:"lane"` entry を `whole-delivery` という単一の
activity として扱い、phase 按分による record 捏造は行わない。lane-scope entry と
phase-scoped entry の session_ids が完全に重なる場合は `deriveIncludedInKpi`
（`ledger.ts`、既存の codex 専用ルールとは別に追加）側で lane-scope entry を除外し、
部分的にしか重ならない曖昧なケースのみ既存の `detectAmbiguousSessionAttribution`
（`metrics-service.ts`）を拡張して emit 全体を fail-closed にする。post-merge の
calibrate（done overlay 存在後）は in-repo `lane-state.json` を書き換えず、overlay 側の
新設 `ledger_delta` に upsert し、`emit-metrics` は in-repo + overlay を合成した
`effectiveLedger()` を読む（`done-overlay.ts` の「merge 後に in-repo を変更しない」原則を
拡張）。

同じレビューラウンドで、`premise_evidence.method` の不正値エラーを zod の `errorMap` で
schema 層に固定（CLI 側の再定義・パターンマッチ無し）、`token_basis`
（`"agent-cost-raw-total/v1"`）を observation/estimate revision 双方に記録して
k-NN population filtering の基準にし、`lane estimate` の silent な reference_table
デフォルト（50,000/150,000 トークン、$1/$4）を廃止して明示指定を必須化、
`evaluatePrediction`/`leaveOneOutValidate` が `predicted.p50=0` で `Infinity` を生成して
JSON round-trip を破壊する不具合を `relative_error_p50: null + reason` へ修正した
（大きい有限値、例えば 2096.03396 倍は clip せず正確に保持する）。

### 2.6 estimate.schema — revision 追記型（rev1 からの最大の変更点）

**sol 課題1裁定の核心**: 見積もりを事後に書き換えると「後知恵バイアス」が入り、較正ループの目的（予測精度の検証）そのものが壊れる。rev1 の「estimate.json を継続更新する可変ドキュメント」という設計を、**revisions の追記のみ許可**（既存 revision は不変）に変更する。intent は `estimate_ref` + `baseline_estimate_revision_id` で参照するだけで、値のコピーは持たない。

predictors も精緻化する: `files_touched_estimate`（impact-scan の候補 path 数）と `files_touched_observed`（実装後の実 diff ファイル数）を分離する。rev1 は `allowed_paths` の glob マッチ件数を `files_touched` としていたが、これは「許可範囲の広さ」であって「変更されるファイル数の予測」ではないという指摘（sol）を反映した。`spec_rule_count` は Phase2 未完了時に `0` ではなく `null` を入れる（未確定を確定値と混同しない）。`novel_surface` は `true|false|unknown` の3値にする（knowledge DB が空なだけで novel と誤認する事故を避ける）。

```ts
// packages/schemas/src/estimate.ts
export const ImpactScanSnapshotSchema = z.object({
  scan_version: z.string(),
  repo_commit: z.string(),
  candidate_paths: z.array(z.string()),
  candidate_layers: z.array(z.string()),
  open_items: z.array(z.string()).default([]),
  digest: z.string().describe("candidate_paths+layers の sha256。再現性検証用"),
});

export const PredictorsSchema = z.object({
  files_touched_estimate: z.number().int().nonnegative().nullable(),
  files_touched_observed: z.number().int().nonnegative().nullable(),
  layers_crossed: z.number().int().nonnegative().nullable(),
  risk_class: RiskLevel,
  spec_rule_count: z.number().int().nonnegative().nullable(),
  novel_surface: z.enum(["true", "false", "unknown"]),
});

const QuantileSchema = z.object({
  p50: z.number().nonnegative().finite(),
  p80: z.number().nonnegative().finite(),
}).refine((q) => q.p50 <= q.p80, { message: "p50 must be <= p80" });

export const NeighborSchema = z.object({
  intent_id: z.string(),
  distance: z.number().nonnegative(),
  measurement_quality: z.enum(["observed", "reconstructed", "imputed"]),
});

export const EstimateRevisionSchema = z.object({
  revision_id: z.string(),
  estimated_at: z.string().datetime(),
  as_of_phase: PhaseSchema,
  repo_commit: z.string(),
  impact_scan_snapshot: ImpactScanSnapshotSchema.optional(),
  estimator_version: z.string(),
  predictors: PredictorsSchema,
  predicted: z.object({
    tokens: QuantileSchema,
    cycle_time_min: QuantileSchema.optional(),
    cost_usd: QuantileSchema,
  }),
  neighbors: z.array(NeighborSchema),
  population_condition: z.object({
    population_size: z.number().int().nonnegative(),
    method: z.enum(["knn_quantile", "reference_table", "manual_fallback"]),
    experimental: z.boolean().describe("母集団 <30 は常に true"),
    leave_one_out_p50_error: z.number().optional(),
    leave_one_out_p80_coverage: z.number().optional(),
  }),
}).refine(
  (r) => r.population_condition.method !== "knn_quantile" || r.predicted.cost_usd.p50 > 0,
  { message: "knn_quantile では誤差計算対象 (cost_usd.p50) に 0 を許容しない" },
);

export const EstimateSchema = z.object({
  schema_version: z.string(),
  intent_id: z.string(),
  revisions: z.array(EstimateRevisionSchema).min(1),
});
export type Estimate = z.infer<typeof EstimateSchema>;
```

`core/application/estimate-service.ts` は `appendRevision()` のみを公開し、既存 `revisions[]` の要素を書き換える API は用意しない（追記専用をコード上で強制する）。`lane calibrate` は `intent.baseline_estimate_revision_id` が指す revision を**参照するだけ**で、その revision 自体は変更しない。

### 2.7 calibration.schema — 観測と予測評価の分離

sol 裁定: 「観測（predictors + actual）」と「予測評価（estimate_revision_id + predicted + error）」は別物であり、1つの schema に混ぜると「予測が無い観測（サルベージした legacy ledger）」を表現できない。discriminated union で分離する。

```ts
// packages/schemas/src/calibration.ts
export const CalibrationObservationSchema = z.object({
  schema_version: z.string(),
  record_id: z.string(),
  kind: z.literal("observation"),
  intent_id: z.string(),
  recorded_at: z.string().datetime(),
  predictors: PredictorsSchema,
  predictor_quality: z.enum(["observed", "reconstructed", "imputed"]),
  actual: z.object({
    tokens: z.number().nonnegative().optional(),
    cycle_time_min: z.number().nonnegative().optional(),
    estimated_cost_usd: z.number().nonnegative().optional(), // 旧 cost_usd から改名
    credits: z.number().nonnegative().optional(),
    pricing_catalog_version: z.string().optional(),
    pricing_status: z.enum(["priced", "unpriced", "stale"]).optional(),
  }).describe("欠測 metric は省略する。0 で代用しない"),
  measurement_quality: z.enum(["observed", "reconstructed", "imputed"]),
  eligible_for_knn: z.boolean(),
  provenance: z.enum(["measured", "imported_legacy_ledger"]),
});

export const CalibrationPredictionEvaluationSchema = z.object({
  schema_version: z.string(),
  record_id: z.string(),
  kind: z.literal("prediction_evaluation"),
  intent_id: z.string(),
  estimate_revision_id: z.string(),
  evaluated_at: z.string().datetime(),
  predicted: EstimateRevisionSchema.shape.predicted,
  actual_record_id: z.string().describe("対応する observation record の record_id"),
  error: z.object({
    tokens: z.object({ relative_error_p50: z.number(), covered_by_p80: z.boolean() }).optional(),
    cost_usd: z.object({ relative_error_p50: z.number(), covered_by_p80: z.boolean() }).optional(),
  }),
});

export const CalibrationRecordSchema = z.discriminatedUnion("kind", [
  CalibrationObservationSchema,
  CalibrationPredictionEvaluationSchema,
]);
export type CalibrationRecord = z.infer<typeof CalibrationRecordSchema>;
```

サルベージした legacy ledger は `kind: "observation"`、`provenance: "imported_legacy_ledger"`、`predictor_quality` は predictors を diff から逆算できたかどうかで `reconstructed`/`imputed` を割り当て、`prediction_evaluation` を持たないまま k-NN 母集団（§3.5）に参加する。`record_id` を主キーにすることで `lane calibrate` の再実行が冪等になる。

### 2.8 knowledge.schema

```ts
// packages/schemas/src/knowledge.ts
export const KnowledgeTaxonomy = z.enum([
  "missing_state", "wrong_assumption", "too_implementation_specific",
  "test_missing", "architecture_violation", "compatibility_missed",
  "context_variant_missed", "lifecycle_missed", "scope_ambiguity", "observability_gap",
]); // critic.taxonomy と同一集合を共有

export const KnowledgeRefSchema = z.object({
  record_id: z.string(), score: z.number(), matched_by: z.enum(["path", "path_prefix", "taxonomy_bonus"]),
  scoring_version: z.string(),
});

const KnowledgeScopeSchema = z.union([
  z.object({ scope: z.literal("global") }),
  z.object({ scope: z.literal("scoped"), repo_id: z.string(), profile_id: z.string().optional() }),
]); // ~/.lane 全体で複数 repo の path が衝突しないための scope 明示

const KnowledgeFindingBody = z.object({
  type: z.literal("review_finding"),
  taxonomy: KnowledgeTaxonomy,
  evidence: z.string().min(1),
  resolution: z.enum(["fixed", "wontfix", "deferred"]),
});
const KnowledgeDecisionBody = z.object({
  type: z.literal("review_decision"),
  context: z.string().min(1),
  rationale: z.string().min(1),
});

export const KnowledgeRecordSchema = z.object({
  schema_version: z.string(),
  id: z.string(),
  source_ref: z.string().optional(),
  confidence: Confidence.default("medium"),
  status: z.enum(["active", "superseded"]).default("active"),
  supersedes: z.string().nullable().default(null),
  applicability: z.string().optional(),
  paths: z.array(z.string()).default([]),
  path_prefixes: z.array(z.string()).default([]),
  summary: z.string(),
  detail: z.string().optional(),
  tags: z.array(z.string()).default([]),
  source_intent_id: z.string().optional(),
  created_at: z.string().datetime(),
  provenance: z.enum(["lane", "imported_legacy_memories"]).default("lane"),
})
  .and(KnowledgeScopeSchema)
  .and(z.discriminatedUnion("type", [KnowledgeFindingBody, KnowledgeDecisionBody]))
  .refine(
    (r) => r.scope === "global" || r.paths.length > 0 || r.path_prefixes.length > 0,
    { message: "paths が空の record は scope=global を明示しない限り拒否" },
  );
export type KnowledgeRecord = z.infer<typeof KnowledgeRecordSchema>;
```

**保存形式**: 1-record-1-file（`~/.lane/knowledge/records/<id>.json`）を採用する。Python 参照実装 の memories.jsonl 相当の単一 JSONL は、追記の file lock 実装コストと record_id 重複排除の両方が必要になり複雑化するため、v1 では 1 record = 1 file にしてこれを回避する（listing はディレクトリ走査、query は全ファイル読み込み + フィルタで v1 の規模には十分）。

---

## 3. core の構成

`packages/core/src/` の分割方針。Python 参照実装 の god module（orchestrator.py 3,814行）を機能単位に割る。

```
packages/core/src/
├── phase.ts         # PHASE_TRANSITIONS を使う純粋関数（定義自体は schemas。§2.1）
├── gate.ts          # gate registry（§3.3）
├── ledger.ts        # cost ledger 派生ルール（§3.6）
├── goodhart.ts       # 個人 dimension 機械強制（§3.6）
├── done-overlay.ts  # done overlay（§3.6）
├── profile.ts       # profile 解決（§3.7）
├── risk.ts          # risk 実効値計算（§3.4）
├── ports/            # adapter interface（Tracker/Telemetry/Budget）。実装は持たない（§4）
│   ├── tracker.ts
│   ├── telemetry.ts
│   └── budget.ts
└── application/      # CLI から呼ばれるユースケース層（§3.8）
    ├── estimate-service.ts
    ├── calibrate-service.ts
    ├── next-service.ts
    ├── knowledge-service.ts
    └── consensus-service.ts
```

### 3.3 gate 評価 — GateContext に schema 検証済み artifacts を渡す

rev1 の `GateContext.state.verification` は **lane-state に verification を保持する設計がそもそも存在せず、動かないコードだった**（sol 指摘）。rev2 では GateContext に `artifacts`（intent/critic/verification を schema 検証した結果）を明示的に渡す設計に変更する。

```ts
// packages/core/src/gate.ts
export interface GateContext {
  phase: Phase;
  targetPhase: Phase;
  event: "phase_advance" | "before_pr_publish"; // spec_consensus はこの event で明示評価する
  state: LaneState;
  artifacts: {
    intent: Intent;
    critic?: Critic;
    verification?: Verification;
    specDigest?: { spec: string; verification: string }; // sha256、都度計算して渡す
  };
  profile: Profile;
}

export interface Gate {
  id: string;
  appliesTo(ctx: GateContext): boolean;
  evaluate(ctx: GateContext): { pass: true } | { pass: false; reason: string };
}

export const specConsensusGate: Gate = {
  id: "spec_consensus",
  appliesTo: (ctx) => ctx.event === "before_pr_publish" || ctx.targetPhase === "5_done",
  // 4_verify→5_done でも digest を再確認する（PR 作成後に spec.md が変わるケースの検出）
  evaluate: (ctx) => {
    const consensus = ctx.artifacts.verification?.spec_consensus;
    if (!consensus) return { pass: false, reason: "spec_consensus 未記入" };
    if (ctx.artifacts.specDigest &&
        (consensus.spec_digest !== ctx.artifacts.specDigest.spec ||
         consensus.verification_digest !== ctx.artifacts.specDigest.verification)) {
      return { pass: false, reason: "spec/verification の内容が ack 後に変更されている（digest 不一致）" };
    }
    const pending = consensus.deviations.filter((d) => d.status === "pending");
    if (pending.length > 0) return { pass: false, reason: `未解決 deviation: ${pending.length}件` };
    const effectiveRisk = ctx.state.effective_risk_log.at(-1)?.effective_risk ?? ctx.artifacts.intent.intent.declared_risk;
    if (effectiveRisk === "high" &&
        consensus.reviewer_ack?.reviewer_kind === "self" &&
        !consensus.reviewer_ack.override_reason) {
      return { pass: false, reason: "risk(effective)=high は self ack に override_reason が必須" };
    }
    if (!consensus.reviewer_ack) return { pass: false, reason: "reviewer_ack 未記入" };
    return { pass: true };
  },
};
```

### 3.4 risk 実効値 — 宣言値は不変、gate 毎に再計算して記録

sol 裁定: `declared_risk`（intent、immutable）と `effective_risk`（gate 評価毎に再計算、単調増加のみ許可）を分離する。

```ts
// packages/core/src/risk.ts
export interface RiskUpgradeRule { id: string; when: { layers?: string[]; paths?: string[] }; upgrade_to: RiskLevel; reason: string }

export function evaluateEffectiveRisk(
  declared: RiskLevel,
  previousEffective: RiskLevel | null,
  intent: Intent,
  rules: RiskUpgradeRule[],
): { effective: RiskLevel; appliedRuleIds: string[] } {
  const currentCandidates = rules.filter((r) => ruleMatches(r, intent)).map((r) => r.upgrade_to);
  const currentEffective = maxRisk([declared, ...currentCandidates]);
  const effective = maxRisk([declared, previousEffective ?? "low", currentEffective]); // 暗黙 downgrade 禁止
  return { effective, appliedRuleIds: rules.filter((r) => ruleMatches(r, intent)).map((r) => r.id) };
}
```

`profile.risk_auto_upgrade` は固定3値配列（high/medium/low）から **rule 配列**に変更する: `{ id, when: { layers, paths, ... }, upgrade_to, reason }[]`。gate 評価毎に `EffectiveRiskEvaluationSchema`（§2.5）としてログに追記する（監査可能性）。

### 3.5 見積もり推定器 — Gower 距離相当の混合型距離

sol 裁定: 「正規化 Euclidean + risk one-hot」は不採用。数値次元は分布の歪みに弱く、risk は本来順序尺度であり one-hot では順序情報が失われる。

```ts
// packages/core/src/estimator.ts
const NUMERIC_DIMS = ["files_touched_estimate", "layers_crossed", "spec_rule_count"] as const;
const RISK_ORDER: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2 };

export function neighborDistance(a: Predictors, b: Predictors, caps: Record<string, number>): number {
  const dims: number[] = [];
  for (const key of NUMERIC_DIMS) {
    if (a[key] == null || b[key] == null) continue; // 欠測次元は分母から除外
    const cap = caps[key];
    dims.push(Math.abs(Math.log1p(a[key]!) - Math.log1p(b[key]!)) / Math.log1p(cap));
  }
  dims.push(Math.abs(RISK_ORDER[a.risk_class] - RISK_ORDER[b.risk_class]) / 2); // 順序尺度
  if (a.novel_surface !== "unknown" && b.novel_surface !== "unknown") {
    dims.push(a.novel_surface === b.novel_surface ? 0 : 1); // 一致/不一致
  }
  if (dims.length === 0) return Infinity;
  return dims.reduce((s, d) => s + d, 0) / dims.length; // Gower 風の平均化、欠測次元除外
}

export function estimate(predictors: Predictors, population: CalibrationObservation[], profile: Profile) {
  if (population.length < 8) return referenceTableEstimate(predictors, profile);
  const ranked = population
    .map((p) => ({ p, distance: neighborDistance(predictors, p.predictors, profile.distance_caps) }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 7); // 母集団 >=8 は最大7近傍
  const usable = ranked.filter((r) => r.p.eligible_for_knn);
  if (usable.length < 5) return referenceTableEstimate(predictors, profile); // 利用可能近傍<5はfallback
  const { leaveOneOutP50Error, leaveOneOutP80Coverage } = leaveOneOutValidate(usable);
  return buildQuantileEstimate(usable, { experimental: population.length < 30, leaveOneOutP50Error, leaveOneOutP80Coverage });
}
```

v1 は固定 weight（近傍間で重み付けしない）+ 非加重分位点。leave-one-out の p50 誤差・p80 coverage を常に revision に保存し、`population_condition.experimental` は母集団 <30 で常に `true` にする（sol: 「精度を主張しない」ことを構造的に強制）。

**M2 実装レビュー修正（2026-07-31）**: `usable.length < 5` フォールバック境界は `MIN_USABLE_FOR_KNN` という名前付き定数として estimator.ts 内で共有し、`leaveOneOutValidate` の各 fold もこの同じ定数で判定する（1件抜いた残りがこの定数を下回る fold はスコアしない — 本番では選ばれ得ない構成の精度を主張しないため）。境界ちょうど（usable=5）では leave-one-out の全 fold が該当し、`leaveOneOutP50Error`/`leaveOneOutP80Coverage` は `0` ではなく `undefined`（省略）になる。`referenceTableEstimate` の `population_size` も固定 `0` をやめ、フォールバック発生時点の実際の母集団サイズを引数で受け取って記録する。

### 3.6 ledger / Goodhart / done overlay

Python 参照実装 の純粋関数群（`compute_ledger_entry_id` / `derive_confidence` / `classify_data_state` / `derive_included_in_kpi` 等、orchestrator.py 508–696行）と Goodhart 機械強制（2724–2787行）、done overlay（87–255行）はロジックを変更せず TS 純粋関数として移植する（3往復レビューで確定済みの仕様のため）。rev1 からの変更点は1点のみ:

- **差し戻し時の per-phase window union を最初から実装する**。Python 参照実装 では v0.7.1（per-phase 計測導入）→ v0.7.2（差し戻し union 修正）という**既知の回帰**があった。TS 版では最初から `session_ids: string[]` を複数保持し、同一 phase の再突入を disjoint window の union として集計する（v0.7.1 相当の未修正状態を経由しない）。

```ts
// packages/core/src/ledger.ts（差分のみ）
export function unionPhaseWindows(occurrences: { startedAt: Date; endedAt: Date | null }[]): { start: Date; end: Date }[] {
  // disjoint な時間区間なので単純に区間リストを返す（二重計上なし、Codex turns はユニークカウント側で吸収）
}
```

### 3.7 profile 解決

Python 参照実装 と同じ解決順（flag > env > repo_local > package_default）を維持するが、repo_local のパスを `.lane/profiles/` から **`profiles-local/`**（または任意の非データ配下パス）に変更する。理由は §7.2（データディレクトリと committable profile の分離）。

```ts
// packages/core/src/profile.ts
export function resolveProfilePath(opts: { explicit?: string; profileId?: string; cwd?: string }):
  { path: string; source: "flag" | "env" | "repo_local" | "package_default" } {
  // 解決順: flag > env(LANE_PROFILE_PATH) > repo_local(profiles-local/) > package default
}
```

`risk_auto_upgrade` は §3.4 のとおり rule 配列形式に変更する。`generic.profile.yaml` の他フィールド（`existing_ssot` / `extra_lenses` / `layer_ownership` / `required_commands` / `forbidden_paths_for_low_risk` / `isomorphism_rules` / `test_coverage_floor`）は Python 参照実装 からそのまま継承する。

### 3.8 application service 層

sol 裁定: `estimate`/`calibrate`/`next`/`knowledge`/`consensus` のロジックは CLI コマンドの中に直接書くのではなく、`core/application/*.ts` にユースケースとして置く。`packages/cli` はこれらを呼ぶ薄いラッパー（引数パース + 標準出力整形のみ）にする。理由: CLI 層に置くとテストが CLI 実行に縛られ、将来 CI/他ツールから呼びたくなった時に再利用できない。

### 3.9 gate 基盤刷新 + premise_evidence / success_criteria ゲート移植（2026-08-06）

§3.3 の `GateContext`/`GateResult` の当初スケッチ（rev2 執筆時点の設計案）は、その後の実装で以下の形に置き換わっている（history として §3.3 の元コードは残し、ここに現行実装を追記する）:

- `GateResult`（`{pass:true} | {pass:false, reason}`、1 gate 1 verdict）を `Diagnostic { gateId, code, severity: "warning"|"error", message }[]` に変更。1 つの gate が複数の同時issueを蓄積できる（後述の success_criteria が典型）。`pass` は「error が0件」で判定し、warning は遷移を止めない。
- `GateContext.{phase, targetPhase, event}` を discriminated union `GateTrigger = {type:"phase_advance", from, to} | {type:"before_pr_publish", phase}` に変更。
- `evaluateGates` は最初の fail で短絡せず、適用された全 gate の診断を集約する。
- `runAdvance`（CLI）は**全遷移**で「妥当性確認 → artifact 読込 → gate 評価 → state 更新」を行い、error があれば state を一切変更しない。`runValidate` は「4_verify 未満で早期 return」を撤廃し、現在フェーズからの forward 遷移辺 + 常設の `before_pr_publish` チェックポイントの両方を随時診断する（gate は unrecorded を warning とすることで、CLI 側が発動判定を代行しない設計を保つ）。

実装は `packages/core/src/gate.ts`（`DEFAULT_GATES`）を正とする。以下の2ゲートは、実運用パイロット（10件計測・較正済み）の判定基準をそのまま移植したもので、**閾値・fail/warning の区分は一切変更していない**:

- **premise_evidence ゲート**（適用: `1_intent`→`2_spec`）: 変更が (a) AI起点のチケットか症状未観測、かつ (b) 新しいガード・拒否・分岐・完了条件を導入する、のいずれかに該当するなら、実機（live）・記録/クエリ（data）・静的読解（code-only、最弱・warning 付き）のいずれかで前提の実在を確認し `intent.yaml` の `premise_evidence` に記録する。未記載は CLI が発動対象かどうか判定できないため warning（fail-closed の担保は skill 運用側）。`required:true` で `reproduced:false` は error（fail-closed: 発動対象と自己申告したのに確認が取れていない）。
- **success_criteria ゲート**（適用: `3_implement`→`4_verify` と常設の before_pr_publish チェックポイントでの二重確認）: `intent.intent.success` の各行を `verification.yaml` の `success_criteria_matrix` と双方向で突合する。①方向（success にあるが criterion が無い）は error、②方向（criterion にあるが success に無い＝spec が intent より強い条件を採用）は warning。`covered_by: none` は error（schema 自体は受理する。schema と gate の責務分離）。`negation_test` 空欄は warning（恒真式の疑い）。突合は `normalizeCriterion`（markdown link・強調記号・全角含む空白のみ吸収、要約は不一致）による正規化後の**完全一致**で、類似度は導入しない。

両ゲートの検査能力には共通の限界がある: 「記録されているか」「形が妥当か」だけを機械検査でき、記録内容が真実かどうかは判定できない。発動判定自体（この変更がゲートの対象か）も人間/skill 運用側の判断であり、CLI は代行しない。

**設計上の意図の明文化（sol 裁定確認、2026-08-06）**: 「error があれば state を一切変更しない」という単純化の結果、**gate-blocked な advance の失敗痕跡は lane-state 側に一切残らない**（effective_risk_log への audit entry 追記も含めて、何も書き込まれない）。これは意図的な設計判断であり、副作用ではない。失敗の記録自体は CLI の標準エラー出力（`Gate failed: ...`）だけが担う。将来、失敗した advance 試行そのものの監査ログが必要になった場合は、**lane-state.json への書き込みを復活させるのではなく**、append-only の側路ログ（例: `docs/spec/<intent-id>/advance-attempts.jsonl` のような別ファイル、または既存の usage_import_attempts と同種の別配列）として設計すること。lane-state 自体は「現在の正しい状態」を表すものであり、「試みて失敗した記録」を混在させない、という区別を保つ。

---

## 4. adapter ports 3つと実装

**rev1 からの変更**: port（interface）は `core/ports/*.ts` に置き、`packages/adapters` は実装のみを持つ（sol 課題3裁定）。存在しない `@lane/telemetry-agent-cost` という他パッケージへの import は削除し、agent-cost の Fact 型は **lane 側の contract として `packages/schemas/src/fact.ts` に再定義**する（Python 側とはプロセス境界を越えた JSON 契約でのみ結合し、コードとして import しない）。

```ts
// packages/schemas/src/fact.ts（agent-cost の facts.py Fact 型を lane 側 contract として再定義）
export const FactSchema = z.object({
  occurred_at_utc: z.string().datetime(),
  agent: z.enum(["claude", "codex"]),
  session_id: z.string().nullable(),
  model_key: z.string(),
  token_kind: z.enum(["input_nocache", "cache_read", "cache_write_5m", "cache_write_1h", "cache_write_unknown", "output"]),
  tokens: z.number().int().nonnegative(),
  mode: z.enum(["fast", "normal", "unknown"]).default("unknown"),
  source_quality: z.enum(["ok", "first_event_delta"]).default("ok"),
});
```

### 4.1 Telemetry port — agent-cost は CLI subprocess で統合（TS 再実装しない）

sol 裁定: agent-cost（Python）を TS に再実装すると二重保守になる。lane は agent-cost を **子プロセスとして呼ぶ**。

**M2 実装時の更新（2026-07-31、agent-cost `measure/v1` 契約が実装・公開済みになったため rev2 の速記を実際の契約に合わせて置き換え）**: 上記 rev2 の `--window` + 生 `facts[]` という速記は agent-cost の実装前の想像であり、実際の契約とは異なる。agent-cost の `measure` は **session_id 起点**（`--session-id` を1個以上必須）で、事前集計済みの per-session / union totals を返す（生 facts は含まれない）。したがって「どの session_id がどの phase occurrence に属するか」を lane 側があらかじめ把握している必要があり、これは時間窓スキャンではなく `LedgerEntry.session_ids[]`（§2.5/§3.6）への直接記録（`lane usage-import` 相当のコマンドが呼び出し側から受け取る）に委ねる。§3.6 の `unionPhaseWindows`/`phaseWindowsForPhase` は cost 計測の入力ではなく、cycle time 記帳・監査のための時間窓管理として残る。

```ts
// packages/schemas/src/agent-cost.ts（抜粋。実際の measure/v1 出力を Zod で表現）
export const AgentCostMeasureResultSchema = z.object({
  protocol_version: z.string(),
  generated_at: z.string(),
  window: z.object({ since: z.string().nullable(), until: z.string().nullable() }),
  timezone: z.string(),
  agent: z.array(z.enum(["claude", "codex"])),
  rates: z.object({ catalog_version: z.string(), sha256: z.string() }),
  session_ids: z.array(z.string()),
  sessions: z.record(z.string(), z.object({
    matched: z.boolean(),
    rows: z.array(z.record(z.string(), z.unknown())),
    totals: z.object({
      tokens: z.number().nonnegative(), priced_tokens: z.number().nonnegative(),
      unpriced_tokens: z.number().nonnegative(), estimated_cost_usd: z.number().nonnegative(),
      credits: z.number().nonnegative(),
    }),
  })),
  total: z.object({ rows: z.array(z.record(z.string(), z.unknown())), totals: /* 同上 */ z.unknown() }),
  data_quality: z.object({
    malformed_events: z.number().int().nonnegative(), skipped_files: z.number().int().nonnegative(),
    negative_deltas: z.number().int().nonnegative(), unpriced_tokens: z.number().nonnegative(),
    source_quality: z.record(z.string(), z.number()),
  }),
});
```

```ts
// packages/core/ports/telemetry.ts
export interface TelemetryMeasureOptions { since?: Date; until?: Date; agents?: readonly ("claude" | "codex")[] }
export interface TelemetryAdapter {
  /** agent-cost 自身が要求する通り、session_ids は1件以上必須。 */
  measure(sessionIds: readonly string[], opts?: TelemetryMeasureOptions): Promise<AgentCostMeasureResult>;
}
```

```ts
// packages/adapters/src/telemetry/agent-cost.ts（抜粋）
export class AgentCostTelemetryAdapter implements TelemetryAdapter {
  async measure(sessionIds, opts = {}) {
    if (sessionIds.length === 0) throw new TelemetryImportFailed("measure requires at least one session id");
    const args = ["measure", "--format", "json", ...sessionIds.flatMap((id) => ["--session-id", id])];
    if (opts.since) args.push("--since", toPythonIsoformat(opts.since)); // "Z" ではなく "+00:00"（後述）
    if (opts.until) args.push("--until", toPythonIsoformat(opts.until));
    const { stdout, stderr } = await execFileAsync(this.bin, args, { timeout: this.timeoutMs });
    if (stderr) throw new TelemetryImportFailed(stderr);
    const validated = AgentCostMeasureResultSchema.safeParse(JSON.parse(stdout));
    if (!validated.success || validated.data.protocol_version !== "measure/v1") {
      throw new TelemetryImportFailed(/* ... */);
    }
    return validated.data;
  }
}
```

**実装時の注記（M2）**:
- agent-cost の `--since`/`--until` は Python の `datetime.fromisoformat`（agent-cost が対象とする Python バージョンでは `"Z"` サフィックスを受け付けない）でパースされるため、`Date.toISOString()` の結果の `"Z"` を `"+00:00"` に置換して渡す（`toPythonIsoformat`）。
- agent-cost は実ログファイルを毎回スキャンするため、呼び出しは開発機のログ蓄積量次第で数十秒かかることがある（実測: 4秒〜25秒の範囲でばらつき、`--since`/`--until` による範囲指定が確実に短縮するとは限らなかった。読み取りコスト自体が支配的な可能性がある）。テスト側は範囲指定の有無にかかわらず十分なタイムアウト（60〜90秒）を確保している。lane の実運用では常に phase 相当の範囲を指定するが、速度改善を保証するものではない点に注意。
- agent-cost は現時点で PyPI 未公開（`~/oss-space/agent-cost` の editable install のみ）。CI で `agent-cost` を PATH に置く手段が未確立（M2 の既知ギャップ、後続タスクで対応）。

### 4.2 Budget port — ResourceSnapshot、信頼度を明示

sol 裁定: Claude の rate limit（% used）と Codex の credits（絶対量）は単位が違う。安易に「tokens p80 が枠内に収まる」と判定すると誤った安心感を与える。

```ts
// packages/core/ports/budget.ts
export interface ResourceSnapshot {
  provider: "claude" | "codex";
  metric: "rate_limit_5h" | "rate_limit_7d" | "credit_balance";
  value: number;
  unit: "percent_used" | "credits" | "usd";
  observedAt: Date;
  expiresAt: Date | null; // TTL、written_at 基準
  quality: "measured" | "computed_low_confidence" | "stale";
  source: string;
}

export interface BudgetAdapter {
  snapshot(): Promise<ResourceSnapshot[]>;
}
```

- `ClaudeBudgetAdapter`: `~/.claude/rate-limits.json` を読む。§5.2 の statusline.sh 拡張が入力源。`quality: "measured"`。
- `CodexBudgetAdapter`: `$LANE_CONFIG_DIR/budgets/codex.yaml`（手入力上限）− agent-cost 実測の減算。`quality: "computed_low_confidence"` を常に付与する。

```yaml
# $LANE_CONFIG_DIR/budgets/codex.yaml
weekly_limit_credits: 15000
period_start: "2026-07-27"
period_end: "2026-08-03"
reset_rule: "weekly"
timezone: "Asia/Tokyo"
```

`usedPct`（消費率）と「残り%」を同じ名前で扱わない（sol: 命名混同の指摘）。`next-service`（§3.8）は、Claude の `percent_used` と estimate の `tokens.p80` の間に **検証済みの変換関数が無い限り、"収まる/収まらない" の判定を出さない**。両方を並列表示するだけに留める。

### 4.3 Tracker port

```ts
// packages/core/ports/tracker.ts
export interface TrackerAdapter {
  markStarted(ref: string): Promise<void>;
  markDone(ref: string, opts?: { comment?: string }): Promise<void>;
  annotatePr(prRef: string, section: { title: string; body: string }): Promise<void>;
}
// 実装: GithubTrackerAdapter（gh CLI 経由）。v1 では annotatePr の PR body 自動編集は後回し（§8）。
// GithubTrackerAdapter の markStarted/markDone は GitHub Issues に組み込みの進行状態が無いため
// (Linear のような state machine が無い)、issue へのコメント投稿として実装する。
// annotatePr も「PR body の in-place 編集」ではなく PR への別コメント投稿として実装する
// （§5.3/§8 が明示的に後回しにしたのは in-place 編集の方であり、コメントでの通知は代替として妥当）。
```

### 4.4 Vcs port（M2 追加、team 確認待ち）

design.md rev2 の §4 は Tracker/Telemetry/Budget の3 port のみを定義していたが、TrackerAdapter は issue の状態管理（started/done/PR annotate）のみを担い、実際の git 操作（branch 作成・commit・push）と PR 作成そのものを担う port が存在しなかった（§6 の per-phase skill 説明が前提としている「commit/push → PR 作成」ステップに対応する port が欠けていた）。M2 着手時に発見し、Tracker（issue tracker の状態）と Vcs（git/PR の実操作）は別の関心事であり将来的に異なるバックエンド（例: GitHub Issues + GitLab MR）を持ちうるため、独立した port として追加した。

```ts
// packages/core/ports/vcs.ts
export interface CreatePrOptions {
  branch: string;
  base?: string; // 省略時はリポジトリの default branch
  title: string;
  body: string;
  draft?: boolean;
}
export interface CreatedPr { url: string; number: number }

export interface VcsAdapter {
  currentBranch(cwd: string): Promise<string>;
  createBranch(name: string, cwd: string): Promise<void>;
  commitAll(message: string, cwd: string): Promise<void>; // 何もステージされていなければ throw
  push(branch: string, cwd: string): Promise<void>;
  createPr(opts: CreatePrOptions, cwd: string): Promise<CreatedPr>;
}
// 実装: GithubVcsAdapter（git CLI + gh CLI 経由）。テストは実 git を使い（安全な一時repo）、
// gh 呼び出しのみ recording テストダブルに置き換える（実 PR を作成しないため）。
```

### 4.5 MetricsPublisher port（MP-3、2026-08-07）— `agent-metrics:v1` emitter の書き込み側

`lane emit-metrics`（§5.5）が PR コメントへ upsert する書き込み側のみを担う新設 port。正本の外部契約は `ai-agent-skills-playbook` の `docs/protocols/agent-metrics-v1.md` + `contracts/agent-metrics/v1/`（vendor 元コミットと fixture tree hash は `contracts/agent-metrics/UPSTREAM` に記録）で、spec-lane 固有語彙を一切持ち込まない。

`VcsAdapter`（§4.4）を拡張しない・`TrackerAdapter.annotatePr`（既存、常に新規コメントを作成し upsert-by-identity を持たない）を再利用しない、の2点は spec.md（`docs/spec/I-2026-08-07-agent-metrics-emitter/spec.md`）の DEP×PATH 対照表で明示的に検討・却下済み: 既存3呼び出し元を持つ `annotatePr` に upsert semantics を後付けするより、独立した port の方が影響範囲が小さい。

```ts
// packages/core/ports/metrics-publisher.ts
export interface MetricsPublishTarget {
  repository: { provider: string; id: string };
  prNumber: number;
}
export interface MetricsPublishResult { action: "created" | "updated"; url: string }
export interface MetricsPublisher {
  upsert(marker: string, target: MetricsPublishTarget): Promise<MetricsPublishResult>;
}
// 実装: GithubCommentMetricsPublisher（`gh api` 直接、`gh pr comment --edit-last` は
// 「自分の直前のコメント」しか対象にできず upsert-by-identity に使えないため不採用）。
// 既存コメント一覧を取得 → 各 body を decodeAndVerifyAgentMetricsMarker（upsert_key を
// 常に再計算、declared 値は信用しない）で復号・検証 → upsert_key 一致で PATCH、
// 不一致なら POST。
```

`packages/schemas/src/agent-cost.ts` の `AgentCostRowSchema` もこの機能で opaque な
`z.record` から実体化した（agent_cost/aggregate.py の `Row.to_dict()` と同一shape。
既存の `AgentCostTelemetryAdapter`/`CodexBudgetAdapter` はこの opaque フィールドを一切
参照していないことを実装前に grep で確認済み — 破壊的変更にならない）。

個人次元 scanner は既存の `core/goodhart.ts`（7-key、spec-lane 内部の ledger/export 機能専用）
とは別に、契約準拠の11-key set を持つ `core/agent-metrics-goodhart.ts` を新設した
（team-lead review 裁定: 統合はせず、両ファイルに相互参照コメントを付けて将来の乖離を防ぐ）。

---

## 5. 4機能の詳細設計

### 5.1 機能1: 見積もり較正ループ

```
lane estimate I-2026-08-01-example-feature-9999
```
```
見積もり revision r3（I-2026-08-01-example-feature-9999, as_of_phase=1_intent）
  母集団: 12件（salvaged: 8 [reconstructed], measured: 4 [observed]） experimental: true(<30)
  近傍(7中5件利用可): I-2026-06-01-example-feature-1234(dist=0.12,observed) / I-2026-05-20-example-feature-1100(dist=0.19,reconstructed) / ...
  leave-one-out: p50 error ±38% / p80 coverage 71%
  tokens        p50=182,000  p80=310,000
  cost_usd      p50=$4.20    p80=$7.80
  method: knn_quantile (k=5 usable)
  → intent.baseline_estimate_revision_id = r3 として採用しますか？ [y/N]
```

- revision は追記のみ。`lane estimate` を再実行すると新しい revision（r4, r5, ...）が追加される。baseline に採用するかは明示コマンド（`lane estimate --adopt r3`）で決める。
- `lane calibrate` は baseline revision を参照するだけで書き換えない。telemetry adapter の実測から `CalibrationObservationSchema` を1件作り、baseline が存在すれば対応する `CalibrationPredictionEvaluationSchema` も1件作る（§2.7）。

**M2 実装ノート（2026-07-31）**:
- `population_condition.leave_one_out_p50_error` / `leave_one_out_p80_coverage`（§2.6）は `method=knn_quantile` の revision で**常に**計算・記録する（M1 では未実装だった）。usable neighbor を1件ずつ抜いて残りで再フィットし、抜いた neighbor 自身の実測 tokens と比較する leave-one-out 方式。`tokens` を対象指標として採用（schema が revision あたり1組の LOO 数値しか持たないため、`cost_usd` 側の LOO は算出しない）。
- `--impact-scan-file` は impact-scan レポート（Markdown）中の ` ```impact-scan:v1 ` フェンスコードブロック（JSON、`scan_version`/`repo_commit`/`candidate_paths`/`candidate_layers`/`open_items?`）を1個だけ探してパースする。**この「フェンスブロック規約」は lane 側の暫定仕様として M2 実装時に起草されたが、2026-07-31 の team 判定で正式採用となり、正本は `ai-agent-skills-playbook` の `skills/pre-implementation-impact-scan/SKILL.md`「Structured output block (impact-scan:v1)」節に置くことに変更された（同節で JSON スキーマ・「生の観測値のみ・集約スコアを作らない」原則・digest 非同梱の理由を規定）。ここ（design.md）の記述は実装参照用の要約であり、規約本体を変更する場合は必ず playbook 側を先に更新すること**。`digest` フィールドはブロック自体に含まれない（前述の正本節の通り）。`packages/core/src/impact-scan.ts` の `parseImpactScanBlock()` はこの点を踏まえ、常に `candidate_paths`+`candidate_layers` から digest を消費側で再計算し、ブロック内の値を信用しない（自己言及的な陳腐化を避けるため）。
- reference_table フォールバック（母集団<8 または利用可能 neighbor<5 のとき）の初期値は `--reference-tokens-p50/p80` / `--reference-cost-p50/p80` で明示指定できる。未指定時は汎用プレースホルダ値（tokens p50=50,000/p80=150,000、cost_usd p50=$1/p80=$4）を使う。`population_condition.experimental=true` が必ず立つため過信は防げるが、実データに基づく値ではない点に注意。

**M2 実装レビュー修正（2026-07-31）**:
- **`lane estimate --adopt` の二重仕様**: `--adopt`（値なし）は「このコマンドが新規作成した revision を採用する」既存挙動のまま。`--adopt <revision-id>`（値あり）は新しい動作で、**新規 revision を作らず**既存の revision id へ intent.baseline_estimate_revision_id を再ポイントするだけの操作になる。どちらの経路でも `IntentSchema` に新設した `baseline_adopted_at`（ISO8601）に採用時刻を記録する（`adoptBaselineRevision(intent, revisionId, estimate, adoptedAt)` が唯一の書き込み経路）。
- **`lane calibrate` の predictors 引き継ぎ**: 当初の実装は observation の predictors を毎回 `buildPredictorsFromIntent(intent, undefined, verification)` で作り直しており、baseline revision が実際の impact-scan snapshot から `files_touched_estimate`/`layers_crossed` を持っていても、それらが常に `null` に戻ってしまい k-NN 母集団の質を落としていた。修正後は intent に採用済み baseline があればその `predictors` をそのまま observation に引き継ぎ（`predictor_quality: "observed"`）、baseline が無い場合のみ従来通り作り直す（この場合は `predictor_quality: "imputed"` を明示し、質の違いを黙って混同しない）。
- **k-NN leave-one-out の境界修正**: `estimate()` は usable neighbor が `MIN_USABLE_FOR_KNN`（=5）未満なら reference_table にフォールバックする。leave-one-out はこの本番選択ロジックと必ず整合させ、1件抜いた残りが `MIN_USABLE_FOR_KNN` を下回るfold はスコアしない（本番では絶対に選ばれ得ない構成の精度を主張しないため）。usable がちょうど5件の境界では全foldが該当し、`leave_one_out_p50_error`/`leave_one_out_p80_coverage` は両方とも省略（`undefined`、誤解を招く `0` にはしない）。
- **`reference_table` の `population_size`**: 固定値 `0` をやめ、フォールバック発生時点の実際の母集団サイズ（`population.length`）を記録する（`<8` 境界の監査のため）。

### 5.2 機能2: lane next 資源逆算

`statusline.sh` に数行追加し、`rate_limits` を毎回 `~/.claude/rate-limits.json` へ side-write する（rev1 と同じ、変更なし）。

```
lane next
```
```
Claude  5h=42%使用(@18:20) / 7d=68%使用(@8/2 09:00)  [measured]
Codex   ≈6,200cr残（低信頼: 手入力上限−推定消費、請求残高ではない）  [computed_low_confidence, period_end=8/3]

候補（同一単位で比較できるものだけ fits/not_fit、それ以外は advisory）:
  [A] I-2026-08-01-example-feature-9999  cost_usd p80=$7.80 → Claude予算(budget[].provider=claude,usd)内: fits
  [B] I-2026-07-30-example-feature-8888  cost_usd p80=$21.00, provider=codex(credits換算前) → advisory（単位不整合、fit判定なし）
  [C] I-2026-07-25-example-feature-7777  estimate 無し（母集団<8, reference_table）→ unknown
```

すべての ResourceSnapshot に `quality: "stale"` または provider 側で unpriced/lower-bound/unknown-model が1つでもあれば、推薦文（fits/not_fit の結論表示）を止めて生データの並列表示のみにする。スコアリング・自動優先度付けはしない（変更なし）。

**M3 実装ノート（2026-07-31、着手時点）**:
- `statusline.sh`（`~/.claude/statusline.sh`、個人 dotfile）に side-write 数行を追加した。既存の表示ロジック・`.high-usage` フラグ判定は一切変更していない（変更前に `~/.claude/statusline.sh.bak-2026-07-31-pre-m3` へバックアップ済み、diff は末尾に追加のみ）。書き込み先 `~/.claude/rate-limits.json` の shape: `{ five_hour: {used_percentage, resets_at}, seven_day: {同}, written_at }`。`rate_limits` が入力に無いターン（`.high-usage` 判定のガード同様）はファイルを書き換えない（既存の有効な値を誤って null で上書きしない）。
- `ResourceSnapshot.quality` を3値から5値に拡張した: `"measured" | "computed_low_confidence" | "stale" | "unpriced" | "lower_bound"`。unpriced/lower_bound は agent-cost 自身の pricing_status ランキング（`agent_cost/aggregate.py`: unpriced < lower_bound < priced）をそのまま反映したもので、「TTL 経過による stale」とは別の理由の劣化を区別して残す（`hasDegradedSnapshot` はこの3値すべてを抑制条件として扱う。`computed_low_confidence` 単体は抑制しない — Codex 予算の常時ベースラインだから）。
- `ClaudeBudgetAdapter`: `~/.claude/rate-limits.json` を読み、`written_at` から既定15分の TTL で `measured`/`stale` を判定する。ファイル不在・不正 JSON は `[]`（スナップショット無し）を返し、値を捏造しない。
- `CodexBudgetAdapter`: `$LANE_CONFIG_DIR/budgets/codex.yaml`（手入力の週次上限）を読み、`agent-cost report --agent codex --group-by agent --since <period_start> --until <period_end>` で実測 credits を減算する。`report` サブコマンドは `measure`（session-id 必須）と違い集計クエリに対応しており、この用途にはこちらが正しい。config ファイル不在時は `[]` を返す（上限を捏造しない）。timezone は v1 スコープとして `Asia/Tokyo`/`UTC` のみサポートし、それ以外は `CodexBudgetConfigError` で明示的に失敗する（IANA tz DB 全体の導入は本スコープ外）。
- `lane next` CLI: 全 lane を列挙し（`listIntentIds`、新設）、採用済み baseline がある lane だけ `buildNextRow` にかける。`predictedCostP80.provider` は常に `"any"`（estimator が出す `predicted.cost_usd` はそもそも provider 非依存の単一ドル値であり、provider 別の内訳を持たないため）。budget 側が credits 単位しか無い場合は自動的に unit 不一致で advisory に落ちる（変換を発明しない）。

**M3 実装レビュー修正（2026-07-31）**:
- **未採用 baseline の lane を table から除外**: 当初の実装は全 lane を row 化しており、baseline 未採用の lane も `verdict: "unknown"` として他の fits/not_fit/advisory 行と並んで表示されていた。修正後は採用済み baseline のある lane だけを table に載せ、未採用の lane は「N lane(s) without an adopted baseline — run `lane estimate --adopt` first」という footer 1行にまとめる（可視性は残すが table を汚さない）。
- **抑制メッセージの quality 出し分け**: `buildNextRow` の抑制メッセージは常に「a resource snapshot is stale」と表示していたが、実際の劣化理由（stale/unpriced/lower_bound のいずれか、複数可）を反映するよう修正した。`degradedQualities()`（新設、`hasDegradedSnapshot` はこれの `.length > 0` に委譲）が実際に存在する劣化理由の集合を返し、`buildNextRow` の呼び出し側がそれをそのまま渡す。
- **`codex.yaml` の期間整合検証**: `period_end <= period_start` および `reset_rule=weekly` で期間が正確に7日でない場合を設定エラーとして明示的に reject するようにした。
- **エラー正規化**: 不正な YAML 構文・agent-cost の不正 JSON 応答・`AgentCostReportResultSchema` との不一致（agent-cost バージョン drift）は、以前は生の例外（YAMLParseError/SyntaxError/ZodError）がそのまま伝播していたが、すべて `CodexBudgetConfigError` に正規化した。`lane next` 側の catch はこの型だけを認識して制御された exit 2 を返すため、これで crashy な経路が塞がれる。

**M4 dogfood エスカレーション対応（2026-07-31）**: 完了済み（`status: "completed"`、5_done overlay 経由も含む）・`aborted` の lane が、baseline 採用済みであれば decision table に表示され続けていた（「次に何をやるか」の趣旨に反する）。`lane status` と同じ `loadStateWithOverlay` で実効 status を求め、`completed`/`aborted` の lane は table からも「未採用 baseline」footer 件数からも完全に除外するようにした。

### 5.3 機能3: 仕様コンセンサス gate

- `spec_consensus` gate（§3.3）は `before_pr_publish` イベントと `4_verify→5_done` の両方で評価する。
- `GithubTrackerAdapter.annotatePr` による PR body への「Spec との差異」節自動挿入は **v1 スコープ外に後回し**（§8。digest 付き hard gate を優先する）。

**M3 実装ノート（2026-07-31）**: `lane consensus <intent-id>` を CLI 統合の仕上げとして追加した。対話ウィザードではなく、`--refresh`（digest 再計算。既存 verification.yaml/spec.md から `computeDigest`/`canonicalVerificationContent` で再計算し、内容変更があれば古い `reviewer_ack` を自動失効させる。gate-check.ts が実際に検証時に使う関数と完全に同一のものを使うため、値のズレが起きない）・`--add-deviation`/`--resolve-deviation`（pending → resolved、rationale 必須）・`--ack`（reviewer_ack 記録。未解決 deviation が残っている場合と、effective risk=high での self ack で `--override-reason` が無い場合は CLI 側で先に弾く。gate 側の判定と同じロジック）の組み合わせで verification.yaml を編集する。`--emit-pr-section` は「Spec との差異」節を stdout に出力するだけで、PR body への自動挿入（`annotatePr`）は前述の通り v1 スコープ外のまま。

**M3 実装レビュー修正（2026-07-31）**:
- **`--ack` の digest 再検証**: 当初の実装は `--ack` 時に `consensus.spec_digest`/`consensus.verification_digest`（直前の `--refresh` で保存された値）をそのまま `reviewer_ack` へ書き込んでおり、`--refresh` と `--ack` が別々の呼び出しで、その間に spec.md/verification.yaml が編集された場合に検知できなかった。修正後は `--ack` 実行時にディスクから再度 `computeDigest`/`canonicalVerificationContent` で計算し、保存値と不一致なら「content changed since last --refresh; run --refresh and re-review」で拒否する（gate と全く同じ関数・同じ判定）。
- **前検証の完備**: `--add-deviation`（`--spec-ref`/`--actual`/`--action` 必須、`--action` の enum 検証）・`--resolve-deviation`（`--rationale` 必須）・`--ack`（`--reviewer-kind`/`--reviewer-id` 必須、`--reviewer-kind` の enum 検証）を `runConsensus` 自体（CLI 引数を素通りさせず、テスト可能な core 相当の関数内）で決定的に拒否するようにした。従来は main.ts 側にしか一部の検証が無く未テストだった。

**M4 dogfood での発見（2026-07-31）**: `--emit-pr-section` の出力見出しが本節見出し（「Spec との差異」）を直訳せずそのまま日本語ハードコードしていた（`## Spec との差異` / `差異なし。`）。他の全 CLI 出力は英語（design.md §1「ユーザー向け文言は英語」の既存方針）なのにこの1箇所だけ日本語だったのは、この design.md 自身の日本語の例示をそのまま実装に転記してしまったため。`## Spec Deviations` / `No deviations.` に修正した。

### 5.4 機能4: 知見DB壁打ち

```
lane knowledge query --paths src/components/presentation/state/hooks/features/useStepNavigation.ts
```
```
score=1.00  path一致        [review_decision] useStepNavigation はステップ遷移の再入を in-flight ref で防止
score=0.72  path_prefix一致  [review_finding] pending状態のレース条件テスト不足（taxonomy: test_missing）
```

- 閾値 `score >= 0.70` **かつ** 全体 top3、各 lens 最大2件（両方を満たすものだけ critic の `knowledge_refs` に注入。§2.3）。
- prefix 一致は path segment 境界一致で判定する（`src/foo` が `src/foobar` にマッチしないよう `path.split("/")` で比較する。単純な `startsWith` は使わない）。
- taxonomy 一致は既に path/path_prefix 一致で閾値を超えている record への**加点のみ**（taxonomy 一致単独では注入しない）。
- 閾値の自動調整は v1 では行わない。実運用（query/citation）が20回に達するまで固定値を凍結する。

**M3 実装ノート（2026-07-31）**:
- `lane knowledge-append`/`lane knowledge-query` を CLI として仕上げた（`knowledge-*` のハイフン区切りコマンド名。他コマンドの `migrate-legacy-*` と同じ命名規則に揃えた）。`knowledge-query` の出力は2部構成: (1) design.md 本節の例と同じ人間可読な score 一覧、(2) `critic.yaml` の `per_lens[].knowledge_candidates` にそのまま貼り付けられる JSON 配列（design §2.3 の定義通り「query で提示された候補、引用したかは問わない」ため、閾値・top3・per-lens上限を適用する**前**の生スコア結果をそのまま出す）。
- **top3(全体)/top2(lens毎) の実装上の限界**: `selectKnowledgeRefs`（core）は複数 lens の候補をまとめて渡して初めて「全体で最大3件」を正しく計算できる設計だが、`lane knowledge-query` は1回の呼び出しにつき1つの `--paths` クエリしか受け付けない（design.md 本節のCLI例自体がlens引数を持たない単純な形のため、これに合わせた）。`--lens <id>` を指定すると「この lens 単独なら」という前提で per-lens 上限（最大2件）だけを適用したプレビューを追加出力するが、複数 lens 分の呼び出しを横断した「全体3件以内」の最終確認は critic.yaml を組み立てる人間/skill 側の責務として残る（この制約はコマンドの doc comment にも明記）。
- **実データ検証（項目6）**: サルベージ済み review-memory export（`migrate-legacy-knowledge` で 1829件 import 済み）に対して `lane knowledge-query --paths <実ファイルパス>` を実行し、(a) 単一ファイルへの参照が74件ある実ファイルで exact path match が正しく74件・score=1.00 で返る、(b) `--lens` 指定時に per-lens 上限2件へ正しく絞り込まれる（tie-break は record id 昇順で決定的）ことを確認した。実データの内容自体は組織固有情報を含むためこの文書やコミットには転記しない（検証はローカルの一時ディレクトリのみで実施し、検証後に削除済み）。

**M3 実装レビュー修正（2026-07-31）**:
- **scoped record の repo_id 未フィルタ**: 当初の実装は `scope=scoped` レコードを repo で絞り込んでおらず、異なる repo が同じ相対パス（例: どちらも `src/index.ts` を持つ）を使う場合に他 repo の scoped knowledge が漏れ得た。`isKnowledgeRecordInScope`（core、新設）を追加し、`scope=global` は常に対象、`scope=scoped` は `repo_id` の完全一致のみ対象とする。repo コンテキストは cwd の git remote から導出（`deriveRepoIdFromGitRemote`、新設）し、`--repo-id` で上書き可能。repo 判定不能時は scoped を全除外し警告行を出す（黙って何かを表示するより取りこぼしを選ぶ）。
- **scoring_version のハードコード修正**: `knowledge_candidates` の `scoring_version` フィールドが `"1.0"` の文字列リテラル直書きだったのを `SCORING_VERSION` 定数参照に修正した。

**M4 dogfood での発見（2026-07-31）**: `lane knowledge-query` の人間可読な score 一覧が本節の例示（上記 "score=1.00 path一致 ..." 等）をそのまま実装に転記しており、`matchLabel`（"path一致"/"path_prefix一致"/"taxonomy加点"）とtaxonomy注記の全角括弧が日本語ハードコードになっていた。`--emit-pr-section` と同じ根本原因（design.md の日本語例示の直訳漏れ）のため、"path match"/"path_prefix match"/"taxonomy bonus" と半角括弧に修正した。本節の例示自体（この文書は日本語で書かれているため）は変更していない。

### 5.5 機能5: `lane emit-metrics` — agent-metrics:v1 emitter（MP-3、2026-08-07）

外部・正本の `agent-metrics:v1`/`token-usage/v1` 契約（§4.5、`ai-agent-skills-playbook` の
`docs/protocols/agent-metrics-v1.md`）に対する emitter。この機能自体はこのタスク（Intent
`I-2026-08-07-agent-metrics-emitter`）自身が spec-lane の lane workflow で実装された最初の
実タスクであり、`docs/spec/I-2026-08-07-agent-metrics-emitter/` の spec.md/critic.yaml が
詳細設計（DEP×PATH 対照表含む）の正本。ここでは要点のみ記録する。

- `lane emit-metrics <intent-id> [--post] [--pr N]`: cost_ledger を KPI 対象 entry に絞り、
  `phase` を activity として group化・session_ids を dedupe した上で、activity ごとに
  `TelemetryAdapter.measure()` を1回だけ呼ぶ（既存の read-only port を再利用。書き込み側
  だけが新設 `MetricsPublisher`、§4.5）。
- **fail-closed 2箇所**: 同一 session id が複数 activity に現れたら
  `ambiguous_session_attribution` で全体を中断（部分 emit しない）。agent-cost が未知の
  `token_kind` を返したら `unknown_token_kind` で中断。いずれも stdout に何も出さない。
- **捏造しない**: manual source / session_ids 空 / agent-cost 該当なし のいずれも
  `data.coverage.omissions[]` に理由コード付きで記録し、record を作らない
  （`manual_source_no_breakdown` / `no_session_ids` / `agent_cost_no_matching_rows` — この
  3つの理由コードは元々 private bridge 用に設計したものを一般化して契約側にも採用した
  語彙で、`valid-no-data.json` fixture 自体がこの語彙を使っている）。
- `data.records[].token_kind` は agent-cost の6値ネイティブ粒度のまま
  （`cache_write_5m`/`cache_write_1h`/`cache_write_unknown` を集約しない。契約の rejected
  design、§4.5/契約doc section 9）。
- `upsert_key` は RFC 8785 JCS（`packages/core/src/jcs.ts`、契約の `verify-fixtures.mjs` と
  bit-for-bit 一致することを fixture テストで確認済み）。
- `--post` の upsert 探索は既存コメントを列挙 → 各 body を復号・sha256 再検証 →
  `upsert_key` 再計算して比較、の順（宣言値を信用しない。契約 MUST）。

**契約統合**: `contracts/agent-metrics/v1/` の全fixture（11件）を
`packages/core/test/fixtures/agent-metrics/v1/` に vendor し、`contracts/agent-metrics/
UPSTREAM` に playbook 側 commit（`d99e480`）と fixture tree hash を記録。fixture-parity
テスト（`packages/core/test/agent-metrics-fixtures.test.ts`）は spec-lane 自身の
schema/scanner/upsert_key 実装を使って全fixtureの期待結果（`expected-results.json`）を
再現することを確認する（契約側の検証ロジックを再実装して自己一致を見るのではなく、
spec-lane の実装部品が契約の期待結果と一致するかを見る）。

**defer（今回やらない、MP-4/5 で対応予定）**: reference harvester 自体の新規実装、
report 層（cost per PR 等の集計）。

**レビューラウンド修正（2026-08-07、PR後・must×2+should×1）**: (1) `--post` が全前提
（PR番号解決・投稿成功）を満たす前に marker を stdout に出していたため、投稿失敗経路
でも marker が漏れ、成功時は投稿結果テキストも stdout に混在していた。修正: 失敗経路は
stdout に1バイトも出さず、成功時の "created/updated <url>" は常に stderr へ。(2)
`decodeAndVerifyAgentMetricsMarker` の base64 検証が契約より緩く、Node の
`Buffer.from(.., "base64")` が不正文字を無視して decode するため、末尾に余剰文字を
付けても同一バイト列・同一 sha256 を再現できる不正 marker を valid 扱いし得た。修正:
契約の `verify-fixtures.mjs` と同じ `BASE64_RE` + `length % 4` チェックを decode 前に
追加。(3) `tokenUsageRecordsFromRows` が agent/model/token_kind が null の row を
zero-token row と同様に黙って捨てていたが、measure/v1 は常に group 済み row を返す契約
のため null は契約逸脱であり、`measure_protocol_violation` として emit 全体を
fail-closed で中断する仕様に変更（unknown_token_kind と同じ扱い）。テストは
`packages/core/test/metrics-service.test.ts`（null-field row 収集・不正 base64 拒否）と
`packages/cli/test/emit-metrics.test.ts`（--post の stdout 純度・fail-closed の両経路、
measure_protocol_violation 中断）に追加。

**MP-7 dogfood follow-up（2026-08-07）**: MP-3 で spec-lane 自身の `lane` workflow を
初めて実運転した際に見つかった3つの粗さを修正した
（`docs/spec/I-2026-08-07-lane-dogfood-followups/`）。(1)(2) は `skills/lane/SKILL.md` の
文言修正のみ（`--paths` が repeatable single-value flag であることの明記、`taxonomy` が
closed 10-value enum であることと値一覧の明記）。(3) `lane validate` が
`readIntent`/`readCriticIfExists` の投げる `ZodError` を素通しし、未整形の `Error#message`
（`JSON.stringify(issues, null, 2)` そのもの）が生の JSON issues 配列として main.ts の
top-level `.catch()` からそのまま出力されていたのを修正: `runValidate` が `ZodError` を
catch し、既存の gate診断 `[gateId] message` と揃えた `<file>: <path>: <message>`
形式（1行1件）で `CommandResult`（exitCode 2）を返すようにした。`ZodError` 以外
（YAML構文エラー等）は今まで通り素通しする（Rule 4）。スコープは `validate` のみに限定し、
`advance.ts` の同経路（`readIntent`/`buildGateContext` 経由の `readCriticIfExists`）は
意図的に未対応のまま残した（team-lead 指示によるスコープ判断）。この非対称性は
CHANGELOG.md の 0.3.1 エントリに既知の限界として明記済み。既存の `validate.test.ts` の
`.toThrow()` に依存していた3テストは新しい `CommandResult` ベースの assertion に書き換えた
（経路対照表 DEP-01/TEST-01/TEST-02、詳細は同ディレクトリの spec.md）。

---

## 6. モノレポ構成

```
lane/
├── pnpm-workspace.yaml
├── biome.json              # 初日から導入（sol: テスト戦略節）
├── package.json
├── tsconfig.base.json
├── .dependency-cruiser.cjs  # schemas→なし / core→schemas / adapters→core,schemas / cli→core,adapters,schemas
├── packages/
│   ├── schemas/    # §2、依存なし。generated/*.schema.json を commit
│   ├── core/       # §3。ports/ は interface のみ、application/ がユースケース層
│   ├── adapters/   # §4。ports の実装のみ
│   └── cli/        # commander.js の薄いラッパー
├── profiles/                # committable。generic.profile.yaml
├── skills/
└── docs/
    ├── design.md（本ファイル）
    └── reviews/2026-07-31-m0-sol-review.md
```

- ビルド: `pnpm -r build`（`tsc -b`、project references で依存順ビルド）。
- 型検査: `pnpm -r typecheck`。
- lint/format: Biome を初日から導入（rev1 の「evigate/acyclic-eval に lint script が無いので後回し」を撤回。sol のテスト戦略節の指摘）。
- テスト: `pnpm -r test`（vitest run）。§10 のとおり「移植契約」の differential test を優先する。
- 依存方向チェック: CI で `dependency-cruiser` を必須実行し、§2.1 の依存方向逆流と package cycle を検出する（§9 checkpoint 4 の合否基準）。
- Node は `engines.node >= 22`、`type: "module"` で統一（evigate 慣行）。

**npm 公開パッケージ `spec-lane`（Track G 最終工程、2026-07-31）**: 公開するのは単一パッケージ
`spec-lane` のみで、`@lane/*` 4パッケージの workspace 構成自体は開発用としてそのまま維持する。
`publish/spec-lane/`（このモノレポの外、`pnpm-workspace.yaml` の対象外）に公開用
`package.json`（name=spec-lane, repository=github.com/shiki-yusuke/spec-lane, engines.node>=22）だけを
手書きで置き、`scripts/build-publish.mjs`（`pnpm run build:publish`）が `packages/cli/dist/main.js`
を esbuild で単一ファイルへ bundle して `publish/spec-lane/dist/main.js` を生成する。bundle は
`@lane/schemas`/`core`/`adapters`/自身のソースを inline し、`workspace:*` 依存を実行時に持たない一方、
`commander`/`yaml`/`zod` の3つは external のまま維持し公開 package.json の通常の `dependencies` として
宣言する（esbuild の ESM 出力では、bundle 対象の CJS パッケージ内部の `require("node:...")` を静的
import に変換できず `Dynamic require of "node:events" is not supported` で実行時に落ちる制約が
あるため。CJS 出力に切り替えると今度は `import.meta.url`（`default-profile.ts` が bundle 同梱の
`resources/profiles/generic.profile.yaml` を探すのに使用）が `undefined` になる。両方の制約を
同時に満たす組み合わせが「ESM 出力 + node:builtin と3つの npm 依存だけを external 指定」だった）。
`publish/spec-lane/dist|resources|README.md|LICENSE` は生成物なので commit 対象外
（`.gitignore` 参照）、`package.json` のみ手書きで commit する。

---

## 7. マイグレーション考慮とデータ配置

### 7.1 サルベージデータの取り込み — 一度限りの importer + reject report

sol 裁定（§8 v1スコープ削減）: 汎用 migration CLI にはしない。

```
lane migrate-legacy-ledger --input ~/archive/legacy-salvage/ledgers/*.json --out $LANE_DATA_DIR/calibration/
lane migrate-legacy-knowledge --input ~/archive/legacy-salvage/memories.jsonl --out $LANE_DATA_DIR/knowledge/records/
```

- 実行は各1回のみを想定（何度も使う汎用パイプラインとして設計しない）。
- predictors を diff から逆算できたレコードは `predictor_quality: "reconstructed"` で投入、できないものは `reject-report.json` に「skipped: predictors不明」として一覧化する（黙ってスキップしない）。
- `migrate-legacy-knowledge` は対話的フィルタ（`--filter-generalizable`）を **v1 スコープから落とす**（§8）。全件を `provenance: "imported_legacy_memories"` で投入し、組織固有の内容は `lane knowledge query` の対象を明示的に絞る運用でカバーする。
- **M2 メモ（team review、2026-07-31）**: Python 参照実装 側の verification 相当データ（test_matrix 等）を salvage する importer を作る場合、`test_matrix.status` の legacy 値（`"✅ existing"` / `"✅ added"` / `"⚠️ not verified"` / `"❌ failing"` / `"🔧 TBD"`）→ rev2 の英語 enum（`existing` / `added` / `not_verified` / `failing` / `tbd`、§2.4/§12-7）へのマッピング表を importer に必ず含めること。マッピング漏れはレコードの取り込み失敗になるため、`migrate-legacy-ledger` と同様に reject-report で一覧化する（黙ってスキップしない）。

**M2 実装ノート（2026-07-31、実データ調査に基づく仕様確定）**: 上記コマンド例（`--input .../ledgers/*.json` / `.../memories.jsonl`）は design.md 執筆時点の仮の入力形式であり、salvage archive の実データはこの形と異なることが M2 実装時の調査で判明した。実装は以下の実データ形状に合わせた。

- **`migrate-legacy-ledger`**: 実データに「`ledgers/*.json`」という単独ファイル群は存在しない。実際に cost 情報を持つのは各 lane の `docs/spec/<intent-id>/lane-state.json`（`cost_ledger[]` を含む）であり、`--input` はこのファイルへの直接パスを1個以上指定する形にした（シェル側で glob 展開する前提。design.md の記法もすでにシェル展開前提のため CLI 側の追加パース不要）。同ディレクトリの `intent.yaml`（あれば）から `risk_class`/`layers_crossed` を補完する。同一 archive 内に **2世代の ledger entry 形状が混在**していることも判明した: 現行（`ledger_entry_id`/`data_state`/`included_in_kpi` あり）と、これらのフィールドを持たない古い世代の形状。旧世代の entry は reject-report に理由付きで記録し、想定外の過去バージョンを逆解析することはしない（汎用 migration framework 化を避ける §8 裁定に合わせる）。**M2 実装レビュー修正（2026-07-31）**: 当初の実装は「ファイル全体のうち usable entry が1件もない」場合しか reject-report に記録しておらず、「usable entry が1件でもあれば lane 全体は import 成功として扱われ、その中に混在する旧世代 entry は per-entry では一切記録されない」黙落ちが指摘された。`buildObservationFromLegacyLaneState` は成功時にも `entryRejects: string[]`（除外された cost_ledger entry ごとの理由）を返すようにし、CLI 側はこれを `rejects` に `sourcePath: <file>:cost_ledger[<index>]` 形式で合流させる。lane 単位の import 成否には影響しない。`files_touched_estimate` は常に `null`（§2.6 が明示的に否定した「allowed_paths glob 数を files_touched の代用にする」手法を salvage importer でも使わない）。
- **`migrate-legacy-knowledge`**: `memories.jsonl` という単独ファイルは存在せず、実データは review-memory 用 Notion DB のフラットな JSONL export（列名がキーになった1行1レコード形式）だった。実データの `Type` 列は `review_decision` / `TODO` / `spec_context` / `review_defer` の4値のみで、**全て `KnowledgeRecord.type: "review_decision"` にマッピングする**（`review_finding` へは変換しない）。理由: `review_finding` は lane の固定10値 taxonomy enum が必須だが、実データの自由記述 `Tags`（例: `"performance"`, `"css"`）からこの enum への信頼できるマッピングが存在しないため、taxonomy を捏造するより「review_finding 移行は v1 スコープ外」と明示する方を選んだ。元の `Type` は `context` フィールドの先頭に残し追跡可能にする。日付は date-only（例 `"2026-03-13"`）で保存されており、`Iso8601Schema` が要求する完全な timestamp に合わせて `T00:00:00+09:00` を付与する。**M2 実装レビュー修正（2026-07-31、should-7）**: importer が取り込む legacy Type="TODO" の行は review_finding 相当だが taxonomy 不明のため review_decision にマッピングされる旨を reject-report の `unmapped[]`/`unmapped_count` に必ず記録する（黙落ち防止、確認済み）。加えて、取り込んだレコードには PR URL やチケット参照等の内部情報がそのまま残ることがある。この importer は個人用途のローカルデータであることが前提のためリダクションは行わない方針だが、`provenance: "imported_legacy_memories"` が**公開/OSS 公開経路からこのデータを機械的に除外できる唯一のキー**である（§7.2 の「repo をそのまま OSS 公開しても legacy 由来データが含まれない」保証は `$LANE_DATA_DIR` がそもそも repo 外にあることによるものだが、`knowledge/` ディレクトリ自体を将来何らかの理由で共有する場合は、必ずこの `provenance` 値でフィルタして除外すること）。CLI の完了メッセージにも「imported records may contain internal references; never publish the knowledge data dir as-is」という注意書きを出力する。
- 両 importer とも reject-report の既定出力先は `calibrationDir()`/`knowledgeDir()` そのものではなく `$LANE_DATA_DIR/migration-reports/` に分離した（`listObservations()`/`listKnowledgeRecords()` がディレクトリ内の `*.json` を全件レコードとして parse するため、reject-report ファイル自体が同居すると読み込みが壊れることが実装中に判明したため）。

### 7.2 データディレクトリの統一 — XDG Base Directory

rev1 は「runtime data は `~/.lane/`」「repo local profile override は `.lane/profiles/`」としており、「`.lane/` を丸ごと gitignore する」という方針と「`.lane/profiles/` を repo に置く」という記述が矛盾していた（sol 指摘）。rev2 で解消する。

```ts
export function resolveDataDir(): string {
  // XDG_DATA_HOME ?? ~/.local/share
  return process.env.LANE_DATA_DIR ?? path.join(xdgDataHome(), "lane");
}
export function resolveConfigDir(): string {
  // XDG_CONFIG_HOME ?? ~/.config
  return process.env.LANE_CONFIG_DIR ?? path.join(xdgConfigHome(), "lane");
}
```

- runtime data（`knowledge/` `calibration/` `done/` = 旧 done overlay）→ `$LANE_DATA_DIR`（既定 `~/.local/share/lane`）。
- budget 手入力設定 → `$LANE_CONFIG_DIR/budgets/`（既定 `~/.config/lane/budgets/`）。
- committable な profile は repo 内 `profiles/`（既定 bundle）と `profiles-local/`（repo local override、§3.7 で `.lane/profiles/` から改名）に置く。**`profiles-local/` は runtime data ではないため gitignore しない**（org 固有 profile を repo にコミットしたい場合はそのまま追跡可能。個人設定として除外したい場合だけ `.gitignore` に追加する運用に委ねる）。
- `$LANE_DATA_DIR` と `$LANE_CONFIG_DIR` はいずれも repo 外なので、「repo をそのまま OSS 公開しても legacy 由来データが含まれない」ことが構造的に保証される。

---

## 8. v1 スコープ削減（9月末制約、sol 裁定）

- legacy ledger 取り込みは一回限りの importer + reject report（§7.1、汎用 migration CLI にしない）。
- knowledge は append/query + critic top3 注入のみ。対話的 generalize importer / lane-finish の「知見1件以上記録」soft gate / 学習型 scoring（閾値自動調整）は落とす。
- spec consensus の PR body 自動編集は後回し。digest 付き hard gate（§3.3, §5.3）を優先する。
- lane next は同一単位（provider/unit が一致する場合）のみ fits/not_fit を出す。それ以外は advisory または unknown。
- wall-clock は `cycle_time_min` として明示するか、そもそも optional にする（cycle time の定義を厳密化しない）。
- webhook emitter / 汎用 migration framework は作らない。

**v1 の核（これだけは削らない）**:
1. 「予測 revision → scoped telemetry → immutable calibration record」の1周が回ること。
2. spec consensus の hard gate（digest 束縛込み）が機能すること。
3. lane next が透明な参考表示（誤った安心感を与えない）を出すこと。
4. knowledge の決定論的 top3 注入（閾値固定でよい）が動くこと。

---

## 9. M1 Go/No-Go 基準（2026-08-21 EOD ハード checkpoint）

sol 裁定により、rev1 で未確定だった「TS velocity チェックポイントの判定基準」を確定する。以下をすべて満たせば TS 継続、1つでも未達、または残作業の p80 見積りが 9/18 を超える場合は Python pivot に切り替える。

1. clean checkout の Node 22 で `build`/`typecheck`/`test` が通る。
2. `pnpm pack` した CLI を空の temp repo に導入し、`--profile` 指定込みで `start → advance(Phase1〜4) → 差し戻し → 再突入 → status/validate` が通る（e2e）。
3. phase transition / done overlay / ledger / Goodhart の critical parity fixture（Python v0.7.8 との differential test、§10）が100%パスする。
4. package cycle が0件、境界（core/ports と adapters の間、schemas の外部）に未検証の `any` / 二重 cast が無い（dependency-cruiser + tsc strict で検証）。
5. M1 の実績速度から M2/M3 の code-complete を 9/18 以前と見積もれ、M4（dogfood）に最低1週間残る。
6. TS/ESM/package 設定に起因する同一 blocker に1営業日以上停滞しない。

---

## 10. テスト戦略

- **単体テスト数より「移植契約」を優先する**: Python 参照実装 v0.7.8 と TS 側に **同一 JSON fixture** を与え、同じ判定・同じ出力になることを検証する differential test を軸にする。
- 対象: done overlay の合成結果 / ledger 派生ルール（`derive_included_in_kpi` 等）/ Goodhart 違反検出 / telemetry window union（差し戻し時）/ 各 schema の不変条件（p50<=p80、passthrough での未知キー保持、discriminated union の判別等）。
- CLI E2E は fake adapter（Tracker/Telemetry/Budget のモック実装）で行う。**実 GitHub / 実 agent-cost を使うのは M4 dogfood のみ**。
- Biome を初日から導入し、フォーマット・基本 lint をローカル/CI 双方で強制する。
- **手動検証・dogfood 実行時は必ず `LANE_DATA_DIR`/`LANE_CONFIG_DIR` を temp ディレクトリに指定すること**（M4 team review、2026-07-31: シェルの各コマンド呼び出し間で環境変数が引き継がれない実行環境で dogfood を行った際、これを見落とし実マシンの既定 XDG データディレクトリ（`~/.local/share/lane/`）にテスト用の done overlay・calibration record・knowledge record が実際に書き込まれてしまった。発見後に該当分を削除済み）。
- **differential parity suite が skip された場合は CI ログに `::warning::` annotation を出す**（M4 Codex 最終レビュー、should-3。`isPythonReferenceAvailable()` が false を返す度に一度、GitHub Actions が job 上の annotation として表示する行を出力する）。vitest 自体の "N skipped" サマリも既に出力されているため、テストサマリでの可視性は元から確保済みだった。

**M4 Codex 最終レビュー修正（2026-07-31）**: dogfood は完走したが、**README の Quick start の字面自体に無効な phase 遷移（`2_spec` → `4_verify` 直行、`3_implement` を経由していない）が残っていた**ことが指摘された。つまり dogfood 実行時は実際には README の字面から逸脱した手順（`3_implement` を挟む）を踏んでおり、これは M4 の受入条件「README のみで完走」の趣旨に反する。README を修正した上で、**修正後の Quick start をコピペそのままの手順で再実行し、Phase 1→5 が逸脱なく完走することを確認済み**（詳細ログは完了報告に添付）。また、`skills/lane/SKILL.md` の critic.yaml 説明が誤 schema（per-lens に `decision` がある形）だった点も修正し、根本対策として `lane validate` が critic.yaml（存在する場合のみ）の schema も検証するように拡張した（誤 schema の critic.yaml が全 gate を素通りする穴を塞ぐ）。

---

## 11. 独断裁定の反映まとめ（rev1 → rev2）

rev1 で「迷って独断した」と報告した3点について、sol の裁定を反映した最終形は以下のとおり。

- **a（estimateの独立化）**: 条件付き妥当 → revision 追記型 + `baseline_estimate_revision_id` 参照に変更して反映済み（§2.6）。
- **b（`calibration_verdict` 削除）**: 妥当と裁定 → rev1 のまま維持（§2.4）。
- **c（JSON Schema → zod への SSOT 変更）**: 条件付き妥当 → 生成 JSON Schema を commit/publish し、zod parse と JSON Schema validate の differential fixture test を CI 必須化する条件を追加した上で維持（§2、§10）。

---

## 12. 残る実装詳細（設計課題ではなく M1 実装時に確定させる項目）

sol レビューは §1〜11 の設計判断を確定させたが、以下は実装に着手した段階で決める粒度の細部であり、design.md のこれ以上の改訂は不要と判断する。

1. `profile.distance_caps`（Gower距離の log1p 正規化キャップ）の初期デフォルト値。
2. `dependency-cruiser` の具体的なルール記述（禁止パターンの正規表現等）。
3. agent-cost 側 `measure --format json` 契約の具体的な CLI 引数名・出力フィールド名（agent-cost リポジトリ側の実装と合わせて確定。M2着手条件）。
4. 1-record-1-file 方式でのファイル名衝突回避規則（`id` の一意性は schema で保証済みだが、ファイルシステム上の命名規則は実装時に決める）。
5. **`Profile` schema の配置**（M1 実装時判断、承認済み）: §2 は7 schema を列挙しているが、`risk_auto_upgrade`（§3.4）・`distance_caps`（§3.5）・`extra_lenses`（§2.3 `buildCriticSchema`）が core と schemas の両方から必要になるため、依存方向固定（schemas→なし、core→schemas）の制約上 `packages/schemas/src/profile.ts` に配置した。Profile は port ではなくデータ schema なので sol の「port は core/ports」裁定と矛盾しない。distance_caps の初期値（§12-1）はプロファイルで上書き可能な前提。
6. **`knowledge.ts` の schema 構造**（M1 実装時判断、承認済み）: §2.8 は `base.and(scope).and(discriminatedUnion(type))` という intersection 合成で示していたが、zod-to-json-schema がこの構造の各 intersection 分岐に `additionalProperties: false` を付与してしまい、生成 JSON Schema が有効なレコードを一件も通さない状態になることを differential test 構築時に ajv で実証した。意味的に同じ 2(scope)×2(type) の4パターンを、フラットな4つの object variant の union（`z.object({...base, ...scope, ...type})` を4通り定義して union）に書き換えて解消した。判定結果（zod parse の成否）は元の意図と同一。まさに §10 differential test が検出すべき類の不整合であり、sol の要求どおりの検出例。
7. **test_matrix.status の enum 値**（M1 実装時判断、承認済み・付帯条件あり）: Python 参照実装 の `"✅ existing"` 等の絵文字+日本語混在値を、i18n 方針（ユーザー向け文言は英語）に合わせて `"existing"/"added"/"not_verified"/"failing"/"tbd"` に変更した。**条件**: §7.1 の一度限り importer（`migrate-legacy-ledger`/知見に相当する verification 系の取り込みがあれば）は旧値→新値のマッピング表を必ず実装に含める（legacy 値の取り込み漏れ = 移行失敗になるため）。マッピング表を schemas 側に置くか importer 側に置くかは M2 実装時判断で良い。
8. **タイムスタンプ比較は epoch instant で行う**（M1 実装時判断、承認済み・付帯条件あり）: `Iso8601Schema`（§12 実装ノート、common.ts）が `+09:00` と `Z` の両方を許容するようにしたため、時刻の前後判定を**文字列比較で行ってはならない**（offset が異なると文字列順序と実時刻順序が一致しない）。`core/ledger.ts` の `isSuperseded`（pricing_as_of / imported_at の新旧判定）はこれに対応して `Date` でパースした epoch ミリ秒で比較するように実装した。`unionPhaseWindows`（§3.6）はもともと `Date` を受け取るインターフェースだが、LaneState.phase_history の ISO 文字列（started_at/ended_at）をどこで `Date` に変換するかが未実装だったため、`core/ledger.ts` に `phaseWindowsForPhase(phaseHistory, phase)` を追加して橋渡しした。offset 混在 fixture（`+09:00` と `Z` が同一比較・同一 union に混在するケース）を `isSuperseded` / `unionPhaseWindows` / `phaseWindowsForPhase` の3箇所すべてに対する回帰テストとして追加した（`packages/core/test/ledger.test.ts`）。
