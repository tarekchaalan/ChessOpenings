"use client";
/**
 * v2 progress store (ADR 0003), guest mode: localStorage `cot.v2.*`.
 *   cot.v2.cards           card key → CardState  (shared across courses)
 *   cot.v2.courseProgress  course id → progress (last line, per-line dates, tier)
 *   cot.v2.overrides       course id → { epd: san }  (learner alternatives)
 * Reads never throw; writes are best-effort (private mode, quota).
 * Subscribers are notified on every write, across tabs too.
 */
import { useEffect, useState } from "react";
import { cardKey, newCard, review, type CardState, type Grade, type Side } from "@/lib/srs/fsrs";

export const KEYS = {
  cards: "cot.v2.cards",
  courses: "cot.v2.courseProgress",
  overrides: "cot.v2.overrides",
  activity: "cot.v2.activity",
} as const;

export type TierKey = "essentials" | "core" | "complete";

export interface LineProgress {
  learnedAt?: string;
  lastReviewedAt?: string;
}

export interface CourseProgress {
  courseId: string;
  tier: TierKey | null;
  lastLineId: string | null;
  lastStudiedAt: string | null;
  lines: Record<string, LineProgress>;
}

const EVENT = "cot:progress";

function read<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage unavailable — progress is best-effort in guest mode
  }
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(EVENT));
}

export const allCards = () => read<Record<string, CardState>>(KEYS.cards, {});
export const getCard = (side: Side, epd: string, answer: string) => allCards()[cardKey(side, epd, answer)] ?? null;

export function putCard(card: CardState): void {
  const cards = allCards();
  cards[cardKey(card.side, card.epd, card.answer)] = card;
  write(KEYS.cards, cards);
}

/** Learn introduces a card (state New) without grading it. */
export function introduceCard(side: Side, epd: string, answer: string, where: { courseId: string; lineId: string }, now = new Date()): CardState {
  const existing = getCard(side, epd, answer);
  const card = { ...(existing ?? newCard(side, epd, answer, now)), lastCourseId: where.courseId, lastLineId: where.lineId, archived: false };
  putCard(card);
  return card;
}

export function gradeCard(
  side: Side,
  epd: string,
  answer: string,
  grade: Grade,
  where: { courseId: string; lineId: string },
  retention: number,
  now = new Date()
): CardState {
  const existing = getCard(side, epd, answer) ?? newCard(side, epd, answer, now);
  const card = { ...review(existing, grade, now, retention), lastCourseId: where.courseId, lastLineId: where.lineId, archived: false };
  putCard(card);
  logActivity(now, grade);
  return card;
}

export const allCourseProgress = () => read<Record<string, CourseProgress>>(KEYS.courses, {});

export function courseProgress(courseId: string): CourseProgress {
  return allCourseProgress()[courseId] ?? { courseId, tier: null, lastLineId: null, lastStudiedAt: null, lines: {} };
}

export function updateCourseProgress(courseId: string, fn: (p: CourseProgress) => CourseProgress): CourseProgress {
  const all = allCourseProgress();
  const next = fn(all[courseId] ?? { courseId, tier: null, lastLineId: null, lastStudiedAt: null, lines: {} });
  all[courseId] = next;
  write(KEYS.courses, all);
  return next;
}

export function markLine(courseId: string, lineId: string, what: "learned" | "reviewed", now = new Date()): void {
  updateCourseProgress(courseId, (p) => {
    const lp = { ...(p.lines[lineId] ?? {}) };
    if (what === "learned") lp.learnedAt ??= now.toISOString();
    else lp.lastReviewedAt = now.toISOString();
    return { ...p, lastLineId: lineId, lastStudiedAt: now.toISOString(), lines: { ...p.lines, [lineId]: lp } };
  });
}

export const allOverrides = () => read<Record<string, Record<string, string>>>(KEYS.overrides, {});
export const overridesFor = (courseId: string) => allOverrides()[courseId] ?? {};

export function setOverride(courseId: string, epd: string, san: string | null): void {
  const all = allOverrides();
  const o = { ...(all[courseId] ?? {}) };
  if (san) o[epd] = san.replace(/[+#]$/, "");
  else delete o[epd];
  all[courseId] = o;
  write(KEYS.overrides, all);
}

/** Days with at least one graded answer (streak, forecast, dashboard). */
function logActivity(now: Date, grade: Grade): void {
  const log = read<Record<string, number[]>>(KEYS.activity, {});
  const day = now.toISOString().slice(0, 10);
  const row = log[day] ?? [0, 0];
  row[0]++;
  if (grade !== "again") row[1]++;
  log[day] = row;
  write(KEYS.activity, log);
}

export const activityLog = () => read<Record<string, number[]>>(KEYS.activity, {});

/** Re-render on any progress write (this tab) or storage change (other tabs). */
export function useProgressVersion(): number {
  const [v, setV] = useState(0);
  useEffect(() => {
    const bump = () => setV((x) => x + 1);
    window.addEventListener(EVENT, bump);
    window.addEventListener("storage", bump);
    return () => {
      window.removeEventListener(EVENT, bump);
      window.removeEventListener("storage", bump);
    };
  }, []);
  return v;
}
