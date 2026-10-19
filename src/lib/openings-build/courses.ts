/**
 * Systems, course trees, lines, chapters and tiers (§4.5–4.7, ADR 0002).
 * Pure and deterministic: the build derives every default course with it,
 * and the client re-derives a course (e.g. with user overrides) from the
 * same dataset bytes and gets identical lines and ids.
 */
import { lineIdFor } from "./hash";
import { commonSegments, segmentsToName, slugify, type Hub } from "./hubs";
import { deepestName, nameSegments, type MMove, type Model } from "./model";
import { T } from "./tunables";
import type { Side } from "./types";

export interface SystemDef {
  hub: string;
  side: Side;
  slug: string;
  name: string;
  /** defining learner choices: [node, normalised SAN] */
  choices: [number, string][];
  /** the choices as move labels ("2…d6", "5…a6"), computed where the ply is known */
  defining: string[];
  signatureNode: number;
  /** variant systems: the system they extend */
  parent: string | null;
}

export interface CourseLine {
  idx: number;
  id: string;
  nodes: number[];
  sans: string[];
  ext: boolean[];
  reach: number;
  transposesTo: number | null;
  rowIds: string[];
  name: string;
  chapter: number;
  section: number | null;
  /** first ply index where the line leaves the approach (σ path) */
  leavesApproachAt: number;
  /** early deviation (diverges before σ): own local reach, Complete tier only */
  early: boolean;
  learnerMovesAfterSigma: number;
  /** ply indices where the course branches (≥ 2 continuations) */
  branchPlies: number[];
}

export interface Chapter {
  name: string;
  /** reply that defines the chapter (SAN with move number), "" for groups */
  key: string;
  lines: number[];
  sections: { name: string; key: string; lines: number[]; segs?: string[] }[];
  /** name segments already said by the chapter title (line names omit them) */
  segs?: string[];
}

export interface Tier {
  lines: number;
  coverage: number;
}

export interface Course {
  id: string;
  hub: string;
  system: SystemDef;
  side: Side;
  lines: CourseLine[];
  folded: { sans: string[]; nodes: number[]; name: string; into: number }[];
  chapters: Chapter[];
  tiers: { essentials: Tier; core: Tier; complete: Tier };
  /** learner book move per learner-to-move node in the tree (theory + ext) */
  bookMoves: Map<number, string>;
  /** other theory moves at learner nodes (soft-fail candidates) */
  alternatives: Map<number, string[]>;
  /** nodes where a system choice is made (overrides blocked) */
  systemNodes: Set<number>;
  sigmaPly: number;
  totalMass: number;
}

export const courseIdOf = (hub: string, system: string, side: Side) => `${hub}/${system}@${side}`;

const moverOf = (model: Model, node: number): Side => (model.nodes[node].white ? "white" : "black");

export function moveLabel(plyIndex: number, san: string): string {
  const n = Math.floor(plyIndex / 2) + 1;
  return plyIndex % 2 === 0 ? `${n}.${san}` : `${n}…${san}`;
}

/** Book-move rule: most master games → most descendant hub rows → first in data order. */
export function bookMove(hub: Hub, moves: MMove[]): MMove | null {
  let best: MMove | null = null;
  for (const m of moves) {
    if (!best) {
      best = m;
      continue;
    }
    const d = m.games - best.games || (hub.rowsThrough.get(m.to) ?? 0) - (hub.rowsThrough.get(best.to) ?? 0) || (best.rows[0] ?? 1e9) - (m.rows[0] ?? 1e9);
    if (d > 0) best = m;
  }
  return best;
}

const approachChoices = (model: Model, hub: Hub, side: Side): [number, string][] =>
  hub.sigmaNorms
    .map((norm, i) => [hub.sigmaPath[i], norm] as [number, string])
    .filter(([node]) => moverOf(model, node) === side);

// ───────────────────────────── systems ─────────────────────────────────────

export function findSystems(model: Model, hub: Hub, side: Side): SystemDef[] {
  const sigma = hub.sigmaPath[hub.sigmaPath.length - 1];
  const total = hub.rows.length;
  const found: { choices: [number, string][]; plies: number[]; sig: number; sigPath: number[] }[] = [];
  const qualifies = (m: MMove) => {
    const n = hub.rowsThrough.get(m.to) ?? 0;
    return n >= T.SYSTEM_MIN_ROWS || n / total >= T.SYSTEM_MIN_SHARE;
  };
  const hubFamilies = new Set(hub.rows.map((r) => model.rows[r].segments[0]));
  const walk = (node: number, depth: number, choices: [number, string][], plies: number[], sig: number, path: number[], sigPath: number[]) => {
    const moves = hub.dag.get(node) ?? [];
    // stop where the opening's name has left the hub's names (§4.5)
    const here = deepestName(model, path);
    const leftHub = here !== null && !hubFamilies.has(here.segments[0]) && path.length - 1 > hub.sigmaPath.length - 1;
    if (!moves.length || depth >= T.SYSTEM_MAX_LEARNER_DEPTH || leftHub || path.slice(0, -1).includes(node)) {
      found.push({ choices, plies, sig, sigPath });
      return;
    }
    const ply = path.length - 1;
    if (moverOf(model, node) === side) {
      const q = moves.filter(qualifies);
      if (q.length >= 2) {
        for (const m of q) walk(m.to, depth + 1, [...choices, [node, m.norm]], [...plies, ply], m.to, [...path, m.to], [...path, m.to]);
      } else {
        const m = q[0] ?? bookMove(hub, moves)!;
        walk(m.to, depth + 1, choices, plies, sig, [...path, m.to], sigPath);
      }
    } else {
      // main path: the most-played opponent move (moves are sorted by games)
      walk(moves[0].to, depth, choices, plies, sig, [...path, moves[0].to], sigPath);
    }
  };
  walk(sigma, 0, [], [], sigma, [...hub.sigmaPath], [...hub.sigmaPath]);

  // dedupe by signature position (transposed choice orders)
  const bySig = new Map<number, (typeof found)[number]>();
  for (const f of found) if (!bySig.has(f.sig)) bySig.set(f.sig, f);
  const systems = [...bySig.values()];

  // most popular first: compare the games of each defining choice in order
  const choiceGames = (s: (typeof systems)[number]) =>
    s.choices.map(([node, norm]) => model.nodes[node].theoryByNorm.get(norm)?.games ?? 0);
  systems.sort((a, b) => {
    const ga = choiceGames(a), gb = choiceGames(b);
    for (let i = 0; i < Math.max(ga.length, gb.length); i++) {
      const d = (gb[i] ?? -1) - (ga[i] ?? -1);
      if (d) return d;
    }
    return 0;
  });
  const out: SystemDef[] = [];
  const used = new Set<string>();
  const hubSegs = commonSegments(model, hub.rows, 0.5);
  for (const s of systems) {
    const rows = hub.rows.filter((r) => model.rows[r].path.includes(s.sig));
    // name: the position the defining moves reach, else what ≥ 80 % of its rows share
    const sigName = deepestName(model, s.sigPath);
    let segs: string[] = [];
    if (s.choices.length) {
      segs = sigName && sigName.segments.length > hubSegs.length ? sigName.segments : commonSegments(model, rows.length ? rows : hub.rows, T.SYSTEM_NAME_SHARE);
    }
    const defining = s.choices.map(([node, norm], k) => moveLabel(s.plies[k], model.nodes[node].theoryByNorm.get(norm)!.san));
    let name = s.choices.length ? segmentsToName(segs) || hub.title : hub.title;
    let slugBase = s.choices.length
      ? slugify(segs.length > hubSegs.length ? segs.slice(hubSegs.length).join(" ") : defining.join(" "))
      : "main";
    if (!slugBase) slugBase = slugify(defining.join(" ")) || "main";
    let slug = slugBase;
    if (used.has(slug)) {
      slug = `${slugBase}-${slugify(defining[defining.length - 1] ?? "x")}`;
      name = `${name} (${defining[defining.length - 1]})`;
    }
    for (let i = 2; used.has(slug); i++) slug = `${slugBase}-${i}`;
    used.add(slug);
    out.push({ hub: hub.slug, side, slug, name, choices: s.choices, defining, signatureNode: s.sig, parent: null });
  }
  return out;
}

// ───────────────────────────── course tree ─────────────────────────────────

/** A partial line as a linked list (no array copies per push: GC was the hot spot). */
interface Partial {
  /** 0 = on the approach or through σ, 1 = early deviation (sorted after all σ lines) */
  cls: 0 | 1;
  onApproach: boolean;
  node: number;
  san: string;
  ext: boolean;
  parent: Partial | null;
  ply: number;
  reach: number;
  extPlies: number;
  /** push order: deterministic tie-break for equal reach */
  seq: number;
}

interface Full {
  nodes: number[];
  sans: string[];
  ext: boolean[];
  reach: number;
  cls: 0 | 1;
}

function materialize(p: Partial): Full {
  const nodes: number[] = [];
  const sans: string[] = [];
  const ext: boolean[] = [];
  for (let q: Partial | null = p; q; q = q.parent) {
    nodes.push(q.node);
    if (q.parent) {
      sans.push(q.san);
      ext.push(q.ext);
    }
  }
  return { nodes: nodes.reverse(), sans: sans.reverse(), ext: ext.reverse(), reach: p.reach, cls: p.cls };
}

/** Heap of partial lines by reach (desc), ties by move sequence for determinism. */
class MaxHeap {
  private a: Partial[] = [];
  get size() {
    return this.a.length;
  }
  private less(i: number, j: number) {
    const x = this.a[i], y = this.a[j];
    return x.cls > y.cls || (x.cls === y.cls && (x.reach < y.reach || (x.reach === y.reach && x.seq > y.seq)));
  }
  push(p: Partial) {
    const a = this.a;
    a.push(p);
    let i = a.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.less(parent, i)) break;
      [a[i], a[parent]] = [a[parent], a[i]];
      i = parent;
    }
  }
  pop(): Partial | undefined {
    const a = this.a;
    if (!a.length) return undefined;
    const top = a[0];
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && this.less(m, l)) m = l;
        if (r < a.length && this.less(m, r)) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m], a[i]];
        i = m;
      }
    }
    return top;
  }
}

/** Opponent extension replies at a node (§4.7): share ≥ 25 %, ≥ 8 games, top 2. */
export function extOpponentMoves(model: Model, node: number): MMove[] {
  const n = model.nodes[node];
  if (n.games < T.EXT_STOP_GAMES) return [];
  return n.moves
    .filter((m) => m.ext && m.to >= 0 && m.games >= T.EXT_MIN_GAMES && m.games / n.games >= T.EXT_MIN_SHARE)
    .sort((a, b) => b.games - a.games || (a.norm < b.norm ? -1 : 1))
    .slice(0, T.EXT_MAX_BRANCHES);
}

/** Learner extension move at a node (§4.7): the most played. */
export function extLearnerMove(model: Model, node: number): MMove | null {
  const n = model.nodes[node];
  if (n.games < T.EXT_STOP_GAMES) return null;
  let best: MMove | null = null;
  for (const m of n.moves) {
    if (!m.ext || m.to < 0) continue;
    if (!best || m.games > best.games || (m.games === best.games && m.norm < best.norm)) best = m;
  }
  return best;
}

export interface DeriveOptions {
  /** user overrides for this course: node → normalised SAN */
  overrides?: Map<number, string>;
  /** disable §4.7 extension (setting) */
  extension?: boolean;
}

export function deriveCourse(model: Model, hub: Hub, system: SystemDef, opts: DeriveOptions = {}): Course {
  const side = system.side;
  const id = courseIdOf(hub.slug, system.slug, side);
  const sigmaPly = hub.sigmaNorms.length;
  const choices = new Map<number, string>([...approachChoices(model, hub, side), ...system.choices]);
  const systemNodes = new Set(system.choices.map(([n]) => n));
  const approachNodes = new Set(approachChoices(model, hub, side).map(([n]) => n));
  const overrides = opts.overrides ?? new Map<number, string>();
  const extension = opts.extension !== false;

  const bookMoves = new Map<number, string>();
  const alternatives = new Map<number, string[]>();

  const learnerTheory = (node: number): MMove | null => {
    const moves = hub.dag.get(node);
    if (!moves?.length) return null;
    const pick = (norm: string | undefined) => (norm ? moves.find((m) => m.norm === norm) : undefined);
    const overridable = !systemNodes.has(node) && !approachNodes.has(node);
    const chosen =
      (overridable ? pick(overrides.get(node)?.replace(/[+#]$/, "")) : undefined) ?? pick(choices.get(node)) ?? bookMove(hub, moves)!;
    const alts = moves.filter((m) => m !== chosen).map((m) => m.norm);
    if (alts.length) alternatives.set(node, alts);
    return chosen;
  };

  const heap = new MaxHeap();
  let seq = 0;
  heap.push({ cls: 0, onApproach: sigmaPly > 0, node: 0, san: "", ext: false, parent: null, ply: 0, reach: 1, extPlies: 0, seq: seq++ });
  const owner = new Map<number, string>(); // node → incoming edge key of its first arrival
  const doneP: Partial[] = [];
  const endsAtTransposition: boolean[] = [];

  while (heap.size) {
    const p = heap.pop()!;
    const node = p.node;
    const incoming = p.parent ? `${p.parent.node}>${p.san}` : "root";
    const prevOwner = owner.get(node);
    if (prevOwner !== undefined && prevOwner !== incoming) {
      doneP.push(p);
      endsAtTransposition.push(true);
      continue;
    }
    owner.set(node, incoming);

    const ply = p.ply;
    const learnerToMove = moverOf(model, node) === side;
    const children: { mv: MMove; ext: boolean; factor: number }[] = [];
    const inTheory = (hub.dag.get(node)?.length ?? 0) > 0;
    const onPath = (n: number) => {
      for (let q: Partial | null = p; q; q = q.parent) if (q.node === n) return true;
      return false;
    };

    if (inTheory) {
      if (learnerToMove) {
        const mv = learnerTheory(node)!;
        bookMoves.set(node, mv.norm);
        children.push({ mv, ext: false, factor: 1 });
      } else {
        const moves = hub.dag.get(node)!;
        const total = moves.reduce((s, m) => s + m.games + 1, 0);
        for (const mv of moves) children.push({ mv, ext: false, factor: moves.length > 1 ? (mv.games + 1) / total : 1 });
      }
    } else if (extension && p.extPlies < T.EXT_MAX_PLIES && ply < model.maxPly) {
      if (learnerToMove) {
        const mv = extLearnerMove(model, node);
        if (mv) {
          bookMoves.set(node, mv.norm);
          children.push({ mv, ext: true, factor: 1 });
        }
      } else {
        const moves = extOpponentMoves(model, node);
        const total = moves.reduce((s, m) => s + m.games + 1, 0);
        for (const mv of moves) children.push({ mv, ext: true, factor: moves.length > 1 ? (mv.games + 1) / total : 1 });
      }
    }

    const viable = children.filter((c) => !onPath(c.mv.to) && ply < T.MAX_LINE_PLIES);
    if (!viable.length) {
      doneP.push(p);
      endsAtTransposition.push(false);
      continue;
    }
    // Reach counts from σ (§4.6): approach nodes are neutral; an early deviation
    // starts its own local reach at the divergence and sorts after σ lines.
    const approachNode = p.onApproach && ply < sigmaPly;
    for (const c of viable) {
      const stays = approachNode && c.mv.to === hub.sigmaPath[ply + 1];
      heap.push({
        cls: approachNode ? (stays ? 0 : 1) : p.cls,
        onApproach: stays && ply + 1 < sigmaPly,
        node: c.mv.to,
        san: c.mv.san,
        ext: c.ext,
        parent: p,
        ply: ply + 1,
        reach: approachNode ? (stays ? 1 : c.factor) : p.reach * c.factor,
        extPlies: p.extPlies + (c.ext ? 1 : 0),
        seq: seq++,
      });
    }
  }
  const done = doneP.map(materialize);

  // lines in completion order (= descending reach)
  const sigmaNorms = hub.sigmaNorms;
  const raw = done.map((p, i) => {
    let leaves = 0;
    while (leaves < sigmaNorms.length && leaves < p.sans.length && p.sans[leaves].replace(/[+#]$/, "") === sigmaNorms[leaves]) leaves++;
    let learnerAfter = 0;
    for (let k = Math.max(leaves, 0); k < p.sans.length; k++) {
      if (k >= sigmaPly || leaves < sigmaPly) if (moverOf(model, p.nodes[k]) === side) learnerAfter++;
    }
    return { p, transposed: endsAtTransposition[i], leaves, learnerAfter, early: p.cls === 1 };
  });

  // fold lines with too few learner moves past the approach into their parent
  // a mini-course where no line qualifies keeps all its lines rather than folding everything
  const qualifying = raw.filter((r) => r.learnerAfter >= T.MIN_LEARNER_MOVES_AFTER_SIGMA || r.transposed);
  const kept = qualifying.length ? qualifying : raw;
  const folded: Course["folded"] = [];
  const keptSet = new Set(kept);
  const linesP = kept.length ? kept : raw.slice(0, 1); // never return an empty course
  for (const r of raw) {
    if (keptSet.has(r) || !kept.length) continue;
    let best = 0, bestLen = -1;
    linesP.forEach((k, i) => {
      let c = 0;
      while (c < k.p.sans.length && c < r.p.sans.length && k.p.sans[c] === r.p.sans[c]) c++;
      if (c > bestLen) {
        bestLen = c;
        best = i;
      }
    });
    folded.push({ sans: r.p.sans, nodes: r.p.nodes, name: lineDeepestName(model, r.p.nodes), into: best });
  }

  const totalMass = raw.filter((r) => !r.early).reduce((s, r) => s + r.p.reach, 0);
  const firstLineWith = new Map<number, number>();
  linesP.forEach((r, i) => {
    for (const n of r.p.nodes) if (!firstLineWith.has(n)) firstLineWith.set(n, i);
  });

  // branch plies: nodes where the kept lines continue with ≥ 2 different moves
  const nextMoves = new Map<number, Set<string>>();
  for (const r of linesP) {
    r.p.nodes.forEach((n, k) => {
      if (k >= r.p.sans.length) return;
      let s = nextMoves.get(n);
      if (!s) nextMoves.set(n, (s = new Set()));
      s.add(r.p.sans[k]);
    });
  }

  const rowsByFinal = new Map<number, string[]>();
  for (const r of hub.rows) {
    const row = model.rows[r];
    const fin = row.path[row.path.length - 1];
    let l = rowsByFinal.get(fin);
    if (!l) rowsByFinal.set(fin, (l = []));
    l.push(row.rowId);
  }

  const lines: CourseLine[] = linesP.map((r, i) => {
    const namedSans = r.p.sans.filter((_, k) => !r.p.ext[k]).map((s) => s.replace(/[+#]$/, ""));
    const end = r.p.nodes[r.p.nodes.length - 1];
    const branchPlies: number[] = [];
    r.p.nodes.forEach((n, k) => {
      if (k < r.p.sans.length && (nextMoves.get(n)?.size ?? 0) >= 2) branchPlies.push(k);
    });
    let tTo: number | null = null;
    if (r.transposed) {
      const f = firstLineWith.get(end);
      tTo = f !== undefined && f !== i ? f : null;
    }
    return {
      idx: i,
      id: lineIdFor(id, namedSans),
      nodes: r.p.nodes,
      sans: r.p.sans,
      ext: r.p.ext,
      reach: r.p.reach,
      transposesTo: tTo,
      rowIds: r.p.nodes.flatMap((n) => rowsByFinal.get(n) ?? []),
      name: "",
      chapter: 0,
      section: null,
      leavesApproachAt: r.leaves,
      early: r.early,
      learnerMovesAfterSigma: r.learnerAfter,
      branchPlies,
    };
  });

  // lineId collisions (same named path, different ext tails): add the ext suffix
  const byId = new Map<string, CourseLine[]>();
  for (const l of lines) {
    let g = byId.get(l.id);
    if (!g) byId.set(l.id, (g = []));
    g.push(l);
  }
  for (const group of byId.values()) {
    if (group.length < 2) continue;
    for (const l of group) {
      const named = l.sans.filter((_, k) => !l.ext[k]).map((s) => s.replace(/[+#]$/, ""));
      const extS = l.sans.filter((_, k) => l.ext[k]).map((s) => s.replace(/[+#]$/, ""));
      l.id = lineIdFor(id, [...named, "|", ...extS]);
    }
  }

  const course: Course = {
    id,
    hub: hub.slug,
    system,
    side,
    lines,
    folded,
    chapters: [],
    tiers: tiersOf(lines, totalMass),
    bookMoves,
    alternatives,
    systemNodes,
    sigmaPly,
    totalMass,
  };
  course.chapters = chapterize(model, hub, course);
  nameLines(model, course, hub.title);
  return course;
}

function lineDeepestName(model: Model, nodes: number[]): string {
  return deepestName(model, nodes)?.name ?? "";
}

/**
 * Tiers are chosen on the *trainable* mass (kept σ lines) so rare unanswered
 * opponent tries can't push every tier to its cap; coverage is reported
 * against all master games from σ, folded lines included (honest number).
 */
export function tiersOf(allLines: CourseLine[], totalMass: number): Course["tiers"] {
  const mass = totalMass || 1;
  const sigmaLines = allLines.filter((l) => !l.early);
  // a course made only of early deviations (σ sits deeper than any reply) tiers over all of them
  const lines = sigmaLines.length ? sigmaLines : allLines;
  const trainable = lines.reduce((s, l) => s + l.reach, 0) || 1;
  const pick = (target: number, min: number, max: number) => {
    let acc = 0;
    let n = 0;
    for (const l of lines) {
      if (acc / trainable >= target && n >= Math.min(min, lines.length)) break;
      if (n >= max) break;
      acc += l.reach;
      n++;
    }
    return { lines: n, coverage: acc / mass };
  };
  const essentials = pick(T.ESSENTIALS_MASS, T.ESSENTIALS_MIN, T.ESSENTIALS_MAX);
  const core = pick(T.CORE_MASS, essentials.lines, T.CORE_MAX);
  const all = lines.reduce((s, l) => s + l.reach, 0);
  return { essentials, core: core.lines < essentials.lines ? essentials : core, complete: { lines: allLines.length, coverage: all / mass } };
}

// ───────────────────────────── chapters & names ────────────────────────────

const lineSegs = (model: Model, l: CourseLine) => deepestName(model, l.nodes)?.segments ?? [];

function sharedSegs(model: Model, lines: CourseLine[], share: number): string[] {
  const rows = lines.map((l) => deepestName(model, l.nodes)?.idx).filter((x): x is number => x !== undefined);
  return commonSegments(model, rows, share);
}

function stripSegs(segs: string[], context: string[], hubTitle?: string): string[] {
  let k = 0;
  while (k < segs.length && k < context.length && segs[k] === context[k]) k++;
  let rest = segs.slice(k);
  // "Queen's Pawn Game, London System, …" inside the London hub → drop up to the hub's own name
  if (hubTitle) {
    const at = rest.indexOf(hubTitle);
    if (at !== -1) rest = rest.slice(at + 1);
  }
  return rest;
}

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

/** Group lines by their move at the first branch node at/after `fromPly` along the common trunk. */
function splitAtBranch(lines: CourseLine[], fromPly: number) {
  if (!lines.length) return null;
  let ply = fromPly;
  const ref = lines[0];
  for (;;) {
    const at = lines.filter((l) => l.sans.length > ply);
    if (!at.length) return null;
    const moves = new Set(at.map((l) => l.sans[ply]));
    if (moves.size >= 2) {
      const groups = new Map<string, CourseLine[]>();
      for (const l of lines) {
        const k = l.sans.length > ply ? l.sans[ply] : at[0].sans[ply];
        let g = groups.get(k);
        if (!g) groups.set(k, (g = []));
        g.push(l);
      }
      return { ply, groups };
    }
    if (!(ref.sans.length > ply)) return null;
    ply++;
  }
}

function chapterize(model: Model, hub: Hub, course: Course): Chapter[] {
  const { lines, sigmaPly, totalMass } = course;
  // the system's own name is context: inside "Najdorf Variation" a chapter is "Main line (2.Nf3)"
  const sysSegs = course.system.choices.length ? nameSegments(course.system.name.replace(/ \([^)]*\)$/, "")) : sharedSegs(model, lines, 0.8);
  const chapters: Chapter[] = [];
  const early = lines.filter((l) => l.leavesApproachAt < sigmaPly);
  const main = lines.filter((l) => l.leavesApproachAt >= sigmaPly);

  const hubSegs = nameSegments(hub.title);
  const build = (group: CourseLine[], fromPly: number, contextSegs: string[], baseSegs: string[], allowOther: boolean) => {
    const split = splitAtBranch(group, fromPly);
    if (!split) return [{ name: segmentsToName(contextSegs) || hub.title, key: "", lines: group, segs: contextSegs }];
    const out: { name: string; key: string; lines: CourseLine[]; segs: string[] }[] = [];
    const other: CourseLine[] = [];
    const otherKeys: string[] = [];
    const entries = [...split.groups.entries()].sort((a, b) => sum(b[1]) - sum(a[1]));
    for (const [san, ls] of entries) {
      const key = moveLabel(split.ply, san);
      if (!allowOther || ls.length >= T.CHAPTER_MIN_LINES || sum(ls) / (totalMass || 1) >= T.CHAPTER_MIN_REACH) {
        // name: the position the key move reaches, else what most of its lines share
        const at = ls.find((l) => l.nodes.length > split.ply + 1) ?? ls[0];
        const nodeSegs = deepestName(model, at.nodes.slice(0, split.ply + 2))?.segments ?? [];
        // the position the key move reaches names the group whenever it says more than its parent
        let segs: string[];
        let rest: string[];
        if (stripSegs(nodeSegs, baseSegs, hub.title).length) {
          segs = nodeSegs;
          rest = stripSegs(nodeSegs, baseSegs, hub.title);
        } else {
          segs = sharedSegs(model, ls, 0.6);
          rest = stripSegs(segs, contextSegs, hub.title);
          if (!rest.length) segs = contextSegs;
        }
        const isMain = ls.some((l) => l.idx === 0);
        const name = rest.length ? `${rest.join(", ")} (${key})` : isMain ? `Main line (${key})` : `${key} line`;
        out.push({ name, key, lines: ls, segs: segs.length > contextSegs.length ? segs : contextSegs });
      } else {
        other.push(...ls);
        otherKeys.push(key);
      }
    }
    if (other.length) {
      const moveNo = Math.floor(split.ply / 2) + 1;
      out.push({ name: `Other ${ordinal(moveNo)} moves (${otherKeys.slice(0, 4).join(", ")}${otherKeys.length > 4 ? ", …" : ""})`, key: "", lines: other, segs: contextSegs });
    }
    return out;
  };

  const groups = main.length ? build(main, sigmaPly, sysSegs, hubSegs, true) : [];
  if (early.length) {
    const keys = [...new Set(early.map((l) => moveLabel(l.leavesApproachAt, l.sans[l.leavesApproachAt])))];
    groups.push({ name: `Early deviations (${keys.slice(0, 4).join(", ")}${keys.length > 4 ? ", …" : ""})`, key: "", lines: early, segs: sysSegs });
  }
  for (const g of groups) {
    const ch: Chapter = { name: g.name, key: g.key, lines: g.lines.map((l) => l.idx).sort((a, b) => a - b), sections: [], segs: g.segs };
    if (g.lines.length >= T.SECTION_MIN_LINES) {
      const from = g.key ? plyOfKey(g, sigmaPly) + 1 : sigmaPly;
      const secs = build(g.lines, from, g.segs, g.segs, true);
      if (secs.length >= 2) {
        ch.sections = secs.map((s) => ({ name: s.name, key: s.key, lines: s.lines.map((l) => l.idx).sort((a, b) => a - b), segs: s.segs }));
      }
    }
    chapters.push(ch);
  }
  // chapters ordered by mass of their first line (= most likely first)
  chapters.sort((a, b) => a.lines[0] - b.lines[0]);
  chapters.forEach((ch, ci) => {
    for (const li of ch.lines) lines[li].chapter = ci;
    ch.sections.forEach((s, si) => {
      for (const li of s.lines) lines[li].section = si;
    });
  });
  return chapters;
}

function plyOfKey(g: { lines: CourseLine[]; key: string }, sigmaPly: number): number {
  // the chapter key is the move at the split ply: find it on the first line
  const l = g.lines[0];
  for (let k = sigmaPly; k < l.sans.length; k++) if (moveLabel(k, l.sans[k]) === g.key) return k;
  return sigmaPly;
}

const sum = (ls: CourseLine[]) => ls.reduce((s, l) => s + l.reach, 0);

function nameLines(model: Model, course: Course, hubTitle: string): void {
  const { lines, chapters } = course;
  const used = new Map<string, number>();
  const chapterShared = chapters.map((ch) => sharedSegs(model, ch.lines.map((i) => lines[i]), 0.8));
  const systemSegs = course.system.choices.length ? nameSegments(course.system.name.replace(/ \([^)]*\)$/, "")) : [];
  let allShared: string[] | null = null;
  for (const l of lines) {
    const ch = chapters[l.chapter];
    const candidates = [
      l.section !== null ? ch.sections[l.section]?.segs ?? [] : [],
      ch.segs ?? [],
      chapterShared[l.chapter],
      systemSegs,
    ];
    // the most specific context that is a prefix of this line's name
    const own = lineSegs(model, l);
    const isPrefix = (c: string[]) => c.every((x, i) => own[i] === x);
    const context = candidates.filter((c) => c.length && isPrefix(c)).sort((a, b) => b.length - a.length)[0] ?? candidates.sort((a, b) => b.length - a.length)[0];
    const segs = lineSegs(model, l);
    const rest = stripSegs(segs, context.length ? context : (allShared ??= sharedSegs(model, lines, 0.8)), hubTitle);
    const keys = l.branchPlies.filter((k) => k >= course.sigmaPly).map((k) => moveLabel(k, l.sans[k]));
    const key = keys[keys.length - 1] ?? (l.sans.length ? moveLabel(l.sans.length - 1, l.sans[l.sans.length - 1]) : "");
    let name = rest.length ? `${rest.join(", ")} (${key})` : `${key} line`;
    if (used.has(name)) {
      const extra = keys.slice(-2, -1)[0];
      if (extra) name = rest.length ? `${rest.join(", ")} (${extra}, ${key})` : `${extra}, ${key} line`;
    }
    for (let k = l.sans.length - 1; used.has(name) && k >= 0; k--) {
      name = `${name.replace(/ line$/, "")} · ${moveLabel(k, l.sans[k])}`;
    }
    used.set(name, l.idx);
    l.name = name;
  }
}
