/**
 * Import scope (ADR 0006, amended): rated standard chess in the chosen time
 * classes, the newest `maxGames` games however old. `maxMonths` only bounds
 * how far back the Chess.com monthly archives are walked to find them.
 */
import type { NormalGame, Skip, TimeClass } from "./types";

export interface ImportScope {
  timeClasses: TimeClass[];
  maxGames: number;
  /** Chess.com: archive months walked at most, newest first */
  maxMonths: number;
}

export const DEFAULT_SCOPE: ImportScope = { timeClasses: ["rapid", "blitz", "classical"], maxGames: 350, maxMonths: 60 };

export function inScope(g: NormalGame, scope: ImportScope): Skip | null {
  if (!g.standard) return { skip: "variant" };
  if (!g.rated) return { skip: "unrated" };
  if (!g.timeClass || !scope.timeClasses.includes(g.timeClass)) return { skip: "time-class" };
  return null;
}

/** Newest first, after the incremental cursor `since` (when there is one), at most `maxGames`. */
export function applyWindow<T extends { playedAt: string }>(games: T[], scope: ImportScope, since: Date | null): T[] {
  const from = since?.getTime() ?? -Infinity;
  return games
    .filter((g) => Date.parse(g.playedAt) > from)
    .sort((a, b) => Date.parse(b.playedAt) - Date.parse(a.playedAt))
    .slice(0, scope.maxGames);
}
