import { effectiveLedger } from "@lane/core";
import type { LaneState } from "@lane/schemas";

/**
 * Every session_id referenced anywhere in one lane's *effective* cost_ledger (in-repo +
 * done-overlay delta composed, per done-overlay.ts's own effectiveLedger) -- the only
 * cross-reference `lane attribution audit`'s v1 orphan_usage detection can make against a
 * lane's own recorded usage (M0 spec §4).
 */
export function effectiveLedgerSessionIds(
  specDir: string,
  intentId: string,
  state: LaneState,
): string[] {
  const ids = new Set<string>();
  for (const entry of effectiveLedger(specDir, intentId, state)) {
    for (const id of entry.session_ids) ids.add(id);
  }
  return [...ids];
}
