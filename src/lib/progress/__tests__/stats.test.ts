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
  it("forecast puts overdue and just-learned cards today and buckets the rest by due day", () => {
    const fresh = newCard("white", "x", "e4", now); // introduced, waiting for its first rep
    const later = review(newCard("white", "y", "d4", now), "good", now);
    later.due = "2026-10-21T08:00:00Z";
    const archived = { ...fresh, archived: true };
    expect(forecast([fresh, later, archived], now)).toEqual([1, 0, 0, 1, 0, 0, 0]);
  });
});
