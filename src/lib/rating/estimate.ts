/**
 * Estimated Elo (ADR 0008): one number, on an Elo-like scale close to FIDE,
 * from a player's Lichess and Chess.com ratings, or from what they say about
 * themselves when no linked rating is reliable yet. Pure; tested in
 * __tests__/estimate.test.ts.
 *
 * It's an estimate and the page says so. The conversion tables below are
 * approximations of public rating-comparison surveys (ChessGoals; Matt Jensen,
 * "Are chess.com ratings the most accurate?", 2020: ±130–165 per column), which
 * put Lichess about 200–300 above FIDE below ~2400 (100–200 above it higher
 * up), and Chess.com about 200 below FIDE under 2000 and above it from ~2000.
 * Tune the points here; every consumer reads them through estimateElo().
 *
 * New accounts: Lichess starts everyone at 1500 (shown "1500?", provisional)
 * and Chess.com at the level picked on sign-up (400 / 800 / 1200 / 1600 /
 * 2000). A rating with fewer than MIN_GAMES games is still mostly that starter
 * number, so it doesn't count; a provisional one counts at a quarter weight.
 */
import { PLATFORM_NAME, TIME_CLASSES, type Platform, type Ratings, type TimeClass } from "@/lib/insights/types";

/** [platform rating, estimated Elo] points; linear between them, slope 1 beyond the ends. */
export const TO_ELO: Record<Platform, [number, number][]> = {
  lichess: [
    [600, 400],
    [1000, 700],
    [1400, 1100],
    [1800, 1550],
    [2200, 2000],
    [2600, 2450],
    [3000, 2850],
  ],
  chesscom: [
    [200, 400],
    [600, 800],
    [1000, 1200],
    [1400, 1550],
    [1800, 1850],
    [2200, 2100],
    [2600, 2400],
    [3200, 2800],
  ],
};

/** Below this many games a rating is still mostly the account's starting number. */
export const MIN_GAMES = 20;
/** How much each time class says about opening and overall strength. */
export const TC_WEIGHT: Record<TimeClass, number> = { classical: 1, rapid: 1, blitz: 0.8, bullet: 0.4 };
/** A provisional rating (high deviation: few or old games) counts at this share. */
export const PROVISIONAL_WEIGHT = 0.25;
/** Each rating's weight grows with games up to this many. */
export const FULL_WEIGHT_GAMES = 100;
/** Ratings a new account starts at, per platform (for the explanation only). */
export const STARTER_RATINGS: Record<Platform, number[]> = { lichess: [1500], chesscom: [400, 800, 1200, 1600, 2000] };

export type SelfLevel = "new" | "basics" | "casual" | "club" | "strong";

export const SELF_LEVELS: { id: SelfLevel; label: string; help: string; elo: number }[] = [
  { id: "new", label: "New to chess", help: "I'm still learning how the pieces move.", elo: 600 },
  { id: "basics", label: "I know the basics", help: "I play now and then and know a couple of openings.", elo: 900 },
  { id: "casual", label: "Casual player", help: "I play online regularly.", elo: 1200 },
  { id: "club", label: "Club player", help: "I play at a club or in tournaments.", elo: 1600 },
  { id: "strong", label: "Strong player", help: "Around 2000 or above, or titled.", elo: 2000 },
];

export type Confidence = "high" | "medium" | "low";

export interface Basis {
  platform: Platform;
  timeClass: TimeClass;
  rating: number;
  games: number;
  provisional: boolean;
  /** the rating on the estimate's scale */
  elo: number;
  weight: number;
}

export interface Ignored {
  platform: Platform;
  timeClass: TimeClass;
  rating: number;
  games: number;
  reason: "too-new";
}

export interface Estimate {
  elo: number;
  low: number;
  high: number;
  confidence: Confidence;
  source: "ratings" | "self";
  basis: Basis[];
  ignored: Ignored[];
  self: SelfLevel | null;
}

/** Piecewise-linear conversion of a platform rating to the estimate's scale. */
export function toElo(platform: Platform, rating: number): number {
  const pts = TO_ELO[platform];
  if (rating <= pts[0][0]) return pts[0][1] - (pts[0][0] - rating);
  for (let i = 1; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x0, y0] = pts[i - 1];
    if (rating <= x1) return y0 + ((rating - x0) * (y1 - y0)) / (x1 - x0);
  }
  const [xl, yl] = pts[pts.length - 1];
  return yl + (rating - xl);
}

const MARGIN: Record<Confidence, number> = { high: 150, medium: 200, low: 300 };
const clampElo = (x: number) => Math.min(3500, Math.max(100, x));
const round10 = (x: number) => Math.round(x / 10) * 10;

/**
 * The estimate from the linked accounts' ratings, else from the self-reported
 * level; null when neither gives anything (e.g. only brand-new accounts and no
 * answer yet: ask the player).
 */
export function estimateElo(accounts: Partial<Record<Platform, { ratings: Ratings }>>, self: SelfLevel | null = null): Estimate | null {
  const basis: Basis[] = [];
  const ignored: Ignored[] = [];
  for (const platform of ["lichess", "chesscom"] as Platform[]) {
    const ratings = accounts[platform]?.ratings ?? {};
    for (const timeClass of TIME_CLASSES) {
      const r = ratings[timeClass];
      if (!r || typeof r.rating !== "number" || !Number.isFinite(r.rating)) continue;
      const games = Math.max(0, r.games ?? 0);
      if (games < MIN_GAMES) {
        ignored.push({ platform, timeClass, rating: r.rating, games, reason: "too-new" });
        continue;
      }
      const weight = TC_WEIGHT[timeClass] * (r.provisional ? PROVISIONAL_WEIGHT : 1) * Math.min(1, games / FULL_WEIGHT_GAMES);
      basis.push({ platform, timeClass, rating: r.rating, games, provisional: r.provisional, elo: toElo(platform, r.rating), weight });
    }
  }

  if (basis.length) {
    const total = basis.reduce((a, b) => a + b.weight, 0);
    const elo = clampElo(round10(basis.reduce((a, b) => a + b.elo * b.weight, 0) / total));
    // games that really measure strength: established, not bullet
    const solid = basis.filter((b) => !b.provisional && b.timeClass !== "bullet").reduce((a, b) => a + b.games, 0);
    const confidence: Confidence = solid >= 150 ? "high" : solid >= 40 ? "medium" : "low";
    basis.sort((a, b) => b.weight - a.weight);
    return { elo, low: clampElo(elo - MARGIN[confidence]), high: clampElo(elo + MARGIN[confidence]), confidence, source: "ratings", basis, ignored, self };
  }
  const level = SELF_LEVELS.find((l) => l.id === self);
  if (level) {
    return { elo: level.elo, low: clampElo(level.elo - MARGIN.low), high: clampElo(level.elo + MARGIN.low), confidence: "low", source: "self", basis: [], ignored, self };
  }
  return null;
}

/** "Lichess blitz 1720 (900 games)" */
export function basisText(b: { platform: Platform; timeClass: TimeClass; rating: number; games: number; provisional?: boolean }): string {
  return `${PLATFORM_NAME[b.platform]} ${b.timeClass} ${b.rating}${b.provisional ? "?" : ""} (${b.games} ${b.games === 1 ? "game" : "games"})`;
}

/** Why a rating didn't count, in words. */
export function ignoredText(i: Ignored): string {
  const starter = STARTER_RATINGS[i.platform].includes(i.rating) ? ", still at the starting rating" : "";
  return `${PLATFORM_NAME[i.platform]} ${i.timeClass} ${i.rating} after ${i.games} ${i.games === 1 ? "game" : "games"}${starter}: too new to count (needs ${MIN_GAMES}).`;
}

/** What the stored setup row keeps of an estimate (save_setup's `estimate`). */
export function estimateRecord(e: Estimate): Record<string, unknown> {
  return {
    confidence: e.confidence,
    low: e.low,
    high: e.high,
    source: e.source,
    basis: e.basis.map((b) => ({ platform: b.platform, timeClass: b.timeClass, rating: b.rating, games: b.games, provisional: b.provisional, weight: Math.round(b.weight * 100) / 100 })),
  };
}
