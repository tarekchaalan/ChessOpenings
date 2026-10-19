/**
 * Book matching (ADR 0006 § Book matching): walk a game through the theory
 * graph with the trainer's keys (EPD positions, normalised SAN). A move is book
 * when it is a theory or extension edge, or when it transposes into a known
 * position. Stats-only moves (to = -1) are off book. A game that plays on from
 * the last position of a theory line hasn't left book (deviatedBy "none").
 */
import { Chess } from "chess.js";
import { normSan, type Model } from "@/lib/openings-build/model";
import { epdOf } from "@/lib/openings-build/replay";
import type { DeviatedBy, Side } from "./types";

const longest = new WeakMap<Model, number>();

/** n: the longest chain of book edges from the start (no game can be in book past it). */
export function maxBookPly(model: Model): number {
  const hit = longest.get(model);
  if (hit !== undefined) return hit;
  const memo = new Int32Array(model.nodes.length).fill(-1);
  const seen = new Uint8Array(model.nodes.length);
  const depth = (start: number): number => {
    // iterative post-order DFS: the graph is acyclic (every edge is one ply deeper)
    const stack: [number, number][] = [[start, 0]];
    seen[start] = 1;
    while (stack.length) {
      const top = stack[stack.length - 1];
      const [node, i] = top;
      const moves = model.nodes[node].moves;
      if (i < moves.length) {
        top[1]++;
        const to = moves[i].to;
        if (to >= 0 && !seen[to]) {
          seen[to] = 1;
          stack.push([to, 0]);
        }
        continue;
      }
      let best = 0;
      for (const m of moves) if (m.to >= 0) best = Math.max(best, 1 + memo[m.to]);
      memo[node] = best;
      stack.pop();
    }
    return memo[start];
  };
  const n = depth(0);
  longest.set(model, n);
  return n;
}

export interface BookMatch {
  /** the first n plies actually played (legal, normalised SAN) */
  plies: string[];
  bookPly: number;
  deviatedBy: DeviatedBy;
  deviationEpd: string | null;
  /** normalised */
  playedSan: string | null;
  /** theory moves at the deviation, most played first */
  bookSans: string[] | null;
  /** node indices: path[0] = start, path[i] = after book ply i */
  path: number[];
}

/**
 * Match one game. `n` = maxBookPly(model); the walk replays up to n + 1 plies
 * so a game that leaves book right after ply n still records its deviation.
 */
export function matchBook(model: Model, sans: string[], color: Side, n = maxBookPly(model)): BookMatch {
  const chess = new Chess();
  const plies: string[] = [];
  const path = [0];
  let node = 0;
  let inBook = true;
  let dev: Pick<BookMatch, "deviatedBy" | "deviationEpd" | "playedSan" | "bookSans"> = { deviatedBy: "none", deviationEpd: null, playedSan: null, bookSans: null };
  for (let i = 0; i < Math.min(sans.length, n + 1); i++) {
    let played: string;
    try {
      played = normSan(chess.move(sans[i]).san);
    } catch {
      break; // illegal or unreadable: the game ends here for matching purposes
    }
    if (i < n) plies.push(played);
    if (!inBook) continue;
    const here = model.nodes[node];
    const edge = here.moves.find((m) => m.to >= 0 && m.norm === played);
    const next = edge ? edge.to : i < n ? model.byEpd.get(epdOf(chess.fen())) : undefined;
    // the end of a theory line (no continuation): playing on isn't leaving book
    if (next === undefined && !here.moves.some((m) => m.to >= 0)) {
      inBook = false;
      continue;
    }
    if (next === undefined) {
      const mover: Side = here.white ? "white" : "black";
      // ply n + 1 can only be book through a transposition; past n we stop either way
      if (i === n && edge) break;
      dev = {
        deviatedBy: mover === color ? "me" : "opponent",
        deviationEpd: here.epd,
        playedSan: played,
        bookSans: here.moves.filter((m) => m.to >= 0).sort((a, b) => b.games - a.games).map((m) => m.norm),
      };
      inBook = false;
      continue;
    }
    if (i === n) break;
    node = next;
    path.push(node);
  }
  return { plies, bookPly: path.length - 1, path, ...dev };
}

/** Re-walk a stored summary's book path (aggregation and deep links). */
export function bookPath(model: Model, plies: string[], bookPly: number): number[] {
  const chess = new Chess();
  const path = [0];
  let node = 0;
  for (let i = 0; i < Math.min(bookPly, plies.length); i++) {
    let played: string;
    try {
      played = normSan(chess.move(plies[i]).san);
    } catch {
      break;
    }
    const edge = model.nodes[node].moves.find((m) => m.to >= 0 && m.norm === played);
    const next = edge ? edge.to : model.byEpd.get(epdOf(chess.fen()));
    if (next === undefined) break;
    node = next;
    path.push(node);
  }
  return path;
}
