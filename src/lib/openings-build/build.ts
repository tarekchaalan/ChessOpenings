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
import { encodeAnnotations, parseAnnotations } from "./annotations";
import { buildCatalog, resolveLegacy, type CatalogResult } from "./catalog";
import { computeExtEdges, ExtCache } from "./extension";
import type { CourseMemo } from "./memo";
import { computeHubs, matchesQuery, slugify, type HubDef } from "./hubs";
import { modelFromRaw, nameSegments, type Model } from "./model";
import { T } from "./tunables";
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
  previous: { rows: BaselineRow[]; outputHash: string; courseLines?: Record<string, string[]> } | null;
  cache?: ReplayCache;
  /** ISO timestamp for the changelog entry (injected for determinism in tests) */
  now?: string;
  /** sha256 → hex; Node adapters inject node:crypto (same output, ~20× faster) */
  hasher?: (s: string) => string;
  /** hash of the build library sources + src/content/hubs.ts (stale-artifact detection) */
  codeHash?: string;
  /** curated hub definitions (src/content/hubs.ts); omit to skip the catalog */
  hubDefs?: HubDef[];
  /** skip the legacy map (the dev watcher computes it after publishing the dataset) */
  skipLegacy?: boolean;
  /** §4.7 extension (default on) */
  extension?: boolean;
  extCache?: ExtCache;
  /** dev watcher: reuse courses of hubs the edit didn't touch */
  courseMemo?: CourseMemo;
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
  catalog: CatalogResult | null;
  /** course id → line ids (written to data/derived for the next build's deltas) */
  courseLines: Record<string, string[]>;
  timingsMs: Record<string, number>;
}

/** inputHash: sorted relative paths + contents of every watched input + stats + lib version. */
export function computeInputHash(
  files: SourceFile[],
  statsSha: string | null,
  hasher: (s: string) => string = sha256Hex,
  /** hash of the build library + curated hub config (Node adapters supply it) */
  codeHash: string | null = null
): string {
  const parts = [...files]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((f) => `${f.path}\u0000${hasher(f.text.replace(/\r\n/g, "\n"))}`); // CRLF checkouts hash the same
  return hasher([BUILD_LIB_VERSION, `code:${codeHash ?? "none"}`, `stats:${statsSha ?? "none"}`, ...parts].join("\n"));
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
  const inputHash = computeInputHash(allFiles, input.statsSha, hasher, input.codeHash ?? null);
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

  const rawRows = encodeRows(graph);
  const maxPly = input.stats?.maxPly ?? 0;
  let nodes = encodeNodes(graph, input.stats);
  lap("encode");

  // Phase 2: hubs → extension edges → courses (ADR 0002). The model is built
  // from the *encoded* nodes so the client re-derives identical courses.
  let catalogResult: CatalogResult | null = null;
  let model: Model | null = null;
  if (input.hubDefs) {
    const model0 = modelFromRaw({ rows: rawRows, nodes, maxPly });
    const hubs0 = computeHubs(model0, input.hubDefs);
    lap("hubs");
    if (input.extension !== false) {
      const ext = computeExtEdges(model0, hubs0, input.stats, input.extCache ?? new ExtCache());
      nodes = encodeNodes(graph, input.stats, ext);
      lap("extension");
    }
    model = modelFromRaw({ rows: rawRows, nodes, maxPly });
    // hubs depend on named theory only, which extension doesn't touch: reuse
    // them (the client recomputes them on the final model and gets the same)
    const hubs = hubs0;
    catalogResult = buildCatalog(model, hubs, input.courseMemo);
    for (const h of hubs) for (const w of h.warnings) issues.push({ level: "warning", message: `hub ${h.slug}: ${w}` });
    for (const r of catalogResult.hubReport) {
      if (r.kind === "curated" && r.pct < T.HUB_COVERAGE_WARN) {
        issues.push({ level: "warning", message: `hub ${r.slug}: only ${r.covered}/${r.rows} rows reachable from its courses (< ${T.HUB_COVERAGE_WARN * 100}%)` });
      }
    }
    lap("courses");
  }

  // §4.2 annotations (keyed by EPD + SAN; moves outside the graph warn but attach)
  const annotations = parseAnnotations(input.annotationFiles ?? [], issues, (epd, norm) => {
    const n = graph.byEpd.get(epd);
    return n !== undefined && graph.nodes[n].edges.some((e) => e.norm === norm);
  });
  lap("annotations");

  const dataset: RawDatasetV2 = {
    format: DATASET_FORMAT,
    lib: BUILD_LIB_VERSION,
    inputHash,
    startEpd: START_EPD,
    maxPly,
    rows: rawRows,
    nodes,
    ...(catalogResult ? { catalog: catalogResult.catalog } : {}),
    ...(annotations.moves.size || annotations.intros.size ? { annotations: encodeAnnotations(annotations) } : {}),
  };
  const datasetJson = JSON.stringify(dataset);
  const outputHash = hasher(datasetJson);
  lap("serialize");

  const current: BaselineRow[] = rows.map((r) => ({ rowId: r.rowId, name: r.name, eco: r.eco }));
  let changelogEntry: ChangelogEntry | null = null;
  let legacyMap: LegacyMap | null = null;
  let v1 = null;
  if (input.v1Openings) {
    if (v1Memo?.src !== input.v1Openings) v1Memo = { src: input.v1Openings, out: replayV1(input.v1Openings, cache) };
    v1 = v1Memo.out;
    if (!input.skipLegacy) legacyMap = legacyMapFor(v1, current, catalogResult);
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
      hubs: catalogResult ? hubDeltas(catalogResult, d!, input.hubDefs ?? []) : {},
      courses: catalogResult && input.previous?.courseLines ? courseDeltas(catalogResult, input.previous.courseLines) : {},
    };
  }
  lap("diff");
  const courseLines: Record<string, string[]> = {};
  if (catalogResult) for (const c of catalogResult.courses) courseLines[c.id] = c.lines.map((l) => l.id);

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
    catalog: catalogResult,
    courseLines,
    timingsMs: timings,
  };
}

/** The v1 legacy map for a build (exported so the watcher can run it after publishing). */
export function legacyMapFor(
  v1: ReturnType<typeof replayV1>,
  current: BaselineRow[],
  catalogResult: CatalogResult | null
): LegacyMap {
  // the row's own position first; a position that is only a folded note falls
  // back to the deepest earlier position that is on a course line
  const resolver = catalogResult
    ? (r: { finalEpd: string; epds?: string[] }) => {
        const tries = r.epds?.length ? [...r.epds].reverse() : [r.finalEpd];
        for (const epd of tries) {
          const hit = resolveLegacy(catalogResult.model, catalogResult, epd);
          if (hit.courseId) return hit;
        }
        return { courseId: null, lineId: null };
      }
    : undefined;
  return buildLegacyMap(v1, new Set(current.map((r) => r.rowId)), resolver);
}

/** Legacy map for a finished build output (watcher: deferred). */
export function deferredLegacyMap(out: BuildOutput, v1Openings: V1Opening[], cache: ReplayCache): LegacyMap {
  if (v1Memo?.src !== v1Openings) v1Memo = { src: v1Openings, out: replayV1(v1Openings, cache) };
  const current = out.graph.rows.map((r) => ({ rowId: r.rowId, name: r.name, eco: r.eco }));
  return legacyMapFor(v1Memo.out, current, out.catalog);
}

/** Per-hub row deltas ("+3 new lines in Ruy Lopez"); removed rows are matched by name. */
function hubDeltas(cat: CatalogResult, d: ReturnType<typeof diffRows>, defs: HubDef[]): ChangelogEntry["hubs"] {
  const out: ChangelogEntry["hubs"] = {};
  const byRowId = new Map<string, string[]>();
  for (const h of cat.hubs) {
    for (const r of h.rows) {
      const id = cat.model.rows[r].rowId;
      let l = byRowId.get(id);
      if (!l) byRowId.set(id, (l = []));
      l.push(h.slug);
    }
  }
  const bump = (slug: string, key: "added" | "removed") => {
    const h = cat.hubs.find((x) => x.slug === slug);
    if (!h) return;
    (out[slug] ??= { title: h.title, added: 0, removed: 0 })[key]++;
  };
  for (const a of d.added) for (const slug of byRowId.get(a.rowId) ?? []) bump(slug, "added");
  for (const r of d.removed) {
    const def = defs.find((x) => x.match.some((q) => matchesQuery(r.name, q)));
    const slug = def ? def.slug : slugify(nameSegments(r.name)[0] ?? r.name);
    bump(slug, "removed");
  }
  return out;
}

function courseDeltas(cat: CatalogResult, prev: Record<string, string[]>): ChangelogEntry["courses"] {
  const out: ChangelogEntry["courses"] = {};
  for (const c of cat.courses) {
    const before = new Set(prev[c.id] ?? []);
    const now = new Set(c.lines.map((l) => l.id));
    const added = [...now].filter((x) => !before.has(x));
    const removed = [...before].filter((x) => !now.has(x));
    if ((added.length || removed.length) && prev[c.id]) out[c.id] = { added, removed };
  }
  return out;
}

/** Format issues for terminals: "a.tsv:12 ply 3 'Bxf9' — illegal move …". */
export function formatIssue(i: Issue): string {
  const loc = i.file ? `${i.file}${i.line ? `:${i.line}` : ""}` : "";
  return `${i.level === "error" ? "ERROR" : "warn "} ${loc ? loc + " — " : ""}${i.message}`;
}
