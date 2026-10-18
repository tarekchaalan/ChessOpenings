/**
 * Shared types for the pure openings build library (no Node APIs).
 * See docs/design/0001-data-pipeline-and-identity.md.
 */

export type Side = "white" | "black";

export interface SourceFile {
  /** POSIX path relative to the watched root, e.g. "all-openings/a.tsv" */
  path: string;
  text: string;
}

export interface Issue {
  level: "error" | "warning";
  message: string;
  file?: string;
  line?: number;
  ply?: number;
  token?: string;
}

/** One data row of a TSV file after column mapping, before replay. */
export interface TsvRow {
  file: string;
  line: number;
  eco: string | null;
  name: string;
  /** move tokens with numbers, results, NAGs and !? suffixes stripped */
  tokens: string[];
  extra?: Record<string, string>;
}

/** One replayed half-move. */
export interface Ply {
  /** chess.js SAN including +/# (display) */
  san: string;
  /** SAN without +#!? (identity) */
  norm: string;
  from: string;
  to: string;
  epd: string;
}

/** A validated, replayed row. */
export interface Row {
  rowId: string;
  eco: string | null;
  name: string;
  /** names of later rows with the same move sequence */
  aliases: string[];
  plies: Ply[];
  file: string;
  line: number;
  extra?: Record<string, string>;
}

export interface MoveStatEntry {
  games: number;
  w: number;
  d: number;
  b: number;
}

/** Position-stats table (data/derived/position-stats.v1.json.gz). */
export interface PositionStats {
  format: "chess-openings-trainer/position-stats@1";
  maxPly: number;
  minGames: number;
  /** epd → [games, w, d, b, [[san, games, w, d, b], ...]] */
  positions: Record<string, [number, number, number, number, [string, number, number, number, number][]]>;
}

/** Move flags in the runtime dataset. */
export const MOVE_THEORY = 1;
export const MOVE_EXT = 2;
