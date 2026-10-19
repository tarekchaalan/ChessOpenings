/**
 * Rating bands per platform and time class (ADR 0006). Lichess and Chess.com
 * ratings are banded on their own scales; nothing converts between them.
 */
import { levelOf } from "@/lib/rating/level";
import { BAND_EDGES, BAND_NAMES } from "./weights";
import type { Platform, Ratings, Summary, TimeClass } from "./types";

export interface Band {
  band: number;
  name: (typeof BAND_NAMES)[number];
  /** null: from the estimated Elo (ADR 0008), not one platform's rating */
  platform: Platform | null;
  timeClass: TimeClass | null;
  rating: number;
  provisional: boolean;
}

/** The band when there are no imported games to rank yet: the estimated Elo's level (ADR 0008). */
export function bandFromEstimate(elo: number): Band {
  const lv = levelOf(elo);
  return { band: lv.band, name: lv.name, platform: null, timeClass: null, rating: elo, provisional: false };
}

/** "Lichess blitz 1834, provisional" or "estimated Elo ≈ 1450" */
export function bandSource(b: Band): string {
  return b.platform ? `${PLATFORM_LABEL[b.platform]} ${b.timeClass} ${b.rating}${b.provisional ? ", provisional" : ""}` : `estimated Elo ≈ ${b.rating}`;
}
const PLATFORM_LABEL: Record<Platform, string> = { lichess: "Lichess", chesscom: "Chess.com" };

export function bandOf(platform: Platform, rating: number): number {
  const edges = BAND_EDGES[platform];
  let b = 1;
  for (let i = 0; i < edges.length; i++) if (rating >= edges[i]) b = i + 1;
  return b;
}

/**
 * The band recommendations use: the platform and time class with the most
 * imported games that has a profile rating. A provisional rating counts one
 * band lower (never below 1).
 */
export function playerBand(summaries: Summary[], ratings: Partial<Record<Platform, Ratings>>): Band | null {
  const counts = new Map<string, number>();
  for (const s of summaries) counts.set(`${s.platform}|${s.timeClass}`, (counts.get(`${s.platform}|${s.timeClass}`) ?? 0) + 1);
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  for (const [key] of ranked) {
    const [platform, timeClass] = key.split("|") as [Platform, TimeClass];
    const r = ratings[platform]?.[timeClass];
    if (!r) continue;
    const raw = bandOf(platform, r.rating);
    const band = r.provisional ? Math.max(1, raw - 1) : raw;
    return { band, name: BAND_NAMES[band - 1], platform, timeClass, rating: r.rating, provisional: r.provisional };
  }
  return null;
}
