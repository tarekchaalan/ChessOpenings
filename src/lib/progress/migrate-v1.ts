/**
 * Guest progress migration v1 → v2 (§4.9, ADR 0003). Pure: takes the raw
 * `cot.v1.*` localStorage values and returns what to write under
 * `cot.v2.*`. The browser runner (migrate-runner.ts) does the I/O: backup
 * first, then the v2 keys, then the marker.
 *
 * v1 cards were keyed (openingId, epd) with SM-2 state; v2 cards are keyed
 * (side, epd, answer) with FSRS state, shared across courses.
 */
import { State, cardKey, type CardState, type Side } from "@/lib/srs/fsrs";
import { normSan, sideToMove } from "@/lib/openings-build/model";
import type { LegacyMap } from "@/lib/openings-build/legacy";
import type { Course } from "@/lib/openings-build/courses";
import type { Dataset } from "@/lib/openings";
import { findSystem, loadCourse, modelOf, parseCourseId } from "@/lib/courses-client";
import { positionTarget } from "@/lib/catalog-client";
import type { CourseProgress } from "./store";

/** The live v1 keys (the backup key is not a source). */
export const V1_KEYS = ["cot.v1.cards", "cot.v1.attempts", "cot.v1.profile", "cot.v1.openingProgress", "cot.v1.prefs"] as const;

export const MIGRATION_KEYS = {
  marker: "cot.v2.migrated",
  backup: "cot.v1.backup",
  report: "cot.v2.migrationReport",
  attempts: "cot.v2.attempts",
  profile: "cot.v2.profile",
  prefs: "cot.v2.prefs",
} as const;

/** ts-fsrs `maximum_interval` default (days). */
export const MAX_INTERVAL_DAYS = 36500;
const DAY = 86400_000;
const LAPSE_RETRY_MS = 10 * 60_000;

export interface V1Card {
  openingId: number;
  epd: string;
  lineSans: string[];
  ease: number;
  intervalDays: number;
  reps: number;
  lapses: number;
  due: string;
  seen: number;
  correct: number;
}

interface V1OpeningProgress {
  openingId: number;
  seen: number;
  correct: number;
  streak: number;
  bestStreak: number;
  mastery: number;
  updatedAt: string;
}

/** Where a v1 card lands: its answer and the course that trains it (null: none does). */
export interface Placement {
  answer: string;
  courseId: string | null;
}

export interface Placer {
  /**
   * `rowMove`: the move the v1 row played at `epd` (null when the card's line
   * left the row). `preferred`: the legacy map's best course for the row.
   */
  place(epd: string, side: Side, rowMove: string | null, preferred: string | null): Placement | null;
}

export interface MigrationReport {
  at: string;
  hash: string;
  v1Cards: number;
  v2Cards: number;
  /** v1 cards folded into another with the same v2 key */
  merged: number;
  /** v2 keys that already had a card (the existing v2 card is kept) */
  kept: number;
  /** answer = the v1 row's own move / a course's book move / the most-played theory move */
  answers: { row: number; book: number; popular: number };
  /** intervals clamped to the FSRS maximum (v1 grew intervals on same-day repeats) */
  clamped: number;
  dropped: { openingId: number; epd: string; reason: string }[];
  courses: number;
  droppedCourses: number[];
}

export interface MigrationOutput {
  cards: Record<string, CardState>;
  courseProgress: Record<string, CourseProgress>;
  /** v1 attempts as the v2 activity log (day → [answers, correct]): streaks carry over */
  activity: Record<string, [number, number]>;
  /** passed through as-is (raw JSON strings), null when absent */
  attempts: string | null;
  profile: string | null;
  prefs: string | null;
  report: MigrationReport;
}

/** FNV-1a over the sorted key=value pairs: the marker that makes the migration idempotent. */
export function sourceHash(snapshot: Record<string, string>): string {
  let h = 0x811c9dc5;
  for (const k of Object.keys(snapshot).sort()) {
    const s = `${k}=${snapshot[k]}\n`;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

const sideOfEpd = (epd: string): Side => (epd.split(" ")[1] === "b" ? "black" : "white");
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/** The move the v1 row played at the card's position, if the card's line is a prefix of the row. */
export function rowMoveFor(card: V1Card, legacy: LegacyMap): string | null {
  const e = legacy.entries[card.openingId];
  if (!e || e.sans.length <= card.lineSans.length) return null;
  for (let i = 0; i < card.lineSans.length; i++) if (normSan(card.lineSans[i]) !== normSan(e.sans[i])) return null;
  return normSan(e.sans[card.lineSans.length]);
}

/**
 * SM-2 → FSRS (ADR 0003): stability = max(0.5, interval); difficulty linear
 * in ease (2.5 → 5, 1.3 → 9, clamped 1–10); due/reps/lapses kept; a card
 * whose last answer lapsed (reps 0, seen > 0) is Relearning. The last review
 * is due − interval (exact for v1, which set due = review + interval), and
 * the interval is clamped to the FSRS maximum.
 */
export function sm2ToFsrs(c: V1Card, side: Side, answer: string): { card: CardState; clamped: boolean } {
  const due = new Date(c.due).getTime();
  const lastReview = c.intervalDays > 0 ? due - c.intervalDays * DAY : due - LAPSE_RETRY_MS;
  const ivl = Math.min(c.intervalDays, MAX_INTERVAL_DAYS);
  const state = c.reps > 0 ? State.Review : c.seen > 0 ? State.Relearning : State.New;
  return {
    clamped: c.intervalDays > MAX_INTERVAL_DAYS,
    card: {
      side,
      epd: c.epd,
      answer: normSan(answer),
      due: new Date(c.intervalDays > 0 ? lastReview + ivl * DAY : due).toISOString(),
      stability: Math.max(0.5, ivl),
      difficulty: clamp(5 + (2.5 - c.ease) * (4 / 1.2), 1, 10),
      elapsed_days: 0,
      scheduled_days: Math.round(ivl),
      learning_steps: 0,
      reps: c.reps,
      lapses: c.lapses,
      state,
      last_review: state === State.New ? null : new Date(lastReview).toISOString(),
      seen: c.seen,
      correct: c.correct,
      migratedFrom: "sm2",
    },
  };
}

function parse<T>(raw: string | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/**
 * The migration proper. `existing` v2 cards always win over migrated ones
 * (a second run after new v1 writes never overwrites real FSRS state).
 */
export function migrateV1(
  snapshot: Record<string, string>,
  legacy: LegacyMap,
  placer: Placer,
  existing: { cards: Record<string, CardState>; courses: Record<string, CourseProgress> },
  now = new Date()
): MigrationOutput {
  const v1Cards = Object.values(parse<Record<string, V1Card>>(snapshot["cot.v1.cards"], {}));
  const report: MigrationReport = {
    at: now.toISOString(),
    hash: sourceHash(snapshot),
    v1Cards: v1Cards.length,
    v2Cards: 0,
    merged: 0,
    kept: 0,
    answers: { row: 0, book: 0, popular: 0 },
    clamped: 0,
    dropped: [],
    courses: 0,
    droppedCourses: [],
  };

  // ── cards ────────────────────────────────────────────────────────────────
  const cards: Record<string, CardState> = {};
  /** the courses each v1 opening's cards landed in (for its progress) */
  const coursesOf = new Map<number, Map<string, number>>();
  for (const c of v1Cards) {
    const side = sideOfEpd(c.epd);
    const rowMove = rowMoveFor(c, legacy);
    // the row's best course is preferred only for its own moves: off the row, every
    // card at a position lands the same way (one row per position on the server)
    const p = placer.place(c.epd, side, rowMove, rowMove ? (legacy.entries[c.openingId]?.bestCourseId ?? null) : null);
    if (!p) {
      report.dropped.push({ openingId: c.openingId, epd: c.epd, reason: "position not in the v2 tree" });
      continue;
    }
    report.answers[p.answer === rowMove ? "row" : p.courseId ? "book" : "popular"]++;
    const { card, clamped } = sm2ToFsrs(c, side, p.answer);
    if (clamped) report.clamped++;
    if (p.courseId) {
      card.lastCourseId = p.courseId;
      const m = coursesOf.get(c.openingId) ?? new Map<string, number>();
      m.set(p.courseId, (m.get(p.courseId) ?? 0) + 1);
      coursesOf.set(c.openingId, m);
    }
    const key = cardKey(side, c.epd, p.answer);
    const prev = cards[key];
    if (!prev) {
      cards[key] = card;
      continue;
    }
    // merge: the state with the most reps (ties → earliest due); lapses, seen, correct summed
    report.merged++;
    const keep = card.reps > prev.reps || (card.reps === prev.reps && card.due < prev.due) ? card : prev;
    cards[key] = { ...keep, lapses: prev.lapses + card.lapses, seen: prev.seen + card.seen, correct: prev.correct + card.correct };
  }
  for (const key of Object.keys(cards)) {
    if (existing.cards[key]) {
      delete cards[key];
      report.kept++;
    }
  }
  report.v2Cards = Object.keys(cards).length;

  // ── opening progress → course progress ───────────────────────────────────
  const courseProgress: Record<string, CourseProgress> = {};
  for (const op of Object.values(parse<Record<string, V1OpeningProgress>>(snapshot["cot.v1.openingProgress"], {}))) {
    // the course most of its cards landed in, else the map's best course for the row
    const landed = [...(coursesOf.get(op.openingId) ?? new Map()).entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    const entry = legacy.entries[op.openingId];
    const courseId: string | null = landed ?? entry?.bestCourseId ?? null;
    if (!courseId) {
      report.droppedCourses.push(op.openingId);
      continue;
    }
    const prev = courseProgress[courseId] ?? existing.courses[courseId];
    const v1 = prev?.v1;
    courseProgress[courseId] = {
      courseId,
      tier: prev?.tier ?? null,
      lastLineId: prev?.lastLineId ?? (entry?.bestCourseId === courseId ? entry.bestLineId : null),
      lastStudiedAt: [prev?.lastStudiedAt, op.updatedAt].filter(Boolean).sort().at(-1) ?? null,
      lines: prev?.lines ?? {},
      v1: {
        seen: (v1?.seen ?? 0) + op.seen,
        correct: (v1?.correct ?? 0) + op.correct,
        streak: (v1?.streak ?? 0) + op.streak,
        bestStreak: Math.max(v1?.bestStreak ?? 0, op.bestStreak),
        updatedAt: [v1?.updatedAt, op.updatedAt].filter(Boolean).sort().at(-1)!,
      },
    };
  }
  report.courses = Object.keys(courseProgress).length;

  const activity: Record<string, [number, number]> = {};
  for (const a of parse<{ correct: boolean; at: string }[]>(snapshot["cot.v1.attempts"], [])) {
    if (typeof a?.at !== "string") continue;
    const row = (activity[a.at.slice(0, 10)] ??= [0, 0]);
    row[0]++;
    if (a.correct) row[1]++;
  }

  return {
    cards,
    courseProgress,
    activity,
    attempts: snapshot["cot.v1.attempts"] ?? null,
    profile: snapshot["cot.v1.profile"] ?? null,
    prefs: snapshot["cot.v1.prefs"] ?? null,
    report,
  };
}

/**
 * The placer on the v2 dataset. For a card at `epd` (the learner's side to
 * move), in order:
 *   1. the row's own move, if a course for that side trains it there (the
 *      row's best course first, then the course the position index names);
 *   2. else that course's book move at `epd` (so the card stays reviewable);
 *   3. else the row's move, else the most-played theory move, with no course.
 * null when the position isn't in the v2 tree (the card is dropped).
 */
export function datasetPlacer(ds: Dataset): Placer {
  const model = modelOf(ds);
  const courses = new Map<string, Course | null>();
  const courseById = (id: string): Course | null => {
    if (!courses.has(id)) {
      const p = parseCourseId(id);
      const s = p ? findSystem(ds, p.hub, p.system, p.side) : null;
      courses.set(id, s ? loadCourse(ds, s) : null);
    }
    return courses.get(id)!;
  };
  const bookIn = (course: Course, node: number): string | null => {
    for (const l of course.lines) {
      const i = l.nodes.indexOf(node);
      if (i >= 0 && i < l.sans.length) return normSan(l.sans[i]);
    }
    return null;
  };
  return {
    place(epd, side, rowMove, preferred) {
      const node = model.byEpd.get(epd);
      if (node === undefined || sideToMove(model, node) !== side) return null;
      const ids: string[] = [];
      if (preferred && parseCourseId(preferred)?.side === side) ids.push(preferred);
      const t = positionTarget(ds, node, side);
      if (t) ids.push(`${t.hub.slug}/${t.system.slug}@${t.system.side}`);
      const books = ids.map((id) => ({ id, book: courseById(id) ? bookIn(courseById(id)!, node) : null }));
      const row = rowMove && model.nodes[node].theoryByNorm.has(rowMove) ? rowMove : null;
      const trains = books.find((b) => row && b.book === row);
      if (trains) return { answer: row!, courseId: trains.id };
      const book = books.find((b) => b.book);
      if (book) return { answer: book.book!, courseId: book.id };
      if (row) return { answer: row, courseId: null };
      const popular = model.nodes[node].moves.filter((m) => m.theory).sort((a, b) => b.games - a.games)[0];
      return popular ? { answer: popular.norm, courseId: null } : null;
    },
  };
}
