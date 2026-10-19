/**
 * Opening Map (§3.2 A, Phase 6 stretch): an icicle of the named-theory tree.
 * A cell's width is the share of master games that reach it through its move
 * (relative to the position it's played from); colour is the ECO volume of
 * the deepest opening name on its path. Pure layout over the model; the view
 * lives in components/openings/OpeningMap.tsx.
 */
import type { Model } from "@/lib/openings-build/model";

export interface MapCell {
  /** moves from the start position (the cell's identity and zoom target) */
  path: string[];
  node: number;
  /** horizontal extent, 0–1 of the focused root's width */
  x0: number;
  x1: number;
  /** rows below the focused root (0 = the root itself) */
  depth: number;
  /** master games through this move (the root: games at the position) */
  games: number;
  /** share of the focused root's games */
  share: number;
  /** deepest named row on the path, -1 if none yet */
  row: number;
  /** ECO volume letter (A–E) of that row, null if unnamed */
  volume: string | null;
}

export interface MapLayout {
  root: MapCell;
  cells: MapCell[];
  depth: number;
}

/** Theory moves with a destination, most-played first. */
export function theoryChildren(model: Model, node: number): { san: string; to: number; games: number }[] {
  return model.nodes[node].moves
    .filter((m) => m.theory && m.to >= 0)
    .map((m) => ({ san: m.san, to: m.to, games: m.games }))
    .sort((a, b) => b.games - a.games || (a.san < b.san ? -1 : 1));
}

/** Walk `path` from the start; null when a move isn't named theory. */
export function nodeAtPath(model: Model, path: string[]): { node: number; row: number } | null {
  let node = 0;
  let row = model.nodes[0].nameRow;
  for (const san of path) {
    const next = theoryChildren(model, node).find((c) => c.san === san);
    if (!next) return null;
    node = next.to;
    if (model.nodes[node].nameRow !== -1) row = model.nodes[node].nameRow;
  }
  return { node, row };
}

const volumeOf = (model: Model, row: number) => (row >= 0 ? (model.rows[row].eco?.[0] ?? null) : null);

/**
 * Lay out `depth` rows below the focused position. Children narrower than
 * `minShare` of the root are dropped (they'd be under a pixel wide).
 */
export function layoutIcicle(model: Model, focus: string[], depth = 8, minShare = 0.0015): MapLayout | null {
  const at = nodeAtPath(model, focus);
  if (!at) return null;
  const rootGames = model.nodes[at.node].games;
  const root: MapCell = { path: focus, node: at.node, x0: 0, x1: 1, depth: 0, games: rootGames, share: 1, row: at.row, volume: volumeOf(model, at.row) };
  const cells: MapCell[] = [root];
  const visit = (parent: MapCell) => {
    if (parent.depth >= depth) return;
    const pGames = model.nodes[parent.node].games;
    if (pGames <= 0) return;
    let x = parent.x0;
    const width = parent.x1 - parent.x0;
    for (const c of theoryChildren(model, parent.node)) {
      const w = (width * c.games) / pGames;
      if (w < minShare) {
        x += w;
        continue;
      }
      const row = model.nodes[c.to].nameRow !== -1 ? model.nodes[c.to].nameRow : parent.row;
      const cell: MapCell = {
        path: [...parent.path, c.san],
        node: c.to,
        x0: x,
        x1: x + w,
        depth: parent.depth + 1,
        games: c.games,
        share: rootGames > 0 ? c.games / rootGames : 0,
        row,
        volume: volumeOf(model, row),
      };
      cells.push(cell);
      visit(cell);
      x += w;
    }
  };
  visit(root);
  return { root, cells, depth };
}
