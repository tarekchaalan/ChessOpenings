import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { buildOpenings } from "../build";
import { ReplayCache } from "../replay";
import type { SourceFile } from "../types";
import type { V1Opening } from "../legacy";

const DATA = join(__dirname, "../../../../public/data");
const tsvFiles: SourceFile[] = readdirSync(join(DATA, "all-openings"))
  .sort()
  .map((f) => ({ path: `all-openings/${f}`, text: readFileSync(join(DATA, "all-openings", f), "utf8") }));
const v1: V1Opening[] = JSON.parse(readFileSync(join(DATA, "openings.v1.json"), "utf8")).openings;

const emptyStats = { format: "chess-openings-trainer/position-stats@1" as const, maxPly: 38, minGames: 3, positions: {} };
const base = { stats: emptyStats, statsSha: null, v1Openings: null, previous: null, now: "2026-10-18T00:00:00.000Z" };
const tiny = (body: string): SourceFile[] => [{ path: "all-openings/t.tsv", text: "eco\tname\tpgn\n" + body }];

describe("build on the shipped TSVs", () => {
  const out = buildOpenings({ ...base, tsvFiles, v1Openings: v1 });

  it("has 0 errors and every row", () => {
    expect(out.issues.filter((i) => i.level === "error")).toEqual([]);
    expect(out.counts.rows).toBe(3865);
  });

  it("row ids are stable across independent builds", () => {
    const again = buildOpenings({ ...base, tsvFiles, cache: new ReplayCache() });
    expect(again.dataset.rows.map((r) => r[0])).toEqual(out.dataset.rows.map((r) => r[0]));
    expect(again.outputHash).toBe(buildOpenings({ ...base, tsvFiles }).outputHash);
  });

  it("changelog vs the v1 baseline: +136 / −4 sequences and the renames", () => {
    const e = out.changelogEntry!;
    expect(e.added.length).toBe(136);
    expect(e.removed.length).toBe(4);
    expect(e.renamed.map((r) => r.to).sort()).toEqual([
      "Catalan Opening: Open Defense",
      "French Defense, Classical, 4. Bg5",
      "Pterodactyl Defense: Eastern, Rhamphorhynchus",
      "Robatsch Defense: Rossolimo Variation",
    ]);
  });

  it("legacy map covers every v1 index", () => {
    expect(out.legacyMap!.entries.length).toBe(v1.length);
    expect(out.legacyMap!.entries.filter((e) => e.rowId === null).length).toBe(4);
  });
});

describe("validation rules (§4.1)", () => {
  it("illegal SAN → error with file:line, ply and token; row skipped; build continues", () => {
    const out = buildOpenings({ ...base, tsvFiles: tiny("C20\tGood\t1. e4 e5\nC20\tBad\t1. e4 e5 2. Bxf9\nC20\tAlso good\t1. e4 c5\n") });
    expect(out.ok).toBe(false);
    expect(out.counts.rows).toBe(2);
    expect(out.issues).toEqual([
      expect.objectContaining({ level: "error", file: "all-openings/t.tsv", line: 3, ply: 3, token: "Bxf9" }),
    ]);
  });

  it("identity uses replayed SAN: 0-0 / O-O and over-disambiguation give the same row", () => {
    const a = buildOpenings({ ...base, tsvFiles: tiny("C60\tX\t1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O\n") });
    const b = buildOpenings({ ...base, tsvFiles: tiny("C60\tX\t1. e4 e5 2. Ngf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. 0-0\n") });
    expect(b.issues.filter((i) => i.level === "error")).toEqual([]);
    expect(b.dataset.rows[0][0]).toBe(a.dataset.rows[0][0]);
  });

  it("duplicate sequence → warning, first kept, other name becomes an alias", () => {
    const out = buildOpenings({ ...base, tsvFiles: tiny("C20\tFirst\t1. e4 e5\nC20\tSecond\t1. e4 e5\n") });
    expect(out.counts.rows).toBe(1);
    expect(out.dataset.rows[0][2]).toBe("First");
    expect(out.dataset.rows[0][5]).toEqual(["Second"]);
    expect(out.issues).toEqual([expect.objectContaining({ level: "warning", line: 3 })]);
  });

  it("same final position via different move orders keeps both rows; shortest path names it", () => {
    const out = buildOpenings({
      ...base,
      tsvFiles: tiny("D30\tLonger order\t1. Nf3 d5 2. d4 Nf6\nD02\tShorter\t1. d4 d5 2. Nf3 Nf6\n"),
    });
    expect(out.counts.rows).toBe(2);
    const finalNode = out.dataset.rows[0][4];
    expect(out.dataset.rows[1][4]).toBe(finalNode);
    expect(out.dataset.nodes[finalNode][1]).toBe(0); // equal length → first row wins
  });

  it("a non-TSV file is ignored with a warning; f.tsv works", () => {
    const out = buildOpenings({
      ...base,
      tsvFiles: [
        ...tiny("C20\tKP\t1. e4 e5\n"),
        { path: "all-openings/f.tsv", text: "eco\tname\tpgn\nA00\tMine\t1. a3\n" },
        { path: "all-openings/notes.txt", text: "hello" },
      ],
    });
    expect(out.counts.rows).toBe(2);
    expect(out.issues).toEqual([expect.objectContaining({ level: "warning", file: "all-openings/notes.txt" })]);
  });
});

describe("position stats join (§4.6)", () => {
  it("joins master stats onto a newly added line without the corpus", async () => {
    const { gunzipSync } = await import("node:zlib");
    const stats = JSON.parse(
      gunzipSync(readFileSync(join(__dirname, "../../../../data/derived/position-stats.v1.json.gz"))).toString("utf8")
    );
    const before = buildOpenings({ ...base, stats, tsvFiles });
    // find an off-book master move from a named position, deep enough to be interesting
    const rows = before.dataset.rows;
    let pick: { sans: string; san: string; games: number } | null = null;
    for (const r of rows) {
      const node = before.dataset.nodes[r[4]];
      const off = node[6].find((m) => m[1] === -1 && m[2] >= 20);
      if (off && r[3].split(" ").length >= 8) {
        pick = { sans: r[3], san: off[0], games: off[2] };
        break;
      }
    }
    expect(pick).not.toBeNull();
    const extra: SourceFile = {
      path: "all-openings/f.tsv",
      text: `eco\tname\tpgn\nA00\tNew From Stats\t${pick!.sans} ${pick!.san}\n`,
    };
    const after = buildOpenings({ ...base, stats, tsvFiles: [...tsvFiles, extra] });
    expect(after.ok).toBe(true);
    const row = after.dataset.rows.find((r) => r[2] === "New From Stats")!;
    const node = after.dataset.nodes[row[4]];
    expect(node[2]).toBeGreaterThanOrEqual(pick!.games); // games reaching the new position
    expect(node[2]).toBe(stats.positions[node[0]][0]);
  });
});
