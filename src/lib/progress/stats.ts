/** Dashboard numbers (§3.2 E) from the v2 store: streak and the 7-day forecast. */
import type { CardState } from "../srs/fsrs";
import { simulateForecast } from "../srs/workload";

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

/** Reviews per day for the next 7 days: FSRS-simulated (each review Good), with the daily cap. */
export function forecast(cards: CardState[], now = new Date(), opts: { cap?: number; retention?: number } = {}): number[] {
  return simulateForecast(cards, now, { days: 7, cap: opts.cap, retention: opts.retention });
}
