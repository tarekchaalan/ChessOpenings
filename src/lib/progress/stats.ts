/** Dashboard numbers (§3.2 E) from the v2 store: streak and the 7-day forecast. */
import { isReviewable, type CardState } from "../srs/fsrs";

const DAY = 86400_000;
const dayKey = (d: Date) => d.toISOString().slice(0, 10);

/** Consecutive days with at least one graded answer, ending today (or yesterday). */
export function streak(log: Record<string, number[]>, now = new Date()): number {
  let d = new Date(now);
  if (!log[dayKey(d)]?.[0]) d = new Date(d.getTime() - DAY);
  let n = 0;
  while (log[dayKey(d)]?.[0]) {
    n++;
    d = new Date(d.getTime() - DAY);
  }
  return n;
}

/** Reviews per day for the next 7 days from the current schedule (overdue counts today). */
export function forecast(cards: CardState[], now = new Date()): number[] {
  const out = new Array(7).fill(0);
  const today = new Date(dayKey(now)).getTime();
  for (const c of cards) {
    if (c.archived) continue;
    if (isReviewable(c, now)) {
      out[0]++;
      continue;
    }
    const i = Math.floor((new Date(dayKey(new Date(c.due))).getTime() - today) / DAY);
    if (i >= 0 && i < 7) out[i]++;
  }
  return out;
}

