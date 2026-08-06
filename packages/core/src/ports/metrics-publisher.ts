// design.md §4.5 — MP-3 review: a new port rather than extending VcsAdapter (ports/vcs.ts)
// or TrackerAdapter (adapters/src/tracker/github.ts's annotatePr). Both were considered
// and rejected in the spec's own dependency/path cross-check: VcsAdapter growing a
// comment-posting method was explicitly out of scope, and TrackerAdapter.annotatePr
// already posts PR comments but always creates a new one (no upsert-by-identity) —
// reusing it would mean either bolting upsert semantics onto a method three other callers
// depend on, or silently not upserting. TelemetryAdapter (ports/telemetry.ts) stays
// read-only; this port is the write side agent-metrics needs, and only that.
export interface MetricsPublishTarget {
  repository: { provider: string; id: string };
  prNumber: number;
}

export interface MetricsPublishResult {
  action: "created" | "updated";
  url: string;
}

export interface MetricsPublisher {
  /**
   * Posts `marker` (an already-serialized `<!-- agent-metrics:v1 ... -->` HTML comment
   * string) to the target PR. Implementations MUST search existing comments for one whose
   * decoded-and-verified payload's own recomputed upsert_key matches `marker`'s, and update
   * that comment in place if found (upsert), never posting a second comment for the same
   * identity (protocol doc section 5's snapshot-replacement semantics; agent-metrics-v1.md
   * section 10's "MUST treat a payload with an already-seen upsert_key as a correction").
   */
  upsert(marker: string, target: MetricsPublishTarget): Promise<MetricsPublishResult>;
}
