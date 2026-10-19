/**
 * Chess.com Published-Data API parsers (verified in
 * docs/qa/insights/phase0/api-verification.md): one game from a monthly
 * archive, the profile stats, and which monthly archives an import needs.
 */
import { START_FEN } from "@/lib/openings-build/replay";
import { pgnTag, sansFromPgn } from "../pgn";
import { TIME_CLASSES, type NormalGame, type Ratings, type Skip, type TimeClass } from "../types";

interface ChesscomPlayer {
  username?: string;
  rating?: number;
  result?: string;
}
export interface ChesscomGame {
  url?: string;
  pgn?: string;
  end_time?: number;
  rated?: boolean;
  rules?: string;
  time_class?: string;
  initial_setup?: string;
  white?: ChesscomPlayer;
  black?: ChesscomPlayer;
}

const isTimeClass = (s: unknown): s is TimeClass => TIME_CLASSES.includes(s as TimeClass);

/** "https://www.chess.com/game/live/183193101523" → "live/183193101523" */
export function chesscomGameId(url: string): string | null {
  const m = url.match(/\/game\/([a-z]+)\/(\d+)/);
  return m ? `${m[1]}/${m[2]}` : null;
}

/** "https://www.chess.com/openings/Alapin-Sicilian-Defense-2...Qa5" → "Alapin Sicilian Defense 2...Qa5" */
function nameFromEcoUrl(url: string | null): string | null {
  if (!url) return null;
  const slug = url.split("/openings/")[1];
  return slug ? decodeURIComponent(slug).replace(/-/g, " ").trim() : null;
}

export function parseChesscomGame(g: ChesscomGame, me: string): NormalGame | Skip {
  const id = me.toLowerCase();
  const white = g.white?.username?.toLowerCase();
  const black = g.black?.username?.toLowerCase();
  if (white !== id && black !== id) return { skip: "not-player" };
  const gameId = g.url ? chesscomGameId(g.url) : null;
  if (!gameId || typeof g.pgn !== "string" || typeof g.end_time !== "number") return { skip: "unreadable" };
  const color = white === id ? "white" : "black";
  const mine = color === "white" ? g.white! : g.black!;
  const opp = color === "white" ? g.black : g.white;
  const eco = pgnTag(g.pgn, "ECO");
  return {
    platform: "chesscom",
    gameId,
    color,
    timeClass: isTimeClass(g.time_class) ? g.time_class : null,
    rated: g.rated === true,
    standard: g.rules === "chess" && (!g.initial_setup || g.initial_setup === START_FEN),
    playedAt: new Date(g.end_time * 1000).toISOString(),
    result: mine.result === "win" ? "win" : opp?.result === "win" ? "loss" : "draw",
    myRating: typeof mine.rating === "number" ? mine.rating : null,
    oppRating: typeof opp?.rating === "number" ? opp.rating : null,
    eco: eco && /^[A-E]\d\d$/.test(eco) ? eco : null,
    openingName: nameFromEcoUrl(pgnTag(g.pgn, "ECOUrl")),
    sans: sansFromPgn(g.pgn),
    evals: null,
  };
}

interface ChesscomStat {
  last?: { rating?: number; rd?: number };
  record?: { win?: number; loss?: number; draw?: number };
}
/** Ratings from /stats; rd above this counts as provisional (Glicko RD, ADR 0006). */
export const CHESSCOM_PROVISIONAL_RD = 100;

export function chesscomRatings(stats: Record<string, ChesscomStat | unknown>): Ratings {
  const ratings: Ratings = {};
  for (const tc of ["bullet", "blitz", "rapid"] as const) {
    const s = stats?.[`chess_${tc}`] as ChesscomStat | undefined;
    const r = s?.last?.rating;
    if (typeof r !== "number") continue;
    const games = (s?.record?.win ?? 0) + (s?.record?.loss ?? 0) + (s?.record?.draw ?? 0);
    ratings[tc] = { rating: r, games, provisional: (s?.last?.rd ?? 0) > CHESSCOM_PROVISIONAL_RD };
  }
  return ratings;
}

/**
 * Monthly archive URLs to fetch, newest first: every month from the month of
 * `since` (or `now − months`, whichever is later) up to now. The caller stops
 * early once it has enough games.
 */
export function monthsToFetch(archives: string[], since: Date | null, now: Date, months: number): string[] {
  const floor = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (months - 1), 1));
  const from = since && since > floor ? new Date(Date.UTC(since.getUTCFullYear(), since.getUTCMonth(), 1)) : floor;
  const key = (y: number, m: number) => y * 12 + (m - 1);
  const min = key(from.getUTCFullYear(), from.getUTCMonth() + 1);
  return archives
    .map((url) => {
      const m = url.match(/\/games\/(\d{4})\/(\d{2})$/);
      return m ? { url, k: key(Number(m[1]), Number(m[2])) } : null;
    })
    .filter((x): x is { url: string; k: number } => !!x && x.k >= min)
    .sort((a, b) => b.k - a.k)
    .map((x) => x.url);
}
