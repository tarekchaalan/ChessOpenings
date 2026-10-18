/**
 * What to train next (§3.2 D Modes): the next line to learn in a tier, the
 * due-card queue for Review (per course and across courses), and Drill
 * picks. Pure functions over a course plus the learner's cards/progress.
 */
import type { Course, CourseLine } from "@/lib/openings-build/courses";
import { normSan, type Model } from "@/lib/openings-build/model";
import { cardKey, isReviewable, retrievability, type CardState, type Side } from "@/lib/srs/fsrs";
import { chapterTrunk, divergence } from "./session";

export type TierKey = "essentials" | "core" | "complete";

/** Lines in a tier: the top-reach σ-lines for Essentials/Core, every line for Complete. */
export function tierLines(course: Course, tier: TierKey): number[] {
  if (tier === "complete") return course.lines.map((l) => l.idx);
  const main = course.lines.filter((l) => !l.early);
  return main.slice(0, course.tiers[tier].lines).map((l) => l.idx);
}

/** The learner plies of a line: (ply, epd, answer). */
export function learnerMoves(model: Model, side: Side, line: CourseLine): { ply: number; epd: string; answer: string }[] {
  const out: { ply: number; epd: string; answer: string }[] = [];
  for (let p = side === "white" ? 0 : 1; p < line.sans.length; p += 2) {
    out.push({ ply: p, epd: model.nodes[line.nodes[p]].epd, answer: normSan(line.sans[p]) });
  }
  return out;
}

/** Next line to learn in tier order, skipping learned lines and `exclude`; null when the tier is done. */
export function nextLearnLine(course: Course, tier: TierKey, learned: (lineId: string) => boolean, exclude?: number): CourseLine | null {
  for (const li of tierLines(course, tier)) {
    const l = course.lines[li];
    if (li !== exclude && !learned(l.id)) return l;
  }
  return null;
}

/** "starts at move 9": where the next line leaves the current one. */
export function startsAtMove(a: CourseLine, b: CourseLine): number {
  return Math.floor(divergence(a, b) / 2) + 1;
}

export interface ReviewItem {
  courseId: string;
  line: number;
  /** due learner plies on this line */
  plies: number[];
  /** fast-forward to the earliest due ply; end after the last */
  startPly: number;
  endPly: number;
  /** lowest retrievability among its cards (most urgent first) */
  urgency: number;
  chapter: number;
}

/**
 * Due cards grouped by line (each card once, on the first line by order that
 * holds it), most urgent first, interleaving chapters.
 */
export function reviewQueue(
  model: Model,
  course: Course,
  cards: Record<string, CardState>,
  now = new Date(),
  retention = 0.9,
  /** cards already queued (shared across courses by the global queue) */
  claimed = new Set<string>()
): ReviewItem[] {
  const items: ReviewItem[] = [];
  for (const line of course.lines) {
    const plies: number[] = [];
    let urgency = 1;
    for (const m of learnerMoves(model, course.side, line)) {
      const key = cardKey(course.side, m.epd, m.answer);
      const c = cards[key];
      if (!c || claimed.has(key) || !isReviewable(c, now)) continue;
      claimed.add(key);
      plies.push(m.ply);
      urgency = Math.min(urgency, retrievability(c, now, retention));
    }
    if (plies.length) {
      items.push({ courseId: course.id, line: line.idx, plies, startPly: plies[0], endPly: plies[plies.length - 1] + 1, urgency, chapter: line.chapter });
    }
  }
  return interleave(items.sort((a, b) => a.urgency - b.urgency || a.line - b.line));
}

/** Round-robin by chapter, keeping each chapter's order. */
export function interleave(items: ReviewItem[]): ReviewItem[] {
  const by = new Map<string, ReviewItem[]>();
  for (const it of items) {
    const k = `${it.courseId}#${it.chapter}`;
    if (!by.has(k)) by.set(k, []);
    by.get(k)!.push(it);
  }
  const lists = [...by.values()];
  const out: ReviewItem[] = [];
  for (let i = 0; out.length < items.length; i++) for (const l of lists) if (l[i]) out.push(l[i]);
  return out;
}

/** Courses with due cards (for the cross-course queue), by their cards' last course. */
export function dueCourses(cards: Record<string, CardState>, now = new Date()): string[] {
  const ids = new Set<string>();
  for (const c of Object.values(cards)) if (c.lastCourseId && isReviewable(c, now)) ids.add(c.lastCourseId);
  return [...ids].sort();
}

/**
 * Drill: a random line from the chosen chapters (not `avoid` when there's a
 * choice), started at its chapter trunk. With `under`, only lines through
 * that position, started there (Explore's "Train from here").
 */
export function drillPick(
  course: Course,
  chapters: number[] | null,
  avoid: number | null,
  rnd = Math.random,
  under: number | null = null
): { line: number; startPly: number } | null {
  // a line that ends at `under` has nothing below it to drill
  const pool = course.lines.filter((l) => (!chapters || chapters.includes(l.chapter)) && (under === null || (l.nodes.includes(under) && l.nodes.indexOf(under) < l.sans.length)));
  if (!pool.length) return null;
  const choices = pool.length > 1 && avoid !== null ? pool.filter((l) => l.idx !== avoid) : pool;
  const line = choices[Math.floor(rnd() * choices.length)];
  return { line: line.idx, startPly: under !== null ? line.nodes.indexOf(under) : chapterTrunk(course, line) };
}

/**
 * The line of `course` matching a line of the same course derived without
 * the learner's overrides: same id, else the longest shared move prefix.
 */
export function sameLine(course: Course, line: CourseLine): CourseLine | null {
  const same = course.lines.find((l) => l.id === line.id);
  if (same) return same;
  const shared = (l: CourseLine) => {
    let i = 0;
    while (i < l.sans.length && i < line.sans.length && l.sans[i] === line.sans[i]) i++;
    return i;
  };
  return [...course.lines].sort((a, b) => shared(b) - shared(a) || a.idx - b.idx)[0] ?? null;
}
