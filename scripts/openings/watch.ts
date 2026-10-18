/**
 * Dev watcher: rebuilds opening artifacts when anything under
 * public/data/all-openings/** or public/data/annotations/** changes.
 * Keeps a replay cache across builds (only changed rows replay), never
 * crashes on bad data, and keeps the last good artifacts on errors.
 */
import chokidar from "chokidar";
import { basename } from "node:path";
import { ANNOTATIONS_DIR, STATS_FILE, TSV_DIR } from "./fsutil";
import { loadStats, printReport, readPrevious, runBuild, writeArtifacts } from "./artifacts";
import { ReplayCache } from "../../src/lib/openings-build/replay";
import { summarizeEntry } from "../../src/lib/openings-build/diff";
import type { BaselineRow } from "../../src/lib/openings-build/diff";

const DEBOUNCE_MS = 300;
const cache = new ReplayCache();
let previous: { rows: BaselineRow[]; outputHash: string } | null = readPrevious();
let timer: NodeJS.Timeout | null = null;
let running = false;
let again = false;
const changed = new Set<string>();

function rebuild(): void {
  if (running) {
    again = true;
    return;
  }
  running = true;
  const files = [...changed];
  changed.clear();
  const t0 = Date.now();
  try {
    const out = runBuild({ cache, previous });
    const ms = Date.now() - t0;
    if (!out.ok) {
      printReport(out, `[openings] ✗ rebuild failed after change to ${files.join(", ")} — keeping last good data`, ms);
    } else if (previous && out.outputHash === previous.outputHash) {
      console.log(`[openings] no dataset change (${ms} ms)`);
    } else {
      writeArtifacts(out);
      previous = { outputHash: out.outputHash, rows: out.graph.rows.map((r) => ({ rowId: r.rowId, name: r.name, eco: r.eco })) };
      const summary = out.changelogEntry ? summarizeEntry(out.changelogEntry) : "rebuilt";
      const steps = Object.entries(out.timingsMs).map(([k, v]) => `${k} ${v}`).join(", ");
      console.log(`[openings] ✓ ${summary} · ${out.counts.rows} rows · ${ms} ms [${steps}] (${out.outputHash.slice(0, 12)})`);
      for (const w of out.issues.filter((i) => i.level === "warning").slice(0, 5)) console.log(`[openings]   warn ${w.file ?? ""} ${w.message}`);
    }
  } catch (e) {
    console.error("[openings] ✗ watcher build crashed — keeping last good data\n", e);
  } finally {
    running = false;
    if (again) {
      again = false;
      schedule();
    }
  }
}

/** A delete is often the first half of an editor's atomic save: wait longer before rebuilding. */
const UNLINK_DEBOUNCE_MS = 1200;

function schedule(path?: string, delay = DEBOUNCE_MS): void {
  if (path) changed.add(path);
  if (timer) clearTimeout(timer);
  timer = setTimeout(rebuild, delay);
}

const watcher = chokidar.watch([TSV_DIR, ANNOTATIONS_DIR, STATS_FILE], {
  ignoreInitial: true,
  awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
  // test the file name only: a dot-folder anywhere above the repo must not hide everything
  ignored: (p: string) => /^\.|~$|\.swp$|\.tmp-\d+$/.test(basename(p)),
});
watcher.on("all", (event, path) => {
  if (path === STATS_FILE) loadStats(true);
  schedule(`${event}:${path.replace(/^.*public\/data\//, "")}`, event === "unlink" || event === "unlinkDir" ? UNLINK_DEBOUNCE_MS : DEBOUNCE_MS);
});
watcher.on("error", (e) => console.error("[openings] watcher error", e));
watcher.on("ready", () => {
  // warm the replay cache so the first edit is incremental too
  const t0 = Date.now();
  try {
    runBuild({ cache, previous });
  } catch {
    // a broken tree is reported on the first real rebuild
  }
  console.log(`[openings] watching public/data/all-openings and public/data/annotations (warm-up ${Date.now() - t0} ms)`);
  process.send?.("ready"); // tells scripts/openings/dev.ts it can start next dev
});
