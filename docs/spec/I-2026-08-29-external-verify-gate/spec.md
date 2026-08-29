# spec: external verify gate (I-2026-08-29-external-verify-gate)

risk: **medium** / intent SSOT: `docs/spec/I-2026-08-29-external-verify-gate/intent.yaml`

> **✅ Human-review band: 承認取得済み（2026-08-29）。**
> 新しい依存・状態・ガードを導入し、かつ「外部コマンドを実際に起動する」という lane が
> これまで持たなかった能力を追加するため §4 applicability = applicable。決定事項・cross-check 表・
> TEST-ID マッピング・Q1〜Q4・`allowed_paths` への `skills/**` / `profiles/**` 追加について承認済み。
>
> **rev2（2026-08-29、architect レビュー反映）**: 初稿には (a) 事実誤認 1 件、(b) 認可の重大な穴
> 1 件、(c) timeout が実際には効かない前提誤り 1 件、(d) cross-check 表の列欠落があった。
> §9 に全指摘と対応を記録し、本文は修正後の内容に差し替えてある。

---

## 1. 背景と確認済みの前提

`lane advance` の phase 遷移は `packages/core/src/gate.ts` の `DEFAULT_GATES`（7 gate）で守られているが、
`3_implement -> 4_verify` の edge に適用されるのは `successCriteriaGate` の 1 本のみで、これは
spec/verification.yaml の内容しか読まない。**どの gate も外部コマンドを起動しない。**
つまり「プロジェクト固有の独立検証（動機付け例: deterministic-discipline の `dd verify --session`）が
完了しているか」は、遷移処理そのものが一切見ていない。

### 1.1 実装方針に直結する確認済み事実

| # | 事実 | 出典 | 効き方 |
|---|---|---|---|
| F1 | `Gate.evaluate(ctx): Diagnostic[]` は**同期**。gate は `GateArtifacts` に載った値を読むだけの述語として書かれている | `packages/core/src/gate.ts` | D2 |
| F2 | `GateArtifacts` は既に「呼び出し側が IO して gate に渡す」形（`specDigest` = "computed fresh by the caller"、`design` = "read fresh from disk every time"） | `gate-check.ts` の `buildGateContext` | D2 |
| F3 | **`packages/core` にも `child_process` は存在する**（`core/src/pin-verify.ts` の `execFileSync`）。初稿の「core に import 皆無」は**誤り**（§9-1） | `packages/core/src/pin-verify.ts:1` | D2 の根拠を訂正 |
| F4 | `wrapper-bind.ts` が既に「シェルを経由しない spawn」の前例と明文コメントを持つ | `packages/cli/src/wrapper-bind.ts:15-17` | D3 |
| F5 | `detectWrapperAgent` は "Exact basename match only (never a `startsWith` heuristic)" を明示 | 同 `:26-28` | D1 |
| F6 | profile の `required_commands` は**宣言のみで実行コードが存在しない** | `packages/schemas/src/profile.ts:102` のみ、他に参照なし | L4 / DEP-08 |
| F7 | profile 解決順は flag > env > repo_local(`profiles-local/`) > package default。`advance`/`validate`/`estimate` は**いずれも `profileId` を渡さない**ため、フラグ・env が無ければ **npm パッケージ同梱 profile**が使われ repo 内は読まれない | `core/src/profile.ts` / 3 コマンドの呼び出しを実確認 | D1 / L3 |
| F8 | **`LANE_PROFILE_PATH` は常に有効で、相対パスなら checkout 内を指せる。`--profile <id>` は `profiles-local/` を読む** | `core/src/profile.ts:62-75` | L3（保証の範囲限定） |
| F9 | `effective_risk_log[].profile_digest = computeDigest(JSON.stringify(profile))` | `packages/core/src/risk.ts:106` | **D1: profile schema に `.default()` を足すと全 lane の digest が変わる** |
| F10 | v0.8.0 で intent.yaml の schema 外キーは fail-closed | CHANGELOG 0.8.0 | 新フィールドは schema + 生成 JSON Schema + differential fixture の 3 点セット必須 |

### 1.2 `spawnSync` の実測（Node v22.23.2、本設計の根拠）

初稿は「timeout 超過時は子が kill される」「timeout は必ず `signal !== null`」を前提にしていたが、
**どちらも誤り**だった。実測結果:

| 条件 | elapsed | `status` | `signal` | `error.code` |
|---|---|---|---|---|
| `timeout:300`, `killSignal` 既定(SIGTERM)、子が SIGTERM を無視 | **5033ms** | **0** | null | `ETIMEDOUT` |
| `timeout:300`, `killSignal:"SIGKILL"`、同上 | **303ms** | null | `SIGKILL` | `ETIMEDOUT` |
| `maxBuffer:1024` を超える stdout | — | null | `SIGTERM` | `ENOBUFS` |
| 実行ファイル不在 | — | null | — | `ENOENT` |
| 実行権限なし | — | null | — | `EACCES` |
| 空 executable / 引数に NUL / `timeout:-1` / `timeout:NaN` | — | — | — | **同期 throw**（`ERR_INVALID_ARG_VALUE` / `ERR_OUT_OF_RANGE`） |

**帰結（いずれも仕様に反映）:**
- 既定 `killSignal` では **timeout が期限として機能しない**。かつ `status===0` になるため、
  `error` を見ない実装は**タイムアウトを成功と誤判定する（fail-open）**。→ D6 で `SIGKILL` 必須。
- `ENOBUFS` は `signal: SIGTERM` を伴うため、signal 判定より先に分類しないと `killed_by_signal` に化ける。
- 不正 argv / timeout は戻り値ではなく **throw** で来るため、runner 境界で catch が必須。

## 2. 用語

- **external verify command**: 本機能が起動する外部コマンド。`argv`（配列）+ `timeout_seconds`。
- **command digest**: `computeDigest(JSON.stringify({ argv, timeout_seconds, cwd }))`。
  **コマンド全体（実行するディレクトリを含む）**の同一性（rev3、§10-1）。
- **authorized**: その command digest が profile の `allowed_command_digests` に含まれる状態。
- **configured**: intent.yaml に `external_verify` が書かれている状態。

## 3. 決定事項

### D1. 二鍵方式 — intent.yaml が「何を」、profile が「そのコマンド全体を実行してよいか」を持つ

**鍵1（intent.yaml、declare）**

```yaml
external_verify:
  argv: ["/usr/local/bin/dd", "verify", "--session-from-env"]
  timeout_seconds: 60          # 省略時 60
```

schema 制約（**すべて fail-closed**、§1.2 の throw ケースを schema 段で先に潰す）:
- `argv` は要素 1 以上
- **`argv[0]` は絶対パス必須**（実装は `startsWith("/")`。POSIX では `node:path` の `isAbsolute`
  と等価で、Windows は L6 のとおり対象外）。相対パスや裸のコマンド名を禁じ、
  **PATH 汚染で `argv[0]` が別物に解決される経路を塞ぐ**
- 全要素が非空かつ **NUL 文字を含まない**
- `timeout_seconds` は整数 1〜600

**鍵2（profile、authorize）**

```yaml
external_verify:
  allowed_command_digests: ["sha256:..."]
```

> **rev3（実装レビューでの必須修正）: digest は `{argv, timeout_seconds, cwd}` を束縛する。**
> rev2 は `{argv, timeout_seconds}` のみだったが、これは**文字列を束縛していてファイルを束縛して
> いなかった**。絶対パス必須なのは `argv[0]` だけで、`argv[1..]` は相対パスを許し、子の cwd は
> `process.cwd()` である。したがって checkout 外の profile（＝ L3 が「最も強い保証が得られる」と
> 書いていた構成、user-level profile では普通の運用）で
> `["/…/node", "scripts/verify.js"]` を認可すると、**同じ2つの文字列を宣言する任意のリポジトリで
> 一致し、そのリポジトリ自身の `scripts/verify.js` が実行された**。実機で再現済み（別リポジトリの
> スクリプトが走り lane が advance した）。ブランチは自分を認可する必要すらなく、**別ファイルに
> 与えられた認可を再利用するだけ**でよかった。cwd を含めることで認可の意味が
> 「このディレクトリでのこのコマンド」になり、別 checkout は別 digest として拒否される。

- **`.optional()` で定義し `.default()` を付けない**。F9 のとおり `profile_digest` は
  `JSON.stringify(profile)` なので、`.default([])` を足すと**既存全 lane の profile_digest が変わる**。
  未設定は「フィールド不在」で表現する（同梱 profile にも空フィールドを書かない）。
- 照合は **command digest の完全一致**。`argv[0]` だけの allowlist では
  **認可済みインタプリタ経由の任意実行（例: `node -e "..."`）を防げない**ため **argv 全体 + timeout**
  を、さらに**相対引数が別リポジトリの別ファイルに解決される**のを防ぐため **cwd** も束縛する
  （§9-2 / §10-1）。
- 未認可時のエラーメッセージに算出済み digest を含め、運用者がそのまま profile に貼れるようにする。

**この二鍵が守るもの / 守らないもの**は L3 に明記する。

### D2. サブプロセスは CLI 層で実行し、core の gate は同期述語のままにする

`core/gate.ts` に新設する `externalVerifyGate` は `GateArtifacts.externalVerify` を読むだけの
**同期述語**。実行は CLI 層（`gate-check.ts`）が行う。

> **根拠の訂正（§9-1）**: 初稿は「core に `child_process` の import が皆無だから」と書いたが、
> これは事実誤り（F3: `core/pin-verify.ts` に `execFileSync` がある）。正しい根拠は
> **F1/F2 — `Gate.evaluate` が同期であり、GateArtifacts に IO 結果を載せる分業が既に確立している**
> こと。core の「純粋性」は型が保証しているわけではない（`Gate` 型が保証するのは同期性のみ）。

**構造（architect should を採用）**: `buildGateContext` に spawn を直接埋めず、次の 2 つに分ける。

- `planExternalVerify({intent, profile, trigger, env, cwd})` — **純粋**。実行すべきか / 認可されて
  いるか / 再帰か / 何をどこで実行するかを決め、`{ kind: "skip" } | { kind: "refuse", code } |
  { kind: "run", argv, timeoutMs, cwd }` を返す。`cwd` を plan に載せるのは、認可した cwd と
  実行 cwd が乖離しないことを構造的に保証するため（§10-1）
- `ExternalVerifyRunner` — 注入可能な副作用境界。既定実装が `spawnSync` を呼ぶ。テストは fake を注入する

`Gate` の async 化はしない（既存 7 gate と 2 呼び出し元に波及するため）。

### D3. シェルを一切経由しない

`spawnSync(argv[0], argv.slice(1), ...)`。`shell: true` を使わない。argv は文字列配列のまま渡し、
文字列結合・補間で組み立てない（F4 の既存規約を踏襲）。

### D4. 発火点は `3_implement -> 4_verify` の phase_advance のみ

`advance` の当該 edge に加え、`lane validate` が同 edge を dry-run する経路でも**実際に実行する**
（実行しない dry-run は「通るはず」という嘘の報告になるため）。

> **⚠️ 二重起動の回避（初稿の自己レビューで検出）**
> `evaluateGatesForTrigger` は呼ばれるたびに `buildGateContext` を新規実行する。`lane validate` は
> 1 回で 2 trigger（`phase_advance{3->4}` と `before_pr_publish{phase:3_implement}`）を評価するため、
> 「buildGateContext で必ず実行」とすると **1 回の validate で外部コマンドが 2 回起動する**。
> したがって起動条件と `externalVerifyGate.appliesTo` の**両方**を
> `phase_advance && from==="3_implement" && to==="4_verify"` に限定する
> （`successCriteriaGate` のように `before_pr_publish` を含めては**ならない**）。TEST-24 / TEST-25。

### D5. 文脈は固定 argv + `LANE_*` 環境変数で渡す

argv は intent.yaml のリテラル。可変値は環境変数で渡す（親 env を継承 + 以下を**上書き**）:

| 変数 | 値 |
|---|---|
| `LANE_INTENT_ID` | intent_id |
| `LANE_PHASE_FROM` / `LANE_PHASE_TO` | `3_implement` / `4_verify` |
| `LANE_SPEC_DIR` | 解決済み spec ディレクトリ |
| `LANE_EXTERNAL_VERIFY_ACTIVE` | `1`（D8 の番兵） |

親プロセスが同名の変数を持っていても**必ず lane の値で上書きする**（TEST-26）。
これにより lane は対象ツールの CLI 構文を知らずに済む。cwd は `process.cwd()`（他コマンドと同じ、
TEST-27）であり、**rev3 以降はこの cwd 自体が digest の一部＝認可対象**である（§10-1）。

### D6. timeout 既定 60 秒 / **`killSignal: "SIGKILL"`** / `maxBuffer` 明示

- 既定 60 秒（初稿 120 秒から短縮。`spawnSync` は event loop を完全にブロックし、同期 API のため
  ストリーミング表示ができない）
- **`killSignal: "SIGKILL"` 必須** — §1.2 のとおり既定の SIGTERM では期限が全く効かない
- `maxBuffer` を明示（1 MiB）。超過は `ENOBUFS` として D7 で独立分類
- 起動直前に stderr へ 1 行 `[external_verify] running <argv[0]> (timeout <n>s)...` を出す

### D7. 失敗分類と**判定順序**（順序自体が仕様）

起動前（純粋判定、`planExternalVerify`）:

| code | 条件 |
|---|---|
| `unauthorized` | command digest が profile の allowlist に無い（D1） |
| `recursion_blocked` | 親 env に `LANE_EXTERNAL_VERIFY_ACTIVE` が**存在する**（D8） |
| `invalid_configuration` | runner 境界で `spawnSync` が throw した（§1.2。schema で先に弾くが二重防御） |

起動後（**この順序で判定する**）:

| 順 | 条件 | code |
|---|---|---|
| 1 | `error?.code === "ETIMEDOUT"` | `timeout` |
| 2 | `error?.code === "ENOBUFS"` | `output_limit_exceeded` |
| 3 | その他の `error` が存在（errno を診断に残す） | `spawn_failed` |
| 4 | `status === null && signal !== null` | `killed_by_signal` |
| 5 | `status !== 0` | `nonzero_exit` |
| 6 | 上記いずれでもなく成功と確定できない | `unknown_failure` |

**順序の根拠（§1.2 の実測）**:
- 1 が最優先である必要: 既定 SIGTERM では timeout 時に `status===0` になりうるため、
  `error` を先に見ないと**タイムアウトを成功と誤判定する**（TEST-20 で固定）。
- 2 が 3・4 より先である必要: `ENOBUFS` は `error` かつ `signal: SIGTERM` を伴うため、
  順序を誤ると `spawn_failed` や `killed_by_signal` に化ける（TEST-28）。
- 4 が 5 より先である必要: シグナル終了は `status === null` で「`!== 0`」も真になるため、
  4 が無いと exit code として `null` を表示する診断になる（TEST-19）。

すべて severity=error（warning にしない）。子の stdout/stderr は**判定に用いない**が、失敗時の
診断に末尾 20 行 / 2000 文字で切り詰めて添付する（Q2）。**lane は一切 redact しない**（L7）。

### D8. 再帰起動の防止（番兵環境変数）— 限界を明示した上で採用

子に `LANE_EXTERNAL_VERIFY_ACTIVE=1` を渡し、起動前に**親 env にこのキーが存在すれば**
起動せず `recursion_blocked` の error を出す。

- 判定は **truthy ではなくキーの存在**（空文字列や `"0"` でも拒否。TEST-29）
- 黙って skip せず error にする（入れ子の深さで判定が変わる＝再現しない状態を作らないため）
- **限界（L8）**: これは「信頼済み verifier の偶発的な再帰」を止めるものであり、
  子が env を削除して孫を起こす経路は塞げない。同一ユーザー権限の任意コードに対する
  強制境界ではない。

### D9. 成功した外部検証を `lane-state.json` に記録する（Q1）

`gate_snapshots.external_verify = { command_digest, exit_status, recorded_at }` を
`3_implement -> 4_verify` の遷移が**成功した時点**で記録する
（`buildUpdatedGateSnapshots` が `success_criteria` を記録するのと同じ位置・同じ条件）。

- **`recorded_at` は runner の実終了時刻**を使う。`advance.ts` の `now` は gate 実行**前**に
  取得されており（`advance.ts:118`）、それを流用すると外部コマンドの実行時間だけ過去にずれる（§9-5）
- **未設定で 3->4 が成功した場合は、既存の `external_verify` snapshot を削除する**。
  「configured で通過 → 4 → rework で 3 → 設定削除 → 再び 3->4」の経路で古い snapshot が残ると、
  「今回は未設定だった」と「前回外部検証を通った」が区別できなくなる（§9-5、TEST-30）
- `lane validate` は snapshot を書かない（TEST-31）

**実装**: `advance.ts` が snapshot 記録に runner の結果を必要とするため、
`evaluateGatesForTriggerDetailed()` を新設して `{ context, evaluation }` を返す
（`advance.ts` に `DEFAULT_GATES` を露出させるより小さい変更。architect should を採用）。
`validate.ts` は既存の `evaluateGatesForTrigger` のままでよい。

## 4. Dependency and path cross-check

**Applicability: 適用（applicable）** — 新しい依存（子プロセス実行）・新しい状態（authorized /
configured / snapshot）・新しいガード（遷移拒否）を同時に導入し、複数の既存経路
（`advance` と `validate`）が同一の gate 評価資源を扱うため。

### 4.1 導入する依存・変更（DEP）

| id | 内容 |
|---|---|
| DEP-01 | `GateArtifacts.externalVerify?` 追加（省略時＝未設定＝従来どおり） |
| DEP-02 | `IntentSchema.external_verify?`（argv / timeout_seconds、D1 の制約付き）+ 生成 JSON Schema + differential fixture |
| DEP-03 | `ProfileSchema.external_verify?.allowed_command_digests?`（**`.default()` なし**）+ 同 3 点セット |
| DEP-04 | `DEFAULT_GATES` に `externalVerifyGate` 追加 |
| DEP-05 | `buildGateContext` が条件付きで `planExternalVerify` + runner を呼ぶ（新規 IO） |
| DEP-06 | `planExternalVerify`（純粋）+ `ExternalVerifyRunner`（no-shell / SIGKILL / maxBuffer / 番兵 env / throw catch）の新設 |
| DEP-07 | `LaneState.gate_snapshots.external_verify` 新設 + 同 3 点セット + `evaluateGatesForTriggerDetailed()` 新設と `advance.ts` の切り替え + 未設定時の snapshot 削除 |
| DEP-08 | ドキュメント/テンプレート: `lane start` の intent.yaml コメント例、`profile.ts` の `required_commands` に「実行されない」注記、README（gate 一覧 / L3 の保証範囲 / L7 の redact しない旨）、`skills/lane/SKILL.md` の Phase 3 行 |

### 4.2 DEP を尊重する必要のある既存経路（PATH）

| id | 経路 | 差分内か |
|---|---|---|
| PATH-01 | `advance.ts` の `phase_advance` 評価 | 内（間接） |
| PATH-02 | `advance.ts` の `promotion` 評価（5_done のみ） | 内（間接） |
| PATH-03 | `validate.ts` の 2 trigger 評価 + `dedupeDiagnostics` | 内（間接） |
| PATH-04 | 既存 7 gate の `appliesTo` / `evaluate` | 外（無改修の確認が必要） |
| PATH-05 | `lane start` が書く intent.yaml テンプレート | 外 |
| PATH-06 | `readIntentForWrite` / `writeIntent`（v0.8.0 の fail-closed 往復） | 外 |
| PATH-07 | 同梱 profile `profiles/generic.profile.yaml` と `profile_digest`（F9） | 外 |
| PATH-08 | `design` 系 2 gate（条件付きで動く先例） | 外 |

### 4.3 cross-check 表（PATH × DEP、**8×8**）

> 初稿は DEP-07/08 を宣言しながら表を DEP-01..06 の 6 列のままにしていた（§9-6）。以下は修正版。

| | DEP-01 | DEP-02 | DEP-03 | DEP-04 | DEP-05 | DEP-06 | DEP-07 | DEP-08 |
|---|---|---|---|---|---|---|---|---|
| PATH-01 | 参照 | 参照 | 参照 | 参照 | 参照 | 間接 | 参照 | しない |
| PATH-02 | しない **(T)** | しない | しない | しない **(T)** | しない **(T)** | しない | しない **(T)** | しない |
| PATH-03 | 参照 | 参照 | 参照 | 参照 | 参照(D4) | 間接 | しない **(T)** | しない |
| PATH-04 | しない **(T)** | しない | しない | しない | しない | しない | しない | しない |
| PATH-05 | しない | 参照 **(T)** | しない | しない | しない | しない | しない | 参照 **(T)** |
| PATH-06 | しない | 参照 **(T)** | しない | しない | しない | しない | 参照 **(T)** | しない |
| PATH-07 | しない | しない | **参照 (T)** | しない | しない | しない | しない | 参照 **(T)** |
| PATH-08 | しない **(T)** | しない | しない | しない | しない | しない | しない | しない |

**(T)** = 「しない／不明」を TEST-ID に昇格させたセル（§4.4）。

### 4.4 TEST-ID

**opt-in / 後方互換**

| id | 検証内容 |
|---|---|
| TEST-01 | 未設定 lane の `advance 3->4` が子プロセスを起動せず、診断も従来と完全同一 |
| TEST-02 | 未設定 lane の既存 gate 診断が本変更の前後で不変（回帰） |
| TEST-03 | `promotion`(5_done) で `appliesTo` が false かつ子プロセスが起動しない |
| TEST-23 | 未設定 lane では `gate_snapshots.external_verify` が書かれない |
| TEST-32 | **`ProfileSchema` に新フィールドを足しても、既存 profile の `profile_digest` が変わらない**（F9） |
| TEST-33 | 同梱 `profiles/generic.profile.yaml` に `external_verify` を**書かない**（不在であること） |
| TEST-34 | design_track 無効時と同様、本 gate も未設定なら他 gate に影響しない |

**認可（D1）**

| id | 検証内容 |
|---|---|
| TEST-08 | configured だが未認可 → `unauthorized`、**実行されない** |
| TEST-09 | command digest が 1 バイトでも違えば拒否（argv 末尾要素の改変） |
| TEST-35 | **認可済みインタプリタの悪用が防がれる**: `node` を含む argv を認可しても、引数を変えた argv は別 digest で拒否 |
| TEST-36 | `argv[0]` が相対パス / 裸のコマンド名なら schema が拒否（PATH 汚染対策） |
| TEST-37 | argv に NUL / 空要素、`timeout_seconds` が範囲外なら schema が拒否 |
| TEST-38 | profile が package default / env / flag のどの source でも認可判定が同一 |

**実行と失敗分類（D6/D7）**

| id | 検証内容 |
|---|---|
| TEST-04 | 認可済み・exit 0 → 遷移成功 |
| TEST-05 | exit 非 0 → `nonzero_exit`、`lane-state.json` が**バイト単位で不変** |
| TEST-06 | timeout 超過 → `timeout`、かつ**実測時間が timeout + 余裕内**（SIGKILL が効いている） |
| TEST-07 | 実行ファイル不在 → `spawn_failed`（errno=ENOENT を診断に含む）、例外が外に漏れない |
| TEST-19 | シグナル終了 → `killed_by_signal`、exit code に `null` を表示しない |
| TEST-20 | **SIGTERM を無視する子の timeout が `nonzero_exit`/`killed_by_signal`/成功 のいずれにもならず `timeout` になる**（§1.2 の fail-open 回帰） |
| TEST-28 | stdout が maxBuffer 超過 → `output_limit_exceeded`（`spawn_failed`/`killed_by_signal` ではない） |
| TEST-39 | 実行権限なし → `spawn_failed`（errno=EACCES） |
| TEST-40 | runner が throw する入力でも `invalid_configuration` に落ち、例外が外に漏れない |
| TEST-10 | argv にシェルメタ文字を含めても 1 引数として渡り、シェル解釈されない |
| TEST-22 | 失敗診断に stdout/stderr 末尾が添付され 20 行 / 2000 文字で切り詰められる |
| TEST-41 | **全失敗分類**（timeout / spawn_failed / killed_by_signal / nonzero_exit / output_limit_exceeded / unauthorized / recursion_blocked / invalid_configuration）で `lane-state.json` がバイト不変 |

**環境・再帰（D5/D8）**

| id | 検証内容 |
|---|---|
| TEST-11 | `LANE_*` 4 種が子に渡る |
| TEST-26 | 親が同名の `LANE_*` を持っていても lane の値で上書きされる |
| TEST-27 | 子の cwd が `process.cwd()` である |
| TEST-18 | **統合再帰テスト**: 実際に子から `lane validate` を起こし、2 段目が `recursion_blocked` になる |
| TEST-29 | 番兵の判定がキーの存在ベース（値が空文字列 / `"0"` でも拒否） |

**発火点（D4）**

| id | 検証内容 |
|---|---|
| TEST-12 | `lane validate` でも同じ判定が出る |
| TEST-13 | `validate` の 2 trigger 評価で同一診断が二重に出ない（`dedupeDiagnostics` と整合） |
| TEST-24 | **`lane validate` 1 回で外部コマンドの起動回数がちょうど 1** |
| TEST-25 | `before_pr_publish` 単独 trigger では `appliesTo` が false かつ起動しない |

**記録（D9）**

| id | 検証内容 |
|---|---|
| TEST-21 | 成功遷移後に `gate_snapshots.external_verify` が digest / exit status / 時刻付きで記録される |
| TEST-30 | **configured で通過 → rework で 3 に戻る → 設定削除 → 再び 3->4 成功、で古い snapshot が削除される** |
| TEST-31 | `lane validate` は snapshot を書かない |
| TEST-42 | `recorded_at` が runner の実終了時刻であり、gate 実行前の `now` ではない |

**スキーマ 3 点セット / ドキュメント**

| id | 検証内容 |
|---|---|
| TEST-14 | `external_verify` を持つ intent.yaml が `lane estimate --adopt` 往復で失われない（v0.8.0 fail-closed と整合） |
| TEST-16 | 生成 JSON Schema に新フィールドが反映され differential fixture が通る（intent / profile / lane-state の 3 本） |
| TEST-17 | `lane start` 出力の intent.yaml が（コメント追加後も）そのまま `lane validate` を通る |

## 5. EARS 要求

- **EARS-01** WHERE `external_verify` が未設定の場合、THE SYSTEM SHALL 子プロセスを起動せず、
  `externalVerifyGate` の診断を 1 件も出さず、`gate_snapshots.external_verify` を書かない。
- **EARS-02** WHEN `3_implement -> 4_verify` の phase_advance が試行され、AND configured であり、
  AND その command digest が profile の `allowed_command_digests` に含まれる場合、THE SYSTEM SHALL
  その argv をシェルを経由せずに起動する。
- **EARS-03** IF command digest が認可されていない場合、THEN THE SYSTEM SHALL 子プロセスを起動せず、
  code=`unauthorized` の error 診断を出し、算出済み digest を診断に含める。
- **EARS-04** IF 親 env に `LANE_EXTERNAL_VERIFY_ACTIVE` が存在する場合、THEN THE SYSTEM SHALL
  子プロセスを起動せず code=`recursion_blocked` の error 診断を出す。値の内容は問わない。
- **EARS-05** WHEN 子プロセスを起動する場合、THE SYSTEM SHALL `killSignal: "SIGKILL"` と明示的な
  `maxBuffer` を指定する。
- **EARS-06** IF `spawnSync` が `ETIMEDOUT` を返した場合、THEN THE SYSTEM SHALL `status` の値に
  かかわらず code=`timeout` の error 診断を出す。
- **EARS-07** IF `spawnSync` が `ENOBUFS` を返した場合、THEN THE SYSTEM SHALL
  code=`output_limit_exceeded` の error 診断を出す。
- **EARS-08** IF `spawnSync` がその他の `error` を返した場合、THEN THE SYSTEM SHALL
  code=`spawn_failed` の error 診断を出し、errno を診断に含める。
- **EARS-09** IF `status === null` かつ `signal !== null` の場合、THEN THE SYSTEM SHALL
  code=`killed_by_signal` の error 診断を出し、exit code として `null` を表示しない。
- **EARS-10** IF `status !== 0` の場合、THEN THE SYSTEM SHALL code=`nonzero_exit` の error 診断を出す。
- **EARS-11** IF 上記いずれにも該当せず成功と確定できない場合、THEN THE SYSTEM SHALL
  code=`unknown_failure` の error 診断を出す。
- **EARS-12** IF runner が例外を送出した場合、THEN THE SYSTEM SHALL それを捕捉して
  code=`invalid_configuration` の error 診断に変換し、例外を CLI 境界の外へ伝播させない。
- **EARS-13** WHEN 子プロセスを起動する場合、THE SYSTEM SHALL `LANE_INTENT_ID` /
  `LANE_PHASE_FROM` / `LANE_PHASE_TO` / `LANE_SPEC_DIR` / `LANE_EXTERNAL_VERIFY_ACTIVE` を、
  親が同名の変数を持つ場合も上書きして設定する。
- **EARS-14** WHEN `3_implement -> 4_verify` の遷移が成功した AND configured であった場合、
  THE SYSTEM SHALL `gate_snapshots.external_verify` に command digest・exit status・
  **runner の実終了時刻**を書き込む。
- **EARS-15** WHEN `3_implement -> 4_verify` の遷移が成功した AND 未設定であった場合、
  THE SYSTEM SHALL 既存の `gate_snapshots.external_verify` を削除する。
- **EARS-16** WHEN 診断に子プロセスの出力を添付する場合、THE SYSTEM SHALL 末尾 20 行かつ
  2000 文字を上限として切り詰め、切り詰めた事実を明示し、内容に対して一切の redaction を行わない。
- **EARS-17** WHEN 子プロセスを起動する直前、THE SYSTEM SHALL stderr に実行中である旨を 1 行出力する。
- **EARS-18** WHILE `promotion` trigger または `before_pr_publish` trigger を評価している間、
  THE SYSTEM SHALL `externalVerifyGate` を適用せず、子プロセスも起動しない。
- **EARS-19** THE SYSTEM SHALL 子プロセスの stdout/stderr の**内容**を判定に用いず、
  終了状態のみを gate 信号として扱う。

## 6. Gherkin シナリオ

```gherkin
Scenario: 未設定 lane は完全に従来どおり
  Given intent.yaml に external_verify が無い lane が 3_implement にある
  When lane advance --phase 4_verify を実行する
  Then 子プロセスは 1 つも起動しない
  And externalVerifyGate の診断は 0 件である
  And gate_snapshots.external_verify は書かれない

Scenario Outline: 認可済みコマンドの終了状態が遷移を決める
  Given profile が対象コマンドの digest を認可している
  And そのコマンドが <behavior> する
  When lane advance --phase 4_verify を実行する
  Then 遷移は <outcome> になり、診断の code は "<code>" である

  Examples:
    | behavior                        | outcome | code                  |
    | exit 0                          | 成功    | (診断なし)            |
    | exit 1                          | 拒否    | nonzero_exit          |
    | SIGTERM を無視して滞留          | 拒否    | timeout               |
    | 大量の stdout を出す            | 拒否    | output_limit_exceeded |
    | SIGSEGV で落ちる                | 拒否    | killed_by_signal      |
    | 実行ファイルが存在しない        | 拒否    | spawn_failed          |

Scenario: 認可済みインタプリタでも引数が変われば拒否される
  Given profile が argv ["/usr/bin/node","verify.js"] の digest だけを認可している
  And intent.yaml の argv が ["/usr/bin/node","-e","evil()"] である
  When gate を評価する
  Then 子プロセスは起動しない
  And 診断の code は "unauthorized" である

Scenario: PATH 汚染は schema 段で塞がれる
  Given intent.yaml の argv[0] が絶対パスでない
  When lane validate を実行する
  Then schema エラーになり、gate 評価まで到達しない

Scenario: timeout は成功と誤判定されない
  Given 認可済みの外部コマンドが SIGTERM を無視して timeout を超えて滞留する
  When gate を評価する
  Then 診断の code は "timeout" である
  And 遷移は拒否される
  And 実測所要時間は timeout に近い（SIGKILL により打ち切られている）

Scenario: 再帰は 1 段で打ち切られる
  Given 認可済みの外部コマンドが内部で lane validate を起動する
  When lane advance --phase 4_verify を実行する
  Then 2 段目の評価は子プロセスを起動しない
  And 2 段目の診断の code は "recursion_blocked" である

Scenario: rework で設定が外れたら古い記録は消える
  Given configured で 3->4 を通過し gate_snapshots.external_verify が記録されている
  And その後 2_spec へ rework し 3_implement に戻り、external_verify を削除した
  When 再び lane advance --phase 4_verify を実行する
  Then 遷移は成功する
  And gate_snapshots.external_verify は存在しない

Scenario: 1 回の validate で外部コマンドはちょうど 1 回だけ起動する
  Given configured かつ authorized な lane が 3_implement にある
  When lane validate を 1 回実行する
  Then 外部コマンドの起動回数は 1 である
  And gate_snapshots は書き換えられない
```

## 7. 既知の限界（正直な範囲宣言）

- **L1: コマンドの同一性は固定できるが、そのパスにあるファイルの中身は固定できない。**
  command digest が束縛するのは argv 文字列・timeout・cwd であり、実行ファイルの**中身**や
  **symlink 差し替え**は束縛しない。同じ checkout 内で認可済みパスのスクリプトを書き換えれば
  digest は変わらないまま実行される — これは意図的で、そのファイルはレビュー対象の作業ツリーの
  一部だからである。lane が保証するのは推移的閉包ではない。
- **L10: `argv[0]` の絶対パス要件は「PATH がどのバイナリを選ぶか」を完全には排除しない。**
  `["/usr/bin/env", "node", ...]` は schema を通り、`env` が `$PATH` を再解決する。この argv は
  運用者が明示的に認可したものではあるが、絶対パス規則が謳う保証はこの形では成立しない。
  interpreter/launcher を認可する場合はこの点を理解した上で行うこと。
- **L2: promotion（5_done）では再チェックしない**（intent の non_goal どおり。
  premise_evidence / success_criteria とは非対称であることを明示的に選んでいる）。
- **L3: 二鍵方式の保証範囲は「profile が checkout 外から解決される場合」に限られる。**
  F7 のとおり `advance`/`validate`/`estimate` は `profileId` を渡さないため、フラグ・env が
  無ければ package default（checkout 外）が使われ、**pull しただけのブランチは自分を認可できない**。
  ただし F8 のとおり **`LANE_PROFILE_PATH`（相対パス可）や `--profile <id>`（`profiles-local/` を読む）を
  使う運用では、ブランチ側が両方の鍵を握りうる**。README にこの条件を明記する。
  いずれにせよこれはハードルであって、運用者環境の侵害に対する防御ではない。
- **L4: 命名衝突。** profile の既存 `required_commands` は**宣言のみで実行されない**（F6）。
  本機能はそれを実行する機能ではない。schema 側に注記を追加する（DEP-08）。
- **L5: `lane validate` が副作用（子プロセス起動）を持つようになる**（D4 の意図的な帰結）。
- **L6: Windows は対象外。** `shell: false` の `spawnSync` は Windows で `.cmd` / `.bat` を
  直接起動できない。既存 `wrapper-bind.ts` も同じ制約を持つ lane 全体の性質（Q4）。
- **L7: 添付される子プロセス出力は redact されない。** 上限で切り詰めるだけで内容の検査・秘匿は
  行わない。秘密情報を出力しないのは外部コマンド側の責任。
- **L8: 再帰防止は偶発的再帰にのみ有効。** 子が env を削除して孫を起こす経路は塞げない
  （D8）。同一ユーザー権限の悪意あるコードに対する強制境界ではない。
- **L9: 孫プロセスは追跡しない。** `SIGKILL` は `spawnSync` が起動した直接の子にのみ届く。
  子が孫を残して終了した場合、孫は生き残りうる（process group kill は非同期 spawn を要し、
  `Gate.evaluate` の同期契約と両立しないため今回は採らない）。

## 8. 非目標

- 子プロセスの stdout/stderr のパース（失敗時の切り詰め添付は「表示」であってパースではない）
- lane 本体への対象ツール固有知識の混入
- deterministic-discipline 側の実装（chunk 3〜5c で完了済み）
- profile の `required_commands` を実行する機能への拡張
- 孫プロセスまでを含む process group の生存管理（L9）

## 9. architect レビュー（sol, 2026-08-29）の指摘と対応

| # | 指摘 | 重大度 | 対応 |
|---|---|---|---|
| 9-1 | 「core に `child_process` の import が皆無」は**事実誤認**（`core/pin-verify.ts` にある） | must | F3 として訂正し、D2 の根拠を「`Gate.evaluate` の同期契約と GateArtifacts の分業」に置き換え |
| 9-2 | `argv[0]` のみの allowlist では PATH 汚染・相対パス・symlink・**認可済みインタプリタ経由の任意実行**を防げない。承認時 argv を束縛する digest も無い | must | **D1 を全面改訂**: profile は `allowed_command_digests`（argv 全体 + timeout の digest）を持つ。`argv[0]` は絶対パス必須。TEST-35/36 |
| 9-3 | 「pull だけで安全」は flag/env 未指定時に限る。`LANE_PROFILE_PATH` は相対パス可 | must | F8 / L3 に条件を明記 |
| 9-4 | profile schema に `.default([])` を足すと `JSON.stringify(profile)` の digest が変わり「未設定時完全不変」を破る | must | D1 で `.optional()`・default なしに変更。同梱 profile にも書かない。TEST-32/33 |
| 9-5 | **「timeout は必ず `signal !== null`」は誤り**。SIGTERM を無視する子では `status=0, signal=null, error=ETIMEDOUT` になる | must | §1.2 で自環境でも実証（300ms 指定に対し 5033ms、`status=0`）。D6 で `killSignal:"SIGKILL"` を必須化。TEST-06/20 |
| 9-6 | `maxBuffer` 超過（`ENOBUFS`）が未分類。空 exe / NUL / 不正 timeout は `spawnSync` 自体が throw する。`unknown_failure` も必要 | must | D7 に `output_limit_exceeded` / `invalid_configuration` / `unknown_failure` を追加し順序を確定。schema でも先に拒否。TEST-28/37/40 |
| 9-7 | 番兵 env は偶発的再帰にしか効かない。判定は truthy でなくキー存在で | must | L8 に限界を明記。D8 を存在ベース判定に。TEST-18 を統合テストへ、TEST-29 追加 |
| 9-8 | `now` が gate 実行前に取得されている。snapshot には runner の実終了時刻を | must | D9 / EARS-14 / TEST-42 |
| 9-9 | rework で設定が外れた場合に古い snapshot が残り「今回未設定」と区別できない | must | D9 に削除仕様、EARS-15、TEST-30 |
| 9-10 | cross-check 表が DEP-01..06 の 6 列しかなく、宣言済みの DEP-07/08 が欠落 | must | §4.3 を 8×8 に修正 |
| 9-11 | `buildGateContext` に spawn を直接埋めず、純粋な `planExternalVerify()` と注入可能な runner に分離すべき | should | **採用**（D2） |
| 9-12 | `advance.ts` に `DEFAULT_GATES` を露出させるより `evaluateGatesForTriggerDetailed()` が小さい | should | **採用**（D9） |
| 9-13 | `TEST-13'`/`13''` は通常 ID に振り直すべき | should | **採用**（TEST-24 / TEST-25） |
| 9-14 | profile source/precedence、cwd 契約、親 `LANE_*` 上書き、全分類での state byte 不変、validate が snapshot を書かないこと等のテスト軸不足 | must | TEST-26/27/31/38/41 を追加 |

## 10. 実装レビュー（2026-08-29）の指摘と対応

設計レビューとは別に、実装完了後の独立レビュー。**Codex spend cap のため sol による実装レビューは
実行できておらず、これはその代替であって要求されたレビューそのものではない**（merge blocker として
残す）。

| # | 指摘 | 重大度 | 対応 |
|---|---|---|---|
| 10-1 | **認可した digest が「実行されるファイル」を固定していない**。`argv[1..]` は相対パス可・子の cwd は `process.cwd()` のため、checkout 外 profile の認可が別リポジトリで再利用され、そのリポジトリのスクリプトが実行される（実機再現） | **High** | **D1 を rev3 に改訂: digest に cwd を含める**。cwd は plan に載せて runner がそれを使う（認可した cwd と実行 cwd の乖離を構造的に防止）。TEST-44 / TEST-45 追加。修正後に同じ再現手順で「両方とも unauthorized・canary 空」を確認 |
| 10-2 | `validate.ts` の第2 trigger 呼び出しが `opts.externalVerify` を渡しておらず、**TEST-24 が構造上失敗できない**（注入 runner が第1呼び出しにしか届かない） | Medium | 第2 trigger にも options を渡す。実動作は元から正しく、守っていたのは core の TEST-25 と appliesTo マトリクス。回帰検知が効くようになった |
| 10-3 | CLI の TEST-06/20 のコメントが「fail-open 分類バグもカバー」と過大主張。実際は SIGKILL のため `status: 0` 経路に到達せず、その経路を守るのは core 側の1本のみ | Low | コメントを実態に合わせ、core 側のテストを「冗長ではない唯一の防壁」と明記 |
| 10-4 | `gate-check.ts` の生 NUL バイトで **git がこのファイルを binary 扱いし、本 PR の差分が読めない**（`Bin 5129 -> 8778 bytes`）。よりによって `resolveExternalVerify` が入っているファイル | Low | `\u0000` エスケープに置換（runtime 値は同一）。**既存バグだが、この PR のレビュー可能性を直接損なうため本 lane で対応**。別途 spec-lane #27 として起票済み |
| 10-5 | spec は `node:path` の `isAbsolute` と書いているが実装は `startsWith("/")` | Low | POSIX では等価・Windows は L6 で対象外。spec の記述を実装に合わせて訂正（D1 参照） |
| — | 観点3（分類順序）/ 観点4（snapshot）/ 観点5（後方互換）/ 観点2（二重起動）は**問題なし**と判定。改変注入13件中12件をテストが検知（生存は 10-2 の1件のみ） | — | — |
