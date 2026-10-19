/**
 * Recommendations (spec §3.3, ADR 0006): Fix, Fill and Grow. Pure: the same
 * games, band and dataset give the same list. Weights live in weights.ts; each
 * reason is built only from numbers computed here.
 */
import { hubCard, positionTarget } from "@/lib/catalog-client";
import { catalogOf, modelOf } from "@/lib/courses-client";
import type { Dataset } from "@/lib/openings";
import type { RawHubSummary } from "@/lib/openings-build/catalog";
import type { Style } from "@/lib/openings-build/hubs";
import { bookPath } from "./book";
import { courseLink, type TrainLink } from "./links";
import type { Analysed, OpeningRow } from "./aggregate";
import { bandSource, type Band } from "./bands";
import { BAND_LEVELS, EARLY_PLY, FILL, FIX, GROW, MAX_PER_KIND, MIN_GAMES } from "./weights";
import type { Side } from "./types";

export type RecKind = "fix" | "fill" | "grow";

export interface Rec {
  kind: RecKind;
  color: Side;
  title: string;
  reason: string;
  score: number;
  link: TrainLink;
  /** hub slug when the recommendation is a hub (dedupe), else null */
  hub: string | null;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const cap = (s: Side) => (s === "white" ? "White" : "Black");
const moveLabel = (ply: number, san: string) => (ply % 2 === 0 ? `${ply / 2 + 1}.${san}` : `${(ply + 1) / 2}…${san}`);

// ── Fix ─────────────────────────────────────────────────────────────────────

export function fixRecs(rows: OpeningRow[]): Rec[] {
  const out: Rec[] = [];
  for (const r of rows) {
    if (!r.enough) continue;
    const earlyShare = r.early / r.games;
    const early = earlyShare >= FIX.earlyShare;
    const low = r.score <= FIX.maxScore;
    if (!early && !low) continue;
    const reason = early
      ? `You leave the ${r.family} by move ${EARLY_PLY / 2} in ${pct(earlyShare)} of games as ${cap(r.color)} (${r.early} of ${r.games}).`
      : `You score ${pct(r.score)} with the ${r.family} as ${cap(r.color)} (${r.w} won, ${r.d} drawn, ${r.l} lost).`;
    const score = FIX.w.early * earlyShare + FIX.w.score * Math.max(0, 0.5 - r.score) + FIX.w.volume * Math.log2(r.games);
    out.push({ kind: "fix", color: r.color, title: r.link.courseName, reason, score, link: r.link, hub: null });
  }
  return out.sort((a, b) => b.score - a.score);
}

// ── Fill ────────────────────────────────────────────────────────────────────

const against = (san: string): RawHubSummary["against"] => (san === "e4" ? "e4" : san === "d4" ? "d4" : "other");
const agLabel = (a: RawHubSummary["against"]) => (a === "e4" ? "1.e4" : a === "d4" ? "1.d4" : "other first moves");

function topHubs(ds: Dataset, side: Side, levels: string[], filter: (h: RawHubSummary) => boolean): RawHubSummary[] {
  const cat = catalogOf(ds);
  if (!cat) return [];
  return cat.hubs
    .filter((h) => h.placement === "top" && h.side === side && h.systems[side].length > 0 && levels.includes(h.level) && filter(h))
    .sort((a, b) => b.games - a.games || a.slug.localeCompare(b.slug));
}

function hubRec(ds: Dataset, h: RawHubSummary, side: Side): TrainLink | null {
  const c = hubCard(ds, h, side);
  if (!c.system || !c.course) return null;
  return courseLink({ hub: h, system: c.system, course: c.course, line: 0, node: h.sigmaNode, at: h.sigmaNode });
}

export function fillRecs(ds: Dataset, games: Analysed[], band: Band | null): Rec[] {
  const out: Rec[] = [];
  const levels = band ? BAND_LEVELS[band.band] : ["beginner", "intermediate"];
  // Black: one answer per first move
  const asBlack = new Map<RawHubSummary["against"], string[]>();
  for (const g of games) {
    if (g.color !== "black" || g.openingPlies.length < 2) continue;
    const a = against(g.openingPlies[0]);
    asBlack.set(a, [...(asBlack.get(a) ?? []), g.openingPlies[1]]);
  }
  for (const [a, replies] of asBlack) {
    const gap = consistency(replies);
    if (!gap) continue;
    const h = topHubs(ds, "black", levels, (x) => x.against === a)[0];
    const link = h && hubRec(ds, h, "black");
    if (!h || !link) continue;
    out.push({
      kind: "fill",
      color: "black",
      title: link.courseName,
      reason: `No consistent answer to ${agLabel(a)} as Black: ${replies.length} games, ${gap.distinct} different replies.`,
      score: FILL.w.gap * (1 - gap.topShare) + FILL.w.volume * Math.log2(replies.length),
      link,
      hub: h.slug,
    });
  }
  // White: one plan per Black reply
  const model = modelOf(ds);
  const asWhite = new Map<string, string[]>();
  for (const g of games) {
    if (g.color !== "white" || g.openingPlies.length < 3) continue;
    const k = `${g.openingPlies[0]} ${g.openingPlies[1]}`;
    asWhite.set(k, [...(asWhite.get(k) ?? []), g.openingPlies[2]]);
  }
  for (const [k, moves] of asWhite) {
    const gap = consistency(moves);
    if (!gap) continue;
    const pre = k.split(" ");
    const path = bookPath(model, pre, 2);
    if (path.length < 3) continue;
    const t = positionTarget(ds, path[2], "white");
    if (!t) continue;
    const link = courseLink(t);
    out.push({
      kind: "fill",
      color: "white",
      title: link.courseName,
      reason: `No consistent plan after ${moveLabel(0, pre[0])} ${pre[1]} as White: ${moves.length} games, ${gap.distinct} different second moves.`,
      score: FILL.w.gap * (1 - gap.topShare) + FILL.w.volume * Math.log2(moves.length),
      link,
      hub: t.hub.slug,
    });
  }
  return out.sort((a, b) => b.score - a.score);
}

function consistency(moves: string[]): { topShare: number; distinct: number } | null {
  if (moves.length < FILL.minGames) return null;
  const counts = new Map<string, number>();
  for (const m of moves) counts.set(m, (counts.get(m) ?? 0) + 1);
  const topShare = Math.max(...counts.values()) / moves.length;
  return topShare < FILL.maxTopShare ? { topShare, distinct: counts.size } : null;
}

// ── Grow ────────────────────────────────────────────────────────────────────

export interface StyleProfile {
  /** share of the side's games per tag */
  shares: Partial<Record<Style, number>>;
  tagged: number;
  games: number;
  known: boolean;
}

/** Style from the hubs (of the player's side) that the player's games reach. */
export function styleProfile(ds: Dataset, games: Analysed[], color: Side): StyleProfile {
  const hubs = (catalogOf(ds)?.hubs ?? []).filter((h) => h.side === color && h.tags.length);
  const mine = games.filter((g) => g.color === color);
  const counts: Partial<Record<Style, number>> = {};
  let tagged = 0;
  for (const g of mine) {
    const on = new Set(g.path);
    const tags = new Set(hubs.filter((h) => on.has(h.sigmaNode)).flatMap((h) => h.tags));
    if (tags.size) tagged++;
    for (const t of tags) counts[t] = (counts[t] ?? 0) + 1;
  }
  const shares: StyleProfile["shares"] = {};
  for (const [t, n] of Object.entries(counts) as [Style, number][]) shares[t] = n / Math.max(1, mine.length);
  return { shares, tagged, games: mine.length, known: tagged >= MIN_GAMES };
}

export function growRecs(ds: Dataset, games: Analysed[], band: Band | null): Rec[] {
  const out: Rec[] = [];
  const levels = band ? BAND_LEVELS[band.band] : ["beginner", "intermediate"];
  for (const color of ["white", "black"] as const) {
    const mine = games.filter((g) => g.color === color);
    const reached = new Set(mine.flatMap((g) => g.path));
    const faced = new Set(games.filter((g) => g.color === "black" && g.openingPlies.length).map((g) => against(g.openingPlies[0])));
    const set = topHubs(ds, color, levels, (h) => color === "white" || !faced.size || faced.has(h.against));
    const style = styleProfile(ds, games, color);
    const top = (Object.entries(style.shares) as [Style, number][]).sort((a, b) => b[1] - a[1])[0];
    const scored: Rec[] = [];
    set.forEach((h, rank) => {
      if (reached.has(h.sigmaNode)) return;
      const link = hubRec(ds, h, color);
      if (!link) return;
      const affinity = style.known ? h.tags.reduce((a, t) => a + (style.shares[t] ?? 0), 0) : 0;
      const score = GROW.w.common * (1 - rank / set.length) + GROW.w.style * affinity + GROW.w.level * (h.level === levels[0] ? 1 : 0);
      const where = band ? `Common at your level (${bandSource(band)})` : `A common course for ${cap(color)}`;
      const styled = style.known && top && h.tags.includes(top[0]) ? ` and close to how you play: ${pct(top[1])} of your games as ${cap(color)} are in ${top[0]} openings` : "";
      scored.push({ kind: "grow", color, title: link.courseName, reason: `${where}${styled}.`, score, link, hub: h.slug });
    });
    out.push(...scored.sort((a, b) => b.score - a.score).slice(0, GROW.perSide));
  }
  return out;
}

/** All three kinds, Fix first, without repeating a course; at most MAX_PER_KIND of each. */
export function recommend(ds: Dataset, games: Analysed[], rows: OpeningRow[], band: Band | null): Rec[] {
  const seen = new Set<string>();
  const out: Rec[] = [];
  for (const kind of [fixRecs(rows), fillRecs(ds, games, band), growRecs(ds, games, band)]) {
    let n = 0;
    for (const r of kind) {
      if (n >= MAX_PER_KIND || seen.has(r.link.course)) continue;
      seen.add(r.link.course);
      out.push(r);
      n++;
    }
  }
  return out;
}
