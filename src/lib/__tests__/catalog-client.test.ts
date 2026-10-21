/** Phase 4 acceptance: catalog search and Explore → course targets, on the shipped dataset. */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDatasetV2 } from "../openings";
import { modelOf } from "../courses-client";
import { fold, groupSearchHits, parseMoveQuery, positionTarget, rowTarget, searchCatalog } from "../catalog-client";
import type { RawDatasetV2 } from "../openings-build/dataset";

const raw = JSON.parse(readFileSync(join(__dirname, "../../../public/data/openings.v2.json"), "utf8")) as RawDatasetV2;
const ds = parseDatasetV2(raw, "test");
const model = modelOf(ds);

describe("search (§3.2 A)", () => {
  it("najdorf → Najdorf rows in the Sicilian hub", () => {
    const hits = searchCatalog(ds, "najdorf");
    expect(hits.length).toBeGreaterThan(3);
    expect(hits[0].name).toMatch(/Najdorf/);
    expect(hits[0].hub?.slug).toBe("sicilian-defense");
  });
  it("B90 keeps the ECO behaviour", () => {
    const hits = searchCatalog(ds, "B90");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.eco?.startsWith("B90"))).toBe(true);
    expect(searchCatalog(ds, "b9").every((h) => h.eco?.startsWith("B9"))).toBe(true);
  });
  it("move strings, with or without numbers, SAN or figurine", () => {
    for (const q of ["e4 c5 Nf3 d6 d4", "1.e4 c5 2.Nf3 d6 3.d4", "1. e4 c5 2. ♘f3 d6 3. d4"]) {
      const hits = searchCatalog(ds, q);
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0].sans.slice(0, 5).join(" ")).toBe("e4 c5 Nf3 d6 d4");
    }
    expect(parseMoveQuery("najdorf")).toBeNull();
  });
  it("a single move like e4 searches moves first (it is also an ECO prefix)", () => {
    const hits = searchCatalog(ds, "e4");
    expect(hits[0].sans[0]).toBe("e4");
  });
  it("results group by opening: Caro-Kann is one group with its variations under it", () => {
    const hits = searchCatalog(ds, "Caro-Kann", 60);
    expect(hits.length).toBeGreaterThan(10);
    const groups = groupSearchHits(ds, hits);
    expect(groups[0].hub?.slug).toBe("caro-kann-defense");
    // every Caro-Kann row lands in that one group, so the hub is never repeated
    expect(groups.filter((g) => g.hub?.slug === "caro-kann-defense")).toHaveLength(1);
    const ck = groups[0];
    // the signature line "Caro-Kann Defense 1.e4 c6" is the header, not a row
    expect(ck.hits.some((h) => h.name === "Caro-Kann Defense" && h.sans.join(" ") === "e4 c6")).toBe(false);
    expect(ck.hits.some((h) => /Advance Variation/.test(h.name))).toBe(true);
    // hit order is preserved inside the group
    const order = ck.hits.map((h) => hits.findIndex((x) => x.row === h.row));
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
  it("grouping keeps the best hit's opening first (najdorf → Sicilian)", () => {
    const groups = groupSearchHits(ds, searchCatalog(ds, "najdorf"));
    expect(groups[0].hub?.slug).toBe("sicilian-defense");
    expect(groups[0].hits[0].name).toMatch(/Najdorf/);
  });
  it("grunfeld is accent-insensitive; one typo is forgiven", () => {
    expect(fold("Grünfeld")).toBe("grunfeld");
    expect(searchCatalog(ds, "grunfeld")[0].name).toMatch(/Grünfeld/);
    expect(searchCatalog(ds, "najdorff")[0].name).toMatch(/Najdorf/);
  });
});

describe("position → course (Explore 'Learn this line')", () => {
  const nodeAfter = (moves: string) => {
    let n = 0;
    for (const m of moves.split(" ")) n = model.nodes[n].theoryByNorm.get(m)!.to;
    return n;
  };
  it("the Ruy Lopez after 3…a6, as White → a Ruy Lopez White course on a line through it", () => {
    const t = positionTarget(ds, nodeAfter("e4 e5 Nf3 Nc6 Bb5 a6"), "white")!;
    expect(t.hub.slug).toBe("ruy-lopez");
    expect(t.system.side).toBe("white");
    // the course whose move masters play here (4.Ba4 96%), the recommended one
    expect(t.system.slug).toBe("closed");
  });
  it("as Black when White is to move: the reply that leads into a Black course", () => {
    const t = positionTarget(ds, nodeAfter("e4"), "black")!;
    expect(t.system.side).toBe("black");
  });
  it("a search hit's row resolves to a course for the chosen side", () => {
    const najdorf = searchCatalog(ds, "najdorf")[0];
    const t = rowTarget(ds, najdorf.row, "black")!;
    expect(t.hub.slug).toBe("sicilian-defense");
  });
});
