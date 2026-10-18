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

export const OUT = {
  dataset: join(DATA_DIR, "openings.v2.json"),
  meta: join(DATA_DIR, "openings.v2.meta.json"),
  changelog: join(DATA_DIR, "openings.changelog.json"),
  legacy: join(DATA_DIR, "legacy-map.v1.json"),
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
  unassigned: unknown[];
  timingsMs: Record<string, number>;
}

export const nodeSha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

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
export function readPrevious(): { rows: BaselineRow[]; outputHash: string } | null {
  const meta = readMeta();
  if (!meta || !existsSync(OUT.dataset)) return null;
  try {
    const ds = JSON.parse(readFileSync(OUT.dataset, "utf8")) as RawDatasetV2;
    return {
      outputHash: meta.outputHash,
      rows: ds.rows.map((r) => ({ rowId: r[0], eco: r[1] || null, name: r[2] })),
    };
  } catch {
    return null;
  }
}

export function runBuild(opts: { cache?: ReplayCache; previous?: BuildInput["previous"] } = {}): BuildOutput {
  const stats = loadStats();
  return buildOpenings({
    ...readInputs(),
    stats: stats?.stats ?? null,
    statsSha: stats?.sha ?? null,
    v1Openings: loadV1(),
    previous: opts.previous === undefined ? readPrevious() : opts.previous,
    cache: opts.cache,
    hasher: nodeSha256,
  });
}

export function writeArtifacts(out: BuildOutput): Meta {
  const gz = gzipSync(out.datasetJson, { level: 9 });
  writeAtomic(OUT.dataset, out.datasetJson);
  if (out.legacyMap) writeAtomic(OUT.legacy, JSON.stringify(out.legacyMap));
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
    unassigned: [],
    timingsMs: out.timingsMs,
  };
  writeAtomic(OUT.meta, JSON.stringify(meta, null, 2) + "\n");
  return meta;
}

export function printReport(out: BuildOutput, label: string, ms: number): void {
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
  for (const i of warnings.slice(0, 20)) lines.push("  " + formatIssue(i));
  if (warnings.length > 20) lines.push(`  … ${warnings.length - 20} more warnings (see openings.v2.meta.json)`);
  console.log(lines.join("\n"));
}
