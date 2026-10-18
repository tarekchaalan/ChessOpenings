/**
 * Catalog helpers (§3.2 A, B, F): search over names / ECO / move strings,
 * position → best course and line (the build's `pos` index), hub card data,
 * and per-line learning status from the learner's cards.
 */
import type { Dataset } from "./openings";
import type { RawCourseSummary, RawHubSummary, RawSystemSummary } from "./openings-build/catalog";
import type { Course, CourseLine } from "./openings-build/courses";
import { normSan, type Model } from "./openings-build/model";
import { cardKey, isMature, isReviewable, type CardState, type Side } from "./srs/fsrs";
import { modelOf } from "./courses-client";

/** Lower-case, accent-free, punctuation-light (Grünfeld → grunfeld, Réti → reti). */
export const fold = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/['’`\-,:()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const FIGURINE: Record<string, string> = { "♔": "K", "♕": "Q", "♖": "R", "♗": "B", "♘": "N", "♚": "K", "♛": "Q", "♜": "R", "♝": "B", "♞": "N", "♙": "", "♟": "" };
const SAN_RE = /^(O-O(-O)?|[KQRBN]?[a-h]?[1-8]?x?[a-h][1-8](=[QRBN])?)[+#]?$/;

/** "1.e4 c5 2. Nf3", "e4 c5 ♘f3" → normalised SANs, or null when it isn't a move string. */
export function parseMoveQuery(q: string): string[] | null {
  const tokens = q
    .replace(/[♔♕♖♗♘♙♚♛♜♝♞♟]/g, (c) => FIGURINE[c])
    .replace(/\d+\.(\.\.)?|…/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (!tokens.length || !tokens.every((t) => SAN_RE.test(t.replace(/0/g, "O")))) return null;
  return tokens.map((t) => normSan(t.replace(/0/g, "O")));
}

/** Levenshtein distance ≤ 1 (one typo), for fuzzy name terms. */
function nearlyEqual(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else {
      i++;
      j++;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

/** A name term matches a word by prefix, or by one typo for longer terms. */
function termMatches(term: string, words: string[]): number {
  let best = 0;
  for (const w of words) {
    if (w === term) return 3;
    if (w.startsWith(term)) best = Math.max(best, 2);
    else if (term.length >= 5 && (nearlyEqual(term, w) || nearlyEqual(term, w.slice(0, term.length)))) best = Math.max(best, 1);
  }
  return best;
}

export interface SearchHit {
  row: number;
  name: string;
  eco: string | null;
  sans: string[];
  /** the hub to open (the row's best listed hub) */
  hub: RawHubSummary | null;
}

const hubsOfRowCache = new WeakMap<Dataset, Map<number, RawHubSummary[]>>();
/** Row → hubs that contain it, top-level and curated first. */
export function hubsOfRow(ds: Dataset): Map<number, RawHubSummary[]> {
  let m = hubsOfRowCache.get(ds);
  if (!m) {
    m = new Map();
    const hubs = ds.raw?.catalog?.hubs ?? [];
    const rank = (h: RawHubSummary) => (h.placement === "top" ? 0 : 2) + (h.kind === "curated" ? 0 : 1);
    for (const h of [...hubs].sort((a, b) => rank(a) - rank(b) || b.games - a.games)) {
      for (const r of h.rowIdx) {
        if (!m.has(r)) m.set(r, []);
        m.get(r)!.push(h);
      }
    }
    hubsOfRowCache.set(ds, m);
  }
  return m;
}

const foldedCache = new WeakMap<Dataset, { name: string; words: string[] }[]>();
/** Folded row names, once per dataset (search runs on every keystroke). */
function foldedNames(ds: Dataset) {
  let f = foldedCache.get(ds);
  if (!f) {
    f = modelOf(ds).rows.map((r) => {
      const name = fold(r.name);
      return { name, words: name.split(" ") };
    });
    foldedCache.set(ds, f);
  }
  return f;
}

/**
 * Catalog search (§3.2 A): ECO codes and prefixes keep `searchOpenings`'
 * behaviour; move strings match rows by move-sequence prefix; anything else
 * is a fuzzy, accent-insensitive name search. Ranked by match then games.
 */
export function searchCatalog(ds: Dataset, query: string, limit = 30): SearchHit[] {
  const raw = query.trim();
  if (!raw) return [];
  const model = modelOf(ds);
  const byRow = hubsOfRow(ds);
  const hit = (r: number): SearchHit => {
    const row = model.rows[r];
    return { row: r, name: row.name, eco: row.eco, sans: row.sans, hub: byRow.get(r)?.[0] ?? null };
  };
  const games = (r: number) => model.nodes[model.rows[r].path[model.rows[r].path.length - 1]].games;
  const scored: { r: number; score: number }[] = [];

  const eco = /^([a-e])\s*(\d{0,2})$/i.exec(raw);
  const moves = parseMoveQuery(raw);
  // "e4" is both an ECO prefix (E4x) and a move: the move rows come first
  if (eco && moves) {
    const prefix = (eco[1] + eco[2]).toUpperCase();
    model.rows.forEach((row, r) => {
      if (row.norms[0] === moves[0] && moves.length === 1) scored.push({ r, score: 2000 - row.norms.length * 10 });
      else if (row.eco?.startsWith(prefix)) scored.push({ r, score: 1000 - row.norms.length });
    });
  } else if (eco) {
    const prefix = (eco[1] + eco[2]).toUpperCase();
    model.rows.forEach((row, r) => {
      if (row.eco?.startsWith(prefix)) scored.push({ r, score: 1000 - row.norms.length });
    });
  } else if (moves) {
    model.rows.forEach((row, r) => {
      if (row.norms.length < moves.length) return;
      for (let i = 0; i < moves.length; i++) if (row.norms[i] !== moves[i]) return;
      // the exact position first, then the shortest continuations
      scored.push({ r, score: 1000 - (row.norms.length - moves.length) * 10 });
    });
  } else {
    const terms = fold(raw).split(" ");
    const folded = foldedNames(ds);
    model.rows.forEach((row, r) => {
      const { name, words } = folded[r];
      let score = 0;
      for (const t of terms) {
        const m = termMatches(t, words);
        if (!m) return;
        score += m * 30;
      }
      if (name.startsWith(terms[0])) score += 40;
      score -= Math.min(30, row.norms.length);
      scored.push({ r, score });
    });
  }
  scored.sort((a, b) => b.score - a.score || games(b.r) - games(a.r));
  return scored.slice(0, limit).map((s) => hit(s.r));
}

// ── position → course ─────────────────────────────────────────────────────

export interface Target {
  hub: RawHubSummary;
  system: RawSystemSummary;
  course: RawCourseSummary;
  /** line index in the derived course (identical in build and browser) */
  line: number;
  /** node the target was asked for */
  node: number;
  /** node the course was found at (a reply's position when the other side is to move) */
  at: number;
}

function targetAt(ds: Dataset, node: number): Target | null {
  const cat = ds.raw?.catalog;
  if (!cat) return null;
  const ci = cat.pos[2 * node];
  if (ci === undefined || ci < 0) return null;
  const course = cat.courses[ci];
  const system = cat.systems[course.system];
  return { hub: cat.hubs[system.hub], system, course, line: cat.pos[2 * node + 1], node, at: node };
}

/**
 * The best course and line for `side` at a position (Explore's "Learn this
 * line"): the build's index when `side` is to move, else the most-played
 * reply that leads into one.
 */
export function positionTarget(ds: Dataset, node: number, side: Side): Target | null {
  const model = modelOf(ds);
  const nd = model.nodes[node];
  if (!nd) return null;
  if ((nd.white ? "white" : "black") === side) return targetAt(ds, node);
  for (const m of [...nd.moves].filter((x) => x.to >= 0).sort((a, b) => b.games - a.games)) {
    const t = targetAt(ds, m.to);
    if (t) return { ...t, node };
  }
  return null;
}

/** Best course for a search hit: the deepest position on the row where `side` is to move. */
export function rowTarget(ds: Dataset, row: number, side: Side): Target | null {
  const model = modelOf(ds);
  const path = model.rows[row].path;
  for (let i = path.length - 1; i >= 0; i--) {
    if ((model.nodes[path[i]].white ? "white" : "black") !== side) continue;
    const t = targetAt(ds, path[i]);
    if (t) return t;
  }
  return null;
}

export const trainHref = (t: Target, mode: "learn" | "drill" = "learn", extra = "") =>
  `/train/${t.hub.slug}/${t.system.slug}/${t.system.side}?mode=${mode}&li=${t.line}${extra}`;

// ── hub cards ─────────────────────────────────────────────────────────────

export interface HubCard {
  hub: RawHubSummary;
  system: RawSystemSummary | null;
  course: RawCourseSummary | null;
}

/** The hub's recommended system/course for a side (card chips and links). */
export function hubCard(ds: Dataset, hub: RawHubSummary, side: Side): HubCard {
  const cat = ds.raw!.catalog!;
  const sys = hub.systems[side].map((i) => cat.systems[i]);
  const system = sys.find((s) => s.recommended) ?? sys[0] ?? null;
  return { hub, system, course: system ? cat.courses[system.course] : null };
}

/** ECO volumes for "All openings" (A Flank · B Semi-open · C Open · D Closed · E Indian). */
export const ECO_VOLUMES: [string, string][] = [
  ["A", "Flank openings"],
  ["B", "Semi-open games"],
  ["C", "Open games"],
  ["D", "Closed games"],
  ["E", "Indian defences"],
];

// ── learning status ───────────────────────────────────────────────────────

export type LineStatus = "new" | "learning" | "due" | "mastered";

export interface LineProgressInfo {
  status: LineStatus;
  cards: number;
  known: number;
  mature: number;
  due: number;
  lastReviewed: string | null;
}

/** Status of a line from the cards of its learner moves (new → learning → due → mastered). */
export function lineProgress(model: Model, course: Course, line: CourseLine, cards: Record<string, CardState>, now = new Date()): LineProgressInfo {
  let total = 0;
  let known = 0;
  let mature = 0;
  let due = 0;
  let last: string | null = null;
  for (let p = course.side === "white" ? 0 : 1; p < line.sans.length; p += 2) {
    total++;
    const c = cards[cardKey(course.side, model.nodes[line.nodes[p]].epd, normSan(line.sans[p]))];
    if (!c || c.archived) continue;
    known++;
    if (isMature(c)) mature++;
    if (isReviewable(c, now)) due++;
    if (c.last_review && (!last || c.last_review > last)) last = c.last_review;
  }
  const status: LineStatus = !known ? "new" : due ? "due" : mature === total ? "mastered" : "learning";
  return { status, cards: total, known, mature, due, lastReviewed: last };
}

/** Course totals over a set of lines (each position counted once). */
export function courseProgressInfo(model: Model, course: Course, lines: number[], cards: Record<string, CardState>, now = new Date()) {
  const seen = new Set<string>();
  let total = 0;
  let mature = 0;
  let due = 0;
  let known = 0;
  for (const li of lines) {
    const line = course.lines[li];
    for (let p = course.side === "white" ? 0 : 1; p < line.sans.length; p += 2) {
      const key = cardKey(course.side, model.nodes[line.nodes[p]].epd, normSan(line.sans[p]));
      if (seen.has(key)) continue;
      seen.add(key);
      total++;
      const c = cards[key];
      if (!c || c.archived) continue;
      known++;
      if (isMature(c)) mature++;
      if (isReviewable(c, now)) due++;
    }
  }
  return { total, known, mature, due, mastery: total ? mature / total : 0 };
}

/** ~10 s per review card: the time estimate on review counters. */
export const reviewMinutes = (cards: number) => Math.max(1, Math.round((cards * 10) / 60));
