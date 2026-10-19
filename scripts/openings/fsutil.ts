/** Node-side helpers for the openings scripts: paths, file walking, atomic writes. */
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { SourceFile } from "../../src/lib/openings-build/types";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const DATA_DIR = join(ROOT, "public", "data");
export const TSV_DIR = join(DATA_DIR, "all-openings");
export const ANNOTATIONS_DIR = join(DATA_DIR, "annotations");
export const DERIVED_DIR = join(ROOT, "data", "derived");
export const CACHE_DIR = join(ROOT, "data", "cache");
export const STATS_FILE = join(DERIVED_DIR, "position-stats.v1.json.gz");
export const STATS_META_FILE = join(DERIVED_DIR, "position-stats.v1.meta.json");

const toPosix = (p: string) => p.split(sep).join("/");

/** Recursively read every file under `dir`, sorted by POSIX path relative to `base`. */
export function readTree(dir: string, base: string = DATA_DIR): SourceFile[] {
  const out: SourceFile[] = [];
  const walk = (d: string) => {
    let entries: string[];
    try {
      entries = readdirSync(d).sort();
    } catch {
      return; // missing folder = no files
    }
    for (const name of entries) {
      if (name.startsWith(".")) continue; // editor swap/lock files
      const full = join(d, name);
      const st = statSync(full, { throwIfNoEntry: false });
      if (!st) continue;
      if (st.isDirectory()) walk(full);
      else if (st.isFile()) out.push({ path: toPosix(relative(base, full)), text: readFileSync(full, "utf8") });
    }
  };
  walk(dir);
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Write via tmp + rename so readers never observe a partial file. */
export function writeAtomic(file: string, data: string | Uint8Array): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, data);
  renameSync(tmp, file);
}
