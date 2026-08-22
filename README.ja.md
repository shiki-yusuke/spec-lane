# spec-lane

AI支援開発の変更を、Intent（目的）から検証・完了まで段階的に進める
local-firstなdelivery workflowです。

[English README](./README.md) | [npm](https://www.npmjs.com/package/spec-lane) | [MIT](./LICENSE)

<!-- docs-sync: 2026-08-23 -->

英語の[README.md](./README.md)が正本です。この日本語版は逐語訳ではなく、初めて使う人が
5〜10分で全体像と安全な使い方を把握するための短縮版です。
英語READMEの変更がこの要約に影響する場合は、変更者が同じPRで両READMEの`docs-sync`日付も更新します。

```text
Intent -> Spec/Critic -> Implement -> Verify -> Done
```

## spec-laneとは

`spec-lane`は、AI coding agentを含む開発作業で、前提・受入条件・検証証拠・人間の判断を
明示的なartifactとして残し、変更を5つのphaseで進めるCLIです。npm package名は
`spec-lane`、コマンド名は`lane`です。

コードの品質を万能に判定するツールではありません。記録の欠落や不整合をmechanicalに
検出しつつ、内容の妥当性、risk判断、承認、PRのmergeは人間に残します。

## 何を防ぐためのツールか

| Check | 防ぎたい失敗 |
|---|---|
| Premise evidence | 実在を確認していない問題を前提に実装を始める |
| Dependency × Path cross-check | 横断的な変更で、考慮すべきpath・state・dependencyを見落とす |
| Success criteria matrix | Intentの成功条件に対応する実装・test・証拠がないままPRを出す |
| Spec consensus | Specとの差分を未解決のままにする、または確認後に変更されたSpec/検証を古い承認のまま扱う |

4つすべてが完全自動のCLI gateという意味ではありません。特にDependency × Pathは
skillと人間のreviewで運用する手順で、CLIは表の内容や網羅性を判定しません。

## 全体フローとartifact

phase名はCLI上では次の5つです。表は「そのphaseへ到達した時点で何が整っているか」を
示します。

| Phase | 状態 |
|---|---|
| `1_intent` | 目的、成功条件、scope、risk、premise evidenceを`intent.yaml`に記録する |
| `2_spec` | `spec.md`と`critic.yaml`を作成・reviewし、実装方針を固める |
| `3_implement` | 実装と対象repositoryのtestを完了する |
| `4_verify` | `verification.yaml`、success criteria matrix、spec consensusを整え、PRを開いて人間の判断を待つ |
| `5_done` | PRが実際にmergeされた後、その事実をlocal overlayへ記録する |

既定では、管理対象repositoryのrootから見て次の場所を使います。

```text
docs/spec/<intent-id>/
├── intent.yaml
├── spec.md
├── critic.yaml
├── verification.yaml
└── lane-state.json
```

`lane start`が`intent.yaml`と`lane-state.json`を作成します。残りは各phaseで作成します。
保存先は`--spec-dir`または`LANE_SPEC_DIR`で変更できます。

## Install

Node.js 22以上が必要です。

```bash
npm install -g spec-lane
lane --version
```

### 任意: Agent Skillsとして導入する

npm packageが導入するのは`lane` CLIであり、このrepositoryのagent向け手順は含みません。
対象projectのrootで、2つのskillをGitHubから別途導入できます。

```bash
# Codex
npx skills add shiki-yusuke/spec-lane --agent codex --skill lane --copy --yes
npx skills add shiki-yusuke/spec-lane --agent codex --skill lane-finish --copy --yes

# Claude Code（codexをclaude-codeへ変更）
npx skills add shiki-yusuke/spec-lane --agent claude-code --skill lane --copy --yes
npx skills add shiki-yusuke/spec-lane --agent claude-code --skill lane-finish --copy --yes
```

上記は2026-08-23に`skills` CLI 1.5.23で実測済みです。`npx skills`は第三者installerで、
導入時にはGitHubへ接続し、公式document上は匿名install telemetryが既定で有効です。必要なら
installerに`DISABLE_TELEMETRY=1`を設定してください。この手順はproject-localへcopyするため、
対象repositoryごとに実行します。導入後のspec-lane CLI自体はlocal-firstです。

基本workflowだけなら追加ツールは不要です。実token使用量や推定costを扱う
`lane calibrate`、`lane emit-metrics`、および`lane next`のCodex側の情報には、別projectの
[agent-cost](https://github.com/shiki-yusuke/agent-cost)が必要です。`agent-cost`をPATHに置くか、
対応commandへ`--agent-cost-bin <path>`を渡します。未導入でも、それ以外の`lane`機能は
利用できます。

source checkoutからのbuild方法は英語READMEの
[From source](./README.md#from-source-for-contributing-to-lane-itself)を参照してください。

## Quick Start

以下は、`lane`で管理したいrepositoryのrootで実行します。`lane start`が作る
`intent.yaml`にはschema-validなplaceholderも含まれるため、必ず実際の目的・成功条件・scopeに
書き換えてください。

```bash
# 1. Intentを開始する
lane start I-2026-01-15-my-first-change \
  --business-goal "Reduce onboarding friction in the setup flow." \
  --user-visible-intent "New users see setup steps in the right order." \
  --primary-user "new_user" \
  --risk low

# intent.yamlへsuccess、scope、premise_evidenceを記録した後に診断する
lane validate I-2026-01-15-my-first-change

# 2. spec.mdとcritic.yamlを作成・reviewした後にSpec phaseへ進める
lane validate I-2026-01-15-my-first-change
lane advance I-2026-01-15-my-first-change --phase 2_spec

# 3. 実装とrepository固有のtestを完了した後に進める
lane advance I-2026-01-15-my-first-change --phase 3_implement

# 4. verification.yamlとsuccess_criteria_matrixを作成する
# 現在のspec.mdとverification.yamlに対するdigestを更新する
lane consensus I-2026-01-15-my-first-change --refresh \
  --spec-ssot-ref docs/spec/I-2026-01-15-my-first-change/spec.md

# 実際のreview後、そのreviewerによる確認を記録する
lane consensus I-2026-01-15-my-first-change --ack \
  --reviewer-kind human --reviewer-id reviewer-name

lane validate I-2026-01-15-my-first-change
lane advance I-2026-01-15-my-first-change --phase 4_verify

# PRを開いた後、任意でagent-metrics:v1 markerをPR commentへupsertする
lane emit-metrics I-2026-01-15-my-first-change --post --pr 1

# 5. PRが実際にmergeされた後だけDoneを記録する
lane advance I-2026-01-15-my-first-change --phase 5_done \
  --merged-at 2026-01-16T09:00:00Z \
  --pr-url https://github.com/you/your-repo/pull/1
```

`--reviewer-kind`は`self`、`independent_agent`、`human`のいずれかです。例の`human`は、
実際に人間がreviewした場合だけ使ってください。`--ack`はreviewを実行するcommandではなく、
誰がどの内容を確認したかを記録するcommandです。各flagは`lane <command> --help`で確認できます。

## 主要なgate

### Premise evidence

Specを書く前に、変更の前提となる問題が実在するかをlive observation、既存data、または最低限の
static code traceで確認し、`intent.yaml`へ記録します。

CLIはrecordのschemaや最低限のshapeを検査し、`required: true`かつ`reproduced: false`なら
`2_spec`への遷移をblockします。一方、記録がない場合はwarningであり、証拠の内容が真実か、
そもそも確認が必要な変更かまでは証明しません。

### Dependency × Path cross-check

新しいdependency・state・guard・完了条件を導入する変更や、同じresourceを複数pathが扱う変更では、
`spec.md`にDependency × Pathの表を作り、未参照・不明な組み合わせをnamed testへ落とします。

適用対象または判断が不明な場合は、実装前に表、test mapping、軸の選び方について明示的な
human approvalが必要です。`lane validate`はこの表の内容、軸の妥当性、網羅性を検査しません。
完成した表も完全性の証明にはなりません。

### Success criteria matrix

`verification.yaml`の`success_criteria_matrix`で、`intent.yaml`の`intent.success`各行を
最終diff、test、証拠、negative caseと対応付けます。

CLIの対応判定は、markdown装飾や空白を正規化したうえでの全文一致です。LLMによる意味的な
類似判定ではありません。matrix自体がない場合はwarningに留まり、matrixに対応行がない場合や
`covered_by: none`はerrorになります。行が存在しても、testや証拠の意味的な十分性までは
自動検証しません。

### Spec consensus

`lane consensus --refresh`は、現在の`docs/spec/<intent-id>/spec.md`の内容と、
`verification.yaml`から`spec_consensus`自身を除いたcanonical contentをSHA-256 digestへ結び付けます。
`--spec-ssot-ref`は参照元を記録する値であり、その引数先の任意fileをhashする指定ではありません。

`--ack`は、そのdigestに対するreviewerの確認を記録します。`spec.md`または対象となる
`verification.yaml`の内容を変更するとackは無効になります。未解決deviationもblock対象です。
`critic.yaml`はdigest対象ではありません。digest一致は「確認後に対象内容が変わっていない」ことを
示しますが、Specの正しさやreviewの質は証明しません。

## Design-critic track（opt-in pilot）

`lane start --design`は、「何を作るか」という設計選択自体がriskになるlane向けに、
別track（activation経路)を有効化します。**default onではなく**、`--design`を渡さない限り
一切gateされません。また、promoteされる前に本当に効果があるか計測されます（reviewの結果
決定が変わったか、review が想定外のfalsifierを見つけたか）— 詳細は
`docs/spec/I-2026-08-18-design-critic-injection/spec.md`。

**既存の`critic.yaml`とは別物です。** `critic.yaml`は既存の9-lens **spec critic**で、
「これから実装するspec」をreviewし、self-authoredも許容され、spec phaseで一度だけ書かれます。
design-critic trackは、spec draft前の**design options**（`lane design submit`が作るartifact）を
reviewし、誰がoptionsを形作り誰がreviewしたかをstructured engine referenceとして記録したうえで、
独立性の分類を**機械的に導出**します — producer自身の独立性の主張は一切受理しません。
命名・state field・gateのいずれも意図的に分離しています。

`lane design status`は、bareなcountを出す前に必ずper-optionのcoverageと各reviewの導出結果
（reasons付き）を表示し、*total* reviewと*qualifying* reviewを別々に報告します。
establishmentはoverride可能（`lane design override`）ですが、これは明示的でscope付きの
独立した操作であり、自分がauthorするartifactのfieldを編集するだけでは成立しません。
overrideの結果は常に**operator-asserted**（human-verifiedではない）と報告されます。

**残余riskを明示すると:** これらの仕組みは、reviewが指定engineへ実際に届いたこと、そのengineが
他のcontextを持たなかったこと、あるいは導出された分類が正しいことを一切証明しません。
記録された内容から分類を導出しているだけです。`lane`はどちらのcriticについてもmodelを
起動しません — 人間かwrapper scriptがreviewを実行し、結果をlaneに渡します。

**Vendoringした依存とpin検証。** 独立性の導出ロジックと`design-options/v1`のdocument形状は、
外部のcontracts repoからvendoringしています
（`packages/core/src/vendor/derive-independence/`、
`packages/schemas/test/fixtures/design-options/`）。それぞれ upstream commit と tree hash を
`UPSTREAM`マーカーに記録しています。tree hashの一致検証はどの環境でも常に実行されますが、
「このpinがupstreamの`main`に対してまだ解決できるか」という検証はupstream repoのlocal
checkoutを必要とするため、**本repo自身のCIでは必須**（`.github/workflows/ci.yml`）ですが、
それ以外の環境（配布されたnpmパッケージの利用者含む）では**opt-in**のままです —
`LANE_UPSTREAM_PLAYBOOK_PATH`にlocal checkoutを指定すると実行され、未指定なら
false passにはならず「unknown」と報告されます。

## `lane validate`と`lane advance`の違い

- `lane validate <intent-id>`は早期feedback用です。現在のartifactに対して、現在phaseからの
  次のforward transitionと`before_pr_publish`に適用されるgateを診断します。phaseは遷移しません。
- `lane advance <intent-id> --phase <phase>`はphase transitionを行います。遷移直前に、その遷移へ
  適用されるgateを同じdisk上のartifactで再評価するmechanical backstopです。
- `warning`は表示されますが遷移をblockしません。`error`は遷移をblockし、gate error時の
  `lane-state.json`は変更されません。

したがって、`validate`を通した記憶に頼らず、`advance`時点のartifactが再評価されます。ただし、
Dependency × Pathのhuman-review手順のようにCLI gateではない判断まで`advance`が代行するわけでは
ありません。

## AI coding agentと使う

Claude Code、Codexなど、local fileとCLIを扱えるcoding agentと組み合わせられます。agentには
次のskillを読ませてください。

- [`skills/lane/SKILL.md`](./skills/lane/SKILL.md) — Intent開始からPhase 4の検証・PR作成まで
- [`skills/lane-finish/SKILL.md`](./skills/lane-finish/SKILL.md) — merge確認後だけ行うPhase 5のcloseout

これらはagentが直接たどれる手順と停止条件です。特別なClaude Code/Codex専用APIではありません。
再開時は`lane status <intent-id>`で現在phaseを確認し、human approval、high-risk判断、PR mergeを
agentが推測で済ませないようにします。Phase 1〜4用skillはPR作成で停止し、Phase 5は利用者が
実際のmergeを確認した後だけ実行します。

## 自動で保証すること／しないこと

`spec-lane`がmechanicalに行うのは、schema検査、許可されたphase transitionの確認、適用gateの
errorによる遷移block、success criteriaの正規化全文対応、spec consensusのdigest照合などです。
失敗した`advance`でphase stateを途中まで進めることもありません。

一方、次は保証しません。

- premise evidenceの記述が真実か、または十分に強いか
- Dependency × Pathの軸・path・dependency・testが完全か
- success criteria matrixが変更の意味的な正しさを網羅しているか
- Spec、実装、test、Criticの品質全体
- `reviewer_ack`の前に十分なreviewが本当に行われたか
- human approval、risk判断、PR mergeなどの人間の意思決定

このprojectはpre-1.0です。minor release間のbreaking changeがあり得るため、更新時は
[CHANGELOG.md](./CHANGELOG.md)も確認してください。

## Related projects

いずれも独立して利用でき、`spec-lane`の必須dependencyではありません。

- [agent-cost](https://github.com/shiki-yusuke/agent-cost) — Claude Code / Codex CLIのlocal logから
  token使用量と推定costを計測します。
- [evigate](https://github.com/shiki-yusuke/evigate) — coding agentの完了申告を、command実行や
  file編集などのexecution evidenceと照合します。
- [acyclic-eval](https://github.com/shiki-yusuke/acyclic-eval) — case生成時に対象Judgeを参照しない
  mutationで、verifier / judge自体を評価します。
- [agent-metrics-harvester](https://github.com/shiki-yusuke/agent-metrics-harvester) —
  `agent-metrics:v1` markerを検証・収集し、JSONL / SQLiteへ保存します。同repositoryの
  `agent-metrics-report`が集計を担当します。
- [ai-agent-skills-playbook](https://github.com/shiki-yusuke/ai-agent-skills-playbook) — 再利用可能な
  skillと、`agent-metrics:v1`など外部protocolの正本を保持します。

役割をまとめると、`agent-cost`がusage / costを測り、`spec-lane`がdelivery workflowと活動の
帰属・optionalなmetrics emitを制御し、`agent-metrics-harvester`が収集・保存します。`evigate`は
agentの申告を実行証拠で検証し、`acyclic-eval`はそのようなverifier / judge自体を評価します。

## 詳細仕様

初回利用には上記で十分です。次のadvanced topicsは日本語版へ複製していません。

- measurement、trace ledger、session attribution、`estimate/v2`、agent-metrics protocol:
  [英語READMEのmeasurement sections](./README.md#agent-metrics-emission)
- estimate / calibrate、`lane next`、knowledge DB:
  [The four evolved features](./README.md#the-four-evolved-features)
- data directory、profile、privacy、開発方法:
  [Configuration](./README.md#configuration)
- 詳細なschema・gate・architecture:
  [`docs/design.md`](./docs/design.md)
- releaseごとの差分と既知の制約:
  [`CHANGELOG.md`](./CHANGELOG.md)

## License

[MIT](./LICENSE)
