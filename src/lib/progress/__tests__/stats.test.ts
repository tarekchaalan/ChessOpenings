import { describe, expect, it } from "vitest";
import { forecast, streak } from "../stats";
import { newCard, review } from "../../srs/fsrs";

describe("dashboard stats", () => {
  const now = new Date("2026-10-18T12:00:00Z");
  it("streak counts consecutive days ending today or yesterday", () => {
    expect(streak({ "2026-10-18": [3, 2], "2026-10-17": [1, 1], "2026-10-15": [5, 5] }, now)).toBe(2);
    expect(streak({ "2026-10-17": [1, 1], "2026-10-16": [1, 0] }, now)).toBe(2);
    expect(streak({ "2026-10-15": [1, 1] }, now)).toBe(0);
  });
  it("forecast counts just-learned cards today, skips archived ones, and follows the schedule", () => {
    const fresh = newCard("white", "x", "e4", now); // introduced, waiting for its first rep
    const archived = { ...fresh, epd: "z", archived: true };
    const f = forecast([fresh, archived], now);
    expect(f).toHaveLength(7);
    expect(f[0]).toBeGreaterThanOrEqual(1);
    expect(forecast([archived], now).every((x) => x === 0)).toBe(true);
    // a card reviewed Good a few days ago with a 3-day interval comes up on its day, not today
    const later = { ...review(fresh, "good", new Date(now.getTime() - 86400_000)), epd: "y", state: 2, stability: 3, due: new Date(now.getTime() + 2 * 86400_000).toISOString() };
    const g = forecast([later], now);
    expect(g[0]).toBe(0);
    expect(g.slice(1, 4).reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(1);
  });
});
