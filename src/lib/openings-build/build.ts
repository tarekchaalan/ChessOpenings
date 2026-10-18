/**
 * Build orchestrator (pure). Node adapters (scripts/openings/*) gather the
 * inputs and write the outputs; everything in between lives here so the dev
 * watcher, the one-shot build and tests share one code path.
 */
import { buildGraph, replayRows, type Graph } from "./graph";
import { sha256Hex } from "./hash";
import { ReplayCache, START_EPD } from "./replay";
import { parseTsv, selectTsvFiles } from "./tsv";
import { DATASET_FORMAT, encodeNodes, encodeRows, type RawDatasetV2 } from "./dataset";
import { diffRows, type BaselineRow, type ChangelogEntry } from "./diff";
import { buildLegacyMap, replayV1, type LegacyMap, type V1Opening } from "./legacy";
import { BUILD_LIB_VERSION } from "./version";
import type { Issue, PositionStats, SourceFile } from "./types";

export interface BuildInput {
  /** files under public/data/all-openings (paths prefixed "all-openings/") */
  tsvFiles: SourceFile[];
  /** files under public/data/annotations (paths prefixed "annotations/") */
  annotationFiles?: SourceFile[];
  stats: PositionStats | null;
  /** sha256 of the gzipped position-stats artifact (part of inputHash) */
  statsSha: string | null;
  /** committed openings.v1.json openings (legacy map + first changelog baseline) */
  v1Openings: V1Opening[] | null;
  /** previous build's rows; null → diff against the v1 baseline */
  previous: { rows: BaselineRow[]; outputHash: string } | null;
  cache?: ReplayCache;
  /** ISO timestamp for the changelog entry (injected for determinism in tests) */
  now?: string;
  /** sha256 → hex; Node adapters inject node:crypto (same output, ~20× faster) */
  hasher?: (s: string) => string;
}

export interface BuildCounts {
  files: number;
  rows: number;
  positions: number;
  theoryMoves: number;
  aliases: number;
  errors: number;
  warnings: number;
  statsCoveredPositions: number;
}

export interface BuildOutput {
  ok: boolean;
  issues: Issue[];
  inputHash: string;
  outputHash: string;
  dataset: RawDatasetV2;
  datasetJson: string;
  graph: Graph;
  counts: BuildCounts;
  changelogEntry: ChangelogEntry | null;
  legacyMap: LegacyMap | null;
  timingsMs: Record<string, number>;
}

/** inputHash: sorted relative paths + contents of every watched input + stats + lib version. */
export function computeInputHash(
  files: SourceFile[],
  statsSha: string | null,
  hasher: (s: string) => string = sha256Hex
): string {
  const parts = [...files]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((f) => `${f.path}\u0000${hasher(f.text.replace(/\r\n/g, "\n"))}`); // CRLF checkouts hash the same
  return hasher([BUILD_LIB_VERSION, `stats:${statsSha ?? "none"}`, ...parts].join("\n"));
}

let v1Memo: { src: V1Opening[]; out: ReturnType<typeof replayV1> } | null = null;

export function buildOpenings(input: BuildInput): BuildOutput {
  const clock = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
  const timings: Record<string, number> = {};
  let t = clock();
  const lap = (name: string) => {
    const now = clock();
    timings[name] = Math.round(now - t);
    t = now;
  };

  const issues: Issue[] = [];
  const cache = input.cache ?? new ReplayCache();
  const allFiles = [...input.tsvFiles, ...(input.annotationFiles ?? [])];
  const hasher = input.hasher ?? sha256Hex;
  const inputHash = computeInputHash(allFiles, input.statsSha, hasher);
  lap("hash");

  const tsv = selectTsvFiles(input.tsvFiles, issues);
  const tsvRows = tsv.flatMap((f) => parseTsv(f, issues));
  lap("parse");
  const rows = replayRows(tsvRows, cache, issues);
  lap("replay");
  const graph = buildGraph(rows);
  lap("graph");

  if (input.stats) {
    const deepest = rows.reduce((m, r) => Math.max(m, r.plies.length), 0);
    if (deepest > input.stats.maxPly - 2) {
      issues.push({
        level: "warning",
        message: `position stats reach ply ${input.stats.maxPly} but the deepest row has ${deepest} plies; re-run npm run corpus:build`,
      });
    }
  } else {
    issues.push({ level: "warning", message: "no position stats found (data/derived/position-stats.v1.json.gz); counts will be 0" });
  }

  const nodes = encodeNodes(graph, input.stats);
  const dataset: RawDatasetV2 = {
    format: DATASET_FORMAT,
    lib: BUILD_LIB_VERSION,
    inputHash,
    startEpd: START_EPD,
    maxPly: input.stats?.maxPly ?? 0,
    rows: encodeRows(graph),
    nodes,
  };
  const datasetJson = JSON.stringify(dataset);
  const outputHash = hasher(datasetJson);
  lap("encode");

  const current: BaselineRow[] = rows.map((r) => ({ rowId: r.rowId, name: r.name, eco: r.eco }));
  let changelogEntry: ChangelogEntry | null = null;
  let legacyMap: LegacyMap | null = null;
  let v1 = null;
  if (input.v1Openings) {
    if (v1Memo?.src !== input.v1Openings) v1Memo = { src: input.v1Openings, out: replayV1(input.v1Openings, cache) };
    v1 = v1Memo.out;
    legacyMap = buildLegacyMap(v1, new Set(current.map((r) => r.rowId)));
  }
  const baseline = input.previous?.rows ?? v1?.baseline ?? null;
  const d = baseline && input.previous?.outputHash !== outputHash ? diffRows(baseline, current) : null;
  // only real row changes become changelog entries (a comment or ECO edit doesn't)
  if (d && (d.added.length || d.removed.length || d.renamed.length)) {
    changelogEntry = {
      fromHash: input.previous?.outputHash ?? null,
      toHash: outputHash,
      builtAt: input.now ?? new Date().toISOString(),
      ...d!,
      hubs: {},
      courses: {},
    };
  }
  lap("diff");

  const errors = issues.filter((i) => i.level === "error").length;
  return {
    ok: errors === 0,
    issues,
    inputHash,
    outputHash,
    dataset,
    datasetJson,
    graph,
    counts: {
      files: tsv.length,
      rows: rows.length,
      positions: graph.nodes.length,
      theoryMoves: graph.nodes.reduce((s, n) => s + n.edges.length, 0),
      aliases: rows.reduce((s, r) => s + r.aliases.length, 0),
      errors,
      warnings: issues.length - errors,
      statsCoveredPositions: input.stats ? graph.nodes.filter((n) => input.stats!.positions[n.epd]).length : 0,
    },
    changelogEntry,
    legacyMap,
    timingsMs: timings,
  };
}

/** Format issues for terminals: "a.tsv:12 ply 3 'Bxf9' — illegal move …". */
export function formatIssue(i: Issue): string {
  const loc = i.file ? `${i.file}${i.line ? `:${i.line}` : ""}` : "";
  return `${i.level === "error" ? "ERROR" : "warn "} ${loc ? loc + " — " : ""}${i.message}`;
}
