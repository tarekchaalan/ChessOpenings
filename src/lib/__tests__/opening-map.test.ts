/** Opening Map layout (Phase 6 stretch) on the shipped dataset. */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { modelFromRaw } from "@/lib/openings-build/model";
import { layoutIcicle, nodeAtPath } from "../opening-map";

const model = modelFromRaw(JSON.parse(readFileSync(join(__dirname, "../../../public/data/openings.v2.json"), "utf8")));

describe("icicle layout", () => {
  const l = layoutIcicle(model, [])!;
  const byPath = new Map(l.cells.map((c) => [c.path.join(" "), c]));
  it("8 plies deep from the start; widths are shares of master games", () => {
    expect(l.root).toMatchObject({ depth: 0, x0: 0, x1: 1, share: 1 });
    expect(Math.max(...l.cells.map((c) => c.depth))).toBe(8);
    const e4 = byPath.get("e4")!;
    expect(e4.x1 - e4.x0).toBeCloseTo(e4.games / model.nodes[0].games, 9);
    // most-played first, left to right
    const firsts = l.cells.filter((c) => c.depth === 1);
    for (let i = 1; i < firsts.length; i++) expect(firsts[i].games).toBeLessThanOrEqual(firsts[i - 1].games);
  });
  it("children sit inside their parent and never overlap", () => {
    for (const c of l.cells) {
      if (!c.path.length) continue;
      const p = byPath.get(c.path.slice(0, -1).join(" "))!;
      expect(c.x0).toBeGreaterThanOrEqual(p.x0 - 1e-9);
      expect(c.x1).toBeLessThanOrEqual(p.x1 + 1e-9);
    }
    for (let d = 1; d <= 8; d++) {
      const row = l.cells.filter((c) => c.depth === d).sort((a, b) => a.x0 - b.x0);
      for (let i = 1; i < row.length; i++) expect(row[i].x0).toBeGreaterThanOrEqual(row[i - 1].x1 - 1e-9);
    }
  });
  it("colour = ECO volume of the deepest name on the path", () => {
    expect(byPath.get("e4 c5")!.volume).toBe("B");
    expect(byPath.get("d4 d5 c4")!.volume).toBe("D");
  });
  it("zoom re-roots the layout; an off-theory path is rejected", () => {
    const z = layoutIcicle(model, ["e4", "c5"])!;
    expect(z.root.node).toBe(nodeAtPath(model, ["e4", "c5"])!.node);
    expect(model.rows[z.root.row].name).toMatch(/Sicilian/);
    expect(z.cells.every((c) => c.path.slice(0, 2).join(" ") === "e4 c5")).toBe(true);
    expect(layoutIcicle(model, ["e4", "Ke7"])).toBeNull();
  });
});
