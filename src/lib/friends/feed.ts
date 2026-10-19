/**
 * Feed building (ADR 0007, decision 7). The database already collapses bursts
 * (one `lines` event per course and session); here consecutive items by the
 * same player on the same UTC day become one group, so the feed reads
 * "Sam · trained 5 lines in the Italian · reached a 14-day streak".
 */
import { PLATFORM_NAME } from "@/lib/insights/types";
import type { FeedEvent } from "./types";

export interface FeedGroup {
  key: string;
  username: string;
  /** UTC day, YYYY-MM-DD */
  day: string;
  /** newest first */
  items: FeedEvent[];
  latest: string;
}

const dayOf = (iso: string) => new Date(iso).toISOString().slice(0, 10);

/** Rating items under this change are noise (the database applies the same rule). */
export const MIN_RATING_CHANGE = 20;

export function visibleEvent(e: FeedEvent): boolean {
  if (e.kind === "rating") return Math.abs(e.payload.to - e.payload.from) >= MIN_RATING_CHANGE;
  if (e.kind === "lines") return e.payload.count > 0;
  return true;
}

/** Groups newest-first events into runs by player and UTC day; drops duplicates by id. */
export function groupFeed(events: FeedEvent[]): FeedGroup[] {
  const seen = new Set<number>();
  const sorted = events
    .filter((e) => visibleEvent(e) && !seen.has(e.id) && (seen.add(e.id), true))
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at) || b.id - a.id);
  const groups: FeedGroup[] = [];
  for (const e of sorted) {
    const day = dayOf(e.updated_at);
    const last = groups[groups.length - 1];
    if (last && last.username === e.username && last.day === day) {
      last.items.push(e);
    } else {
      groups.push({ key: `${e.username}:${day}:${e.id}`, username: e.username, day, items: [e], latest: e.updated_at });
    }
  }
  return groups;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** One item without the player's name: "trained 3 new lines in the Italian". */
export function eventText(e: FeedEvent, courseName: (id: string) => string): string {
  switch (e.kind) {
    case "lines":
      return `trained ${plural(e.payload.count, "new line")} in ${courseName(e.payload.course)}`;
    case "streak":
      return `reached a ${e.payload.days}-day streak`;
    case "course":
      return `started ${courseName(e.payload.course)}`;
    case "rating": {
      const d = e.payload.to - e.payload.from;
      return `${PLATFORM_NAME[e.payload.platform]} ${e.payload.time_class} rating is ${d >= 0 ? "up" : "down"} ${Math.abs(d)} this week (now ${e.payload.to})`;
    }
  }
}

/** The whole sentence: "Sam trained 3 new lines in the Italian", "Sam's Lichess blitz rating is up 40 this week". */
export function eventSentence(e: FeedEvent, courseName: (id: string) => string): string {
  const text = eventText(e, courseName);
  return e.kind === "rating" ? `${e.username}'s ${text}` : `${e.username} ${text}`;
}
