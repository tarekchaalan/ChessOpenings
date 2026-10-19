/** Back up and restore the data folder so E2E edits never leak into git. */
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

export const ROOT = join(__dirname, "..");
export const DATA = join(ROOT, "public", "data");
export const TSV_DIR = join(DATA, "all-openings");
const BACKUP = join(ROOT, "test-results", ".data-backup");
const FILES = ["openings.v2.json", "openings.v2.meta.json", "openings.changelog.json", "legacy-map.v1.json"];
// the watcher also rewrites the previous build's line ids (course deltas)
const DERIVED = join(ROOT, "data", "derived", "course-lines.v2.json");

export function backupData(): void {
  rmSync(BACKUP, { recursive: true, force: true });
  mkdirSync(BACKUP, { recursive: true });
  cpSync(TSV_DIR, join(BACKUP, "all-openings"), { recursive: true });
  for (const f of FILES) if (existsSync(join(DATA, f))) cpSync(join(DATA, f), join(BACKUP, f));
  if (existsSync(DERIVED)) cpSync(DERIVED, join(BACKUP, "course-lines.v2.json"));
}

/**
 * Restore the TSVs first, give a still-running dev watcher time to react,
 * then restore the artifacts last so the watcher's rebuild can't win.
 */
export async function restoreData(settleMs = 3000): Promise<void> {
  if (!existsSync(BACKUP)) return;
  rmSync(TSV_DIR, { recursive: true, force: true });
  cpSync(join(BACKUP, "all-openings"), TSV_DIR, { recursive: true });
  await new Promise((r) => setTimeout(r, settleMs));
  for (const f of FILES) if (existsSync(join(BACKUP, f))) cpSync(join(BACKUP, f), join(DATA, f));
  if (existsSync(join(BACKUP, "course-lines.v2.json"))) cpSync(join(BACKUP, "course-lines.v2.json"), DERIVED);
}
