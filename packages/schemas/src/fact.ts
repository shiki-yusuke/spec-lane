import { z } from "zod";

// design.md §4 — agent-cost's facts.py Fact type re-declared as a lane-side contract.
// lane never imports agent-cost as a package (sol 裁定, §4.1); it calls the agent-cost
// CLI as a subprocess and validates its JSON stdout against this schema line-by-line.
export const FactSchema = z.object({
  occurred_at_utc: z.string().datetime(),
  agent: z.enum(["claude", "codex"]),
  session_id: z.string().nullable(),
  model_key: z.string(),
  token_kind: z.enum([
    "input_nocache",
    "cache_read",
    "cache_write_5m",
    "cache_write_1h",
    "cache_write_unknown",
    "output",
  ]),
  tokens: z.number().int().nonnegative(),
  mode: z.enum(["fast", "normal", "unknown"]).default("unknown"),
  source_quality: z
    .enum(["ok", "first_event_delta", "identity_missing", "output_lower_bound"])
    .default("ok"),
});
export type Fact = z.infer<typeof FactSchema>;
