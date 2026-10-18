import { describe, expect, it } from "vitest";
import { cardKey, gradeFor, isDue, isMature, isReviewable, newCard, review, State } from "../fsrs";

const NOW = new Date("2026-10-18T10:00:00Z");

describe("auto-grading (ADR 0003)", () => {
  const base = { correct: true, hintLevel: 0 as const, wrongAttempts: 0, ms: 4000, reps: 0 };
  it("maps the hint ladder to grades", () => {
    expect(gradeFor(base)).toBe("good");
    expect(gradeFor({ ...base, hintLevel: 1 })).toBe("hard");
    expect(gradeFor({ ...base, hintLevel: 2 })).toBe("hard");
    expect(gradeFor({ ...base, hintLevel: 3 })).toBe("again");
  });
  it("a real wrong move is Again; Easy needs speed and ≥ 2 reps", () => {
    expect(gradeFor({ ...base, wrongAttempts: 1 })).toBe("again");
    expect(gradeFor({ ...base, ms: 1200, reps: 1 })).toBe("good");
    expect(gradeFor({ ...base, ms: 1200, reps: 2 })).toBe("easy");
    expect(gradeFor({ ...base, correct: false })).toBe("again");
  });
});

describe("cards", () => {
  it("keys normalise check suffixes", () => {
    expect(cardKey("white", "x", "Bb5+")).toBe(cardKey("white", "x", "Bb5"));
  });
  it("Good schedules forward; Again lapses; maturity at 21 days stability", () => {
    let c = newCard("white", "epd", "e4", NOW);
    expect(c.state).toBe(State.New);
    expect(isDue(c, NOW)).toBe(false); // new cards aren't "due" reviews
    expect(isReviewable(c, NOW)).toBe(true); // …but an introduced card waits for its first rep
    c = review(c, "good", NOW);
    expect(new Date(c.due).getTime()).toBeGreaterThan(NOW.getTime());
    expect(c.reps).toBe(1);
    let t = new Date(c.due);
    for (let i = 0; i < 10 && !isMature(c); i++) {
      c = review(c, "good", t);
      t = new Date(c.due);
    }
    expect(isMature(c)).toBe(true);
    const lapsed = review(c, "again", t);
    expect(lapsed.lapses).toBe(c.lapses + 1);
    expect(new Date(lapsed.due).getTime() - t.getTime()).toBeLessThan(86_400_000);
  });
});
