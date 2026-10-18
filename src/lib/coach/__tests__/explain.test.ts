import { describe, expect, it } from "vitest";
import { Chess } from "chess.js";
import { clip, ideaText, opponentText, whyText, MAX_COACH_CHARS } from "../explain";
import { parseAnnotations } from "@/lib/openings-build/annotations";

const empty = { moves: new Map(), intros: new Map() };
const ctx = { annotations: empty, names: [], stats: null, previous: null };
const fen = (moves: string) => {
  const c = new Chess();
  for (const m of moves.split(" ").filter(Boolean)) c.move(m);
  return c.fen();
};

describe("coach text", () => {
  it("authored notes win and are clipped with a More", () => {
    const long = "x ".repeat(200).trim();
    const a = parseAnnotations([{ path: "a/t.pgn", text: `1. e4 { ${long} } *` }], []);
    const w = whyText(fen(""), "e4", { ...ctx, annotations: a });
    expect(w.authored).toBe(true);
    expect(w.text.length).toBeLessThanOrEqual(MAX_COACH_CHARS);
    expect(w.more).toBe(long);
  });
  it("fact text only states verified facts", () => {
    expect(whyText(fen("d4 d5 c4 e6 Nc3 Nf6"), "Bg5", ctx).text).toMatch(/Pins the knight on f6 to the queen/);
    expect(whyText(fen("d4 Nf6 c4 g6 Nc3"), "Bg7", ctx).text).toMatch(/long diagonal/);
    expect(whyText(fen("e4 e5 Nf3 Nc6 Bc4 Bc5"), "O-O", ctx).text).toMatch(/Castles/);
    expect(whyText(fen("e4 e5"), "Nf3", ctx).text).not.toMatch(/pin|check|captur/i);
  });
  it("gambit wording needs both the name and the material deficit", () => {
    const g = whyText(fen("e4 e5"), "f4", { ...ctx, names: ["King's Gambit"] });
    expect(g.text).not.toMatch(/down/); // no deficit yet after 2.f4
    const d = whyText(fen("e4 e5 f4 exf4 Nf3 g5 h4 g4"), "Ne5", { ...ctx, names: ["King's Gambit Accepted"] });
    expect(d.text).toMatch(/down: that's the gambit/);
  });
  it("stats sentences use the real numbers", () => {
    const t = whyText(fen("e4 c5"), "Nf3", { ...ctx, stats: { nodeGames: 1000, moveGames: 750, scoreBefore: 0.52, scoreAfter: 0.58 } }).text;
    expect(t).toMatch(/75% of master games/);
    expect(t).toMatch(/White scores 58% after it \(52% before\)/);
  });
  it("H1 idea never names the destination square", () => {
    const idea = ideaText(fen("d4 d5 c4 e6 Nc3 Nf6"), "Bg5", empty);
    expect(idea).toBe("Pin a piece with your bishop.");
    expect(idea).not.toMatch(/g5/);
    expect(ideaText(fen("e4 e5"), "Nf3", empty)).toBe("Develop a knight.");
  });
  it("opponent text includes created threats (Vienna 4…Ng8)", () => {
    const o = opponentText(fen("e4 e5 Nc3 Nf6 f4 exf4 e5"), "Ng8", ctx);
    expect(o.threats[0].san).toBe("Qh4+");
    expect(o.text).toMatch(/Black threatens …Qh4\+/);
  });
  it("clip keeps sentences whole when it can", () => {
    expect(clip("a".repeat(300)).length).toBeLessThanOrEqual(240);
  });
});
