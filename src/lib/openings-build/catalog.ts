/**
 * Catalog orchestration (ADR 0002): every hub × side × system → course,
 * global row coverage, variant systems for rows no default course reaches,
 * catalog placement, compact summaries for the client, the position→course
 * index, and legacy resolution. Pure and deterministic.
 */
import { bookMove, courseIdOf, deriveCourse, findSystems, moveLabel, type Course, type SystemDef } from "./courses";
import { commonSegments, segmentsToName, slugify, type Hub, type HubDef, type Style } from "./hubs";
import { deepestName, type Model } from "./model";
import { T } from "./tunables";
import type { CourseMemo } from "./memo";
import type { Side } from "./types";

export type Level = "beginner" | "intermediate" | "advanced";

export interface RawHubSummary {
  slug: string;
  title: string;
  kind: Hub["kind"];
  parent: string | null;
  side: Side;
  /** σ as SANs (display) */
  sigma: string[];
  /** name whose shortest row is the canonical row (hub seed) */
  primaryName: string;
  /** row indices of the hub (hub seed: lets the client rebuild just this hub) */
  rowIdx: number[];
  sigmaNode: number;
  rows: number;
  placement: "top" | "offbeat";
  featured: boolean;
  tags: Style[];
  level: Level;
  /** curated defining side / signature (hub seed, so the client needs no config) */
  defSide: Side | null;
  signature: string | null;
  /** Black hubs: which first move they answer */
  against: "e4" | "d4" | "other" | null;
  description: string | null;
  siblings: string[];
  /** sibling groups too small for their own listing (they live in Offbeat) */
  minorSiblings: string[];
  eco: [string, string] | null;
  games: number;
  wdl: [number, number, number];
  /** system indices per learner side, ordered for display */
  systems: { white: number[]; black: number[] };
  /** σ excludes hub rows by move order (early deviations / siblings exist) */
  moveOrderNote: boolean;
}

export interface RawSystemSummary {
  hub: number;
  side: Side;
  slug: string;
  name: string;
  /** [node, normalised SAN] */
  choices: [number, string][];
  defining: string[];
  signatureNode: number;
  parent: number;
  recommended: boolean;
  course: number;
}

export interface RawCourseSummary {
  id: string;
  system: number;
  lines: number;
  essentials: [number, number];
  core: [number, number];
  complete: [number, number];
  avgDepth: number;
  maxDepth: number;
  chapters: [string, number][];
  games: number;
  /** lines through σ (early deviations excluded) */
  sigmaLines: number;
}

export interface RawCatalog {
  hubs: RawHubSummary[];
  systems: RawSystemSummary[];
  courses: RawCourseSummary[];
  /** per node: [course, line] for the side to move, -1 when none (flat pairs) */
  pos: number[];
}

export interface Unassigned {
  rowId: string;
  name: string;
  reason: string;
}

export interface CatalogResult {
  model: Model;
  catalog: RawCatalog;
  courses: Course[];
  hubs: Hub[];
  systems: SystemDef[];
  unassigned: Unassigned[];
  coverage: { rows: number; covered: number; asNotes: number; variants: number; extPlies: number; lines: number };
  hubReport: { slug: string; title: string; kind: string; rows: number; covered: number; pct: number }[];
}

const SIDES: Side[] = ["white", "black"];

export function buildCatalog(model: Model, hubs: Hub[], memo?: CourseMemo): CatalogResult {
  memo?.begin();
  const systems: SystemDef[] = [];
  const courses: Course[] = [];
  const courseOfSystem: number[] = [];
  const hubIdx = new Map(hubs.map((h, i) => [h.slug, i]));

  // two systems whose courses teach exactly the same lines are one course
  const lineSetOf = (c: Course) =>
    `${c.hub}@${c.side}#` + [...c.lines.map((l) => l.sans.join(" ")), ...c.folded.map((f) => "~" + f.sans.join(" "))].sort().join("|");
  const lineSets = new Set<string>();
  const usedNames = new Set<string>();
  const make = (hub: Hub, sys: SystemDef) => (memo ? memo.derive(model, hub, sys) : deriveCourse(model, hub, sys));
  const commit = (sys: SystemDef, course: Course): boolean => {
    const set = lineSetOf(course);
    if (lineSets.has(set)) return false;
    lineSets.add(set);
    // names are unique within a hub and side
    let name = sys.name;
    const nameKey = (n: string) => `${sys.hub}@${sys.side}#${n}`;
    for (let k = 2; usedNames.has(nameKey(name)); k++) name = `${sys.name} (${k})`;
    usedNames.add(nameKey(name));
    if (name !== sys.name) {
      sys = { ...sys, name };
      course = { ...course, system: sys };
    }
    systems.push(sys);
    courses.push(course);
    courseOfSystem.push(courses.length - 1);
    return true;
  };
  for (const hub of hubs) for (const side of SIDES) for (const sys of findSystems(model, hub, side)) commit(sys, make(hub, sys));

  // ── coverage: a row is covered when its final position is on a course line
  const covered = new Set<number>();
  const notes = new Set<number>(); // positions only reachable as folded notes
  const markCourse = (c: Course) => {
    for (const l of c.lines) for (const n of l.nodes) covered.add(n);
    for (const f of c.folded) for (const n of f.nodes) notes.add(n);
  };
  courses.forEach(markCourse);
  const finalNode = (r: number) => model.rows[r].path[model.rows[r].path.length - 1];
  const hubsOfRow = new Map<number, number[]>();
  hubs.forEach((h, hi) => {
    for (const r of h.rows) {
      let l = hubsOfRow.get(r);
      if (!l) hubsOfRow.set(r, (l = []));
      l.push(hi);
    }
  });

  // ── variant systems: greedy set cover over still-uncovered rows
  let variants = 0;
  const variantsPerRoot = new Map<string, number>();
  const rootOf = (s: SystemDef): string => `${s.hub}/${s.slug.split("~")[0]}@${s.side}`;
  const tried = new Set<string>();
  const nodeSets = new Map<number, Set<number>>();
  const courseNodes = (ci: number) => {
    let set = nodeSets.get(ci);
    if (!set) {
      set = new Set<number>();
      for (const l of courses[ci].lines) for (const n of l.nodes) set.add(n);
      for (const f of courses[ci].folded) for (const n of f.nodes) set.add(n);
      nodeSets.set(ci, set);
    }
    return set;
  };
  const coursesByHub = new Map<string, number[]>();
  const indexCourse = (ci: number) => {
    let l = coursesByHub.get(courses[ci].hub);
    if (!l) coursesByHub.set(courses[ci].hub, (l = []));
    l.push(ci);
  };
  courses.forEach((_, ci) => indexCourse(ci));
  const usedSlugs = new Set(systems.map((s) => `${s.hub}/${s.slug}@${s.side}`));

  // Rounds of greedy set cover: each round takes every best candidate whose
  // rows don't overlap an earlier pick (deterministic order), then rescans.
  for (let round = 0; round < 64 && variants < T.VARIANT_MAX_TOTAL; round++) {
    const uncovered = model.rows.filter((r) => !covered.has(finalNode(r.idx)) && !notes.has(finalNode(r.idx))).map((r) => r.idx);
    if (!uncovered.length) break;
    const cand = new Map<string, { ci: number; node: number; norm: string; ply: number; path: number[]; rows: number[] }>();
    for (const r of uncovered) {
      const row = model.rows[r];
      for (const hi of hubsOfRow.get(r) ?? []) {
        const hub = hubs[hi];
        const start = hub.attach.get(r) ?? hub.earlyRows.get(r) ?? 0;
        for (const ci of coursesByHub.get(hub.slug) ?? []) {
          const c = courses[ci];
          if ((variantsPerRoot.get(rootOf(c.system)) ?? 0) >= T.VARIANT_MAX_PER_SYSTEM) continue;
          const onCourse = courseNodes(ci);
          // moves before the attachment point are just another move order into the hub;
          // so is a detour that rejoins the course later (EPD transposition): skip to the rejoin
          const rejoin = (i: number) => {
            for (let j = row.norms.length - 1; j > i; j--) if (onCourse.has(row.path[j])) return j;
            return -1;
          };
          // the ply where this row asks for a new learner choice, or -1
          const deviation = (skipDetours: boolean): number => {
            for (let i = start; i < row.norms.length; i++) {
              const node = row.path[i];
              const book = onCourse.has(node) ? c.bookMoves.get(node) : undefined;
              if (onCourse.has(node) && (book === undefined || book === row.norms[i])) continue; // opponent node, or the book move
              const j = skipDetours ? rejoin(i) : -1;
              if (j > 0) {
                i = j - 1;
                continue;
              }
              if (!onCourse.has(node)) return -1;
              if (c.systemNodes.has(node)) return -1; // that's a different system, not a variant
              if (!hub.dag.get(node)?.some((m) => m.norm === row.norms[i])) return -1;
              if (tried.has(`${ci}|${node}|${row.norms[i]}`)) return -1;
              return i;
            }
            return -1;
          };
          // the rejoin may land on an unrelated course node: then the first deviation is the fix
          let i = deviation(true);
          if (i < 0) i = deviation(false);
          if (i < 0) continue;
          const node = row.path[i];
          const key = `${ci}|${node}|${row.norms[i]}`;
          let e = cand.get(key);
          if (!e) cand.set(key, (e = { ci, node, norm: row.norms[i], ply: i, path: row.path.slice(0, i + 1), rows: [] }));
          e.rows.push(r);
        }
      }
    }
    if (!cand.size) break;
    const sorted = [...cand.values()].sort(
      (a, b) => b.rows.length - a.rows.length || a.ci - b.ci || a.node - b.node || (a.norm < b.norm ? -1 : 1)
    );
    const claimed = new Set<number>();
    const picks: typeof sorted = [];
    for (const c of sorted) {
      if (c.rows.some((r) => claimed.has(r))) continue;
      picks.push(c);
      for (const r of c.rows) claimed.add(r);
    }
    for (const best of picks) {
      if (variants >= T.VARIANT_MAX_TOTAL) break;
      tried.add(`${best.ci}|${best.node}|${best.norm}`);
      const parent = courses[best.ci];
      if ((variantsPerRoot.get(rootOf(parent.system)) ?? 0) >= T.VARIANT_MAX_PER_SYSTEM) continue;
      const hub = hubs[hubIdx.get(parent.hub)!];
      const mv = model.nodes[best.node].theoryByNorm.get(best.norm)!;
      // the ply comes from the row's own path, so the move number is right
      const label = moveLabel(best.ply, mv.san);
      const named = deepestName(model, [...best.path, mv.to]);
      const parentSegs = commonSegments(model, hub.rows, 0.5);
      const rest = named ? named.segments.slice(Math.max(parentSegs.length, 1)) : [];
      const rootName = parent.system.name.split(" · ")[0];
      let slug = `${parent.system.slug}~${slugify(label)}`;
      for (let k = 2; usedSlugs.has(`${hub.slug}/${slug}@${parent.side}`); k++) slug = `${parent.system.slug}~${slugify(label)}-${k}`;
      const sys: SystemDef = {
        hub: hub.slug,
        side: parent.side,
        slug,
        name: `${rootName} · ${rest.length ? `${rest[rest.length - 1]} (${label})` : label}`,
        choices: [...parent.system.choices, [best.node, best.norm]],
        defining: [...parent.system.defining, label],
        signatureNode: mv.to,
        parent: parent.system.slug,
      };
      const course = make(hub, sys);
      // a variant must get further along at least one target row than its parent
      // (reach it, or set up the next nested choice), and teach something new
      const reach = new Set<number>([...course.lines.flatMap((l) => l.nodes), ...course.folded.flatMap((f) => f.nodes)]);
      const before = courseNodes(best.ci);
      const progress = (set: Set<number>, r: number) => {
        const path = model.rows[r].path;
        let k = -1;
        for (let i = 0; i < path.length; i++) if (set.has(path[i])) k = i;
        return k;
      };
      if (!best.rows.some((r) => progress(reach, r) > progress(before, r))) continue;
      if (!commit(sys, course)) continue;
      usedSlugs.add(`${hub.slug}/${slug}@${parent.side}`);
      indexCourse(courses.length - 1);
      markCourse(courses[courses.length - 1]);
      variantsPerRoot.set(rootOf(sys), (variantsPerRoot.get(rootOf(sys)) ?? 0) + 1);
      variants++;
    }
  }

  // ── unassigned report
  const unassigned: Unassigned[] = [];
  let asNotes = 0;
  for (const row of model.rows) {
    if (covered.has(finalNode(row.idx))) continue;
    if (notes.has(finalNode(row.idx))) {
      asNotes++;
      continue;
    }
    const hs = hubsOfRow.get(row.idx) ?? [];
    unassigned.push({
      rowId: row.rowId,
      name: row.name,
      reason: hs.length
        ? `not reached by any course of ${hs.map((h) => hubs[h].slug).join(", ")} (both colours leave the book before it)`
        : "no hub claims it",
    });
  }

  // ── summaries
  const sysIndex = new Map(systems.map((s, i) => [`${s.hub}/${s.slug}@${s.side}`, i]));
  const rawSystems: RawSystemSummary[] = systems.map((s, i) => ({
    hub: hubIdx.get(s.hub)!,
    side: s.side,
    slug: s.slug,
    name: s.name,
    choices: s.choices,
    defining: s.defining,
    signatureNode: s.signatureNode,
    parent: s.parent ? sysIndex.get(`${s.hub}/${s.parent}@${s.side}`) ?? -1 : -1,
    recommended: false,
    course: courseOfSystem[i],
  }));

  const rawCourses: RawCourseSummary[] = courses.map((c, i) => {
    const depths = c.lines.map((l) => l.sans.length);
    return {
      id: c.id,
      system: i,
      lines: c.lines.length,
      essentials: [c.tiers.essentials.lines, round3(c.tiers.essentials.coverage)],
      core: [c.tiers.core.lines, round3(c.tiers.core.coverage)],
      complete: [c.tiers.complete.lines, round3(c.tiers.complete.coverage)],
      avgDepth: depths.length ? Math.round((depths.reduce((a, b) => a + b, 0) / depths.length) * 10) / 10 : 0,
      maxDepth: depths.length ? Math.max(...depths) : 0,
      chapters: c.chapters.map((ch) => [ch.name, ch.lines.length] as [string, number]),
      sigmaLines: c.lines.filter((l) => !l.early).length,
      games: model.nodes[c.system.signatureNode].games,
    };
  });

  const minorByParent = new Map<string, string[]>();
  for (const x of hubs) if (x.small && x.parent) minorByParent.set(x.parent, [...(minorByParent.get(x.parent) ?? []), x.slug]);
  const minorSiblingsOf = (slug: string) => minorByParent.get(slug) ?? [];
  const rawHubs: RawHubSummary[] = hubs.map((h, hi) => {
    const sigmaNode = h.sigmaPath[h.sigmaPath.length - 1];
    const node = model.nodes[sigmaNode];
    const bySide = { white: [] as number[], black: [] as number[] };
    systems.forEach((s, si) => {
      if (s.hub === h.slug) bySide[s.side].push(si);
    });
    for (const side of SIDES) {
      // roots by games at their signature, each followed by its variants
      const list = bySide[side];
      // findSystems already ordered roots by popularity of their defining choices
      const roots = list.filter((si) => !systems[si].parent);
      // …but never recommend a stub: when the top choice's main line transposes into a
      // sibling system (KID 5.Be2 → 5.Nf3), the first root with a real course leads
      const sigmaLines = (si: number) => rawCourses[courseOfSystem[si]].sigmaLines;
      let rec = roots.findIndex((si) => sigmaLines(si) >= T.RECOMMENDED_MIN_LINES);
      // none qualifies: the fullest course leads (earliest on ties)
      if (rec < 0) rec = roots.reduce((best, si, k) => (sigmaLines(si) > sigmaLines(roots[best]) ? k : best), 0);
      if (rec > 0) roots.unshift(...roots.splice(rec, 1));
      if (roots.length) rawSystems[roots[0]].recommended = true;
      const ordered: number[] = [];
      const addTree = (si: number) => {
        ordered.push(si);
        list.filter((x) => systems[x].parent === systems[si].slug).forEach(addTree);
      };
      roots.forEach(addTree);
      bySide[side] = ordered;
    }
    const defaultRec = bySide[h.side][0];
    const recCourse = defaultRec !== undefined ? rawCourses[courseOfSystem[defaultRec]] : null;
    const isTop =
      !!recCourse &&
      !h.small &&
      recCourse.sigmaLines >= T.TOP_LEVEL_MIN_LINES &&
      recCourse.maxDepth >= T.TOP_LEVEL_MIN_DEPTH &&
      (h.kind === "curated" || h.sigmaNorms.length >= T.MIN_SIGMA_PLIES);
    const ecos = h.rows.map((r) => model.rows[r].eco).filter((e): e is string => !!e).sort();
    const sigmaSans: string[] = [];
    for (let i = 0; i < h.sigmaNorms.length; i++) sigmaSans.push(model.nodes[h.sigmaPath[i]].theoryByNorm.get(h.sigmaNorms[i])!.san);
    return {
      slug: h.slug,
      title: h.title,
      kind: h.kind,
      parent: h.parent,
      side: h.side,
      sigma: sigmaSans,
      primaryName: h.primaryName,
      rowIdx: h.rows,
      defSide: h.def?.side ?? null,
      signature: h.def?.signature ?? null,
      sigmaNode,
      rows: h.rows.length,
      placement: isTop ? "top" : "offbeat",
      featured: !!h.def?.featured,
      tags: styleTags(model, h),
      level: levelOf(recCourse),
      against: h.side === "black" ? (h.sigmaNorms[0] === "e4" ? "e4" : h.sigmaNorms[0] === "d4" ? "d4" : "other") : null,
      description: h.def?.description ?? null,
      siblings: h.siblings,
      minorSiblings: minorSiblingsOf(h.slug),
      eco: ecos.length ? [ecos[0], ecos[ecos.length - 1]] : null,
      games: node.games,
      wdl: [node.w, node.d, node.b],
      systems: bySide,
      moveOrderNote: h.earlyRows.size > 0 || h.siblings.length > 0 || minorSiblingsOf(h.slug).length > 0,
    };
    void hi;
  });

  // ── position → best (course, line) for the side to move. Ranked by how
  // often masters play the course's move here (4.Ba4 96% beats 4.Bxc6 4%),
  // then recommended, root and σ-lines first, then the line's reach.
  const pos = new Array<number>(model.nodes.length * 2).fill(-1);
  const bestScore = new Float64Array(model.nodes.length).fill(-1);
  courses.forEach((c, ci) => {
    const rank = (rawSystems[ci].recommended ? 4 : 0) + (c.system.parent ? 0 : 2);
    c.lines.forEach((l) => {
      for (const n of l.nodes) {
        if ((model.nodes[n].white ? "white" : "black") !== c.side) continue;
        const nd = model.nodes[n];
        const book = c.bookMoves.get(n);
        const mv = book === undefined ? undefined : nd.moves.find((m) => m.norm === book);
        const share = mv && nd.games ? mv.games / nd.games : 0;
        const score = Math.round(share * 100) * 100 + rank * 10 + (l.early ? 0 : 1) * 5 + l.reach;
        if (score > bestScore[n]) {
          bestScore[n] = score;
          pos[2 * n] = ci;
          pos[2 * n + 1] = l.idx;
        }
      }
    });
  });

  // ── reports
  const coveredRows = model.rows.length - unassigned.length;
  // per-hub coverage counts only the hub's own courses and its linked siblings' (§4.4),
  // recursively, minor (Offbeat) siblings included: the hub pages link them all
  const nodesByHub = new Map<string, Set<number>>();
  for (const c of courses) {
    let set = nodesByHub.get(c.hub);
    if (!set) nodesByHub.set(c.hub, (set = new Set()));
    for (const l of c.lines) for (const n of l.nodes) set.add(n);
    for (const f of c.folded) for (const n of f.nodes) set.add(n);
  }
  const hubReport = hubs.map((h) => {
    const family = [h.slug];
    for (let i = 0; i < family.length; i++) {
      const x = hubs[hubIdx.get(family[i])!];
      family.push(...x.siblings, ...minorSiblingsOf(x.slug));
    }
    const sets = family.map((s) => nodesByHub.get(s)).filter((x): x is Set<number> => !!x);
    const cov = h.rows.filter((r) => sets.some((set) => set.has(finalNode(r)))).length;
    return { slug: h.slug, title: h.title, kind: h.kind, rows: h.rows.length, covered: cov, pct: cov / (h.rows.length || 1) };
  });
  const extPlies = courses.reduce((s, c) => s + c.lines.reduce((a, l) => a + l.ext.filter(Boolean).length, 0), 0);

  memo?.end();
  return {
    model,
    catalog: { hubs: rawHubs, systems: rawSystems, courses: rawCourses, pos },
    courses,
    hubs,
    systems,
    unassigned,
    coverage: {
      rows: model.rows.length,
      covered: coveredRows - asNotes,
      asNotes,
      variants,
      extPlies,
      lines: courses.reduce((s, c) => s + c.lines.length, 0),
    },
    hubReport,
  };
}

const round3 = (x: number) => Math.round(x * 1000) / 1000;

/**
 * Style tags (documented rules): curated tags win; otherwise
 * gambit = the hub name says Gambit; system = curated only;
 * sharp = decisive results ≥ 66 % at σ (≥ 30 games);
 * solid = draws ≥ 40 % at σ (≥ 30 games).
 */
function styleTags(model: Model, h: Hub): Style[] {
  if (h.def?.tags?.length) return h.def.tags;
  const tags: Style[] = [];
  if (/gambit/i.test(h.title)) tags.push("gambit");
  const n = model.nodes[h.sigmaPath[h.sigmaPath.length - 1]];
  if (n.games >= 30) {
    if ((n.w + n.b) / n.games >= 0.66) tags.push("sharp");
    else if (n.d / n.games >= 0.4) tags.push("solid");
  }
  return tags;
}

/** Level from tier size and depth: beginner ≤ 8 essential lines and avg depth ≤ 12; advanced ≥ 60 lines or avg ≥ 18. */
function levelOf(c: RawCourseSummary | null): Level {
  if (!c) return "beginner";
  if (c.lines >= 60 || c.avgDepth >= 18) return "advanced";
  if (c.essentials[0] <= 8 && c.avgDepth <= 12) return "beginner";
  return "intermediate";
}

const hubIndexes = new WeakMap<CatalogResult, { hubsOfRow: Map<number, string[]>; hubSide: Map<string, Side> }>();
function hubIndex(result: CatalogResult) {
  let idx = hubIndexes.get(result);
  if (!idx) {
    const hubsOfRow = new Map<number, string[]>();
    for (const h of result.hubs) {
      for (const r of h.rows) {
        let l = hubsOfRow.get(r);
        if (!l) hubsOfRow.set(r, (l = []));
        l.push(h.slug);
      }
    }
    idx = { hubsOfRow, hubSide: new Map(result.hubs.map((h) => [h.slug, h.side])) };
    hubIndexes.set(result, idx);
  }
  return idx;
}

const lineIndex = new WeakMap<CatalogResult, Map<number, [number, number][]>>();
/** node → [(course, line)] for every line passing through it (memoised per result). */
export function linesThrough(result: CatalogResult): Map<number, [number, number][]> {
  let idx = lineIndex.get(result);
  if (!idx) {
    idx = new Map();
    result.courses.forEach((c, ci) =>
      c.lines.forEach((l, li) => {
        for (const n of new Set(l.nodes)) {
          let list = idx!.get(n);
          if (!list) idx!.set(n, (list = []));
          list.push([ci, li]);
        }
      })
    );
    lineIndex.set(result, idx);
  }
  return idx;
}

/** Best course for a v1 row (legacy map): a course containing its final position, preferring the row's own hub and default side. */
export function resolveLegacy(
  model: Model,
  result: CatalogResult,
  finalEpd: string
): { courseId: string | null; lineId: string | null } {
  const node = model.byEpd.get(finalEpd);
  if (node === undefined) return { courseId: null, lineId: null };
  const name = model.nodes[node].nameRow;
  const { hubsOfRow, hubSide } = hubIndex(result);
  const ownHubs = new Set(name === -1 ? [] : hubsOfRow.get(name) ?? []);
  // the position index already picks the course whose move masters play here
  const pci = result.catalog.pos[2 * node];
  if (pci >= 0) {
    const c = result.courses[pci];
    if ((ownHubs.size === 0 || ownHubs.has(c.hub)) && c.side === hubSide.get(c.hub)) {
      return { courseId: c.id, lineId: c.lines[result.catalog.pos[2 * node + 1]].id };
    }
  }
  let best: { score: number; courseId: string; lineId: string } | null = null;
  for (const [ci, li] of linesThrough(result).get(node) ?? []) {
    const c = result.courses[ci];
    const l = c.lines[li];
    const score = l.reach + (ownHubs.has(c.hub) ? 10 : 0) + (c.side === hubSide.get(c.hub) ? 5 : 0) + (c.system.parent ? 0 : 1);
    if (!best || score > best.score) best = { score, courseId: c.id, lineId: l.id };
  }
  return best ? { courseId: best.courseId, lineId: best.lineId } : { courseId: null, lineId: null };
}

export { courseIdOf, bookMove, segmentsToName };
export type { HubDef };
