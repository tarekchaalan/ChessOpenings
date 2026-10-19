/**
 * What the estimated Elo changes (ADR 0008): the player's level, which
 * courses are suggested, how deep a course starts, and how many new lines a
 * day. Level names and catalog levels are the same as Insights' bands
 * (insights/weights.ts), so the two pages speak one language.
 */
import { hubCard } from "@/lib/catalog-client";
import { catalogOf } from "@/lib/courses-client";
import type { Dataset } from "@/lib/openings";
import type { Level as CatalogLevel, RawHubSummary } from "@/lib/openings-build/catalog";
import type { Side } from "@/lib/insights/types";
import { courseLink, type TrainLink } from "@/lib/insights/links";
import { BAND_LEVELS, BAND_NAMES } from "@/lib/insights/weights";
import type { TierKey } from "@/lib/trainer/plan";

/** Lower edges of levels 1–5 on the estimate's scale. */
export const LEVEL_EDGES = [0, 900, 1300, 1700, 2000];

export interface PlayerLevel {
  band: 1 | 2 | 3 | 4 | 5;
  name: (typeof BAND_NAMES)[number];
  /** catalog levels to suggest, the level's own first */
  catalog: CatalogLevel[];
  /** where a course's depth selector starts */
  tier: TierKey;
  /** new lines a day suggested at setup */
  newLines: number;
}

export const TIER_LABEL: Record<TierKey, string> = { essentials: "Essentials", core: "Core", complete: "Complete" };

const TIER: Record<PlayerLevel["band"], TierKey> = { 1: "essentials", 2: "essentials", 3: "core", 4: "complete", 5: "complete" };
const NEW_LINES: Record<PlayerLevel["band"], number> = { 1: 3, 2: 4, 3: 5, 4: 6, 5: 8 };

export function levelOf(elo: number): PlayerLevel {
  let band = 1;
  for (let i = 0; i < LEVEL_EDGES.length; i++) if (elo >= LEVEL_EDGES[i]) band = i + 1;
  const b = band as PlayerLevel["band"];
  return { band: b, name: BAND_NAMES[b - 1], catalog: BAND_LEVELS[b], tier: TIER[b], newLines: NEW_LINES[b] };
}

export interface Starter {
  hub: string;
  title: string;
  side: Side;
  level: CatalogLevel;
  link: TrainLink;
}

/**
 * The most played top-level openings for a side at the player's catalog
 * levels (their own level first), as course links: "Start here".
 */
export function starterCourses(ds: Dataset, level: PlayerLevel, side: Side, n = 3): Starter[] {
  const cat = catalogOf(ds);
  if (!cat) return [];
  const rank = (h: RawHubSummary) => level.catalog.indexOf(h.level);
  const hubs = cat.hubs
    .filter((h) => h.placement === "top" && h.side === side && h.systems[side].length > 0 && level.catalog.includes(h.level))
    .sort((a, b) => rank(a) - rank(b) || b.games - a.games || a.slug.localeCompare(b.slug));
  const out: Starter[] = [];
  for (const h of hubs) {
    const c = hubCard(ds, h, side);
    if (!c.system || !c.course) continue;
    const link = courseLink({ hub: h, system: c.system, course: c.course, line: 0, node: h.sigmaNode, at: h.sigmaNode });
    out.push({ hub: h.slug, title: link.courseName, side, level: h.level, link });
    if (out.length >= n) break;
  }
  return out;
}

// The level, kept in this browser so pages that render before the setup
// loads (the course page's depth selector) start at the right place.
const LEVEL_KEY = "cot.v2.level";

export function readStoredBand(): PlayerLevel["band"] | null {
  try {
    const v = Number(window.localStorage.getItem(LEVEL_KEY));
    return v >= 1 && v <= 5 ? (v as PlayerLevel["band"]) : null;
  } catch {
    return null;
  }
}

export function storeBand(band: PlayerLevel["band"] | null): void {
  try {
    if (band) window.localStorage.setItem(LEVEL_KEY, String(band));
    else window.localStorage.removeItem(LEVEL_KEY);
  } catch {
    // a convenience only
  }
}

/** The depth a course page starts at: the player's level, else everything (as before). */
export function defaultTier(): TierKey {
  const band = readStoredBand();
  return band ? TIER[band] : "complete";
}
