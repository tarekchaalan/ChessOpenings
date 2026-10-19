/**
 * The in-memory model every hub/course computation runs on. It is built from
 * the *encoded* dataset (RawDatasetV2), on the server during the build and in
 * the browser when a course is re-derived, so both produce identical results
 * from identical bytes (ADR 0002 "Shipping").
 */
import type { RawDatasetV2 } from "./dataset";
import { MOVE_EXT, MOVE_THEORY } from "./types";

export interface MMove {
  san: string;
  norm: string;
  /** destination node, -1 = stats-only (off book, no node) */
  to: number;
  games: number;
  w: number;
  d: number;
  b: number;
  theory: boolean;
  ext: boolean;
  /** rows whose path uses this move (theory moves only), ascending */
  rows: number[];
}

export interface MNode {
  idx: number;
  epd: string;
  /** row naming this position (shortest path, ties → first), -1 if none */
  nameRow: number;
  games: number;
  w: number;
  d: number;
  b: number;
  white: boolean;
  moves: MMove[];
  /** theory moves only, by normalised SAN */
  theoryByNorm: Map<string, MMove>;
}

export interface MRow {
  idx: number;
  rowId: string;
  eco: string | null;
  name: string;
  /** "Family: A, B" → ["Family", "A", "B"]; "London System, with Be2" → ["London System", "with Be2"] */
  segments: string[];
  family: string;
  sans: string[];
  norms: string[];
  /** node indices, path[0] = start, path[i] = after ply i */
  path: number[];
}

export interface Model {
  rows: MRow[];
  nodes: MNode[];
  byEpd: Map<string, number>;
  maxPly: number;
}

export const normSan = (san: string) => san.replace(/[+#?!]+$/, "");

export function nameSegments(name: string): string[] {
  const colon = name.indexOf(":");
  const head = colon === -1 ? name : name.slice(0, colon);
  const tail = colon === -1 ? "" : name.slice(colon + 1);
  const headParts = head.split(",").map((s) => s.trim()).filter(Boolean);
  const tailParts = tail.split(",").map((s) => s.trim()).filter(Boolean);
  return [...headParts, ...tailParts];
}

export const familyOfName = (name: string) => {
  const colon = name.indexOf(":");
  return (colon === -1 ? name : name.slice(0, colon)).trim();
};

export function modelFromRaw(raw: Pick<RawDatasetV2, "rows" | "nodes" | "maxPly">): Model {
  const nodes: MNode[] = raw.nodes.map((n, idx) => {
    const moves: MMove[] = n[6].map((m) => ({
      san: m[0],
      norm: normSan(m[0]),
      to: m[1],
      games: m[2],
      w: m[3],
      d: m[4],
      b: m[5],
      theory: (m[6] & MOVE_THEORY) !== 0,
      ext: (m[6] & MOVE_EXT) !== 0,
      rows: [],
    }));
    const theoryByNorm = new Map<string, MMove>();
    for (const m of moves) if (m.theory) theoryByNorm.set(m.norm, m);
    return {
      idx,
      epd: n[0],
      nameRow: n[1],
      games: n[2],
      w: n[3],
      d: n[4],
      b: n[5],
      white: n[0].split(" ")[1] === "w",
      moves,
      theoryByNorm,
    };
  });
  const byEpd = new Map<string, number>();
  nodes.forEach((n) => byEpd.set(n.epd, n.idx));

  const rows: MRow[] = raw.rows.map((r, idx) => {
    const sans = r[3].split(" ");
    const norms = sans.map(normSan);
    const path = [0];
    let cur = 0;
    for (const norm of norms) {
      const mv = nodes[cur].theoryByNorm.get(norm);
      if (!mv) throw new Error(`dataset inconsistent: row ${r[0]} move ${norm} missing at node ${cur}`);
      mv.rows.push(idx);
      cur = mv.to;
      path.push(cur);
    }
    return {
      idx,
      rowId: r[0],
      eco: r[1] || null,
      name: r[2],
      segments: nameSegments(r[2]),
      family: familyOfName(r[2]),
      sans,
      norms,
      path,
    };
  });
  return { rows, nodes, byEpd, maxPly: raw.maxPly };
}

/** Side to move at a node. */
export const sideToMove = (m: Model, node: number): "white" | "black" => (m.nodes[node].white ? "white" : "black");

/** Display name of a position (its naming row), or null. */
export function nodeName(m: Model, node: number): MRow | null {
  const r = m.nodes[node].nameRow;
  return r === -1 ? null : m.rows[r];
}

/** Deepest named position along a node path (lichess naming convention). */
export function deepestName(m: Model, path: number[]): MRow | null {
  for (let i = path.length - 1; i >= 0; i--) {
    const r = nodeName(m, path[i]);
    if (r) return r;
  }
  return null;
}
