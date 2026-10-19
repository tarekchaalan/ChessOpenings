/**
 * UCI helpers for the on-demand engine (Phase 6, stretch 2): parse Stockfish
 * output, convert scores, classify a mistake's eval drop. Pure; the worker
 * wrapper is lib/engine/engine.ts.
 */
import { Chess } from "chess.js";

/** A score from the side to move's point of view. */
export type Score = { cp: number } | { mate: number };

export interface Info {
  depth: number;
  score: Score;
  /** principal variation, UCI moves */
  pv: string[];
}

/** Parse one `info … score … pv …` line; null for other lines (currmove, string…). */
export function parseInfo(line: string): Info | null {
  if (!line.startsWith("info ") || !line.includes(" pv ")) return null;
  const t = line.split(/\s+/);
  const depth = Number(t[t.indexOf("depth") + 1]);
  const si = t.indexOf("score");
  if (si < 0 || !Number.isFinite(depth)) return null;
  const kind = t[si + 1];
  const val = Number(t[si + 2]);
  if (!Number.isFinite(val) || (kind !== "cp" && kind !== "mate")) return null;
  const pv = t.slice(t.indexOf("pv") + 1);
  return { depth, score: kind === "cp" ? { cp: val } : { mate: val }, pv };
}

/** `bestmove e2e4 ponder e7e5` → "e2e4" ("(none)" when mated/stalemated → null). */
export function parseBestmove(line: string): string | null | undefined {
  if (!line.startsWith("bestmove")) return undefined;
  const m = line.split(/\s+/)[1];
  return m && m !== "(none)" ? m : null;
}

const MATE_CP = 10_000;
/** Centipawns for comparisons (mate in n ≈ ±10000 − n). */
export const toCp = (s: Score) => ("cp" in s ? s.cp : s.mate > 0 ? MATE_CP - s.mate : -MATE_CP - s.mate);
export const negate = (s: Score): Score => ("cp" in s ? { cp: -s.cp } : { mate: -s.mate });

/** "+0.4", "−1.2", "#3", "#−2" (from White's point of view when given White's score). */
export function formatScore(s: Score): string {
  if ("mate" in s) return `#${s.mate < 0 ? "−" : ""}${Math.abs(s.mate)}`;
  const v = s.cp / 100;
  return `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(1)}`;
}

/** White's winning chances 0–1 for the eval bar (lichess' logistic curve). */
export function whiteShare(white: Score): number {
  if ("mate" in white) return white.mate > 0 ? 1 : 0;
  const cp = Math.max(-1000, Math.min(1000, white.cp));
  return 1 / (1 + Math.exp(-0.00368208 * cp));
}

export type Verdict = "blunder" | "mistake" | "inaccuracy" | "playable";

/** Classify the learner's loss in centipawns (before − after, both from the learner's side). */
export function classify(before: Score, after: Score): { verdict: Verdict; drop: number } {
  const drop = Math.max(0, toCp(before) - toCp(after));
  const verdict: Verdict = drop >= 300 ? "blunder" : drop >= 120 ? "mistake" : drop >= 50 ? "inaccuracy" : "playable";
  return { verdict, drop };
}

/** Play a UCI PV from a FEN as SAN (stops at the first illegal move). */
export function pvToMoves(fen: string, pv: string[], max = 4): { san: string; from: string; to: string; fen: string }[] {
  const c = new Chess(fen);
  const out: { san: string; from: string; to: string; fen: string }[] = [];
  for (const u of pv.slice(0, max)) {
    try {
      const mv = c.move({ from: u.slice(0, 2), to: u.slice(2, 4), ...(u[4] ? { promotion: u[4] } : {}) });
      out.push({ san: mv.san, from: mv.from, to: mv.to, fen: c.fen() });
    } catch {
      break;
    }
  }
  return out;
}
