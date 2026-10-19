/** §4.9 tier forecast ("Core adds ~N reviews/day next week") on the shipped dataset. */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDatasetV2 } from "@/lib/openings";
import { findSystem, loadCourse, modelOf } from "@/lib/courses-client";
import type { RawDatasetV2 } from "@/lib/openings-build/dataset";
import { cardKey, review, type CardState } from "@/lib/srs/fsrs";
import { tierAddsPerDay, tierLines, tierNewCards } from "../plan";

const raw = JSON.parse(readFileSync(join(__dirname, "../../../../public/data/openings.v2.json"), "utf8")) as RawDatasetV2;
const ds = parseDatasetV2(raw, "test");
const model = modelOf(ds);
const course = loadCourse(ds, findSystem(ds, "ruy-lopez", "closed", "white")!)!;
const NOW = new Date("2026-10-18T12:00:00Z");
const none = () => false;

describe("tier forecast", () => {
  it("new cards: one per learner move of each unlearned line, a shared trunk once", () => {
    const lines = tierNewCards(model, course, "core", {}, none);
    expect(lines).toHaveLength(tierLines(course, "core").length);
    const keys = lines.flatMap((l) => l.cards.map((c) => cardKey(c.side, c.epd, c.answer)));
    expect(new Set(keys).size).toBe(keys.length);
    expect(lines[0].cards[0].answer).toBe("e4");
    // learned lines and existing cards add nothing
    expect(tierNewCards(model, course, "core", {}, () => true)).toEqual([]);
  });
  it("a bigger tier adds at least as many reviews; known cards reduce it", () => {
    const opts = { perDay: 5, retention: 0.9, now: NOW };
    const ess = tierAddsPerDay(model, course, "essentials", {}, none, opts);
    const core = tierAddsPerDay(model, course, "core", {}, none, opts);
    expect(ess).toBeGreaterThan(0);
    expect(core).toBeGreaterThanOrEqual(ess);
    const known: Record<string, CardState> = {};
    for (const l of tierNewCards(model, course, "essentials", {}, none)) {
      for (const c of l.cards) known[cardKey(c.side, c.epd, c.answer)] = { ...review(c, "good", new Date(NOW.getTime() - 60 * 86400_000)), due: new Date(NOW.getTime() + 60 * 86400_000).toISOString() };
    }
    expect(tierAddsPerDay(model, course, "essentials", known, none, opts)).toBe(0);
  });
  it("more new lines a day adds more reviews within the week", () => {
    const at = (perDay: number) => tierAddsPerDay(model, course, "complete", {}, none, { perDay, retention: 0.9, now: NOW });
    expect(at(10)).toBeGreaterThan(at(2));
  });
});
