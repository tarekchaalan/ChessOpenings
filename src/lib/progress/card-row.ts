/** srs_cards (v2) row ↔ CardState: shared by the route handlers and the signed-in client (small, no server deps). */
import type { CardState, Side } from "@/lib/srs/fsrs";

export interface CardRow {
  side: Side;
  epd: string;
  answer_san: string;
  due: string;
  stability: number;
  difficulty: number;
  elapsed_days: number;
  scheduled_days: number;
  learning_steps: number;
  reps: number;
  lapses: number;
  state: number;
  last_review: string | null;
  seen: number;
  correct: number;
  archived: boolean;
  migrated_from: string | null;
  deferred_from: string | null;
  last_course_id: string | null;
  last_line_id: string | null;
}

export const CARD_COLUMNS =
  "side, epd, answer_san, due, stability, difficulty, elapsed_days, scheduled_days, learning_steps, reps, lapses, state, last_review, seen, correct, archived, migrated_from, deferred_from, last_course_id, last_line_id";

export function cardFromRow(r: CardRow): CardState {
  return {
    side: r.side,
    epd: r.epd,
    answer: r.answer_san,
    due: new Date(r.due).toISOString(),
    stability: r.stability,
    difficulty: r.difficulty,
    elapsed_days: r.elapsed_days,
    scheduled_days: r.scheduled_days,
    learning_steps: r.learning_steps,
    reps: r.reps,
    lapses: r.lapses,
    state: r.state,
    last_review: r.last_review ? new Date(r.last_review).toISOString() : null,
    seen: r.seen,
    correct: r.correct,
    ...(r.archived ? { archived: true } : {}),
    ...(r.migrated_from === "sm2" ? { migratedFrom: "sm2" as const } : {}),
    ...(r.deferred_from ? { deferredFrom: new Date(r.deferred_from).toISOString() } : {}),
    ...(r.last_course_id ? { lastCourseId: r.last_course_id } : {}),
    ...(r.last_line_id ? { lastLineId: r.last_line_id } : {}),
  };
}
