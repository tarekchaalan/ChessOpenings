/**
 * Browser-side trainer helpers shared by the /train screens: decoded
 * annotations, a course with the learner's overrides, Learn's start ply, and
 * the cross-course review queue.
 */
import { findSystem, hubSummary, loadCourse, modelOf, parseCourseId, type Course, type RawHubSummary, type RawSystemSummary } from "@/lib/courses-client";
import { decodeAnnotations, type Annotations } from "@/lib/openings-build/annotations";
import type { Dataset } from "@/lib/openings";
import { allCards, getCard, overridesFor } from "@/lib/progress/store";
import { learnStartPly } from "./session";
import { dueCourses, reviewQueue, type ReviewItem } from "./plan";

const annotationsCache = new WeakMap<Dataset, Annotations>();
export function annotationsOf(ds: Dataset): Annotations {
  let a = annotationsCache.get(ds);
  if (!a) annotationsCache.set(ds, (a = decodeAnnotations(ds.raw?.annotations)));
  return a;
}

export function courseFor(ds: Dataset, system: RawSystemSummary): Course {
  const id = `${ds.raw!.catalog!.hubs[system.hub].slug}/${system.slug}@${system.side}`;
  return loadCourse(ds, system, overridesFor(id))!;
}

/** Learn's start: skip known moves (setting), but a fully known line is relearned from the start. */
export function learnStart(ds: Dataset, course: Course, lineIdx: number, skipKnown: boolean): number {
  if (!skipKnown) return 0;
  const line = course.lines[lineIdx];
  const start = learnStartPly(line, course.side, modelOf(ds), (epd, answer) => !!getCard(course.side, epd, answer));
  return start >= line.sans.length ? 0 : start;
}

export type GlobalItem = { item: ReviewItem; hub: RawHubSummary; system: RawSystemSummary; course: Course };

export function globalQueue(ds: Dataset, retention: number): GlobalItem[] {
  const cards = allCards();
  const claimed = new Set<string>(); // a card shared by two courses is reviewed once
  const out: GlobalItem[] = [];
  for (const id of dueCourses(cards)) {
    const p = parseCourseId(id);
    const hub = p && hubSummary(ds, p.hub);
    const system = p && hub ? findSystem(ds, p.hub, p.system, p.side) : null;
    if (!hub || !system) continue;
    const course = courseFor(ds, system);
    for (const item of reviewQueue(modelOf(ds), course, cards, new Date(), retention, claimed)) out.push({ item, hub, system, course });
  }
  // most urgent first, then round-robin across course chapters (keeps the interleave)
  out.sort((a, b) => a.item.urgency - b.item.urgency);
  const by = new Map<string, GlobalItem[]>();
  for (const g of out) {
    const k = `${g.item.courseId}#${g.item.chapter}`;
    if (!by.has(k)) by.set(k, []);
    by.get(k)!.push(g);
  }
  const lists = [...by.values()];
  const mixed: GlobalItem[] = [];
  for (let i = 0; mixed.length < out.length; i++) for (const l of lists) if (l[i]) mixed.push(l[i]);
  return mixed;
}
