import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveDataDir } from "@lane/core";
import {
  type CalibrationObservation,
  type CalibrationRecord,
  CalibrationRecordSchema,
} from "@lane/schemas";

// design.md §7.2 — calibration population lives under $LANE_DATA_DIR (runtime data, not
// committable). 1-record-1-file, matching knowledge's own storage convention (§2.8) for
// consistency; design.md did not specify a format for calibration storage explicitly.
export function calibrationDir(): string {
  return join(resolveDataDir(), "calibration");
}

export function calibrationRecordPath(recordId: string): string {
  return join(calibrationDir(), `${recordId}.json`);
}

export function calibrationRecordExists(recordId: string): boolean {
  return existsSync(calibrationRecordPath(recordId));
}

/** I-2026-10-15-cohort-producer (D8) -- the existing record with this id, if any, so
 * calibrate can refuse a re-run that would change an observation's cohort presence. */
export function readCalibrationRecord(recordId: string): CalibrationRecord | undefined {
  const path = calibrationRecordPath(recordId);
  if (!existsSync(path)) return undefined;
  return CalibrationRecordSchema.parse(JSON.parse(readFileSync(path, "utf-8")));
}

export function writeCalibrationRecord(record: CalibrationRecord): void {
  const validated = CalibrationRecordSchema.parse(record);
  mkdirSync(calibrationDir(), { recursive: true });
  writeFileSync(calibrationRecordPath(validated.record_id), JSON.stringify(validated, null, 2));
}

export function listCalibrationRecords(): CalibrationRecord[] {
  const dir = calibrationDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => CalibrationRecordSchema.parse(JSON.parse(readFileSync(join(dir, f), "utf-8"))));
}

export function listObservations(): CalibrationObservation[] {
  return listCalibrationRecords().filter(
    (r): r is CalibrationObservation => r.kind === "observation",
  );
}
