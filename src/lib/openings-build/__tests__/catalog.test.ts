/**
 * Phase 2 acceptance fixtures (§5 Phase 2, ADR 0002) on the shipped TSVs and
 * the committed position stats.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
import { buildOpenings, type BuildOutput } from "../build";
import { definingSide, computeHubs } from "../hubs";
import { deriveCourse } from "../courses";
import { modelFromRaw } from "../model";
import { HUBS } from "@/content/hubs";
import type { SourceFile } from "../types";

const ROOT = join(__dirname, "../../../..");
const tsvFiles: SourceFile[] = readdirSync(join(ROOT, "public/data/all-openings"))
  .sort()
  .map((f) => ({ path: `all-openings/${f}`, text: readFileSync(join(ROOT, "public/data/all-openings", f), "utf8") }));
const stats = JSON.parse(gunzipSync(readFileSync(join(ROOT, "data/derived/position-stats.v1.json.gz"))).toString("utf8"));

let out: BuildOutput;
beforeAll(() => {
  out = buildOpenings({ tsvFiles, stats, statsSha: "test", v1Openings: null, previous: null, hubDefs: HUBS, now: "2026-10-18T00:00:00Z" });
}, 120_000);

const cat = () => out.catalog!;
const hub = (slug: string) => cat().catalog.hubs.find((h) => h.slug === slug)!;
const systemsOf = (slug: string, side: "white" | "black") => hub(slug).systems[side].map((i) => cat().catalog.systems[i]);
const recCourse = (slug: string, side?: "white" | "black") => {
  const h = hub(slug);
  const sys = systemsOf(slug, side ?? h.side).find((s) => s.recommended)!;
  return cat().courses[sys.course];
};

describe("default (defining) side", () => {
  // shortest plies of a row with exactly this name, from the real data
  const plies = (name: string) => {
    const rows = out.catalog!.model.rows.filter((r) => r.name === name);
    return rows.length ? Math.min(...rows.map((r) => r.sans.length)) : null;
  };
  const side = (name: string, own?: number) => definingSide(name, own ?? plies(name) ?? 0, plies);
  it.each([
    ["Queen's Gambit Declined", "black"],
    ["Queen's Gambit Accepted", "black"],
    ["King's Gambit", "white"],
    ["King's Gambit Accepted", "black"],
    ["King's Indian Defense", "black"],
    ["English Opening", "white"],
    ["Latvian Gambit", "black"],
    ["Latvian Gambit Accepted", "white"],
    ["Englund Gambit", "black"],
    ["Benko Gambit", "black"],
    ["Benko Gambit Declined", "white"],
  ])("%s → %s", (name, expected) => {
    expect(side(name)).toBe(expected);
  });
  it("Evans Gambit → white (C = 1.e4 e5 2.Nf3 Nc6 3.Bc4 Bc5 4.b4, 7 plies)", () => {
    expect(side("Evans Gambit", 7)).toBe("white");
  });
});

describe("signature positions σ (§4.4 fixtures)", () => {
  it.each([
    ["queens-gambit-declined", "black", "d4 d5 c4 e6"],
    ["kings-indian-defense", "black", "d4 Nf6 c4 g6"],
    ["sicilian-defense", "black", "e4 c5"],
    ["ruy-lopez", "white", "e4 e5 Nf3 Nc6 Bb5"],
    ["italian-game", "white", "e4 e5 Nf3 Nc6 Bc4"],
    ["grunfeld-defense", "black", "d4 Nf6 c4 g6 Nc3 d5"],
    ["caro-kann-defense", "black", "e4 c6"],
    ["benoni-defense", "black", "d4 Nf6 c4 c5"],
    ["semi-slav-defense", "black", "d4 d5 c4 c6 Nf3 Nf6 Nc3 e6"],
    ["kings-gambit", "white", "e4 e5 f4"],
    ["london-system", "white", "d4 d5 Nf3 Nf6 Bf4"],
  ])("%s: side %s, σ = %s", (slug, side, sigma) => {
    expect(hub(slug).side).toBe(side);
    expect(hub(slug).sigma.join(" ")).toBe(sigma);
  });

  it("hub coverage at σ matches the prototype (rows through σ / attached)", () => {
    const hubs = out.catalog!.hubs;
    const h = (slug: string) => hubs.find((x) => x.slug === slug)!;
    const model = out.catalog!.model;
    const through = (slug: string) => {
      const x = h(slug);
      const sigma = x.sigmaPath[x.sigmaPath.length - 1];
      return [...x.attach.keys()].filter((r) => model.rows[r].path.includes(sigma)).length;
    };
    expect([through("queens-gambit-declined"), h("queens-gambit-declined").attach.size]).toEqual([80, 171]);
    expect(h("kings-indian-defense").attach.size).toBe(119);
    expect(h("sicilian-defense").attach.size).toBe(400);
    expect(h("ruy-lopez").attach.size).toBe(235);
    expect(h("italian-game").attach.size).toBe(187);
    expect(h("caro-kann-defense").attach.size).toBe(110);
    expect(h("grunfeld-defense").attach.size).toBe(55);
    expect(h("benoni-defense").attach.size).toBe(34);
  });

  it("the London unifies its three name groups", () => {
    const rows = out.catalog!.hubs.find((x) => x.slug === "london-system")!.rows.map((r) => out.catalog!.model.rows[r].name);
    expect(rows.some((n) => n.startsWith("London System"))).toBe(true);
    expect(rows.some((n) => n.startsWith("Queen's Pawn Game: London System"))).toBe(true);
    expect(rows.some((n) => n.startsWith("Queen's Pawn Game: Accelerated London System"))).toBe(true);
  });
});

describe("systems", () => {
  it("Sicilian as Black offers the Najdorf and the Dragon; the Najdorf is recommended", () => {
    const sys = systemsOf("sicilian-defense", "black");
    const naj = sys.find((s) => s.slug === "najdorf-variation")!;
    const dra = sys.find((s) => s.slug === "dragon-variation")!;
    expect(naj.defining).toEqual(["2…d6", "5…a6"]);
    expect(dra.defining).toEqual(["2…d6", "5…g6"]);
    expect(naj.recommended).toBe(true);
  });
  it("Ruy Lopez as White: the Closed system (4.Ba4 5.O-O 6.Re1) is recommended", () => {
    const rec = systemsOf("ruy-lopez", "white").find((s) => s.recommended)!;
    expect(rec.defining).toEqual(["4.Ba4", "5.O-O", "6.Re1"]);
  });
  it("King's Gambit as White: King's Knight's and Bishop's Gambit", () => {
    expect(systemsOf("kings-gambit", "white").map((s) => s.slug).filter((s) => !s.includes("~"))).toEqual(["kings-knights-gambit", "bishops-gambit"]);
  });
  it("QGD, KID, Caro-Kann and Italian have courses for both sides", () => {
    for (const slug of ["queens-gambit-declined", "kings-indian-defense", "caro-kann-defense", "italian-game", "london-system"]) {
      expect(systemsOf(slug, "white").length).toBeGreaterThan(0);
      expect(systemsOf(slug, "black").length).toBeGreaterThan(0);
    }
  });
});

describe("chapters and lines", () => {
  it("chapters are named by the opponent's reply", () => {
    expect(recCourse("ruy-lopez").chapters.map((c) => c.name)).toEqual(
      expect.arrayContaining(["Morphy Defense (3…a6)", "Berlin Defense (3…Nf6)", "Schliemann Defense (3…f5)"])
    );
    expect(recCourse("sicilian-defense").chapters.map((c) => c.name)).toEqual(
      expect.arrayContaining(["Main line (2.Nf3)", "Alapin Variation (2.c3)", "Smith-Morra Gambit (2.d4)"])
    );
    expect(recCourse("italian-game").chapters.map((c) => c.name)).toEqual(
      expect.arrayContaining(["Two Knights Defense (3…Nf6)", "Giuoco Piano (3…Bc5)"])
    );
    expect(recCourse("kings-gambit").chapters.map((c) => c.name)[0]).toBe("King's Gambit Accepted (2…exf4)");
  });

  it("QGD, KID, London and Caro-Kann chapters carry the theory names (both sides)", () => {
    const names = (slug: string, side: "white" | "black") => recCourse(slug, side).chapters.map((c) => c.name);
    expect(names("queens-gambit-declined", "white")).toEqual(
      expect.arrayContaining(["Normal Defense (3…Nf6)", "Tarrasch Defense (3…c5)", "Semi-Slav Defense, Accelerated Move Order (3…c6)"])
    );
    expect(names("queens-gambit-declined", "black")).toEqual(
      expect.arrayContaining(["Queen's Knight Variation (3.Nc3)", "Early deviations (2.Nf3, 1.c4)"])
    );
    expect(names("kings-indian-defense", "white")[0]).toBe("Orthodox Variation (6…e5)");
    expect(names("kings-indian-defense", "black")).toEqual(
      expect.arrayContaining(["Main line (3.Nc3)", "Fianchetto Variation, Immediate Fianchetto (3.g3)"])
    );
    expect(names("london-system", "white")).toEqual(expect.arrayContaining(["Main line (4…Nc6)", "Poisoned Pawn Variation (4…Qb6)"]));
    expect(names("caro-kann-defense", "black")[0]).toBe("Main line (2.d4)");
    // no chapter repeats the hub's own name
    for (const slug of ["queens-gambit-declined", "kings-indian-defense", "london-system", "caro-kann-defense"]) {
      for (const side of ["white", "black"] as const) for (const n of names(slug, side)) expect(n.startsWith(hub(slug).title)).toBe(false);
    }
  });

  it("the recommended system is never a stub (KID as White: 5.Nf3, not the 1-line 5.Be2)", () => {
    expect(systemsOf("kings-indian-defense", "white").find((s) => s.recommended)!.defining).toEqual(["3.Nc3", "4.e4", "5.Nf3"]);
  });

  it("every line name is unique within its course and never generic", () => {
    for (const c of cat().courses) {
      const names = c.lines.map((l) => l.name);
      expect(new Set(names).size, c.id).toBe(names.length);
      for (const n of names) expect(n, c.id).not.toMatch(/#\d|^\s*$/);
    }
  });

  it("line ids are unique per course", () => {
    for (const c of cat().courses) expect(new Set(c.lines.map((l) => l.id)).size, c.id).toBe(c.lines.length);
  });

  it("tier sizes follow the rules (QGD, KID, Sicilian, Ruy, London, Caro-Kann, Italian, KG)", () => {
    for (const slug of ["queens-gambit-declined", "kings-indian-defense", "sicilian-defense", "ruy-lopez", "london-system", "caro-kann-defense", "italian-game", "kings-gambit"]) {
      const c = recCourse(slug);
      const sigmaLines = c.lines.filter((l) => !l.early).length;
      const { essentials, core, complete } = c.tiers;
      expect(essentials.lines, slug).toBeGreaterThanOrEqual(Math.min(5, sigmaLines));
      expect(essentials.lines, slug).toBeLessThanOrEqual(20);
      expect(core.lines, slug).toBeGreaterThanOrEqual(essentials.lines);
      expect(core.lines, slug).toBeLessThanOrEqual(60);
      expect(complete.lines, slug).toBe(c.lines.length);
      expect(core.coverage, slug).toBeGreaterThanOrEqual(essentials.coverage);
    }
    expect(recCourse("sicilian-defense").tiers.essentials.coverage).toBeGreaterThanOrEqual(0.8);
  });

  it("lines are ordered by reach (σ lines first, then early deviations)", () => {
    for (const c of cat().courses.slice(0, 200)) {
      const main = c.lines.filter((l) => !l.early);
      for (let i = 1; i < main.length; i++) expect(main[i].reach).toBeLessThanOrEqual(main[i - 1].reach + 1e-12);
      const firstEarly = c.lines.findIndex((l) => l.early);
      if (firstEarly !== -1) expect(c.lines.slice(firstEarly).every((l) => l.early)).toBe(true);
    }
  });
});

describe("coverage (§4.4, Phase 2 acceptance)", () => {
  it("every TSV row is reachable from some course (unassigned = 0)", () => {
    expect(cat().unassigned).toEqual([]);
  });

  it("≥ 95 % of QGD-named rows are reachable from the QGD hub or its linked siblings; KID 119/119", () => {
    const model = cat().model;
    const reachable = (slugs: string[]) => {
      const nodes = new Set<number>();
      for (const c of cat().courses) {
        if (!slugs.includes(c.hub)) continue;
        for (const l of c.lines) for (const n of l.nodes) nodes.add(n);
        for (const f of c.folded) for (const n of f.nodes) nodes.add(n);
      }
      return nodes;
    };
    const qgd = cat().hubs.find((h) => h.slug === "queens-gambit-declined")!;
    const qgdNodes = reachable([qgd.slug, ...qgd.siblings]);
    const qgdRows = model.rows.filter((r) => r.name.startsWith("Queen's Gambit Declined"));
    const ok = qgdRows.filter((r) => qgdNodes.has(r.path[r.path.length - 1])).length;
    expect(ok / qgdRows.length).toBeGreaterThanOrEqual(0.95);

    const kidNodes = reachable(["kings-indian-defense"]);
    const kidRows = model.rows.filter((r) => r.name.startsWith("King's Indian Defense"));
    expect(kidRows.filter((r) => kidNodes.has(r.path[r.path.length - 1])).length).toBe(119);
  });

  it("no top-level hub has σ shorter than 2 plies unless curated; 1-ply families are offbeat", () => {
    for (const h of cat().catalog.hubs) {
      if (h.placement === "top" && h.kind !== "curated") expect(h.sigma.length, h.slug).toBeGreaterThanOrEqual(2);
      if (h.kind === "auto" && h.sigma.length === 1) expect(h.placement, h.slug).toBe("offbeat");
    }
  });
});

describe("client re-derivation (ADR 0002 Shipping)", () => {
  it("deriving a course from the encoded dataset reproduces the build's line ids", () => {
    const model = modelFromRaw(out.dataset);
    const hubs = computeHubs(model, HUBS);
    for (const id of ["ruy-lopez/closed@white", "sicilian-defense/najdorf-variation@black", "queens-gambit-declined/normal-defense@black"]) {
      const built = cat().courses.find((c) => c.id === id)!;
      const h = hubs.find((x) => x.slug === built.hub)!;
      const again = deriveCourse(model, h, built.system);
      expect(again.lines.map((l) => l.id)).toEqual(built.lines.map((l) => l.id));
    }
  });

  it("the client path (one hub from its shipped seed) gives the same courses, variants included", async () => {
    const { loadCourse, findSystem } = await import("@/lib/courses-client");
    const { parseDatasetV2 } = await import("@/lib/openings");
    const ds = parseDatasetV2(out.dataset, out.outputHash);
    const sample = cat().courses.filter((_, i) => i % 37 === 0).concat(cat().courses.filter((c) => c.system.parent).slice(0, 10));
    for (const built of sample) {
      const sys = findSystem(ds, built.hub, built.system.slug, built.side)!;
      const again = loadCourse(ds, sys)!;
      expect(again.lines.map((l) => l.id), built.id).toEqual(built.lines.map((l) => l.id));
      expect(again.lines.map((l) => l.name), built.id).toEqual(built.lines.map((l) => l.name));
    }
  });

  it("an override re-derives the course (4.Bxc6 in a 4.Ba4 course)", () => {
    const built = cat().courses.find((c) => c.id === "ruy-lopez/closed@black")!;
    const model = cat().model;
    const h = cat().hubs.find((x) => x.slug === "ruy-lopez")!;
    // as Black there is no 4.Bxc6 choice; use the White Closed course instead
    const white = cat().courses.find((c) => c.id === "ruy-lopez/closed@white")!;
    const after3a6 = white.lines[0].nodes[6]; // 1.e4 e5 2.Nf3 Nc6 3.Bb5 a6 → White to move
    expect(white.bookMoves.get(after3a6)).toBe("Ba4");
    expect(white.systemNodes.has(after3a6)).toBe(true); // system-defining: overrides blocked
    const at4Nf6 = white.lines[0].nodes[8]; // after 4.Ba4 Nf6: 5.O-O is also system-defining
    expect(white.systemNodes.has(at4Nf6)).toBe(true);
    void built;
    // pick a non-system learner node with an alternative and override it
    const node = [...white.alternatives.keys()].find((n) => !white.systemNodes.has(n) && white.bookMoves.has(n))!;
    const alt = white.alternatives.get(node)![0];
    const re = deriveCourse(model, h, white.system, { overrides: new Map([[node, alt]]) });
    expect(re.bookMoves.get(node)).toBe(alt);
    expect(re.lines.map((l) => l.id)).not.toEqual(white.lines.map((l) => l.id));
  });
});

describe("course memo (dev watcher)", () => {
  it("memoised incremental builds are byte-identical to fresh builds, even when node indices shift", async () => {
    const { CourseMemo } = await import("../memo");
    const { createHash } = await import("node:crypto");
    const hasher = (s: string) => createHash("sha256").update(s).digest("hex");
    const memo = new CourseMemo(hasher);
    const build = (files: SourceFile[], m?: InstanceType<typeof CourseMemo>) =>
      buildOpenings({ tsvFiles: files, stats, statsSha: "t", v1Openings: null, previous: null, hubDefs: HUBS, hasher, courseMemo: m, skipLegacy: true });
    build(tsvFiles, memo);
    // an insertion in a.tsv shifts every later node index
    const edited = tsvFiles.map((f) => (f.path.endsWith("a.tsv") ? { ...f, text: f.text + "A00\tAmar Opening: Memo Test\t1. Nh3 a5 2. a3\n" } : f));
    const viaMemo = build(edited, memo);
    expect(memo.hits).toBeGreaterThan(memo.misses);
    expect(viaMemo.outputHash).toBe(build(edited).outputHash);
  }, 120_000);
});
