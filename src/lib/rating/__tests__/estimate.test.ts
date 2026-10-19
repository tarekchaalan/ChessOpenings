/** Estimated Elo and what it changes (ADR 0008). */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseDatasetV2 } from "@/lib/openings";
import type { RawDatasetV2 } from "@/lib/openings-build/dataset";
import type { Ratings } from "@/lib/insights/types";
import { basisText, estimateElo, estimateRecord, ignoredText, MIN_GAMES, SELF_LEVELS, toElo, TO_ELO } from "../estimate";
import { levelOf, starterCourses } from "../level";

const r = (rating: number, games: number, provisional = false) => ({ rating, games, provisional });

describe("toElo", () => {
  it("hits the table points and interpolates between them", () => {
    expect(toElo("lichess", 1800)).toBe(1550);
    expect(toElo("lichess", 1600)).toBe(1325);
    expect(toElo("chesscom", 1000)).toBe(1200);
    expect(toElo("chesscom", 1200)).toBe(1375);
  });

  it("extends with slope 1 beyond the ends", () => {
    expect(toElo("lichess", 500)).toBe(300);
    expect(toElo("chesscom", 3300)).toBe(2900);
  });

  it("is increasing on both platforms", () => {
    for (const p of ["lichess", "chesscom"] as const) {
      for (let x = 100; x < 3300; x += 50) expect(toElo(p, x + 50)).toBeGreaterThan(toElo(p, x));
      const pts = TO_ELO[p];
      for (let i = 1; i < pts.length; i++) expect(pts[i][0]).toBeGreaterThan(pts[i - 1][0]);
    }
  });

  it("puts the surveys' equivalents close together (ChessGoals: Chess.com rapid 2000 ≈ Lichess rapid 2200)", () => {
    expect(Math.abs(toElo("chesscom", 2000) - toElo("lichess", 2200))).toBeLessThanOrEqual(50);
    // Chess.com rapid 1000 ≈ Lichess rapid ~1600 (within the surveys' ±135)
    expect(Math.abs(toElo("chesscom", 1000) - toElo("lichess", 1595))).toBeLessThanOrEqual(135);
  });
});

describe("estimateElo", () => {
  it("ignores new accounts still at the starting rating (Lichess 1500?, Chess.com picked level)", () => {
    const e = estimateElo({ lichess: { ratings: { blitz: r(1500, 3, true), rapid: r(1520, 8, true) } }, chesscom: { ratings: { rapid: r(800, 2) } } });
    expect(e).toBeNull();
    const withSelf = estimateElo({ lichess: { ratings: { blitz: r(1500, 3, true) } } }, "casual");
    expect(withSelf).toMatchObject({ elo: 1200, source: "self", confidence: "low", self: "casual" });
    expect(withSelf!.ignored).toEqual([{ platform: "lichess", timeClass: "blitz", rating: 1500, games: 3, reason: "too-new" }]);
    expect(ignoredText(withSelf!.ignored[0])).toBe(`Lichess blitz 1500 after 3 games, still at the starting rating: too new to count (needs ${MIN_GAMES}).`);
  });

  it("uses one established rating, converted, with high confidence", () => {
    const e = estimateElo({ lichess: { ratings: { blitz: r(1800, 900) } } })!;
    expect(e).toMatchObject({ elo: 1550, low: 1400, high: 1700, confidence: "high", source: "ratings" });
    expect(basisText(e.basis[0])).toBe("Lichess blitz 1800 (900 games)");
  });

  it("weights rapid over blitz over bullet, and by games", () => {
    // rapid and bullet far apart: the estimate sits much closer to rapid
    const e = estimateElo({ chesscom: { ratings: { rapid: r(1400, 200), bullet: r(800, 200) } } })!;
    const rapid = toElo("chesscom", 1400);
    const bullet = toElo("chesscom", 800);
    expect(e.elo).toBeGreaterThan((rapid + bullet) / 2);
    expect(e.elo).toBeLessThan(rapid);
    expect(e.basis[0].timeClass).toBe("rapid");
    // fewer games → less weight
    const few = estimateElo({ chesscom: { ratings: { rapid: r(1400, 25), blitz: r(1000, 400) } } })!;
    expect(Math.abs(few.elo - toElo("chesscom", 1000))).toBeLessThan(Math.abs(few.elo - rapid));
  });

  it("counts a provisional rating at a quarter, and confidence falls with thin data", () => {
    const solid = estimateElo({ lichess: { ratings: { rapid: r(2000, 60) } } })!;
    expect(solid.confidence).toBe("medium");
    const prov = estimateElo({ lichess: { ratings: { rapid: r(2000, 60, true) } } })!;
    expect(prov.confidence).toBe("low");
    expect(prov.high - prov.low).toBe(600);
    const mixed = estimateElo({ lichess: { ratings: { rapid: r(2000, 100, true), blitz: r(1600, 100) } } })!;
    // the provisional rapid counts 0.25 vs blitz 0.8
    expect(Math.abs(mixed.elo - toElo("lichess", 1600))).toBeLessThan(Math.abs(mixed.elo - toElo("lichess", 2000)));
  });

  it("combines both platforms; a linked rating beats the self-reported level", () => {
    const e = estimateElo({ lichess: { ratings: { blitz: r(1900, 500) } }, chesscom: { ratings: { rapid: r(1500, 300) } } }, "new")!;
    expect(e.source).toBe("ratings");
    expect(e.basis.map((b) => b.platform).sort()).toEqual(["chesscom", "lichess"]);
    expect(e.elo).toBeGreaterThan(1500);
    expect(e.elo).toBeLessThan(1750);
  });

  it("returns null with nothing to go on, and every self level maps", () => {
    expect(estimateElo({})).toBeNull();
    expect(estimateElo({ lichess: { ratings: {} as Ratings } })).toBeNull();
    for (const l of SELF_LEVELS) expect(estimateElo({}, l.id)!.elo).toBe(l.elo);
  });

  it("rounds to tens and stays inside the stored range", () => {
    const e = estimateElo({ lichess: { ratings: { classical: r(3400, 50) } } })!;
    expect(e.elo % 10).toBe(0);
    expect(e.high).toBeLessThanOrEqual(3500);
    const low = estimateElo({ chesscom: { ratings: { rapid: r(100, 50) } } })!;
    expect(low.low).toBeGreaterThanOrEqual(100);
  });

  it("keeps a compact record for the server", () => {
    const e = estimateElo({ lichess: { ratings: { blitz: r(1800, 900) } } })!;
    expect(estimateRecord(e)).toEqual({
      confidence: "high",
      low: 1400,
      high: 1700,
      source: "ratings",
      basis: [{ platform: "lichess", timeClass: "blitz", rating: 1800, games: 900, provisional: false, weight: 0.8 }],
    });
  });
});

describe("level", () => {
  it("bands the estimate like Insights names its bands", () => {
    expect(levelOf(600)).toMatchObject({ band: 1, name: "Beginner", tier: "essentials", newLines: 3 });
    expect(levelOf(900).band).toBe(2);
    expect(levelOf(1450)).toMatchObject({ band: 3, name: "Club", tier: "core", newLines: 5, catalog: ["beginner", "intermediate"] });
    expect(levelOf(1700).band).toBe(4);
    expect(levelOf(2300)).toMatchObject({ band: 5, name: "Expert+", tier: "complete", newLines: 8 });
  });

  const raw = JSON.parse(readFileSync(join(__dirname, "../../../../public/data/openings.v2.json"), "utf8")) as RawDatasetV2;
  const ds = parseDatasetV2(raw, "test-hash");

  it("suggests real courses at the player's level, own level first", () => {
    for (const elo of [600, 1450, 2300]) {
      const lv = levelOf(elo);
      for (const side of ["white", "black"] as const) {
        const s = starterCourses(ds, lv, side);
        expect(s.length).toBeGreaterThan(0);
        expect(s.length).toBeLessThanOrEqual(3);
        for (const c of s) {
          expect(lv.catalog).toContain(c.level);
          expect(c.link.course).toMatch(new RegExp(`^/openings/[^/]+/[^/]+/${side}$`));
          expect(c.side).toBe(side);
        }
        // the player's own level comes first when that side has one, then the next
        const ranks = s.map((c) => lv.catalog.indexOf(c.level));
        expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
      }
    }
  });
});
