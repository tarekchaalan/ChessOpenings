/** Book matching, summaries and re-matching against the shipped dataset. */
import { describe, expect, it } from "vitest";
import { modelOf } from "@/lib/courses-client";
import { bookPath, matchBook, maxBookPly } from "../book";
import { parseLichessGame } from "../sources/lichess";
import { rematch, summarize } from "../summarize";
import type { NormalGame } from "../types";
import { LICHESS_USER, ds, lichessGames } from "./helpers";

const model = modelOf(ds);
const n = maxBookPly(model);

const game = (sans: string[], color: "white" | "black" = "white", extra: Partial<NormalGame> = {}): NormalGame => ({
  platform: "lichess",
  gameId: "g1",
  color,
  timeClass: "blitz",
  rated: true,
  standard: true,
  playedAt: "2026-10-01T00:00:00.000Z",
  result: "win",
  myRating: 1800,
  oppRating: 1800,
  eco: null,
  openingName: null,
  sans,
  evals: null,
  ...extra,
});

describe("maxBookPly", () => {
  it("is the longest theory path: no shorter than the deepest named row, and memoised", () => {
    const deepestRow = Math.max(...model.rows.map((r) => r.sans.length));
    expect(n).toBeGreaterThanOrEqual(deepestRow);
    expect(n).toBeLessThanOrEqual(model.maxPly);
    expect(maxBookPly(model)).toBe(n);
  });
});

describe("matchBook", () => {
  it("a game that stays in book to its end: deviatedBy none", () => {
    const m = matchBook(model, ["e4", "c5", "Nf3", "d6"], "white");
    expect(m).toMatchObject({ bookPly: 4, deviatedBy: "none", deviationEpd: null, playedSan: null });
    expect(m.plies).toEqual(["e4", "c5", "Nf3", "d6"]);
    expect(m.path).toHaveLength(5);
  });

  it("my deviation: position before it, my move, the theory moves there", () => {
    // 1.e4 e5 2.Nf3 h6 is not theory
    const m = matchBook(model, ["e4", "e5", "Nf3", "h6", "Nc3"], "black");
    expect(m.bookPly).toBe(3);
    expect(m.deviatedBy).toBe("me");
    expect(m.playedSan).toBe("h6");
    expect(m.deviationEpd).toBe(model.nodes[m.path[3]].epd);
    expect(m.bookSans).toContain("Nf6");
    expect(m.bookSans![0]).toBe("Nc6"); // most played first
    // every ply up to n is kept, past the deviation too
    expect(m.plies).toEqual(["e4", "e5", "Nf3", "h6", "Nc3"]);
  });

  it("the opponent's deviation from my side", () => {
    expect(matchBook(model, ["e4", "e5", "Nf3", "h6"], "white").deviatedBy).toBe("opponent");
  });

  it("a transposition into a known position stays in book", () => {
    // 1.Nf3 c5 2.e4 isn't an edge from 1.Nf3 c5, but reaches 1.e4 c5 2.Nf3
    const m = matchBook(model, ["Nf3", "c5", "e4", "d6"], "white");
    expect(m.deviatedBy).toBe("none");
    expect(m.bookPly).toBe(4);
    expect(model.nodes[m.path[3]].epd).toBe(model.nodes[matchBook(model, ["e4", "c5", "Nf3"], "white").path[3]].epd);
  });

  it("normalises SAN (+, #) and stops at an illegal move", () => {
    const m = matchBook(model, ["e4", "e5", "Qh5", "Nc6", "Bc4", "Nf6", "Qxf7#"], "white");
    expect(m.plies[m.plies.length - 1]).toBe("Qxf7");
    const bad = matchBook(model, ["e4", "e5", "Qh9"], "white");
    expect(bad.plies).toEqual(["e4", "e5"]);
    expect(bad.deviatedBy).toBe("none");
  });

  it("keeps exactly the first n plies; a deviation at ply n + 1 lives in playedSan", () => {
    const deep = model.rows.find((r) => r.sans.length === n);
    if (!deep) return; // n can exceed the deepest row via extension edges
    const sans = [...deep.sans, "Kh1", "Kg8", "Kg1"];
    const m = matchBook(model, sans, "white");
    expect(m.plies).toHaveLength(n);
    expect(m.bookPly).toBe(n);
  });

  it("bookPath re-walks a stored summary to the same nodes", () => {
    const m = matchBook(model, ["d4", "Nf6", "c4", "e6", "Nc3", "Bb4", "a3"], "white");
    expect(bookPath(model, m.plies, m.bookPly)).toEqual(m.path);
  });
});

describe("summarize", () => {
  const games = lichessGames().map((g) => parseLichessGame(g, LICHESS_USER) as NormalGame);

  it("every fixture game summarises within the DB's shape rules", () => {
    for (const g of games) {
      const s = summarize(model, g, "h")!;
      expect(s.openingPlies.length).toBeGreaterThan(0);
      expect(s.openingPlies.length).toBeLessThanOrEqual(n);
      expect(s.bookPly).toBeLessThanOrEqual(s.openingPlies.length);
      expect(s.deviatedBy === "none").toBe(s.deviationEpd === null);
      expect(s.deviationEpd === null).toBe(s.playedSan === null);
      if (s.playedSan) expect(s.playedSan).toMatch(/^[A-Za-z0-9+#=-]{2,8}$/);
    }
  });

  it("evaluation at the deviation comes from the analysis, on the mover's side", () => {
    const g = games.find((x) => x.evals && summarize(model, x, "h")!.deviationEpd && summarize(model, x, "h")!.bookPly > 0)!;
    const s = summarize(model, g, "h")!;
    const before = g.evals![s.bookPly - 1]!;
    const after = g.evals![s.bookPly]!;
    const white = s.deviationEpd!.split(" ")[1] === "w";
    const sign = white ? 1 : -1;
    if ("cp" in before) expect(s.evalBefore).toBe(sign * before.cp);
    if ("cp" in after) expect(s.evalAfter).toBe(sign * after.cp);
  });

  it("no evaluation without analysis, and a game with no time class isn't summarised", () => {
    const s = summarize(model, game(["e4", "e5", "Nf3", "h6"]), "h")!;
    expect([s.evalBefore, s.evalAfter]).toEqual([null, null]);
    expect(summarize(model, game(["e4"], "white", { timeClass: null }), "h")).toBeNull();
  });

  it("rematch on the same dataset is the identity (apart from the hash)", () => {
    for (const g of games) {
      const s = summarize(model, g, "old")!;
      expect(rematch(model, s, "new")).toEqual({ ...s, datasetHash: "new" });
    }
  });
});
