/**
 * Account Insights types (ADR 0006). A `NormalGame` is one platform game in a
 * common shape (never stored, never sent to our server); a `Summary` is what
 * survives the import: derived fields plus the first n plies.
 */
import type { Score } from "@/lib/engine/uci";
import type { Side } from "@/lib/openings-build/types";

export type { Side };
export type Platform = "lichess" | "chesscom";
export type TimeClass = "bullet" | "blitz" | "rapid" | "classical";
export type Result = "win" | "draw" | "loss";
export type DeviatedBy = "me" | "opponent" | "none";

export const PLATFORMS: Platform[] = ["lichess", "chesscom"];
export const TIME_CLASSES: TimeClass[] = ["bullet", "blitz", "rapid", "classical"];
export const PLATFORM_NAME: Record<Platform, string> = { lichess: "Lichess", chesscom: "Chess.com" };

export interface NormalGame {
  platform: Platform;
  /** Lichess "BCi6IZfn", Chess.com "live/183193101523" */
  gameId: string;
  color: Side;
  /** null: a time class outside the four we import (daily, correspondence, unknown) */
  timeClass: TimeClass | null;
  rated: boolean;
  /** standard rules from the standard start position */
  standard: boolean;
  /** ISO timestamp of the game's end */
  playedAt: string;
  result: Result;
  myRating: number | null;
  oppRating: number | null;
  /** the platform's own classification, display only */
  eco: string | null;
  openingName: string | null;
  sans: string[];
  /** Lichess server analysis: score after each ply, White's side (null entries where absent) */
  evals: (Score | null)[] | null;
}

export interface Summary {
  platform: Platform;
  gameId: string;
  color: Side;
  timeClass: TimeClass;
  playedAt: string;
  result: Result;
  myRating: number | null;
  oppRating: number | null;
  eco: string | null;
  openingName: string | null;
  /** the first n plies (normalised SAN), n = maxBookPly of the matching dataset */
  openingPlies: string[];
  bookPly: number;
  deviatedBy: DeviatedBy;
  /** position before the first non-book move */
  deviationEpd: string | null;
  playedSan: string | null;
  /** theory moves available at deviationEpd, most played first */
  bookSans: string[] | null;
  /** centipawns from the mover's side, before and after the deviating move (Lichess analysis) */
  evalBefore: number | null;
  evalAfter: number | null;
  datasetHash: string;
}

export interface RatingInfo {
  rating: number;
  games: number;
  provisional: boolean;
}
export type Ratings = Partial<Record<TimeClass, RatingInfo>>;

export interface LinkedAccount {
  platform: Platform;
  username: string;
  verified: boolean;
  ratings: Ratings;
  linkedAt: string;
  lastSyncedAt: string | null;
  lastGameAt: string | null;
}

/** A parser's answer for a game it won't import, with the reason (counted in the UI). */
export interface Skip {
  skip: "variant" | "unrated" | "time-class" | "unreadable" | "not-player";
}
export const isSkip = (g: NormalGame | Skip): g is Skip => "skip" in g;
