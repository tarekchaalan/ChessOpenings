/**
 * NormalGame → Summary: book matching plus the Lichess evaluation at the
 * deviation. Everything else about the game is dropped here.
 */
import { negate, toCp, type Score } from "@/lib/engine/uci";
import type { Model } from "@/lib/openings-build/model";
import { matchBook } from "./book";
import type { NormalGame, Summary } from "./types";

const CLAMP = 10_000;
const cp = (s: Score | null | undefined): number | null => (s ? Math.max(-CLAMP, Math.min(CLAMP, toCp(s))) : null);

export function summarize(model: Model, g: NormalGame, datasetHash: string, n?: number): Summary | null {
  if (!g.timeClass) return null;
  const m = matchBook(model, g.sans, g.color, n);
  if (!m.plies.length) return null;
  let evalBefore: number | null = null;
  let evalAfter: number | null = null;
  if (m.deviationEpd && g.evals) {
    // evals[k] = score after ply k + 1 (White's side); the deviation is ply bookPly + 1
    const k = m.bookPly;
    const whiteToMove = m.deviationEpd.split(" ")[1] === "w";
    const side = (s: Score | null | undefined) => (s ? (whiteToMove ? s : negate(s)) : null);
    evalBefore = k === 0 ? null : cp(side(g.evals[k - 1]));
    evalAfter = cp(side(g.evals[k]));
    if (evalBefore === null || evalAfter === null) evalBefore = evalAfter = null;
  }
  return {
    platform: g.platform,
    gameId: g.gameId,
    color: g.color,
    timeClass: g.timeClass,
    playedAt: g.playedAt,
    result: g.result,
    myRating: g.myRating,
    oppRating: g.oppRating,
    eco: g.eco,
    openingName: g.openingName ? g.openingName.slice(0, 200) : null,
    openingPlies: m.plies,
    bookPly: m.bookPly,
    deviatedBy: m.deviatedBy,
    deviationEpd: m.deviationEpd,
    playedSan: m.playedSan,
    bookSans: m.bookSans,
    evalBefore,
    evalAfter,
    datasetHash,
  };
}

/** Re-match a stored summary against a newer dataset (no platform calls). */
export function rematch(model: Model, s: Summary, datasetHash: string, n?: number): Summary {
  const plies = s.deviatedBy !== "none" && s.bookPly >= s.openingPlies.length && s.playedSan ? [...s.openingPlies, s.playedSan] : s.openingPlies;
  const m = matchBook(model, plies, s.color, n);
  // the stored eval belongs to the old deviation; keep it only when the deviation didn't move
  const same = m.deviationEpd === s.deviationEpd && m.playedSan === s.playedSan;
  return {
    ...s,
    openingPlies: m.plies,
    bookPly: m.bookPly,
    deviatedBy: m.deviatedBy,
    deviationEpd: m.deviationEpd,
    playedSan: m.playedSan,
    bookSans: m.bookSans,
    evalBefore: same ? s.evalBefore : null,
    evalAfter: same ? s.evalAfter : null,
    datasetHash,
  };
}
