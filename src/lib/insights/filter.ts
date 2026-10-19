/**
 * Import scope (spec §2, ADR 0006): rated standard chess in the chosen time
 * classes, within a window of the last N months or M games, whichever is
 * smaller.
 */
import type { NormalGame, Skip, TimeClass } from "./types";

export interface ImportScope {
  timeClasses: TimeClass[];
  months: number;
  maxGames: number;
}

export const DEFAULT_SCOPE: ImportScope = { timeClasses: ["rapid", "blitz", "classical"], months: 3, maxGames: 200 };

export function inScope(g: NormalGame, scope: ImportScope): Skip | null {
  if (!g.standard) return { skip: "variant" };
  if (!g.rated) return { skip: "unrated" };
  if (!g.timeClass || !scope.timeClasses.includes(g.timeClass)) return { skip: "time-class" };
  return null;
}

/** Window start: the later of `since` and `now − months`. */
export function windowStart(scope: ImportScope, since: Date | null, now: Date): Date {
  const floor = new Date(now);
  floor.setUTCMonth(floor.getUTCMonth() - scope.months);
  return since && since > floor ? since : floor;
}

/** Newest first, inside the window, at most `maxGames`. */
export function applyWindow<T extends { playedAt: string }>(games: T[], scope: ImportScope, since: Date | null, now: Date): T[] {
  const from = windowStart(scope, since, now).getTime();
  return games
    .filter((g) => Date.parse(g.playedAt) > from)
    .sort((a, b) => Date.parse(b.playedAt) - Date.parse(a.playedAt))
    .slice(0, scope.maxGames);
}
