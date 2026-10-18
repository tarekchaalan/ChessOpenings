/**
 * Line extension beyond named theory (§4.7), build side. From every hub-DAG
 * leaf, follow master practice from the position-stats table for both
 * learner sides: the learner plays the most-played move, the opponent's
 * replies branch (share ≥ 25 %, ≥ 8 games, top 2). Up to +8 plies, never
 * past maxPly, stopping at positions with < 8 games. Destination positions
 * need a real move, so this step uses chess.js (cached across builds).
 */
import { Chess } from "chess.js";
import { epdOf } from "./replay";
import { T } from "./tunables";
import type { PositionStats } from "./types";
import type { Hub } from "./hubs";
import type { Model } from "./model";

export interface ExtEdge {
  san: string;
  toEpd: string;
}

/** (epd|san) → [display SAN, destination EPD]; survives across watcher builds. */
export class ExtCache {
  private map = new Map<string, [string, string] | null>();
  moves = 0;
  child(epd: string, san: string): [string, string] | null {
    const key = epd + "|" + san;
    let hit = this.map.get(key);
    if (hit === undefined) {
      try {
        const c = new Chess(epd + " 0 1");
        const mv = c.move(san);
        this.moves++;
        hit = [mv.san, epdOf(c.fen())];
      } catch {
        hit = null;
      }
      this.map.set(key, hit);
    }
    return hit;
  }
}

/** Shortest theory depth of every node (plies from the start). */
export function theoryDepths(model: Model): Int32Array {
  const depth = new Int32Array(model.nodes.length).fill(-1);
  depth[0] = 0;
  const q = [0];
  while (q.length) {
    const n = q.shift()!;
    for (const m of model.nodes[n].moves) {
      if (m.theory && m.to >= 0 && depth[m.to] === -1) {
        depth[m.to] = depth[n] + 1;
        q.push(m.to);
      }
    }
  }
  return depth;
}

export function computeExtEdges(model: Model, hubs: Hub[], stats: PositionStats | null, cache: ExtCache): Map<string, ExtEdge[]> {
  const out = new Map<string, ExtEdge[]>();
  if (!stats) return out;
  const depth = theoryDepths(model);
  const seen = new Set<string>(); // epd|side|extPlies already expanded
  const add = (from: string, e: ExtEdge) => {
    let list = out.get(from);
    if (!list) out.set(from, (list = []));
    if (!list.some((x) => x.san === e.san)) list.push(e);
  };

  const expand = (epd: string, ply: number, extPlies: number, learner: "w" | "b") => {
    if (extPlies >= T.EXT_MAX_PLIES || ply >= stats.maxPly) return;
    const key = `${epd}|${learner}|${extPlies}`;
    if (seen.has(key)) return;
    seen.add(key);
    const st = stats.positions[epd];
    if (!st || st[0] < T.EXT_STOP_GAMES) return;
    const toMove = epd.split(" ")[1] as "w" | "b";
    const moves = st[4];
    const picks =
      toMove === learner
        ? moves.slice(0, 1) // stats moves are sorted by games desc
        : moves.filter((m) => m[1] >= T.EXT_MIN_GAMES && m[1] / st[0] >= T.EXT_MIN_SHARE).slice(0, T.EXT_MAX_BRANCHES);
    for (const m of picks) {
      const child = cache.child(epd, m[0]);
      if (!child) continue;
      add(epd, { san: child[0], toEpd: child[1] });
      expand(child[1], ply + 1, extPlies + 1, learner);
    }
  };

  const leaves = new Set<number>();
  for (const hub of hubs) {
    for (const moves of hub.dag.values()) for (const m of moves) if (!hub.dag.get(m.to)?.length) leaves.add(m.to);
  }
  for (const leaf of [...leaves].sort((a, b) => a - b)) {
    const d = depth[leaf] >= 0 ? depth[leaf] : 0;
    expand(model.nodes[leaf].epd, d, 0, "w");
    expand(model.nodes[leaf].epd, d, 0, "b");
  }
  return out;
}
