/**
 * Compare (spec §2.5): openings both players learn, and ratings on the same
 * platform and time class. Only what the other player lets the viewer see
 * arrives here (compare_with in 0008), so a hidden section compares nothing.
 */
import { TIME_CLASSES } from "@/lib/insights/types";
import type { LearningRow, LinkedInfo, Platform, Ratings, TimeClass } from "./types";

export interface Side {
  /** 0..100 */
  mastery: number;
  /** 0..100, null before any graded answer */
  accuracy: number | null;
  seen: number;
}

export interface CourseComparison {
  course_id: string;
  me: Side;
  them: Side;
}

export interface RatingComparison {
  platform: Platform;
  time_class: TimeClass;
  me: number;
  them: number;
  /** me − them */
  diff: number;
}

export function accuracy(correct: number, seen: number): number | null {
  return seen > 0 ? Math.round((100 * correct) / seen) : null;
}

const side = (r: LearningRow): Side => ({
  mastery: Math.round(Math.min(1, Math.max(0, Number(r.mastery) || 0)) * 100),
  accuracy: accuracy(r.correct, r.seen),
  seen: r.seen,
});

/** Courses in both lists, most recently trained (by either) first. */
export function compareCourses(me: LearningRow[], them: LearningRow[] | null): CourseComparison[] {
  if (!them) return [];
  const theirs = new Map(them.map((r) => [r.course_id, r]));
  return me
    .filter((r) => theirs.has(r.course_id))
    .map((r) => {
      const t = theirs.get(r.course_id)!;
      const latest = r.updated_at > t.updated_at ? r.updated_at : t.updated_at;
      return { latest, row: { course_id: r.course_id, me: side(r), them: side(t) } };
    })
    .sort((a, b) => b.latest.localeCompare(a.latest) || a.row.course_id.localeCompare(b.row.course_id))
    .map((x) => x.row);
}

const rating = (r: Ratings, tc: TimeClass) => {
  const v = r[tc]?.rating;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
};

/** Every platform and time class where both have a rating. */
export function compareRatings(me: LinkedInfo[], them: LinkedInfo[] | null): RatingComparison[] {
  if (!them) return [];
  const out: RatingComparison[] = [];
  for (const m of me) {
    const t = them.find((x) => x.platform === m.platform);
    if (!t) continue;
    for (const tc of TIME_CLASSES) {
      const a = rating(m.ratings, tc);
      const b = rating(t.ratings, tc);
      if (a !== null && b !== null) out.push({ platform: m.platform, time_class: tc, me: a, them: b, diff: a - b });
    }
  }
  return out;
}

/** The rating to show for an account: the time class with the most games. */
export function primaryRating(r: Ratings): { timeClass: TimeClass; rating: number } | null {
  let best: { timeClass: TimeClass; rating: number; games: number } | null = null;
  for (const tc of TIME_CLASSES) {
    const v = r[tc];
    if (!v || typeof v.rating !== "number") continue;
    const games = v.games ?? 0;
    if (!best || games > best.games) best = { timeClass: tc, rating: v.rating, games };
  }
  return best && { timeClass: best.timeClass, rating: best.rating };
}
