/**
 * Every finding links to something trainable (ADR 0006 § Deep links): the
 * deepest position on the game's book path that has a course for the player's
 * side, opened in the trainer at that position; else the course of the deepest
 * named opening on the path; else the catalog.
 */
import { positionTarget, rowTarget, trainHref, type Target } from "@/lib/catalog-client";
import { loadCourse, modelOf } from "@/lib/courses-client";
import type { Dataset } from "@/lib/openings";
import { deepestName } from "@/lib/openings-build/model";
import type { Side } from "./types";

export interface TrainLink {
  /** /train/... at the position (or the course start on a fallback) */
  train: string;
  /** /openings/{hub}/{system}/{side} */
  course: string;
  courseName: string;
  /** false when only a fallback was found */
  exact: boolean;
}

export const CATALOG_LINK: TrainLink = { train: "/openings", course: "/openings", courseName: "the opening catalog", exact: false };

const courseHref = (t: Target) => `/openings/${t.hub.slug}/${t.system.slug}/${t.system.side}`;
const courseName = (t: Target) => {
  const s = t.system.name;
  // system names usually repeat the hub's ("Sicilian Defense: Old Sicilian")
  return !s || s === t.hub.title ? t.hub.title : s.startsWith(t.hub.title) ? s : `${t.hub.title}: ${s}`;
};

/** Ply index of the target's position in its course line, or null. */
function startPly(ds: Dataset, t: Target): number | null {
  const line = loadCourse(ds, t.system)?.lines[t.line];
  const i = line ? line.nodes.indexOf(t.at) : -1;
  return i >= 0 && i < line!.sans.length ? i : null;
}

export function trainLink(ds: Dataset, path: number[], color: Side): TrainLink {
  for (let i = path.length - 1; i >= 0; i--) {
    const t = positionTarget(ds, path[i], color);
    if (!t) continue;
    const ply = startPly(ds, t);
    return { train: trainHref(t, "learn", ply !== null ? `&start=${ply}` : ""), course: courseHref(t), courseName: courseName(t), exact: i === path.length - 1 };
  }
  const row = deepestName(modelOf(ds), path);
  const t = row ? rowTarget(ds, row.idx, color) : null;
  return t ? { train: trainHref(t), course: courseHref(t), courseName: courseName(t), exact: false } : CATALOG_LINK;
}

/** A course's own links (recommendations): Learn from its first line. */
export function courseLink(t: Target): TrainLink {
  return { train: trainHref(t), course: courseHref(t), courseName: courseName(t), exact: true };
}
