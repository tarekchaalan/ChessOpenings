/**
 * v1 guest progress persistence (cot.v1.* keys). No longer used by the app
 * (the v2 store is lib/progress/store.ts); kept for the v1 fixture generator
 * that the migration tests run on (ADR 0003).
 */
import { START_RATING } from "@/lib/scoring";
import { SrsCard, cardKey, dueCards } from "@/lib/srs";
import type { Attempt, OpeningProgress, ProgressReader, ProgressSummary } from "./types";

const KEYS = {
  cards: "cot.v1.cards",
  attempts: "cot.v1.attempts",
  profile: "cot.v1.profile",
  progress: "cot.v1.openingProgress",
};

interface LocalProfile {
  rating: number;
  attempts: number;
  correct: number;
  /** ISO dates (YYYY-MM-DD) of the current daily streak, most recent last */
  lastActiveDay: string | null;
  dailyStreak: number;
}

const MAX_ATTLOG = 500;

function read<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage full or unavailable — progress is best-effort in guest mode
  }
}

export function localProfile(): LocalProfile {
  return read<LocalProfile>(KEYS.profile, {
    rating: START_RATING,
    attempts: 0,
    correct: 0,
    lastActiveDay: null,
    dailyStreak: 0,
  });
}

export function localCards(): Record<string, SrsCard> {
  return read<Record<string, SrsCard>>(KEYS.cards, {});
}

export function saveLocalCard(card: SrsCard): void {
  const cards = localCards();
  cards[cardKey(card.openingId, card.epd)] = card;
  write(KEYS.cards, cards);
}

export function localOpeningProgress(): Record<number, OpeningProgress> {
  return read<Record<number, OpeningProgress>>(KEYS.progress, {});
}

export function recordLocalAttempt(a: Attempt, masteryPct: number): void {
  const attempts = read<Attempt[]>(KEYS.attempts, []);
  attempts.push(a);
  if (attempts.length > MAX_ATTLOG) attempts.splice(0, attempts.length - MAX_ATTLOG);
  write(KEYS.attempts, attempts);

  const profile = localProfile();
  profile.rating = a.ratingAfter;
  profile.attempts += 1;
  profile.correct += a.correct ? 1 : 0;
  const today = a.at.slice(0, 10);
  if (profile.lastActiveDay !== today) {
    const yesterday = new Date(new Date(a.at).getTime() - 86_400_000).toISOString().slice(0, 10);
    profile.dailyStreak = profile.lastActiveDay === yesterday ? profile.dailyStreak + 1 : 1;
    profile.lastActiveDay = today;
  }
  write(KEYS.profile, profile);

  const all = localOpeningProgress();
  const p = all[a.openingId] ?? {
    openingId: a.openingId,
    seen: 0,
    correct: 0,
    streak: 0,
    bestStreak: 0,
    mastery: 0,
    updatedAt: a.at,
  };
  p.seen += 1;
  p.correct += a.correct ? 1 : 0;
  p.streak = a.correct ? p.streak + 1 : 0;
  p.bestStreak = Math.max(p.bestStreak, p.streak);
  p.mastery = masteryPct;
  p.updatedAt = a.at;
  all[a.openingId] = p;
  write(KEYS.progress, all);
}

export function updateLocalMastery(openingId: number, masteryPct: number): void {
  const all = localOpeningProgress();
  if (all[openingId]) {
    all[openingId].mastery = masteryPct;
    write(KEYS.progress, all);
  }
}

export const localReader: ProgressReader = {
  kind: "local",
  async summary(): Promise<ProgressSummary> {
    const profile = localProfile();
    const cards = Object.values(localCards());
    const attempts = read<Attempt[]>(KEYS.attempts, []);
    // a daily streak is broken if the last active day is before yesterday
    let dailyStreak = profile.dailyStreak;
    if (profile.lastActiveDay) {
      const gap = Date.now() - new Date(profile.lastActiveDay + "T00:00:00").getTime();
      if (gap > 2 * 86_400_000) dailyStreak = 0;
    }
    return {
      rating: profile.rating,
      attempts: profile.attempts,
      correct: profile.correct,
      dailyStreak,
      dueCount: dueCards(cards).length,
      perOpening: Object.values(localOpeningProgress()).sort(
        (a, b) => b.updatedAt.localeCompare(a.updatedAt)
      ),
      recentAttempts: attempts.slice(-20).reverse(),
    };
  },
  async cards(): Promise<SrsCard[]> {
    return Object.values(localCards());
  },
};
