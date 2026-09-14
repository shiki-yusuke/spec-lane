ack 不可

## 1. success_criteria_matrix

指定資料の `test_matrix` 上で照合した判定です。

- **S1 不十分** — `verification.yaml:585-599` → telemetry adapter の pass-through と `calibrate` が書く ledger entry の永続化テストを指しておらず、negation も usage-import の `"unknown"` omission だけ → `agent-cost-basis-fields.test.ts` の pass-through を追記し、`calibrate.test.ts` で 0.2.0 の両値および 0.1.x の `"unknown"`/`null` を assert。既存なら参照追記、なければ追加。
- **S2 記録修正後は十分** — `verification.yaml:600-622` → `packages/core/ test/...` と `packages/core/test/ attribution-projection...` は実在パスを指さない → 空白を除去し、RULE-06/07/09/11、TEST-46/47、D14 recovery の正確なテスト名を記載。否定根拠の内容自体は十分。
- **S3 十分** — `verification.yaml:623-638` → TEST-19/48 が pre-change の silent overwrite を落とし、TEST-20 と supersession unit tests が identity・history を押さえている。
- **S4 不十分** — `verification.yaml:639-659` → パス誤記に加え、TEST-64 は template/free-text drift しか否定せず、entry・observation・estimate 出力からの reason 欠落や estimate/v2 contract の非version-upを落とせない → TEST-16/17、RULE-12、TEST-24 を negation に明記し、estimate/v2 の既存 envelope/version を固定するテストを追加または参照。
- **S5 内容は十分、記録は要更新** — `verification.yaml:660-682` → TEST-02 は required 化を確実に落とす。ただし CLI 件数が `MV-04` では369、S5 evidenceでは370、親側最終状態では371 → `verification.yaml:535-537,668-671` を最終結果「371」に統一。

## 2. deviations

- overlay のプロセス間ロック未実装: **accept の rationale は妥当**。単一operator前提、既存race、導入した部分書込み経路は除去済み、lock は allowed paths 外、という受容境界が明示されている。
- TEST-44 の pin 出典: **accept の rationale は妥当**。byte-identity の独立証明ではない点を隠しておらず、TEST-38/51 の直接assertを主根拠に降格している。
- **記録漏れ1件**: `spec.md:1022-1024` は intent が「2件」で「Four more」と記す一方、`intent.yaml:76-110` は9件、`verification.yaml:683-704` は解消済みと断定している。spec の stale 文言を9件に合わせて修正するか、未解消 deviation として記録が必要。
- 親側最終状態を前提とすれば、`sol-impl-review-3.md:29-31` の usage-import 順序条件は解消済み。他の実装差は指定範囲からは確認されない。

## 3. ack 条件

- S1/S4 の不足、S2 の参照誤記、S5/MV-04 の件数を修正する。
- `spec.md:1022-1024` の不整合を修正または deviation 化し、文書変更後に consensus を `--refresh` する。
- `lane validate` green を再確認後、指定の independent ack を実行する。現時点では打たない。