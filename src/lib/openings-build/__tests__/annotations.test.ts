import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Chess } from "chess.js";
import { decodeAnnotations, encodeAnnotations, parseAnnotations, parseComment } from "../annotations";
import { epdOf } from "../replay";
import { ANNOTATIONS } from "@/content/annotations";
import type { Issue } from "../types";

const epdAfter = (sans: string[]) => {
  const c = new Chess();
  for (const s of sans) c.move(s);
  return epdOf(c.fen());
};

describe("annotation PGN parser (§4.2)", () => {
  it("reads why / intro / shapes / NAGs / hint / plan, including variations", () => {
    const issues: Issue[] = [];
    const pgn = `[Event "t"]

{ Intro at the start } 1. e4 { Grabs the centre [%cal Ge2e4,Rd7d5] [%csl Gd4] } e5 2. Nf3!? { Attacks e5. [%hint Develop with tempo] }
( 2. f4 { The King's Gambit [%plan Open the f-file] } exf4 $2 ) 2... Nc6 *`;
    const a = parseAnnotations([{ path: "annotations/t.pgn", text: pgn }], issues);
    expect(issues).toEqual([]);
    const start = epdAfter([]);
    expect(a.intros.get(start)?.text).toBe("Intro at the start");
    expect(a.moves.get(`${start}|e4`)).toEqual({
      why: "Grabs the centre",
      shapes: [
        { orig: "e2", dest: "e4", brush: "green" },
        { orig: "d7", dest: "d5", brush: "red" },
        { orig: "d4", brush: "green" },
      ],
    });
    const afterE5 = epdAfter(["e4", "e5"]);
    expect(a.moves.get(`${afterE5}|Nf3`)).toEqual({ nags: [5], why: "Attacks e5.", hint: "Develop with tempo" });
    expect(a.moves.get(`${afterE5}|f4`)).toEqual({ why: "The King's Gambit", plan: "Open the f-file" });
    expect(a.moves.get(`${epdAfter(["e4", "e5", "f4"])}|exf4`)).toEqual({ nags: [2] });
  });

  it("strips custom commands from display text", () => {
    expect(parseComment("Play it [%hint x] now [%clk 0:01:00] [%plan y]")).toMatchObject({ text: "Play it now", hint: "x", plan: "y" });
  });

  it("keys by position: transposed move orders share a note", () => {
    const a = parseAnnotations([{ path: "annotations/t.pgn", text: "1. d4 Nf6 2. c4 e6 3. Nf3 d5 { QGD by transposition } *" }], []);
    const viaQgdOrder = epdAfter(["d4", "d5", "c4", "e6", "Nf3"]);
    expect(a.moves.get(`${viaQgdOrder}|Nf6`)).toBeUndefined(); // different last move
    const before = epdAfter(["d4", "Nf6", "c4", "e6", "Nf3"]);
    expect(a.moves.get(`${before}|d5`)?.why).toBe("QGD by transposition");
  });

  it("warns on illegal moves and on moves outside the theory graph, never throws", () => {
    const issues: Issue[] = [];
    parseAnnotations([{ path: "annotations/bad.pgn", text: "1. e4 e5 2. Bxf9 { nope } *" }], issues, () => false);
    expect(issues.map((i) => i.level)).toEqual(["warning", "warning", "warning"]);
    expect(issues[2].message).toMatch(/illegal/);
  });

  it("round-trips through the dataset encoding", () => {
    const a = parseAnnotations([{ path: "annotations/t.pgn", text: "{ hi } 1. e4 { why [%cal Ge2e4] } $1 *" }], []);
    const b = decodeAnnotations(encodeAnnotations(a));
    expect([...b.moves]).toEqual([...a.moves]);
    expect([...b.intros]).toEqual([...a.intros]);
  });
});

describe("migrated curated notes", () => {
  const text = readFileSync(join(__dirname, "../../../../public/data/annotations/curated.pgn"), "utf8");
  const a = parseAnnotations([{ path: "annotations/curated.pgn", text }], []);
  it("every v1 note resolves to a (position, move) key with its text", () => {
    expect(Object.keys(ANNOTATIONS).length).toBe(74);
    // the 74 migrated v1 notes + the 4 authored end-of-line plans (Phase 6)
    expect(a.moves.size).toBe(78);
    let found = 0;
    for (const [line, note] of Object.entries(ANNOTATIONS)) {
      const sans = (line === "e4 e6 d5" ? "e4 e6 d4" : line).split(" ");
      const key = `${epdAfter(sans.slice(0, -1))}|${sans[sans.length - 1]}`;
      if (a.moves.get(key)?.why === note) found++;
    }
    expect(found).toBe(74);
  });
  it("the authored plans carry their text and arrows", () => {
    const plans = [...a.moves.values()].filter((n) => n.plan);
    expect(plans).toHaveLength(4);
    for (const p of plans) {
      expect(p.plan!.length).toBeGreaterThan(80);
      expect(p.shapes?.some((sh) => sh.dest)).toBe(true);
    }
    const canal = a.moves.get(`${epdAfter("e4 e5 Nf3 Nc6 Bc4 Nf6 d3 Bc5 Nc3 d6".split(" "))}|Bg5`);
    expect(canal?.plan).toMatch(/Canal Variation/);
  });
});
