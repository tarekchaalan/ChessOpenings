/**
 * Workload control (ADR 0003, §4.9): the daily review cap with explicit
 * deferral, the 7-day forecast (simulated with FSRS, each review answered
 * Good), and the daily new-line count. Pure functions over card states.
 */
import { cardKey, isDue, isReviewable, retrievability, review, type CardState } from "./fsrs";

const DAY = 86400_000;

/** Local midnight of `d` plus `days` days. */
export function startOfDay(d: Date, days = 0): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() + days);
  return x;
}

const dayIndex = (now: Date, at: Date) => Math.round((startOfDay(at).getTime() - startOfDay(now).getTime()) / DAY);

export interface CapPlan {
  /** keys reviewable today, lowest recall first (≤ cap) */
  today: string[];
  /** cards whose due moved to a later day (overflow), with `deferredFrom` set */
  deferred: CardState[];
}

/**
 * When more cards are due than the cap: today's queue is the `cap` cards
 * with the lowest retrievability; the rest move to the start of tomorrow,
 * then the next day…, in the same order, keeping every day (counting the
 * cards already due that day) at or under the cap. Nothing is dropped.
 */
export function planDailyCap(cards: CardState[], cap: number, now = new Date(), retention = 0.9): CapPlan {
  const live = cards.filter((c) => !c.archived);
  // reviews only: a card introduced in Learn and waiting for its first rep
  // (state New) isn't a review and isn't capped or deferred
  const due = live
    .filter((c) => isDue(c, now))
    .map((c) => ({ c, r: retrievability(c, now, retention) }))
    .sort((a, b) => a.r - b.r || (a.c.due < b.c.due ? -1 : 1));
  const today = due.slice(0, cap).map(({ c }) => cardKey(c.side, c.epd, c.answer));
  const overflow = due.slice(cap).map(({ c }) => c);
  if (!overflow.length) return { today, deferred: [] };
  // cards already scheduled on each coming day count against that day's cap
  const booked = new Map<number, number>();
  for (const c of live) {
    if (isReviewable(c, now)) continue; // due today, or New (not a scheduled review)
    const d = dayIndex(now, new Date(c.due));
    booked.set(d, (booked.get(d) ?? 0) + 1);
  }
  const deferred: CardState[] = [];
  let day = 1;
  for (const c of overflow) {
    while ((booked.get(day) ?? 0) >= cap) day++;
    booked.set(day, (booked.get(day) ?? 0) + 1);
    deferred.push({ ...c, due: startOfDay(now, day).toISOString(), deferredFrom: c.deferredFrom ?? c.due });
  }
  return { today, deferred };
}

export interface ForecastOptions {
  days?: number;
  retention?: number;
  /** daily review cap: reviews beyond it roll to the next day */
  cap?: number;
  /** new cards introduced (learned, then recalled) on each day */
  newByDay?: CardState[][];
}

/**
 * Reviews per day for the next `days` days. Every card counts on its due
 * day (overdue and just-learned → today); each review is answered Good and
 * re-scheduled with FSRS, so same-day learning steps count too.
 */
export function simulateForecast(cards: CardState[], now = new Date(), opts: ForecastOptions = {}): number[] {
  const days = opts.days ?? 7;
  const retention = opts.retention ?? 0.9;
  const cap = opts.cap ?? Infinity;
  const pool: CardState[][] = Array.from({ length: days }, () => []);
  for (const c of cards) {
    if (c.archived) continue;
    const d = isReviewable(c, now) ? 0 : dayIndex(now, new Date(c.due));
    if (d >= 0 && d < days) pool[d].push(c);
  }
  const counts = new Array(days).fill(0);
  for (let d = 0; d < days; d++) {
    const dayStart = startOfDay(now, d);
    const dayEnd = startOfDay(now, d + 1);
    const at = d === 0 ? now : new Date(dayStart.getTime() + 9 * 3600_000);
    // new cards: learned and recalled that day (not subject to the review cap)
    const queue: CardState[] = [...(opts.newByDay?.[d] ?? [])];
    const due = pool[d];
    const take = Math.min(due.length, cap);
    queue.push(...due.slice(0, take));
    if (d + 1 < days) pool[d + 1].push(...due.slice(take));
    for (let i = 0; i < queue.length; i++) {
      let card = queue[i];
      let t = at;
      // same-day learning steps are reviewed the same day (bounded)
      for (let step = 0; step < 4; step++) {
        counts[d]++;
        card = review(card, "good", t, retention);
        const next = new Date(card.due);
        if (next >= dayEnd) break;
        t = new Date(Math.max(next.getTime(), t.getTime() + 60_000));
      }
      const nd = dayIndex(now, new Date(card.due));
      if (nd > d && nd < days) pool[nd].push(card);
    }
  }
  return counts;
}

/** Lines whose first Learn was today (the daily new-line cap counts these). */
export function linesLearnedToday(progress: Record<string, { lines: Record<string, { learnedAt?: string }> }>, now = new Date()): number {
  const from = startOfDay(now).getTime();
  let n = 0;
  for (const p of Object.values(progress)) for (const l of Object.values(p.lines)) if (l.learnedAt && new Date(l.learnedAt).getTime() >= from) n++;
  return n;
}
