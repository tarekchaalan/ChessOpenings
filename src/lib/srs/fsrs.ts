/**
 * FSRS scheduling (ADR 0003), one TS implementation for guest mode and the
 * server route handlers. Cards are keyed (side, EPD, answer SAN) and shared
 * across courses. Grades come from what happened on the board, never from
 * rating buttons.
 */
import { createEmptyCard, fsrs, generatorParameters, Rating, State, type Card, type Grade as FsrsGrade } from "ts-fsrs";

export type Side = "white" | "black";
export type Grade = "again" | "hard" | "good" | "easy";

export interface CardState {
  side: Side;
  epd: string;
  /** normalised SAN (no +/#) */
  answer: string;
  due: string;
  stability: number;
  difficulty: number;
  elapsed_days: number;
  scheduled_days: number;
  learning_steps: number;
  reps: number;
  lapses: number;
  state: State;
  last_review: string | null;
  seen: number;
  correct: number;
  migratedFrom?: "sm2";
  archived?: boolean;
  deferredFrom?: string;
  /** where it was last practised (for "Continue" and grouping) */
  lastCourseId?: string;
  lastLineId?: string;
}

export const DEFAULT_RETENTION = 0.9;
export const MATURE_STABILITY_DAYS = 21;
export const EASY_MS = 2500;

export const cardKey = (side: Side, epd: string, answer: string) => `${side}|${epd}|${answer.replace(/[+#]$/, "")}`;

const schedulers = new Map<number, ReturnType<typeof fsrs>>();
function scheduler(retention: number) {
  let s = schedulers.get(retention);
  if (!s) {
    s = fsrs(generatorParameters({ request_retention: retention, enable_fuzz: true, enable_short_term: true }));
    schedulers.set(retention, s);
  }
  return s;
}

const toCard = (c: CardState): Card => ({
  due: new Date(c.due),
  stability: c.stability,
  difficulty: c.difficulty,
  elapsed_days: c.elapsed_days,
  scheduled_days: c.scheduled_days,
  learning_steps: c.learning_steps,
  reps: c.reps,
  lapses: c.lapses,
  state: c.state,
  last_review: c.last_review ? new Date(c.last_review) : undefined,
});

export function newCard(side: Side, epd: string, answer: string, now = new Date()): CardState {
  const e = createEmptyCard(now);
  return {
    side,
    epd,
    answer: answer.replace(/[+#]$/, ""),
    due: e.due.toISOString(),
    stability: e.stability,
    difficulty: e.difficulty,
    elapsed_days: e.elapsed_days,
    scheduled_days: e.scheduled_days,
    learning_steps: e.learning_steps,
    reps: e.reps,
    lapses: e.lapses,
    state: e.state,
    last_review: null,
    seen: 0,
    correct: 0,
  };
}

const RATING: Record<Grade, FsrsGrade> = { again: Rating.Again, hard: Rating.Hard, good: Rating.Good, easy: Rating.Easy };

export function review(card: CardState, grade: Grade, now = new Date(), retention = DEFAULT_RETENTION): CardState {
  const next = scheduler(retention).next(toCard(card), now, RATING[grade]).card;
  return {
    ...card,
    due: next.due.toISOString(),
    stability: next.stability,
    difficulty: next.difficulty,
    elapsed_days: next.elapsed_days,
    scheduled_days: next.scheduled_days,
    learning_steps: next.learning_steps,
    reps: next.reps,
    lapses: next.lapses,
    state: next.state,
    last_review: now.toISOString(),
    seen: card.seen + 1,
    correct: card.correct + (grade === "again" ? 0 : 1),
    deferredFrom: undefined,
  };
}

export function retrievability(card: CardState, now = new Date(), retention = DEFAULT_RETENTION): number {
  if (card.state === State.New) return 0;
  return scheduler(retention).get_retrievability(toCard(card), now, false) as number;
}

export const isDue = (c: CardState, now = new Date()) => !c.archived && c.state !== State.New && new Date(c.due) <= now;
export const isMature = (c: CardState) => c.stability >= MATURE_STABILITY_DAYS;
export const isNew = (c: CardState) => c.state === State.New;

export interface Outcome {
  /** a book (or accepted extension) move was eventually played */
  correct: boolean;
  /** 0 = none, 1 = idea, 2 = piece, 3 = arrow */
  hintLevel: 0 | 1 | 2 | 3;
  /** wrong moves that were not soft-fails */
  wrongAttempts: number;
  ms: number;
  reps: number;
}

/**
 * Auto-grade (ADR 0003): correct, no hint → Good (Easy if < 2.5 s and the
 * card has ≥ 2 reps); after H1/H2 → Hard; after H3 or any real mistake →
 * Again. Soft-fails don't count as mistakes and never grade by themselves.
 */
export function gradeFor(o: Outcome): Grade {
  if (!o.correct || o.wrongAttempts > 0 || o.hintLevel >= 3) return "again";
  if (o.hintLevel >= 1) return "hard";
  if (o.ms < EASY_MS && o.reps >= 2) return "easy";
  return "good";
}

export { State };
