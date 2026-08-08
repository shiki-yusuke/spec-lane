import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type LaneState, LaneStateSchemaV3, parseLaneState } from "@lane/schemas";

export function laneStatePath(specDir: string, intentId: string): string {
  return join(specDir, intentId, "lane-state.json");
}

export function laneStateExists(specDir: string, intentId: string): boolean {
  return existsSync(laneStatePath(specDir, intentId));
}

export function readLaneState(specDir: string, intentId: string): LaneState {
  const path = laneStatePath(specDir, intentId);
  const raw = JSON.parse(readFileSync(path, "utf-8"));
  return parseLaneState(raw);
}

/** Atomic write (tmp file + rename), matching the Python reference implementation's own state-write pattern. */
export function writeLaneState(specDir: string, intentId: string, state: LaneState): void {
  LaneStateSchemaV3.parse(state); // fail fast on an invalid write rather than persist it
  const path = laneStatePath(specDir, intentId);
  mkdirSync(join(path, ".."), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, path);
}
