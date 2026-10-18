/**
 * Runtime dataset format `chess-openings-trainer/graph@2` (compact tuples,
 * like v1). Encoded by the build, decoded by src/lib/openings.ts.
 */
import type { Graph } from "./graph";
import type { RawCatalog } from "./catalog";
import type { RawAnnotations } from "./annotations";
import { MOVE_EXT, MOVE_THEORY, type PositionStats } from "./types";

export const DATASET_FORMAT = "chess-openings-trainer/graph@2";

/** [san, to (-1 = off-book), games, w, d, b, flags] */
export type RawMove = [string, number, number, number, number, number, number];
/** [epd, nameRow (-1 = unnamed), games, w, d, b, moves] */
export type RawNode = [string, number, number, number, number, number, RawMove[]];
/** [rowId, eco ("" = null), name, sans (display, space-joined), finalNode, aliases] */
export type RawRow = [string, string, string, string, number, string[]];

export interface RawDatasetV2 {
  format: typeof DATASET_FORMAT;
  lib: string;
  inputHash: string;
  startEpd: string;
  maxPly: number;
  rows: RawRow[];
  nodes: RawNode[];
  /** hubs, systems, course summaries and the position index (Phase 2) */
  catalog?: RawCatalog;
  /** authored coach content (§4.2) */
  annotations?: RawAnnotations;
}

/** Off-book (stats-only) moves listed per position, like v1's "extras". */
export const MAX_STATS_MOVES = 8;

/**
 * Encode the theory graph with stats joined from the position table.
 * `extEdges`: extension edges (from-epd → [san, to-epd]) added by Phase 2;
 * their destination positions become nodes too.
 */
export function encodeNodes(
  graph: Graph,
  stats: PositionStats | null,
  extEdges: Map<string, { san: string; toEpd: string }[]> = new Map()
): RawNode[] {
  // ext destinations not in the theory graph get appended node indices
  const epdIndex = new Map(graph.byEpd);
  const extraEpds: string[] = [];
  for (const list of extEdges.values()) {
    for (const e of list) {
      if (!epdIndex.has(e.toEpd)) {
        epdIndex.set(e.toEpd, graph.nodes.length + extraEpds.length);
        extraEpds.push(e.toEpd);
      }
    }
  }
  const allEpds = [...graph.nodes.map((n) => n.epd), ...extraEpds];

  return allEpds.map((epd, idx) => {
    const st = stats?.positions[epd];
    const statMoves = new Map<string, [string, number, number, number, number]>();
    if (st) for (const m of st[4]) statMoves.set(m[0], m);
    const node = idx < graph.nodes.length ? graph.nodes[idx] : null;
    const moves: RawMove[] = [];
    const used = new Set<string>();
    if (node) {
      for (const e of node.edges) {
        const s = statMoves.get(e.norm);
        moves.push([e.san, e.to, s?.[1] ?? 0, s?.[2] ?? 0, s?.[3] ?? 0, s?.[4] ?? 0, MOVE_THEORY]);
        used.add(e.norm);
      }
    }
    for (const e of extEdges.get(epd) ?? []) {
      const norm = e.san.replace(/[+#]$/, "");
      if (used.has(norm)) {
        // an extension move that is also named theory carries both flags
        const t = moves.find((m) => m[0].replace(/[+#]$/, "") === norm);
        if (t) t[6] |= MOVE_EXT;
        continue;
      }
      const s = statMoves.get(norm);
      moves.push([e.san, epdIndex.get(e.toEpd)!, s?.[1] ?? 0, s?.[2] ?? 0, s?.[3] ?? 0, s?.[4] ?? 0, MOVE_EXT]);
      used.add(norm);
    }
    let extras = 0;
    for (const s of st?.[4] ?? []) {
      if (used.has(s[0]) || extras >= MAX_STATS_MOVES) continue;
      moves.push([s[0], -1, s[1], s[2], s[3], s[4], 0]);
      extras++;
    }
    // theory first, then by games, then SAN (deterministic)
    moves.sort(
      (a, b) =>
        Number(b[6] !== 0) - Number(a[6] !== 0) || b[2] - a[2] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)
    );
    return [epd, node ? node.nameRow : -1, st?.[0] ?? 0, st?.[1] ?? 0, st?.[2] ?? 0, st?.[3] ?? 0, moves];
  });
}

export function encodeRows(graph: Graph): RawRow[] {
  return graph.rows.map((r, i) => [
    r.rowId,
    r.eco ?? "",
    r.name,
    r.plies.map((p) => p.san).join(" "),
    graph.rowPath[i][graph.rowPath[i].length - 1],
    r.aliases,
  ]);
}
