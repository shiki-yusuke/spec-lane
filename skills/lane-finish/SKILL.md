---
name: lane-finish
description: Delivery lane orchestrator's post-merge-only closeout (Phase 5, Done). Use once the user has confirmed a PR actually merged — records the local done overlay (advance --phase 5_done) and closes the estimate/calibrate loop by measuring what the work actually cost. Triggers: "PR merged, close this out", "lane done", "finish this lane". Never use before merge or mid-review — Phase 1-4 and PR creation are `lane`'s job.
---

# Lane Finish (Phase 5)

## When to use this

- The user has said the PR is merged (not "approved", not "ready" — actually merged).
- "lane done" / "close this lane out" / "PR merged, finish it"

## The done overlay (why this matters)

- **Merging is the done signal**, not a separate action. `lane advance --phase 5_done`
  never rewrites `docs/spec/<intent-id>/lane-state.json`'s `current_phase` in place — it
  only writes a **local overlay** (`$LANE_DATA_DIR/done/...`, XDG data dir, outside the
  repo). The in-repo lane-state.json's last real state stays at `4_verify` (verified +
  PR submitted) — that's correct, not a bug; no post-merge commit back to the repo is
  needed.
- `lane status` reads the overlay and reports the lane as done even though the in-repo
  file never changed.

## Steps

1. Confirm the PR actually merged and get the real merge time + URL + merge commit:
   `gh pr view <pr-number> --json mergedAt,url,mergeCommit`.
2. Run `lane advance <intent-id> --phase 5_done --merged-at <mergedAt ISO8601> --pr-url <url> --merge-sha <mergeCommit.oid>`.
   - `--merged-at` is required — cycle time is measured from the real merge time, not
     whenever this command happens to run.
   - This re-checks the spec_consensus gate one last time (same check `lane validate` ran
     at 4_verify). If spec_consensus was never ack'd, this fails with `Gate failed: ...` —
     go back, run `lane consensus <intent-id> --ack ...` (or `--refresh`/`--resolve-deviation`
     first if content changed since the last ack), then retry.
3. **Close the estimate/calibrate loop** (design.md §5.1) — this is the whole point of
   having an estimator: `lane calibrate <intent-id> --session-id <id> [--session-id <id> ...]`
   with the real Claude/Codex session id(s) from this lane's work. This records a
   `CalibrationObservation` **and** a `scope:"lane"` `cost_ledger` entry from the same
   measurement (design.md §2.5) — the latter is what `lane emit-metrics` actually reads,
   so running calibrate here is also what makes a later `--post` (step 3.5) report real
   numbers instead of `no_data`. Since the done overlay from step 2 already exists at
   this point, the ledger entry is written into the overlay (not in-repo
   `lane-state.json`) — this step never needs a post-merge commit back to the repo. If a
   baseline estimate was adopted at Phase 1, this also records a `prediction_evaluation`
   scoring that estimate against what actually happened — feeding the k-NN population for
   future estimates. Optionally pass `--files-touched-observed <n>` (the actual diff file
   count) for a more complete predictor record.
3.5. Optionally, `lane emit-metrics <intent-id> --post` posts this lane's measured
   token-usage snapshot to the PR as a standardized `agent-metrics:v1` marker (design.md
   §5.5) — useful if anything downstream (a harvester, a dashboard) is collecting these.
4. Report to the user: done overlay recorded, calibration observation written, and (if a
   baseline existed) how the prediction compared to reality.

## Batch closeout for multiple lanes

There's no batch/sync command in v1 — finish each lane individually with the steps above.
If several lanes merged around the same time, just repeat step 1-3 per lane.

## What this skill does *not* do

- No issue-tracker status update (no Linear/Jira/GitHub-Issues integration is wired to any
  CLI command in v1 — TrackerAdapter exists as a port but nothing calls it yet). Update
  your own tracker manually if you use one.
- No PR body editing, no external dashboard integration — v1 deliberately scopes this out
  (design.md §5.3/§8). `lane emit-metrics --post` (step 3.5 above) can post a standardized
  usage snapshot to the PR, but this skill's own flow doesn't require it.

## Troubleshooting

| symptom | what to do |
|---|---|
| `Invalid transition: 4_verify -> 1_intent` (or similar) | `lane status` to see what phase the lane is actually at; something advanced unexpectedly |
| `Gate failed: spec_consensus is not filled in` | run `lane consensus <intent-id> --refresh --spec-ssot-ref <ref>` first |
| `Gate failed: N unresolved deviation(s)` | `lane consensus <intent-id> --resolve-deviation <spec-ref> --rationale "..."` for each, then ack |
| `Gate failed: content changed since last --refresh` | spec.md or verification.yaml changed since the last `--refresh`/`--ack` — re-run `--refresh`, re-review, then `--ack` again |
| `Lane is already 5_done (local overlay: ...)` | already finished; nothing to do |
| PR not actually merged yet | don't run this skill — wait for the user to confirm the merge |

## Trigger keywords

- "lane done" / "close this lane out" / "PR merged, finish it"
- "Phase 5"
