import { describe, expect, it } from "vitest";
import { Chess } from "chess.js";
import { developedMinors, materialBalance, moveFacts, newThreats, pinsBy } from "../facts";

const fenAfter = (moves: string) => {
  const c = new Chess();
  for (const m of moves.split(" ").filter(Boolean)) c.move(m);
  return c.fen();
};
/** threats created by the last move of `moves` */
const threats = (moves: string) => {
  const list = moves.split(" ");
  return newThreats(fenAfter(list.slice(0, -1).join(" ")), fenAfter(moves));
};

describe("threat detection (10 real positions)", () => {
  it("Vienna Gambit after 4…Ng8: …Qh4+ is threatened (d8–h4, king square tinted)", () => {
    expect(threats("e4 e5 Nc3 Nf6 f4 exf4 e5 Ng8")).toEqual([
      { kind: "check", from: "d8", to: "h4", san: "Qh4+", target: "k", tint: ["h4", "e1"] },
    ]);
  });
  it("Scholar's mate set-up: after 3.Bc4, Qxf7# is threatened", () => {
    const t = threats("e4 e5 Qh5 Nc6 Bc4");
    expect(t[0]).toMatchObject({ kind: "mate", from: "h5", to: "f7", san: "Qxf7#" });
  });
  it("2.Qh5 creates a threat on the undefended e5 pawn", () => {
    expect(threats("e4 e5 Qh5")).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "capture", to: "e5", target: "p" })]));
  });
  it("3…a6 threatens the bishop with a pawn (up-trade)", () => {
    expect(threats("e4 e5 Nf3 Nc6 Bb5 a6")).toEqual([expect.objectContaining({ kind: "capture", from: "a6", to: "b5", target: "b" })]);
  });
  it("no threat: 2…Nc6 in the open games", () => {
    expect(threats("e4 e5 Nf3 Nc6")).toEqual([]);
  });
  it("long-standing threats are not repeated: Ruy Exchange 5.O-O keeps an existing Nxe5", () => {
    expect(threats("e4 e5 Nf3 Nc6 Bb5 a6 Bxc6 dxc6 O-O").some((t) => t.san === "Nxe5")).toBe(false);
  });
  it("Two Knights 4.Ng5: Bxf7+ becomes a safe check (Ng5 defends f7); Nxf7 takes a defended pawn, so it isn't claimed", () => {
    // before 4.Ng5, Bxf7+ just lost the bishop to Kxf7
    expect(threats("e4 e5 Nf3 Nc6 Bc4 Nf6 Ng5").map((t) => [t.kind, t.san])).toEqual([["check", "Bxf7+"]]);
  });
  it("a harmless bishop check is not a threat: 2…e6 allows …Bb4+, which can be blocked", () => {
    expect(threats("d4 d5 c4 e6")).toEqual([]);
  });
  it("a check that loses the checker is no threat: Giuoco Piano 3…Bc5 (…Bxf2+ Kxf2)", () => {
    expect(threats("e4 e5 Nf3 Nc6 Bc4 Bc5").map((t) => t.san)).not.toContain("Bxf2+");
  });
  it("no threats are computed when the learner is in check", () => {
    expect(threats("e4 f6 d4 g5 Qh5+")).toEqual([]);
  });
  it("Sicilian 2…d6 3.Bb5+: the check itself, nothing else", () => {
    expect(threats("e4 c5 Nf3 d6 Bb5+")).toEqual([]);
  });
});

describe("pins (ray scans)", () => {
  it("4.Bg5 in the QGD pins the f6 knight to the queen (relative)", () => {
    expect(pinsBy(fenAfter("d4 d5 c4 e6 Nc3 Nf6 Bg5"), "g5")).toEqual([
      { pinner: "g5", pinned: "f6", pinnedPiece: "n", behind: "d8", behindPiece: "q", absolute: false },
    ]);
  });
  it("3…Bb4 in the Nimzo-Indian pins the c3 knight to the king (absolute)", () => {
    expect(pinsBy(fenAfter("d4 Nf6 c4 e6 Nc3 Bb4"), "b4")).toEqual([
      expect.objectContaining({ pinned: "c3", behind: "e1", absolute: true }),
    ]);
  });
  it("3.Bb5 in the Ruy Lopez is not a pin (a pawn stands behind the knight)", () => {
    expect(pinsBy(fenAfter("e4 e5 Nf3 Nc6 Bb5"), "b5")).toEqual([]);
  });
  it("knights never pin", () => {
    expect(pinsBy(fenAfter("e4 e5 Nf3"), "f3")).toEqual([]);
  });
});

describe("move facts", () => {
  it("fianchetto: 3…Bg7 in the King's Indian; not 2.Bc4", () => {
    expect(moveFacts(fenAfter("d4 Nf6 c4 g6 Nc3"), "Bg7")!.fianchetto).toBe(true);
    expect(moveFacts(fenAfter("e4 e5"), "Bc4")!.fianchetto).toBe(false);
  });
  it("pawn breaks: 2.c4 vs d5, 2.f4 vs e5; 2.Nf3 isn't one", () => {
    expect(moveFacts(fenAfter("d4 d5"), "c4")!.pawnBreak).toBe(true);
    expect(moveFacts(fenAfter("e4 e5"), "f4")!.pawnBreak).toBe(true);
    expect(moveFacts(fenAfter("e4 e5"), "Nf3")!.pawnBreak).toBe(false);
  });
  it("captures and recaptures: the QGD Exchange 4…exd5", () => {
    const c = new Chess(fenAfter("d4 d5 c4 e6 Nc3 Nf6"));
    const prev = c.move("cxd5");
    const f = moveFacts(c.fen(), "exd5", prev)!;
    expect(f.capture).toEqual({ piece: "p", square: "d5", recapture: true });
    expect(moveFacts(fenAfter("d4 d5"), "c4")!.capture).toBeNull();
  });
  it("checks, mates and castling", () => {
    expect(moveFacts(fenAfter("e4 c5 Nf3 d6"), "Bb5+")!.check).toBe(true);
    expect(moveFacts(fenAfter("f3 e5 g4"), "Qh4#")!.mate).toBe(true);
    expect(moveFacts(fenAfter("e4 e5 Nf3 Nc6 Bc4 Bc5"), "O-O")!.castle).toBe("short");
  });
  it("material vs the start: the King's Gambit is a pawn down after 2…exf4", () => {
    expect(materialBalance(fenAfter("e4 e5 f4 exf4"))).toBe(-1);
    expect(moveFacts(fenAfter("e4 e5 f4"), "exf4")!.materialVsStart).toBe(1); // for Black
  });
  it("development count", () => {
    expect(developedMinors(fenAfter("e4 e5 Nf3 Nc6 Bc4 Nf6"), "b")).toBe(2);
    expect(developedMinors(fenAfter("e4 e5 Nf3 Nc6 Bc4 Nf6"), "w")).toBe(2);
  });
});
