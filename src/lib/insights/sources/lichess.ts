/**
 * Lichess parsers (API verified in docs/qa/insights/phase0/api-verification.md):
 * one ndjson game from GET /api/games/user/{u}, and the profile from
 * GET /api/user/{u}.
 */
import type { Score } from "@/lib/engine/uci";
import { TIME_CLASSES, type NormalGame, type Ratings, type Skip, type TimeClass } from "../types";

interface LichessPlayer {
  user?: { name?: string; id?: string };
  rating?: number;
}
export interface LichessGame {
  id: string;
  rated?: boolean;
  variant?: string;
  speed?: string;
  createdAt?: number;
  lastMoveAt?: number;
  status?: string;
  players?: { white?: LichessPlayer; black?: LichessPlayer };
  winner?: "white" | "black";
  opening?: { eco?: string; name?: string };
  moves?: string;
  initialFen?: string;
  analysis?: ({ eval?: number; mate?: number } | undefined)[];
}

const isTimeClass = (s: unknown): s is TimeClass => TIME_CLASSES.includes(s as TimeClass);

export function parseLichessGame(g: LichessGame, me: string): NormalGame | Skip {
  const id = me.toLowerCase();
  const white = g.players?.white?.user?.id?.toLowerCase();
  const black = g.players?.black?.user?.id?.toLowerCase();
  if (white !== id && black !== id) return { skip: "not-player" };
  if (!g.id || typeof g.moves !== "string") return { skip: "unreadable" };
  const color = white === id ? "white" : "black";
  const opp = color === "white" ? g.players?.black : g.players?.white;
  const mine = color === "white" ? g.players?.white : g.players?.black;
  const ts = g.lastMoveAt ?? g.createdAt;
  if (typeof ts !== "number") return { skip: "unreadable" };
  const evals: (Score | null)[] | null = g.analysis
    ? g.analysis.map((a) => (a && typeof a.mate === "number" ? { mate: a.mate } : a && typeof a.eval === "number" ? { cp: a.eval } : null))
    : null;
  return {
    platform: "lichess",
    gameId: g.id,
    color,
    timeClass: isTimeClass(g.speed) ? g.speed : null,
    rated: g.rated === true,
    standard: g.variant === "standard" && !g.initialFen,
    playedAt: new Date(ts).toISOString(),
    result: !g.winner ? "draw" : g.winner === color ? "win" : "loss",
    myRating: typeof mine?.rating === "number" ? mine.rating : null,
    oppRating: typeof opp?.rating === "number" ? opp.rating : null,
    eco: g.opening?.eco ?? null,
    openingName: g.opening?.name ?? null,
    sans: g.moves.split(" ").filter(Boolean),
    evals,
  };
}

interface LichessUser {
  id?: string;
  username?: string;
  disabled?: boolean;
  perfs?: Record<string, { games?: number; rating?: number; prov?: boolean }>;
}

export function lichessProfile(u: LichessUser): { username: string; ratings: Ratings } | null {
  if (!u?.username || u.disabled) return null;
  const ratings: Ratings = {};
  for (const tc of TIME_CLASSES) {
    const p = u.perfs?.[tc];
    if (p && typeof p.rating === "number" && (p.games ?? 0) > 0) ratings[tc] = { rating: p.rating, games: p.games ?? 0, provisional: p.prov === true };
  }
  return { username: u.username, ratings };
}

/** Split an ndjson chunk stream into lines; keeps the trailing partial line in `rest`. */
export function splitNdjson(rest: string, chunk: string): { lines: string[]; rest: string } {
  const text = rest + chunk;
  const parts = text.split("\n");
  const tail = parts.pop() ?? "";
  return { lines: parts.map((l) => l.trim()).filter(Boolean), rest: tail };
}
