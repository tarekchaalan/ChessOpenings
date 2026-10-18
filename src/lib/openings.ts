/**
 * Dataset access layer: loads the versioned opening graph and exposes
 * position-keyed navigation, name/ECO search, and per-opening line families.
 *
 * The dataset is a variation graph keyed by EPD (FEN minus move clocks):
 *   nodes[i]  = one chess position with popularity + win rates
 *   edges     = moves out of a position (named theory, plus stats-only
 *               "off book" moves seen in the games corpus)
 *   openings  = the 3.7k named ECO lines; each points at its defining node
 */

import type { RawDatasetV2 } from "./openings-build/dataset";

export const START_EPD = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -";

export interface MoveStat {
  san: string;
  /** destination node index, -1 when the move leaves named theory */
  to: number;
  games: number;
  white: number;
  draws: number;
  black: number;
  inTheory: boolean;
  /** v2: extension edge (master practice beyond named theory) */
  ext?: boolean;
}

export interface PositionNode {
  idx: number;
  epd: string;
  /** opening whose defining position is exactly this node, -1 if none */
  openingIdx: number;
  games: number;
  white: number;
  draws: number;
  black: number;
  moves: MoveStat[];
}

export interface Opening {
  id: number;
  eco: string;
  name: string;
  /** base name before the colon, e.g. "Sicilian Defense" */
  family: string;
  variation: string | null;
  sans: string[];
  nodeIdx: number;
  /** games reaching the defining position in the corpus */
  popularity: number;
  /** v2: stable content identity (§4.3); absent in the legacy v1 dataset */
  rowId?: string;
  /** v2: other names for the same move sequence */
  aliases?: string[];
}

export interface Dataset {
  version: string;
  /** v2: the raw build output (course derivation runs on it, ADR 0002) */
  raw?: RawDatasetV2;
  /** v2 build output hash (cache key + live-reload identity) */
  outputHash?: string;
  openings: Opening[];
  nodes: PositionNode[];
  byEpd: Map<string, number>;
}

interface RawDataset {
  format: string;
  version: string;
  startEpd: string;
  openings: [string, string, string, number][];
  nodes: [string, number, number, number, number, number, (string | number)[][]][];
}

// ---------------------------------------------------------------------------
// Loading. `loadDataset` (v2, live-reloading) lives in lib/dataset-live.ts;
// the legacy v1 dataset stays for the row-index-keyed Learn/Quiz screens
// until they are replaced (Phase 4) and progress is migrated (Phase 5).
// ---------------------------------------------------------------------------
let datasetPromise: Promise<Dataset> | null = null;

export function loadLegacyDataset(): Promise<Dataset> {
  if (!datasetPromise) {
    datasetPromise = fetch("/data/openings.v1.json")
      .then((r) => {
        if (!r.ok) throw new Error(`dataset fetch failed: ${r.status}`);
        return r.json() as Promise<RawDataset>;
      })
      .then(parseDataset);
  }
  return datasetPromise;
}

/** Decode the v2 graph (`chess-openings-trainer/graph@2`) into the shared shape. */
export function parseDatasetV2(raw: RawDatasetV2, outputHash: string): Dataset {
  const nodes: PositionNode[] = raw.nodes.map((n, idx) => ({
    idx,
    epd: n[0],
    openingIdx: n[1],
    games: n[2],
    white: n[3],
    draws: n[4],
    black: n[5],
    moves: n[6].map((e) => ({
      san: e[0],
      to: e[1],
      games: e[2],
      white: e[3],
      draws: e[4],
      black: e[5],
      inTheory: (e[6] & 1) === 1,
      ext: (e[6] & 2) === 2,
    })),
  }));
  const openings: Opening[] = raw.rows.map((r, id) => {
    const colon = r[2].indexOf(":");
    return {
      id,
      rowId: r[0],
      eco: r[1],
      name: r[2],
      family: colon === -1 ? r[2] : r[2].slice(0, colon),
      variation: colon === -1 ? null : r[2].slice(colon + 1).trim(),
      sans: r[3].split(" "),
      nodeIdx: r[4],
      popularity: nodes[r[4]].games,
      aliases: r[5],
    };
  });
  const byEpd = new Map<string, number>();
  nodes.forEach((n, i) => byEpd.set(n.epd, i));
  return { version: raw.lib, outputHash, openings, nodes, byEpd, raw };
}

export function parseDataset(raw: RawDataset): Dataset {
  const nodes: PositionNode[] = raw.nodes.map((n, idx) => ({
    idx,
    epd: n[0],
    openingIdx: n[1],
    games: n[2],
    white: n[3],
    draws: n[4],
    black: n[5],
    moves: n[6].map((e) => ({
      san: e[0] as string,
      to: e[1] as number,
      games: e[2] as number,
      white: e[3] as number,
      draws: e[4] as number,
      black: e[5] as number,
      inTheory: (e[1] as number) >= 0,
    })),
  }));
  const openings: Opening[] = raw.openings.map((o, id) => {
    const colon = o[1].indexOf(":");
    return {
      id,
      eco: o[0],
      name: o[1],
      family: colon === -1 ? o[1] : o[1].slice(0, colon),
      variation: colon === -1 ? null : o[1].slice(colon + 1).trim(),
      sans: o[2].split(" "),
      nodeIdx: o[3],
      popularity: nodes[o[3]].games,
    };
  });
  const byEpd = new Map<string, number>();
  nodes.forEach((n, i) => byEpd.set(n.epd, i));
  return { version: raw.version, openings, nodes, byEpd };
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------
const fold = (s: string) =>
  s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[''`-]/g, " ");

/**
 * Search openings by name and/or ECO code. Returns best matches ranked by
 * (match quality, popularity). Query examples: "najdorf", "B90", "sicilian dragon".
 */
export function searchOpenings(ds: Dataset, query: string, limit = 25): Opening[] {
  const q = fold(query.trim());
  if (!q) return [];
  const ecoMatch = /^([a-e])\s*(\d{0,2})$/i.exec(query.trim());
  const terms = q.split(/\s+/);
  const scored: { o: Opening; score: number }[] = [];
  for (const o of ds.openings) {
    let score = 0;
    if (ecoMatch) {
      const prefix = (ecoMatch[1] + ecoMatch[2]).toUpperCase();
      if (o.eco.startsWith(prefix)) score = 1000 - o.sans.length;
      else continue;
    } else {
      const name = fold(o.name);
      let all = true;
      for (const t of terms) {
        if (!name.includes(t)) { all = false; break; }
      }
      if (!all) continue;
      score = 100;
      if (name.startsWith(terms[0])) score += 50;
      // prefer shorter (more canonical) lines among equal name matches
      score -= Math.min(30, o.sans.length);
    }
    scored.push({ o, score });
  }
  scored.sort((a, b) => b.score - a.score || b.o.popularity - a.o.popularity);
  return scored.slice(0, limit).map((s) => s.o);
}

/** Distinct opening families (base names) ranked by popularity — the catalog. */
export function openingCatalog(ds: Dataset): { root: Opening; variations: number }[] {
  const byFamily = new Map<string, { root: Opening; variations: number }>();
  for (const o of ds.openings) {
    const cur = byFamily.get(o.family);
    if (!cur) {
      byFamily.set(o.family, { root: o, variations: 1 });
    } else {
      cur.variations++;
      // the family root is the shortest line (most canonical entry point)
      if (
        o.sans.length < cur.root.sans.length ||
        (o.sans.length === cur.root.sans.length && o.popularity > cur.root.popularity)
      ) {
        cur.root = o;
      }
    }
  }
  return [...byFamily.values()].sort((a, b) => b.root.popularity - a.root.popularity);
}

// ---------------------------------------------------------------------------
// Position graph navigation
// ---------------------------------------------------------------------------
export function nodeAt(ds: Dataset, epd: string): PositionNode | null {
  const idx = ds.byEpd.get(epd);
  return idx === undefined ? null : ds.nodes[idx];
}

/**
 * The deepest named opening along a played line (lichess naming convention).
 * `epds` is the sequence of positions from the start, most recent last.
 */
export function nameForLine(ds: Dataset, epds: string[]): Opening | null {
  for (let i = epds.length - 1; i >= 0; i--) {
    const n = nodeAt(ds, epds[i]);
    if (n && n.openingIdx !== -1) return ds.openings[n.openingIdx];
  }
  return null;
}

// ---------------------------------------------------------------------------
// Line families (an opening + all named lines that extend it)
// ---------------------------------------------------------------------------
export interface Family {
  root: Opening;
  /** every named line whose SAN sequence starts with the root's line */
  lines: Opening[];
}

export function familyOf(ds: Dataset, openingId: number): Family {
  const root = ds.openings[openingId];
  const prefix = root.sans;
  const lines = ds.openings.filter(
    (o) => o.sans.length >= prefix.length && prefix.every((s, i) => o.sans[i] === s)
  );
  return { root, lines };
}

/**
 * Moves that continue named theory from a line prefix, restricted to a family.
 * Weighted by real game counts from the corpus (via the position graph).
 */
export function familyNextMoves(
  ds: Dataset,
  family: Family,
  prefix: string[],
  epd: string
): { san: string; games: number; lines: number }[] {
  const counts = new Map<string, { games: number; lines: number }>();
  for (const line of family.lines) {
    if (line.sans.length <= prefix.length) continue;
    let match = true;
    for (let i = 0; i < prefix.length; i++) {
      if (line.sans[i] !== prefix[i]) { match = false; break; }
    }
    if (!match) continue;
    const san = line.sans[prefix.length];
    const cur = counts.get(san) ?? { games: 0, lines: 0 };
    cur.lines++;
    counts.set(san, cur);
  }
  const node = nodeAt(ds, epd);
  if (node) {
    for (const mv of node.moves) {
      const cur = counts.get(mv.san);
      if (cur) cur.games = mv.games;
    }
  }
  return [...counts.entries()]
    .map(([san, c]) => ({ san, ...c }))
    .sort((a, b) => b.games - a.games || b.lines - a.lines);
}

/**
 * The positions a user training `family` from `side` must answer, walking the
 * top lines of the family. Used for mastery denominators and Learn mode.
 */
export function trainablePlies(family: Family, side: "white" | "black"): number {
  const seen = new Set<string>();
  for (const line of family.lines) {
    for (let i = 0; i < line.sans.length; i++) {
      const isWhiteMove = i % 2 === 0;
      if ((side === "white") === isWhiteMove) {
        seen.add(line.sans.slice(0, i).join(" "));
      }
    }
  }
  return seen.size;
}

/** Heuristic default training side for an opening. */
export function defaultSide(o: Opening): "white" | "black" {
  return /defen[cs]e|counter|indian|sicilian|caro|scandinavian|alekhine|grünfeld|gruenfeld|dutch|benoni|benko/i.test(
    o.name
  )
    ? "black"
    : "white";
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------
export function winRateBar(white: number, draws: number, black: number) {
  const total = white + draws + black;
  if (!total) return { white: 33.3, draws: 33.4, black: 33.3, total: 0 };
  return {
    white: (white / total) * 100,
    draws: (draws / total) * 100,
    black: (black / total) * 100,
    total,
  };
}

export function sansToPgn(sans: string[]): string {
  const parts: string[] = [];
  for (let i = 0; i < sans.length; i += 2) {
    parts.push(`${i / 2 + 1}. ${sans[i]}${sans[i + 1] ? " " + sans[i + 1] : ""}`);
  }
  return parts.join(" ");
}
