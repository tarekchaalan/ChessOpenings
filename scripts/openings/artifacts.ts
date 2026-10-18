/**
 * Shared Node adapter: gathers build inputs from disk and writes artifacts
 * atomically (dataset → legacy map → changelog → meta last, so a client that
 * sees a new meta hash can always fetch the matching dataset).
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import { join } from "node:path";
import {
  ANNOTATIONS_DIR,
  DATA_DIR,
  DERIVED_DIR,
  ROOT,
  STATS_FILE,
  TSV_DIR,
  readTree,
  writeAtomic,
} from "./fsutil";
import { buildOpenings, formatIssue, type BuildInput, type BuildOutput } from "../../src/lib/openings-build/build";
import { CHANGELOG_KEEP, type BaselineRow, type Changelog } from "../../src/lib/openings-build/diff";
import type { RawDatasetV2 } from "../../src/lib/openings-build/dataset";
import type { V1Opening } from "../../src/lib/openings-build/legacy";
import type { PositionStats } from "../../src/lib/openings-build/types";
import { ReplayCache } from "../../src/lib/openings-build/replay";
import { ExtCache } from "../../src/lib/openings-build/extension";
import type { CourseMemo } from "../../src/lib/openings-build/memo";
import { HUBS } from "../../src/content/hubs";

export const OUT = {
  dataset: join(DATA_DIR, "openings.v2.json"),
  meta: join(DATA_DIR, "openings.v2.meta.json"),
  changelog: join(DATA_DIR, "openings.changelog.json"),
  legacy: join(DATA_DIR, "legacy-map.v1.json"),
  courseLines: join(DERIVED_DIR, "course-lines.v2.json"),
  v1: join(DATA_DIR, "openings.v1.json"),
};

export interface Meta {
  format: "chess-openings-trainer/meta@2";
  lib: string;
  inputHash: string;
  outputHash: string;
  bytes: number;
  gzipBytes: number;
  statsSha: string | null;
  counts: BuildOutput["counts"];
  issues: BuildOutput["issues"];
  unassigned: { rowId: string; name: string; reason: string }[];
  coverage: Record<string, number> | null;
  hubCoverage: { slug: string; rows: number; covered: number }[];
  timingsMs: Record<string, number>;
}

export const nodeSha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

/**
 * Code that shapes the artifacts: the pure build library and the curated hub
 * config. Editing either makes the committed artifacts stale (check fails,
 * predev/prebuild rebuild), not just TSV edits.
 */
export function codeHash(): string {
  const files = [
    ...readTree(join(ROOT, "src", "lib", "openings-build"), ROOT).filter((f) => f.path.endsWith(".ts") && !f.path.includes("__tests__")),
    ...readTree(join(ROOT, "src", "content"), ROOT).filter((f) => f.path.endsWith("hubs.ts")),
  ];
  return nodeSha256(files.map((f) => `${f.path}\u0000${nodeSha256(f.text)}`).join("\n"));
}

let statsCache: { sha: string; stats: PositionStats } | null | undefined;

export function loadStats(force = false): { sha: string; stats: PositionStats } | null {
  if (statsCache !== undefined && !force) return statsCache;
  if (!existsSync(STATS_FILE)) return (statsCache = null);
  const gz = readFileSync(STATS_FILE);
  statsCache = {
    sha: createHash("sha256").update(gz).digest("hex"),
    stats: JSON.parse(gunzipSync(gz).toString("utf8")) as PositionStats,
  };
  return statsCache;
}

export function readInputs(): Pick<BuildInput, "tsvFiles" | "annotationFiles"> {
  return {
    tsvFiles: readTree(TSV_DIR),
    annotationFiles: readTree(ANNOTATIONS_DIR),
  };
}

let v1Cache: V1Opening[] | null | undefined;
export function loadV1(): V1Opening[] | null {
  if (v1Cache !== undefined) return v1Cache;
  if (!existsSync(OUT.v1)) return (v1Cache = null);
  return (v1Cache = (JSON.parse(readFileSync(OUT.v1, "utf8")) as { openings: V1Opening[] }).openings);
}

export function readMeta(): Meta | null {
  try {
    return JSON.parse(readFileSync(OUT.meta, "utf8")) as Meta;
  } catch {
    return null;
  }
}

/** Previous build's rows (the changelog baseline), from the committed dataset. */
export function readPrevious(): { rows: BaselineRow[]; outputHash: string; courseLines?: Record<string, string[]> } | null {
  const meta = readMeta();
  if (!meta || !existsSync(OUT.dataset)) return null;
  try {
    const ds = JSON.parse(readFileSync(OUT.dataset, "utf8")) as RawDatasetV2;
    let courseLines: Record<string, string[]> | undefined;
    try {
      courseLines = JSON.parse(readFileSync(OUT.courseLines, "utf8")) as Record<string, string[]>;
    } catch {
      courseLines = undefined;
    }
    return {
      outputHash: meta.outputHash,
      rows: ds.rows.map((r) => ({ rowId: r[0], eco: r[1] || null, name: r[2] })),
      courseLines,
    };
  } catch {
    return null;
  }
}

export function runBuild(
  opts: { cache?: ReplayCache; extCache?: ExtCache; courseMemo?: CourseMemo; previous?: BuildInput["previous"]; skipLegacy?: boolean } = {}
): BuildOutput {
  const stats = loadStats();
  return buildOpenings({
    ...readInputs(),
    stats: stats?.stats ?? null,
    statsSha: stats?.sha ?? null,
    v1Openings: loadV1(),
    previous: opts.previous === undefined ? readPrevious() : opts.previous,
    cache: opts.cache,
    extCache: opts.extCache,
    courseMemo: opts.courseMemo,
    skipLegacy: opts.skipLegacy,
    hubDefs: HUBS,
    codeHash: codeHash(),
    hasher: nodeSha256,
  });
}

export function writeArtifacts(out: BuildOutput): Meta {
  const gz = gzipSync(out.datasetJson, { level: 9 });
  writeAtomic(OUT.dataset, out.datasetJson);
  if (out.legacyMap) writeAtomic(OUT.legacy, JSON.stringify(out.legacyMap));
  writeAtomic(OUT.courseLines, JSON.stringify(out.courseLines) + "\n");
  if (out.changelogEntry) {
    let log: Changelog = { format: "chess-openings-trainer/changelog@1", entries: [] };
    try {
      log = JSON.parse(readFileSync(OUT.changelog, "utf8")) as Changelog;
    } catch {
      // first build
    }
    // keep the newest entries, but never drop the v1-baseline entry (fromHash null)
    const baseline = log.entries.filter((e) => e.fromHash === null).slice(-1);
    const recent = [out.changelogEntry, ...log.entries.filter((e) => e.fromHash !== null)].slice(0, CHANGELOG_KEEP - baseline.length);
    log.entries = [...recent, ...baseline];
    writeAtomic(OUT.changelog, JSON.stringify(log, null, 1) + "\n");
  }
  const meta: Meta = {
    format: "chess-openings-trainer/meta@2",
    lib: out.dataset.lib,
    inputHash: out.inputHash,
    outputHash: out.outputHash,
    bytes: out.datasetJson.length,
    gzipBytes: gz.length,
    statsSha: loadStats()?.sha ?? null,
    counts: out.counts,
    issues: out.issues,
    unassigned: out.catalog?.unassigned ?? [],
    coverage: out.catalog ? { ...out.catalog.coverage, hubs: out.catalog.hubs.length, courses: out.catalog.courses.length } : null,
    hubCoverage: out.catalog ? out.catalog.hubReport.map((h) => ({ slug: h.slug, rows: h.rows, covered: h.covered })) : [],
    timingsMs: out.timingsMs,
  };
  writeAtomic(OUT.meta, JSON.stringify(meta, null, 2) + "\n");
  return meta;
}

export function printReport(out: BuildOutput, label: string, ms: number, verbose = false): void {
  const c = out.counts;
  const lines = [
    `${label}: ${c.rows} rows from ${c.files} file(s) → ${c.positions} positions, ${c.theoryMoves} theory moves` +
      ` · ${c.errors} error(s), ${c.warnings} warning(s) · ${ms} ms`,
  ];
  const errors = out.issues.filter((i) => i.level === "error");
  const warnings = out.issues.filter((i) => i.level === "warning");
  if (errors.length) {
    lines.push("┌─ errors " + "─".repeat(60));
    for (const i of errors) lines.push("│ " + formatIssue(i));
    lines.push("└" + "─".repeat(69));
  }
  const cat = out.catalog;
  if (cat) {
    const cv = cat.coverage;
    const kinds = cat.hubs.reduce<Record<string, number>>((a, h) => ((a[h.kind] = (a[h.kind] ?? 0) + 1), a), {});
    const top = cat.catalog.hubs.filter((h) => h.placement === "top").length;
    lines.push(
      `  hubs ${cat.hubs.length} (curated ${kinds.curated ?? 0}, auto ${kinds.auto ?? 0}, sibling ${kinds.sibling ?? 0}; top-level ${top}, offbeat ${cat.hubs.length - top})` +
        ` · systems ${cat.systems.length} (variants ${cv.variants}) · lines ${cv.lines} · extension plies ${cv.extPlies}`
    );
    lines.push(`  coverage: ${cv.covered} rows on lines + ${cv.asNotes} as notes of ${cv.rows} · unassigned ${cat.unassigned.length}`);
    if (verbose) {
      lines.push("  per-hub coverage (curated hubs; own courses + linked siblings):");
      for (const h of cat.hubReport.filter((x) => x.kind === "curated")) {
        lines.push(`    ${h.pct < 0.95 ? "!" : " "} ${h.slug.padEnd(26)} ${String(h.covered).padStart(4)}/${String(h.rows).padEnd(4)} ${(h.pct * 100).toFixed(0).padStart(3)}%`);
      }
    }
  }
  for (const i of warnings.slice(0, 20)) lines.push("  " + formatIssue(i));
  if (warnings.length > 20) lines.push(`  … ${warnings.length - 20} more warnings (see openings.v2.meta.json)`);
  console.log(lines.join("\n"));
}
