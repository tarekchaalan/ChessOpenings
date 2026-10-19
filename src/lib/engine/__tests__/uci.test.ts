/** UCI parsing, score handling and mistake classification for the on-demand engine. */
import { describe, expect, it } from "vitest";
import { barLabel, classify, formatScore, negate, parseBestmove, parseInfo, pvToMoves, toCp, whiteShare } from "../uci";

describe("UCI output", () => {
  it("parses info lines with cp and mate scores, and ignores the rest", () => {
    expect(parseInfo("info depth 12 seldepth 18 multipv 1 score cp 34 nodes 1000 nps 1 time 5 pv e2e4 e7e5 g1f3")).toEqual({ depth: 12, score: { cp: 34 }, pv: ["e2e4", "e7e5", "g1f3"] });
    expect(parseInfo("info depth 9 score mate -3 pv h7h6 d1h5")).toEqual({ depth: 9, score: { mate: -3 }, pv: ["h7h6", "d1h5"] });
    expect(parseInfo("info depth 9 currmove e2e4 currmovenumber 1")).toBeNull();
    expect(parseInfo("info string NNUE evaluation using nn.nnue")).toBeNull();
  });
  it("parses bestmove, including (none)", () => {
    expect(parseBestmove("bestmove e2e4 ponder e7e5")).toBe("e2e4");
    expect(parseBestmove("bestmove (none)")).toBeNull();
    expect(parseBestmove("readyok")).toBeUndefined();
  });
});

describe("scores", () => {
  it("formats from White's view, mates as #n", () => {
    expect(formatScore({ cp: 34 })).toBe("+0.3");
    expect(formatScore({ cp: -240 })).toBe("−2.4");
    expect(formatScore({ cp: 0 })).toBe("0.0");
    expect(formatScore({ mate: 3 })).toBe("#3");
    expect(formatScore({ mate: -2 })).toBe("#−2");
  });
  it("orders mates beyond any centipawn score and flips sides", () => {
    expect(toCp({ mate: 2 })).toBeGreaterThan(toCp({ cp: 5000 }));
    expect(toCp({ mate: -2 })).toBeLessThan(toCp({ cp: -5000 }));
    expect(toCp({ mate: 1 })).toBeGreaterThan(toCp({ mate: 5 }));
    expect(negate({ cp: 50 })).toEqual({ cp: -50 });
    expect(negate({ mate: 4 })).toEqual({ mate: -4 });
  });
  it("eval bar share: even at 0, monotonic, mates fill it", () => {
    expect(whiteShare({ cp: 0 })).toBeCloseTo(0.5);
    expect(whiteShare({ cp: 300 })).toBeGreaterThan(whiteShare({ cp: 100 }));
    expect(whiteShare({ mate: 2 })).toBe(1);
    expect(whiteShare({ mate: -2 })).toBe(0);
  });
});

describe("mistake classification (learner's point of view)", () => {
  it("thresholds: ≥ 300 blunder, ≥ 120 mistake, ≥ 50 inaccuracy, else playable", () => {
    expect(classify({ cp: 30 }, { cp: -400 }).verdict).toBe("blunder");
    expect(classify({ cp: 30 }, { cp: -100 }).verdict).toBe("mistake");
    expect(classify({ cp: 30 }, { cp: -30 }).verdict).toBe("inaccuracy");
    expect(classify({ cp: 30 }, { cp: 10 }).verdict).toBe("playable");
    expect(classify({ cp: 30 }, { mate: -3 }).verdict).toBe("blunder");
    // a "better" move never counts as a drop
    expect(classify({ cp: 30 }, { cp: 80 })).toEqual({ verdict: "playable", drop: 0 });
  });
  it("refutation PV → SAN with squares, stopping at an illegal move", () => {
    // 1.e4 e5 2.Ba6?? — the refutation starts with …bxa6 / …Nxa6
    const fen = "rnbqkbnr/pppp1ppp/B7/4p3/4P3/8/PPPP1PPP/RNBQK1NR b KQkq - 1 2";
    const moves = pvToMoves(fen, ["b7a6", "d2d4", "e5d4", "zz99"], 4);
    expect(moves.map((m) => m.san)).toEqual(["bxa6", "d4", "exd4"]);
    expect(moves[0]).toMatchObject({ from: "b7", to: "a6" });
  });
});

describe("barLabel", () => {
  it("is unsigned, one decimal under 10, M for mate", () => {
    expect(barLabel({ cp: 34 })).toBe("0.3");
    expect(barLabel({ cp: -250 })).toBe("2.5");
    expect(barLabel({ cp: 1234 })).toBe("12");
    expect(barLabel({ mate: -3 })).toBe("M3");
  });
});
