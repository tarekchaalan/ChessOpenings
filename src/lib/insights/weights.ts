/**
 * Every threshold and weight Insights uses, in one place (spec §3.3).
 * Changing a number here changes the page; the tests pin the behaviour.
 */
import type { Level } from "@/lib/openings-build/catalog";
import type { Platform } from "./types";

/** below this many games an opening's percentages are hidden as noise */
export const MIN_GAMES = 5;
/** "leaves book early": the player's own deviation before this ply (move 5) */
export const EARLY_PLY = 10;
/** a repeat deviation needs at least this many games */
export const REPEAT_MIN = 2;

/** Rating band lower edges per platform (bands 1–5, never converted between platforms). */
export const BAND_EDGES: Record<Platform, number[]> = {
  lichess: [0, 1300, 1600, 1900, 2200],
  chesscom: [0, 800, 1200, 1600, 2000],
};
export const BAND_NAMES = ["Beginner", "Improving", "Club", "Strong club", "Expert+"] as const;
/** catalog levels that suit each band; the first is the band's own level */
export const BAND_LEVELS: Record<number, Level[]> = {
  1: ["beginner"],
  2: ["beginner"],
  3: ["beginner", "intermediate"],
  4: ["intermediate", "advanced"],
  5: ["advanced", "intermediate", "beginner"],
};

export const FIX = {
  /** a family qualifies when the early share or the score crosses these */
  earlyShare: 0.4,
  maxScore: 0.4,
  w: { early: 1, score: 2, volume: 0.15 },
};

export const FILL = {
  minGames: 10,
  /** top reply below this share = no consistent answer */
  maxTopShare: 0.5,
  w: { gap: 1, volume: 0.15 },
};

export const GROW = {
  w: { common: 1, style: 1, level: 0.3 },
  /** suggestions per side */
  perSide: 2,
};

/** recommendations shown per kind (Fix, Fill, Grow) */
export const MAX_PER_KIND = 4;
/** Engine verdicts (Phase 4): positions per page visit and time per search. */
export const ENGINE = { positions: 10, movetimeMs: 700 };
