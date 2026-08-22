# 計測の帰属に関する注記

この lane には CalibrationObservation を記録しない (lane calibrate 未実行)。

## 理由 (D2: mixed session の按分禁止 / 1 session = 1 task)

- オーケストレーション側セッション `49419e6e-...` は同日に I-shadow (CLI-1925) /
  Phase E (release-evidence 一式) / cohort-2 凍結 / estimate abstain 配線 / 本 lane を
  すべて跨いだ mixed session
- builder サブエージェントのセッション `agent-alane-builder-af33c101...` も、
  estimate abstain 配線 (PR #21、lane 非管理) と本 lane (PR #22) の**2タスクを跨いだ mixed**
- どちらを使っても過大計上になり、按分は禁止されている

## 教訓

専従セッションを立てれば帰属できた。次に lane を回すときは
「1 lane = 1 builder セッション」で起動する (タスク定義を分けるだけで達成できる)。
なお本 lane では lane estimate を実行し忘れた — abstain 配線 (#21) が入った直後で、
INSUFFICIENT_POPULATION の abstained revision を実タスクで初使用する機会だった。
次の lane で使う。
