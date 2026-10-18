/**
 * Hubs and signature positions (§4.4, ADR 0002): which rows form "an
 * opening", where it really starts (σ), which rows attach by transposition,
 * which become sibling hubs or early-deviation chapters, and the hub DAG
 * that courses are cut from.
 */
import { familyOfName, type MMove, type Model } from "./model";
import { T } from "./tunables";
import type { Side } from "./types";

export type Style = "gambit" | "solid" | "sharp" | "system";

export type NameQuery =
  | { name: string }
  | { nameStartsWith: string }
  | { family: string; variationStartsWith?: string };

export interface HubDef {
  slug: string;
  title: string;
  /** name whose shortest row is the canonical row C (default: title) */
  primaryName?: string;
  side?: Side;
  match: NameQuery[];
  exclude?: NameQuery[];
  /** explicit σ for system openings, e.g. "1. d4 d5 2. Bf4" */
  signature?: string;
  description?: string;
  tags?: Style[];
  featured?: boolean;
}

export type HubKind = "curated" | "auto" | "sibling";

export interface Hub {
  slug: string;
  title: string;
  kind: HubKind;
  parent: string | null;
  def: HubDef | null;
  rows: number[];
  primaryName: string;
  canonicalRow: number;
  side: Side;
  /** node path start → σ */
  sigmaPath: number[];
  sigmaNorms: string[];
  sigmaFromSignature: boolean;
  /** row → index on the row's path where it joins the hub (σ or transposition) */
  attach: Map<number, number>;
  /** rows that end on the approach (prefixes of σ) */
  approachRows: number[];
  /** row → ply index where the opponent deviates before σ */
  earlyRows: Map<number, number>;
  siblings: string[];
  /** node → hub-DAG moves (theory edges) */
  dag: Map<number, MMove[]>;
  /** node → number of hub rows whose hub path passes through it */
  rowsThrough: Map<number, number>;
  connectingEdges: number;
  warnings: string[];
  /** a sibling group smaller than SIBLING_MIN_ROWS: always Offbeat */
  small: boolean;
}

const SEGMENT_END = /^($|[:, ])/;

export function slugify(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function matchesQuery(name: string, q: NameQuery): boolean {
  if ("name" in q) return name === q.name;
  if ("nameStartsWith" in q) {
    return name.startsWith(q.nameStartsWith) && SEGMENT_END.test(name.slice(q.nameStartsWith.length));
  }
  if (familyOfName(name) !== q.family) return false;
  if (!q.variationStartsWith) return true;
  const colon = name.indexOf(":");
  if (colon === -1) return false;
  const v = name.slice(colon + 1).trim();
  return v.startsWith(q.variationStartsWith) && SEGMENT_END.test(v.slice(q.variationStartsWith.length));
}

const mover = (plyIndex: number): Side => (plyIndex % 2 === 0 ? "white" : "black");
const other = (s: Side): Side => (s === "white" ? "black" : "white");

/** Deepest name (as segments) shared by ≥ `share` of the rows. */
export function commonSegments(model: Model, rows: number[], share: number): string[] {
  if (!rows.length) return [];
  let prefix: string[] = [];
  let pool = rows;
  for (let k = 1; ; k++) {
    const counts = new Map<string, number>();
    for (const r of pool) {
      const segs = model.rows[r].segments;
      if (segs.length < k) continue;
      const key = segs.slice(0, k).join("\u0000");
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    let best: [string, number] | null = null;
    for (const e of counts) if (!best || e[1] > best[1] || (e[1] === best[1] && e[0] < best[0])) best = e;
    if (!best || best[1] / rows.length < share) break;
    prefix = best[0].split("\u0000");
    pool = pool.filter((r) => model.rows[r].segments.slice(0, k).join("\u0000") === best![0]);
  }
  return prefix;
}

export function segmentsToName(segs: string[]): string {
  if (!segs.length) return "";
  if (segs.length === 1) return segs[0];
  return `${segs[0]}: ${segs.slice(1).join(", ")}`;
}

const wordRe = (w: string) => new RegExp(`(^|[^A-Za-z])${w}($|[^A-Za-z])`, "i");

/**
 * Defining side by name (ADR 0002): curated side, else Accepted/Declined →
 * opponent of the gambit's side; Defense/Defence/Countergambit → Black;
 * Gambit/Attack/Opening/Game/System → mover of C's last (untrimmed) move;
 * else C's last mover.
 */
export function definingSide(
  name: string,
  canonicalPlies: number,
  baseRowPlies: (baseName: string) => number | null,
  curated?: Side
): Side {
  if (curated) return curated;
  const lastMover = canonicalPlies > 0 ? mover(canonicalPlies - 1) : "white";
  const ad = /\s+(Accepted|Declined)\b/i.exec(name);
  if (ad) {
    const base = name.slice(0, ad.index).trim();
    const plies = baseRowPlies(base);
    const gambitSide =
      plies !== null ? definingSide(base, plies, baseRowPlies) : other(lastMover); // fallback: accepting side moved last
    return other(gambitSide);
  }
  if (wordRe("Defen[cs]e").test(name) || wordRe("Countergambit").test(name)) return "black";
  return lastMover;
}

function parseSignature(sig: string): string[] {
  return sig
    .split(/\s+/)
    .filter((t) => t && !/^\d+\.+$/.test(t))
    .map((t) => t.replace(/^\d+\.+/, "").replace(/[+#!?]+$/, ""));
}

export interface HubSeed {
  /** a sibling group smaller than SIBLING_MIN_ROWS: always Offbeat */
  small?: boolean;
  slug: string;
  title: string;
  kind: HubKind;
  parent: string | null;
  def: HubDef | null;
  rows: number[];
  primaryName: string;
}

/** All hubs: curated, auto (one per unclaimed first name segment), and siblings (recursive). */
export function computeHubs(model: Model, defs: HubDef[]): Hub[] {
  const claimed = new Set<number>();
  const seeds: HubSeed[] = [];
  for (const def of defs) {
    const rows: number[] = [];
    for (const r of model.rows) {
      if (def.match.some((q) => matchesQuery(r.name, q)) && !def.exclude?.some((q) => matchesQuery(r.name, q))) {
        rows.push(r.idx);
        claimed.add(r.idx);
      }
    }
    if (rows.length) {
      seeds.push({ slug: def.slug, title: def.title, kind: "curated", parent: null, def, rows, primaryName: def.primaryName ?? def.title });
    }
  }
  const auto = new Map<string, number[]>();
  for (const r of model.rows) {
    if (claimed.has(r.idx)) continue;
    const key = r.segments[0] ?? r.family;
    let list = auto.get(key);
    if (!list) auto.set(key, (list = []));
    list.push(r.idx);
  }
  for (const [name, rows] of [...auto.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    seeds.push({ slug: slugify(name), title: name, kind: "auto", parent: null, def: null, rows, primaryName: name });
  }

  const usedSlugs = new Set<string>();
  const uniqueSlug = (s: string) => {
    let slug = s || "opening";
    for (let i = 2; usedSlugs.has(slug); i++) slug = `${s}-${i}`;
    usedSlugs.add(slug);
    return slug;
  };
  // curated slugs are reserved first
  for (const s of seeds) s.slug = uniqueSlug(s.slug);

  const hubs: Hub[] = [];
  const queue = [...seeds];
  while (queue.length) {
    const seed = queue.shift()!;
    const hub = buildHub(model, seed);
    hubs.push(hub);
    for (const g of hub.siblingGroupsOut) {
      const segs = commonSegments(model, g.rows, 1);
      let name = segmentsToName(segs) || model.rows[g.rows[0]].name;
      if (name === hub.title || name === hub.primaryName) {
        // nothing more specific in common: name it by the deviating move
        const san = model.rows[g.rows[0]].sans[g.ply];
        const n = Math.floor(g.ply / 2) + 1;
        name = `${name} (${g.ply % 2 === 0 ? `${n}.${san}` : `${n}…${san}`})`;
      }
      const slug = uniqueSlug(slugify(name));
      // groups of ≥ SIBLING_MIN_ROWS are sibling hubs listed on the parent; smaller ones go to Offbeat
      const small = g.rows.length < T.SIBLING_MIN_ROWS;
      if (!small) hub.siblings.push(slug);
      queue.push({ slug, title: name, kind: "sibling", parent: hub.slug, def: null, rows: g.rows, primaryName: name, small });
    }
    delete (hub as Partial<HubInternal>).siblingGroupsOut;
  }
  return hubs;
}

/**
 * Rebuild one hub from its seed (rows + identity), e.g. on the client where
 * the catalog ships each hub's rows: identical to the hub computeHubs made.
 */
export function hubFromSeed(model: Model, seed: HubSeed, siblings: string[]): Hub {
  const hub = buildHub(model, seed);
  delete (hub as Partial<HubInternal>).siblingGroupsOut;
  hub.siblings = [...siblings];
  return hub;
}

interface HubInternal extends Hub {
  siblingGroupsOut: { ply: number; norm: string; rows: number[] }[];
}

function buildHub(model: Model, seed: HubSeed): HubInternal {
  const warnings: string[] = [];
  const rowsOf = seed.rows.map((r) => model.rows[r]);
  const gamesAt = (r: number) => model.nodes[model.rows[r].path[model.rows[r].path.length - 1]].games;
  const byShortest = (a: number, b: number) =>
    model.rows[a].sans.length - model.rows[b].sans.length || gamesAt(b) - gamesAt(a) || a - b;

  const exact = seed.rows.filter((r) => model.rows[r].name === seed.primaryName).sort(byShortest);
  const canonicalRow = exact[0] ?? [...seed.rows].sort(byShortest)[0];
  const C = model.rows[canonicalRow];

  const baseRowPlies = (base: string): number | null => {
    let best: number | null = null;
    for (const r of model.rows) if (r.name === base && (best === null || r.sans.length < best)) best = r.sans.length;
    return best;
  };
  const side = definingSide(seed.primaryName, C.sans.length, baseRowPlies, seed.def?.side);

  // σ: curated signature, else C trimmed to its last defining-side move
  let sigmaNorms: string[] = [];
  let sigmaPath: number[] = [0];
  let sigmaFromSignature = false;
  if (seed.def?.signature) {
    const norms = parseSignature(seed.def.signature);
    const path = [0];
    let ok = true;
    for (const n of norms) {
      const mv = model.nodes[path[path.length - 1]].theoryByNorm.get(n);
      if (!mv) {
        ok = false;
        break;
      }
      path.push(mv.to);
    }
    if (ok) {
      sigmaNorms = norms;
      sigmaPath = path;
      sigmaFromSignature = true;
    } else {
      warnings.push(`curated signature "${seed.def.signature}" is not in the theory graph; using the canonical row`);
    }
  }
  if (!sigmaFromSignature) {
    let plies = C.sans.length;
    while (plies > 0 && mover(plies - 1) !== side) plies--;
    sigmaNorms = C.norms.slice(0, plies);
    sigmaPath = C.path.slice(0, plies + 1);
  }
  const sigma = sigmaPath[sigmaPath.length - 1];

  // forward closure of σ in the global theory graph
  const closure = new Set<number>([sigma]);
  const stack = [sigma];
  while (stack.length) {
    const n = stack.pop()!;
    for (const mv of model.nodes[n].moves) {
      if (mv.theory && mv.to >= 0 && !closure.has(mv.to)) {
        closure.add(mv.to);
        stack.push(mv.to);
      }
    }
  }

  const attach = new Map<number, number>();
  const approachRows: number[] = [];
  const earlyRows = new Map<number, number>();
  const groups = new Map<string, { ply: number; norm: string; rows: number[] }>();
  for (const r of rowsOf) {
    const at = r.path.findIndex((n) => closure.has(n));
    if (at !== -1) {
      attach.set(r.idx, at);
      continue;
    }
    let k = 0;
    while (k < r.norms.length && k < sigmaNorms.length && r.norms[k] === sigmaNorms[k]) k++;
    if (k >= r.norms.length) {
      approachRows.push(r.idx); // a prefix of the approach
    } else if (mover(k) === side) {
      const key = `${k}:${r.norms[k]}`;
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { ply: k, norm: r.norms[k], rows: [] }));
      g.rows.push(r.idx);
    } else {
      earlyRows.set(r.idx, k);
    }
  }

  // hub DAG
  const dag = new Map<number, MMove[]>();
  const addEdge = (from: number, mv: MMove) => {
    let list = dag.get(from);
    if (!list) dag.set(from, (list = []));
    if (!list.includes(mv)) list.push(mv);
  };
  const addRowFrom = (r: number, start: number) => {
    const row = model.rows[r];
    for (let i = start; i < row.norms.length; i++) {
      addEdge(row.path[i], model.nodes[row.path[i]].theoryByNorm.get(row.norms[i])!);
    }
  };
  for (let i = 0; i < sigmaNorms.length; i++) {
    addEdge(sigmaPath[i], model.nodes[sigmaPath[i]].theoryByNorm.get(sigmaNorms[i])!);
  }
  for (const [r, at] of attach) addRowFrom(r, at);
  for (const [r, k] of earlyRows) addRowFrom(r, k);

  // connecting paths from σ to attachment points the DAG can't reach yet
  let connectingEdges = 0;
  const reachable = () => {
    const seen = new Set<number>([sigma]);
    const st = [sigma];
    while (st.length) {
      const n = st.pop()!;
      for (const mv of dag.get(n) ?? []) if (!seen.has(mv.to)) {
        seen.add(mv.to);
        st.push(mv.to);
      }
    }
    return seen;
  };
  let reach = reachable();
  for (const [r, at] of [...attach.entries()].sort((a, b) => a[0] - b[0])) {
    const a = model.rows[r].path[at];
    if (reach.has(a)) continue;
    // BFS over G within the closure, preferring more-played moves
    const prev = new Map<number, [number, MMove]>();
    const q = [sigma];
    const seen = new Set<number>([sigma]);
    while (q.length && !seen.has(a)) {
      const n = q.shift()!;
      const moves = model.nodes[n].moves.filter((m) => m.theory && m.to >= 0 && closure.has(m.to));
      moves.sort((x, y) => y.games - x.games || (x.norm < y.norm ? -1 : 1));
      for (const mv of moves) {
        if (seen.has(mv.to)) continue;
        seen.add(mv.to);
        prev.set(mv.to, [n, mv]);
        q.push(mv.to);
      }
    }
    if (!seen.has(a)) {
      warnings.push(`row "${model.rows[r].name}" attaches at a position not reachable from σ`);
      continue;
    }
    for (let n = a; n !== sigma; ) {
      const [p, mv] = prev.get(n)!;
      const before = dag.get(p)?.includes(mv);
      addEdge(p, mv);
      if (!before) connectingEdges++;
      n = p;
    }
    reach = reachable();
  }

  // rows through each node (for system thresholds and book-move ties)
  const rowsThrough = new Map<number, number>();
  const bump = (n: number) => rowsThrough.set(n, (rowsThrough.get(n) ?? 0) + 1);
  for (const [r, at] of attach) for (const n of new Set(model.rows[r].path.slice(at))) bump(n);
  for (const [r, k] of earlyRows) for (const n of new Set(model.rows[r].path.slice(k))) bump(n);
  for (const r of approachRows) for (const n of new Set(model.rows[r].path)) bump(n);
  for (const n of sigmaPath) if (!rowsThrough.has(n)) rowsThrough.set(n, 0);

  // deterministic move order inside the DAG: most games, then SAN
  for (const list of dag.values()) list.sort((x, y) => y.games - x.games || (x.norm < y.norm ? -1 : 1));

  const siblingGroupsOut = [...groups.values()].sort((a, b) => a.ply - b.ply || (a.norm < b.norm ? -1 : 1));
  return {
    slug: seed.slug,
    title: seed.title,
    kind: seed.kind,
    parent: seed.parent,
    def: seed.def,
    rows: seed.rows,
    primaryName: seed.primaryName,
    canonicalRow,
    side,
    sigmaPath,
    sigmaNorms,
    sigmaFromSignature,
    attach,
    approachRows,
    earlyRows,
    siblings: [],
    dag,
    rowsThrough,
    connectingEdges,
    warnings,
    small: !!seed.small,
    siblingGroupsOut,
  };
}

/** Hub-level coverage numbers for the build report. */
export function hubCoverage(model: Model, hub: Hub) {
  const total = hub.rows.length;
  const sigma = hub.sigmaPath[hub.sigmaPath.length - 1];
  const throughSigma = [...hub.attach.keys()].filter((r) => model.rows[r].path.includes(sigma)).length;
  return {
    total,
    attached: hub.attach.size,
    throughSigma,
    approach: hub.approachRows.length,
    early: hub.earlyRows.size,
    siblingRows: total - hub.attach.size - hub.approachRows.length - hub.earlyRows.size,
  };
}
