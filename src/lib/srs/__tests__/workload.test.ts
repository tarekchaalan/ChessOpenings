/** ADR 0003 workload control: overflow deferral and the simulated forecast. */
import { describe, expect, it } from "vitest";
import { cardKey, newCard, retrievability, review, type CardState } from "../fsrs";
import { linesLearnedToday, planDailyCap, simulateForecast, startOfDay } from "../workload";

const NOW = new Date("2026-10-18T12:00:00Z");
const DAY = 86400_000;

/** A Review card last seen `ago` days ago with interval `ivl` (so overdue by ago − ivl). */
function reviewed(i: number, ago: number, stability: number): CardState {
  let c = newCard("white", `epd${i}`, "e4", new Date(NOW.getTime() - (ago + 30) * DAY));
  c = review(c, "good", new Date(NOW.getTime() - (ago + 30) * DAY));
  c = review(c, "good", new Date(NOW.getTime() - (ago + 29) * DAY));
  return { ...c, stability, last_review: new Date(NOW.getTime() - ago * DAY).toISOString(), due: new Date(NOW.getTime() - (ago - stability) * DAY).toISOString() };
}

describe("daily review cap: explicit deferral (§4.9)", () => {
  // 7 overdue cards with different recall, cap 3
  const cards = [reviewed(1, 30, 2), reviewed(2, 5, 4), reviewed(3, 40, 3), reviewed(4, 10, 8), reviewed(5, 20, 1), reviewed(6, 6, 5), reviewed(7, 12, 9)];
  const plan = planDailyCap(cards, 3, NOW);

  it("today gets the cap's worth of the lowest-retrievability cards", () => {
    const r = (c: CardState) => retrievability(c, NOW);
    const sorted = [...cards].sort((a, b) => r(a) - r(b));
    expect(plan.today).toEqual(sorted.slice(0, 3).map((c) => cardKey(c.side, c.epd, c.answer)));
  });
  it("the overflow moves to tomorrow, then the next day, in the same order, each day ≤ cap; nothing is dropped", () => {
    expect(plan.deferred).toHaveLength(4);
    const days = plan.deferred.map((c) => Math.round((new Date(c.due).getTime() - startOfDay(NOW).getTime()) / DAY));
    expect(days).toEqual([1, 1, 1, 2]);
    for (const c of plan.deferred) expect(c.deferredFrom).toBe(cards.find((x) => x.epd === c.epd)!.due);
  });
  it("cards already due on a later day count against that day's cap", () => {
    const tomorrow = { ...reviewed(9, 1, 3), due: new Date(startOfDay(NOW, 1).getTime() + 3600_000).toISOString() };
    const p = planDailyCap([...cards, tomorrow, { ...tomorrow, epd: "epd10" }], 3, NOW);
    const days = p.deferred.map((c) => Math.round((new Date(c.due).getTime() - startOfDay(NOW).getTime()) / DAY));
    expect(days).toEqual([1, 2, 2, 2]);
  });
  it("no overflow, no change", () => {
    expect(planDailyCap(cards.slice(0, 2), 3, NOW).deferred).toEqual([]);
  });
});

describe("7-day forecast (simulated with FSRS)", () => {
  it("overdue and just-learned cards count today; reviews re-schedule forward", () => {
    const learned = newCard("white", "x", "e4", NOW); // awaiting its first rep
    const later = { ...reviewed(20, 2, 4), due: new Date(startOfDay(NOW, 3).getTime() + 3600_000).toISOString() };
    const f = simulateForecast([learned, later], NOW);
    expect(f[0]).toBeGreaterThanOrEqual(1);
    expect(f[3]).toBeGreaterThanOrEqual(1);
    expect(f.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(3); // the new card comes back within the week
  });
  it("the cap rolls overflow into the next day", () => {
    const many = Array.from({ length: 10 }, (_, i) => reviewed(100 + i, 30, 2));
    const f = simulateForecast(many, NOW, { cap: 4 });
    expect(f[0]).toBe(4);
    expect(f[1]).toBeGreaterThanOrEqual(4);
  });
  it("adding a tier's new cards at the daily cap raises the forecast", () => {
    const base = simulateForecast([], NOW);
    const fresh = Array.from({ length: 7 }, (_, d) => Array.from({ length: 5 }, (_, i) => newCard("white", `n${d}-${i}`, "e4", NOW)));
    const more = simulateForecast([], NOW, { newByDay: fresh });
    expect(base.every((x) => x === 0)).toBe(true);
    expect(more[0]).toBeGreaterThanOrEqual(5);
  });
});

it("lines learned today count toward the new-line cap", () => {
  const today = new Date(NOW.getTime() - 3600_000).toISOString();
  const yesterday = new Date(NOW.getTime() - 2 * DAY).toISOString();
  expect(linesLearnedToday({ a: { lines: { l1: { learnedAt: today }, l2: { learnedAt: yesterday } } }, b: { lines: { l3: { learnedAt: today } } } }, NOW)).toBe(2);
});
