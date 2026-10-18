/**
 * Theory graph: EPD-keyed positions, edges = moves on any named row.
 * Applies the §4.1 validation rules and assigns stable row ids (§4.3).
 */
import { rowIdFor } from "./hash";
import { ReplayCache, START_EPD } from "./replay";
import type { Issue, Ply, Row, TsvRow } from "./types";

export interface GraphEdge {
  san: string;
  norm: string;
  to: number;
  from: string;
  dest: string;
  /** indices into Graph.rows of rows whose path uses this edge */
  rows: number[];
}

export interface GraphNode {
  idx: number;
  epd: string;
  /** row whose final position is this node (shortest path, ties → first); -1 if none */
  nameRow: number;
  /** all rows ending here */
  endRows: number[];
  edges: GraphEdge[];
  /** node indices of theory parents */
  parents: number[];
  /** ply depth of the shortest theory path to this node */
  depth: number;
}

export interface Graph {
  rows: Row[];
  nodes: GraphNode[];
  byEpd: Map<string, number>;
  /** row index → node index per ply (0 = start) */
  rowPath: number[][];
}

export function replayRows(tsvRows: TsvRow[], cache: ReplayCache, issues: Issue[]): Row[] {
  const rows: Row[] = [];
  const bySeq = new Map<string, number>();
  for (const r of tsvRows) {
    const res = cache.replay(r.tokens);
    if (!res.ok) {
      issues.push({
        level: "error",
        file: r.file,
        line: r.line,
        ply: res.plyIndex + 1,
        token: res.token,
        message: `illegal move "${res.token}" at ply ${res.plyIndex + 1} in "${r.name}"; row skipped`,
      });
      continue;
    }
    const norms = res.plies.map((p) => p.norm);
    const seq = norms.join(" ");
    const dup = bySeq.get(seq);
    if (dup !== undefined) {
      const first = rows[dup];
      issues.push({
        level: "warning",
        file: r.file,
        line: r.line,
        message: `duplicate move sequence of "${first.name}" (${first.file}:${first.line}); "${r.name}" kept as an alias`,
      });
      if (r.name !== first.name && !first.aliases.includes(r.name)) first.aliases.push(r.name);
      continue;
    }
    bySeq.set(seq, rows.length);
    rows.push({
      rowId: rowIdFor(norms),
      eco: r.eco,
      name: r.name,
      aliases: [],
      plies: res.plies,
      file: r.file,
      line: r.line,
      ...(r.extra ? { extra: r.extra } : {}),
    });
  }
  const ids = new Set<string>();
  for (const row of rows) {
    if (ids.has(row.rowId)) throw new Error(`rowId collision ${row.rowId} — impossible unless sha256 broke`);
    ids.add(row.rowId);
  }
  return rows;
}

export function buildGraph(rows: Row[]): Graph {
  const nodes: GraphNode[] = [];
  const byEpd = new Map<string, number>();
  const getNode = (epd: string): number => {
    let idx = byEpd.get(epd);
    if (idx === undefined) {
      idx = nodes.length;
      byEpd.set(epd, idx);
      nodes.push({ idx, epd, nameRow: -1, endRows: [], edges: [], parents: [], depth: Infinity });
    }
    return idx;
  };
  getNode(START_EPD);
  nodes[0].depth = 0;

  const rowPath: number[][] = [];
  rows.forEach((row, ri) => {
    const path = [0];
    let cur = 0;
    row.plies.forEach((p: Ply, i) => {
      const to = getNode(p.epd);
      const node = nodes[cur];
      let edge = node.edges.find((e) => e.norm === p.norm);
      if (!edge) {
        edge = { san: p.san, norm: p.norm, to, from: p.from, dest: p.to, rows: [] };
        node.edges.push(edge);
        if (!nodes[to].parents.includes(cur)) nodes[to].parents.push(cur);
      }
      edge.rows.push(ri);
      nodes[to].depth = Math.min(nodes[to].depth, i + 1);
      cur = to;
      path.push(to);
    });
    rowPath.push(path);
    const end = nodes[cur];
    end.endRows.push(ri);
    if (end.nameRow === -1 || rows[ri].plies.length < rows[end.nameRow].plies.length) end.nameRow = ri;
  });
  return { rows, nodes, byEpd, rowPath };
}
