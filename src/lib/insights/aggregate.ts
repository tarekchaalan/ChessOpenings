/**
 * Aggregation over imported summaries (spec §3.2). Every number here is
 * computed from the player's own games; nothing comes from master statistics.
 */
import { modelOf } from "@/lib/courses-client";
import type { Dataset } from "@/lib/openings";
import { deepestName } from "@/lib/openings-build/model";
import { bookPath } from "./book";
import { trainLink, type TrainLink } from "./links";
import { EARLY_PLY, MIN_GAMES, REPEAT_MIN } from "./weights";
import type { Platform, Result, Side, Summary, TimeClass } from "./types";

/** A summary with its book path and the dataset's opening name. */
export interface Analysed extends Summary {
  path: number[];
  /** opening family ("Sicilian Defense"), from the dataset's names */
  family: string;
  /** deepest named position on the path */
  name: string;
}

export const UNNAMED = "Other first moves";

export function analyse(ds: Dataset, summaries: Summary[]): Analysed[] {
  const model = modelOf(ds);
  return summaries.map((s) => {
    const path = bookPath(model, s.openingPlies, s.bookPly);
    const row = deepestName(model, path);
    return { ...s, path, family: row?.family ?? UNNAMED, name: row?.name ?? UNNAMED };
  });
}

export interface Wdl {
  games: number;
  w: number;
  d: number;
  l: number;
  /** (W + D/2) / N, 0 when empty */
  score: number;
}

const tally = (rs: Result[]): Wdl => {
  const w = rs.filter((r) => r === "win").length;
  const d = rs.filter((r) => r === "draw").length;
  const l = rs.length - w - d;
  return { games: rs.length, w, d, l, score: rs.length ? (w + d / 2) / rs.length : 0 };
};

export interface OpeningRow extends Wdl {
  family: string;
  color: Side;
  /** mean plies in book */
  avgBookPly: number;
  /** games where I / the opponent played the first non-book move */
  byMe: Wdl;
  byOpp: Wdl;
  /** games still in book when they ended (or through the deepest theory) */
  inBook: number;
  /** my deviation before EARLY_PLY */
  early: number;
  /** enough games to show percentages */
  enough: boolean;
  link: TrainLink;
}

/** Results and book exits per (opening family, color), most played first. */
export function byOpening(ds: Dataset, games: Analysed[]): OpeningRow[] {
  const groups = new Map<string, Analysed[]>();
  for (const g of games) {
    const k = `${g.family}|${g.color}`;
    let list = groups.get(k);
    if (!list) groups.set(k, (list = []));
    list.push(g);
  }
  const rows: OpeningRow[] = [];
  for (const list of groups.values()) {
    const { family, color } = list[0];
    // link to where this player's games in the family most often leave book
    const exits = new Map<number, { n: number; g: Analysed }>();
    for (const g of list) {
      const end = g.path[g.path.length - 1];
      const e = exits.get(end);
      if (e) e.n++;
      else exits.set(end, { n: 1, g });
    }
    const rep = [...exits.values()].sort((a, b) => b.n - a.n || b.g.path.length - a.g.path.length)[0].g;
    rows.push({
      family,
      color,
      ...tally(list.map((g) => g.result)),
      avgBookPly: list.reduce((a, g) => a + g.bookPly, 0) / list.length,
      byMe: tally(list.filter((g) => g.deviatedBy === "me").map((g) => g.result)),
      byOpp: tally(list.filter((g) => g.deviatedBy === "opponent").map((g) => g.result)),
      inBook: list.filter((g) => g.deviatedBy === "none").length,
      early: list.filter((g) => g.deviatedBy === "me" && g.bookPly < EARLY_PLY).length,
      enough: list.length >= MIN_GAMES,
      link: trainLink(ds, rep.path, color),
    });
  }
  return rows.sort((a, b) => b.games - a.games || a.family.localeCompare(b.family));
}

export interface RepeatGroup extends Wdl {
  epd: string;
  color: Side;
  playedSan: string;
  bookSans: string[];
  /** the moves leading to the position (display, MiniBoard) */
  plies: string[];
  name: string;
  /** Lichess server evaluation at the deviation (mover's side), when a game had one */
  evalBefore: number | null;
  evalAfter: number | null;
  gameIds: string[];
  link: TrainLink;
}

/** Positions where I played the same non-book move at least REPEAT_MIN times, most frequent first. */
export function repeatDeviations(ds: Dataset, games: Analysed[]): RepeatGroup[] {
  const groups = new Map<string, Analysed[]>();
  for (const g of games) {
    if (g.deviatedBy !== "me" || !g.deviationEpd || !g.playedSan) continue;
    const k = `${g.deviationEpd}|${g.playedSan}`;
    let list = groups.get(k);
    if (!list) groups.set(k, (list = []));
    list.push(g);
  }
  const out: RepeatGroup[] = [];
  for (const list of groups.values()) {
    if (list.length < REPEAT_MIN) continue;
    const g = list[0];
    const evaluated = list.find((x) => x.evalBefore !== null && x.evalAfter !== null);
    out.push({
      epd: g.deviationEpd!,
      color: g.color,
      playedSan: g.playedSan!,
      bookSans: g.bookSans ?? [],
      plies: g.openingPlies.slice(0, g.bookPly),
      name: g.name,
      ...tally(list.map((x) => x.result)),
      evalBefore: evaluated?.evalBefore ?? null,
      evalAfter: evaluated?.evalAfter ?? null,
      gameIds: list.map((x) => `${x.platform}:${x.gameId}`),
      link: trainLink(ds, g.path, g.color),
    });
  }
  return out.sort((a, b) => b.games - a.games || a.score - b.score);
}

export interface InsightsSummary {
  games: number;
  perPlatform: Partial<Record<Platform, Partial<Record<TimeClass, number>>>>;
  from: string | null;
  to: string | null;
  byColor: Record<Side, Wdl>;
}

export function summary(games: Summary[]): InsightsSummary {
  const perPlatform: InsightsSummary["perPlatform"] = {};
  for (const g of games) {
    const p = (perPlatform[g.platform] ??= {});
    p[g.timeClass] = (p[g.timeClass] ?? 0) + 1;
  }
  const times = games.map((g) => g.playedAt).sort();
  return {
    games: games.length,
    perPlatform,
    from: times[0] ?? null,
    to: times[times.length - 1] ?? null,
    byColor: {
      white: tally(games.filter((g) => g.color === "white").map((g) => g.result)),
      black: tally(games.filter((g) => g.color === "black").map((g) => g.result)),
    },
  };
}
