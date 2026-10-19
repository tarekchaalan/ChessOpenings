/**
 * Client access to hubs, systems and courses. Summaries come straight from
 * the dataset's catalog; full courses (lines, chapters, book moves) are
 * re-derived with the same pure library the build uses, memoised per
 * dataset hash and override set, so they match the build exactly.
 */
import type { Dataset } from "./openings";
import type { RawCatalog, RawCourseSummary, RawHubSummary, RawSystemSummary } from "./openings-build/catalog";
import { courseIdOf, deriveCourse, type Course, type SystemDef } from "./openings-build/courses";
import { hubFromSeed, type Hub } from "./openings-build/hubs";
import { modelFromRaw, type Model } from "./openings-build/model";
import type { Side } from "./openings-build/types";

export type { RawHubSummary, RawSystemSummary, RawCourseSummary, Course, Side };

interface Derived {
  hash: string;
  model: Model;
  hubs: Map<string, Hub>;
  courses: Map<string, Course>;
}

// the two most recent datasets: a trainer run keeps the snapshot it started on
// while the rest of the app moves to a live-updated one
const derivedCache: Derived[] = [];

function base(ds: Dataset): Derived {
  if (!ds.raw) throw new Error("course data needs the v2 dataset");
  const hash = ds.outputHash ?? "";
  let d = derivedCache.find((x) => x.hash === hash);
  if (!d) {
    d = { hash, model: modelFromRaw(ds.raw), hubs: new Map(), courses: new Map() };
    derivedCache.unshift(d);
    derivedCache.length = Math.min(derivedCache.length, 2);
  }
  return d;
}

export function catalogOf(ds: Dataset): RawCatalog | null {
  return ds.raw?.catalog ?? null;
}

export function modelOf(ds: Dataset): Model {
  return base(ds).model;
}

export function hubSummary(ds: Dataset, slug: string): RawHubSummary | null {
  return catalogOf(ds)?.hubs.find((h) => h.slug === slug) ?? null;
}

export function systemsFor(ds: Dataset, hub: RawHubSummary, side: Side): RawSystemSummary[] {
  const cat = catalogOf(ds)!;
  return hub.systems[side].map((i) => cat.systems[i]);
}

export function courseSummary(ds: Dataset, system: RawSystemSummary): RawCourseSummary {
  return catalogOf(ds)!.courses[system.course];
}

export function findSystem(ds: Dataset, hubSlug: string, systemSlug: string, side: Side): RawSystemSummary | null {
  const cat = catalogOf(ds);
  const hub = hubSummary(ds, hubSlug);
  if (!cat || !hub) return null;
  return hub.systems[side].map((i) => cat.systems[i]).find((s) => s.slug === systemSlug) ?? null;
}

function systemDef(ds: Dataset, s: RawSystemSummary): SystemDef {
  const cat = catalogOf(ds)!;
  return {
    hub: cat.hubs[s.hub].slug,
    side: s.side,
    slug: s.slug,
    name: s.name,
    choices: s.choices,
    defining: s.defining,
    signatureNode: s.signatureNode,
    parent: s.parent >= 0 ? cat.systems[s.parent].slug : null,
  };
}

/** Full course, optionally with per-course overrides (EPD-keyed, mapped to nodes here). */
export function loadCourse(ds: Dataset, s: RawSystemSummary, overrides?: Record<string, string>): Course | null {
  const b = base(ds);
  const def = systemDef(ds, s);
  const hub = hubOf(ds, def.hub);
  if (!hub) return null;
  const ov = new Map<number, string>();
  for (const [epd, san] of Object.entries(overrides ?? {})) {
    const n = b.model.byEpd.get(epd);
    if (n !== undefined) ov.set(n, san);
  }
  const key = courseIdOf(def.hub, def.slug, def.side) + "|" + [...ov].map(([n, s2]) => `${n}:${s2}`).sort().join(",");
  let c = b.courses.get(key);
  if (!c) {
    c = deriveCourse(b.model, hub, def, { overrides: ov });
    b.courses.set(key, c);
  }
  return c;
}

/** One hub, rebuilt from the seed the catalog ships (only the hub you need). */
export function hubOf(ds: Dataset, slug: string): Hub | null {
  const b = base(ds);
  let hub = b.hubs.get(slug);
  if (!hub) {
    const sum = hubSummary(ds, slug);
    if (!sum) return null;
    hub = hubFromSeed(
      b.model,
      {
        slug: sum.slug,
        title: sum.title,
        kind: sum.kind,
        parent: sum.parent,
        // the shipped seed, not the code bundle's config, defines the hub
        def: sum.kind === "curated" ? { slug: sum.slug, title: sum.title, match: [], ...(sum.defSide ? { side: sum.defSide } : {}), ...(sum.signature ? { signature: sum.signature } : {}) } : null,
        rows: sum.rowIdx,
        primaryName: sum.primaryName,
      },
      sum.siblings
    );
    b.hubs.set(slug, hub);
  }
  return hub;
}

export const courseHref = (hub: string, system: string, side: Side) => `/openings/${hub}/${system}/${side}`;
export const hubHref = (hub: string) => `/openings/${hub}`;

export function parseCourseId(id: string): { hub: string; system: string; side: Side } | null {
  const m = /^([^/]+)\/([^@]+)@(white|black)$/.exec(id);
  return m ? { hub: m[1], system: m[2], side: m[3] as Side } : null;
}

/** "e4 c5 Nf3" → "1.e4 c5 2.Nf3", with "…" for a Black start. */
export function formatMoves(sans: string[], startPly = 0, max = Infinity): string {
  const parts: string[] = [];
  for (let i = 0; i < sans.length && i < max; i++) {
    const ply = startPly + i;
    const n = Math.floor(ply / 2) + 1;
    if (ply % 2 === 0) parts.push(`${n}.${sans[i]}`);
    else parts.push(i === 0 ? `${n}…${sans[i]}` : sans[i]);
  }
  return parts.join(" ") + (sans.length > max ? " …" : "");
}
