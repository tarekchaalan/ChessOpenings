/**
 * Spaced-repetition scheduler (SM-2 variant) for opening positions.
 *
 * A card is one position the user must answer within one opening, identified
 * by (openingId, epd). The line that led there is stored so review sessions
 * can replay the moves up to the position.
 *
 * The same algorithm is mirrored server-side in plpgsql (supabase migrations)
 * so authenticated progress can't be forged; this module is the client-side
 * implementation used in guest mode and for optimistic UI.
 */

export interface SrsCard {
  openingId: number;
  epd: string;
  /** SAN moves from the start position up to (not including) the answer */
  lineSans: string[];
  ease: number;
  intervalDays: number;
  reps: number;
  lapses: number;
  /** ISO timestamp when the card is due for review */
  due: string;
  seen: number;
  correct: number;
}

export const cardKey = (openingId: number, epd: string) => `${openingId}|${epd}`;

export function newCard(openingId: number, epd: string, lineSans: string[], now = new Date()): SrsCard {
  return {
    openingId,
    epd,
    lineSans,
    ease: 2.5,
    intervalDays: 0,
    reps: 0,
    lapses: 0,
    due: now.toISOString(),
    seen: 0,
    correct: 0,
  };
}

/**
 * Grade quality 0–5 (SM-2 scale) from a quiz answer.
 * Fast correct answers earn long intervals; wrong answers lapse the card.
 */
export function answerQuality(correct: boolean, ms: number, usedHint: boolean): number {
  if (!correct) return 1;
  if (usedHint) return 3;
  if (ms < 4000) return 5;
  if (ms < 12000) return 4;
  return 3;
}

const MIN_EASE = 1.3;
const LAPSE_RETRY_MINUTES = 10;

/** Apply an SM-2 review. Returns the updated card (does not mutate). */
export function reviewCard(card: SrsCard, quality: number, now = new Date()): SrsCard {
  const next = { ...card, seen: card.seen + 1, correct: card.correct + (quality >= 3 ? 1 : 0) };
  if (quality < 3) {
    next.reps = 0;
    next.lapses = card.lapses + 1;
    next.intervalDays = 0;
    next.due = new Date(now.getTime() + LAPSE_RETRY_MINUTES * 60_000).toISOString();
    next.ease = Math.max(MIN_EASE, card.ease - 0.2);
    return next;
  }
  next.reps = card.reps + 1;
  if (next.reps === 1) next.intervalDays = 1;
  else if (next.reps === 2) next.intervalDays = 6;
  else next.intervalDays = Math.round(card.intervalDays * card.ease * 10) / 10;
  next.ease = Math.max(
    MIN_EASE,
    card.ease + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02))
  );
  next.due = new Date(now.getTime() + next.intervalDays * 86_400_000).toISOString();
  return next;
}

export const isDue = (card: SrsCard, now = new Date()) => new Date(card.due) <= now;

/** A card is "mature" once its interval passes 21 days — it counts toward mastery. */
export const isMature = (card: SrsCard) => card.intervalDays >= 21;

export function dueCards(cards: SrsCard[], now = new Date()): SrsCard[] {
  return cards.filter((c) => isDue(c, now)).sort((a, b) => a.due.localeCompare(b.due));
}
