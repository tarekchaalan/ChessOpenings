/**
 * Server grading for signed-in users (ADR 0004, option B): the /api/train/*
 * route handlers' logic, behind a small Db interface (Supabase in
 * production, an in-memory fake in the unit tests).
 *
 * Anti-forge, as in v1: the client proposes the line and its book move, but
 * every ply must be a stored edge (named theory, or an extension edge where
 * flagged), the side is derived from the position, challenges are
 * single-use, expire after 5 minutes and are rate-limited, and the grade,
 * the FSRS state and the Elo update are computed here and in train_commit —
 * never accepted from the client.
 */
import { gradeFor, newCard, review, type CardState, type Grade, type Side } from "@/lib/srs/fsrs";
import { normSan } from "@/lib/openings-build/model";
import { START_EPD } from "@/lib/openings-build/replay";

export const CHALLENGE_TTL_MS = 5 * 60_000;
export const RATE_LIMIT_PER_MIN = 60;
const MAX_PLIES = 120;

export interface WalkRow {
  ply: number;
  from_epd: string;
  san: string;
  to_epd: string;
  is_ext: boolean;
}
export interface EdgeInfo {
  san: string;
  games: number;
  is_ext: boolean;
}
export interface ChallengeRow {
  id: string;
  user_id: string;
  course_id: string;
  line_id: string | null;
  side: Side;
  sans: string[];
  epd: string;
  expected: string;
  ext: boolean;
  cap_epd: string | null;
  cap_ply: number | null;
  answered: boolean;
  issued_at: string;
}
export type NewChallenge = Omit<ChallengeRow, "id" | "answered" | "issued_at">;

export interface CommitArgs {
  userId: string;
  challengeId: string;
  san: string;
  correct: boolean;
  grade: Grade;
  hintLevel: number;
  ms: number;
  card: CardState;
}

export interface TrainDb {
  walk(sans: string[]): Promise<WalkRow[]>;
  edgesFrom(epd: string): Promise<EdgeInfo[]>;
  challengesSince(userId: string, since: Date): Promise<number>;
  insertChallenge(c: NewChallenge): Promise<string>;
  getChallenge(userId: string, id: string): Promise<ChallengeRow | null>;
  getCard(userId: string, side: Side, epd: string, answer: string): Promise<CardState | null>;
  /** train_commit: null when the challenge can't be claimed (used, expired) */
  commit(a: CommitArgs): Promise<{ rating: number; rating_delta: number } | null>;
  defer(userId: string, cards: { side: Side; epd: string; answer: string; due: string }[]): Promise<number>;
  remap(userId: string, moves: { epd: string; answer: string }[]): Promise<number>;
  upsertProgress(userId: string, row: { course_id: string; mastery: number; last_line_id: string | null }): Promise<void>;
}

export interface Result {
  status: number;
  body: Record<string, unknown>;
}

const bad = (message: string, status = 400): Result => ({ status, body: { message } });
const isStr = (x: unknown, max = 200): x is string => typeof x === "string" && x.length > 0 && x.length <= max;
const COURSE_ID = /^[a-z0-9~-]{1,80}\/[a-z0-9~-]{1,80}@(white|black)$/;
const SAN = /^[A-Za-z0-9=+#-]{1,10}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const GRADE_NUM: Record<Grade, number> = { again: 1, hard: 2, good: 3, easy: 4 };
const sideOf = (epd: string): Side => (epd.split(" ")[1] === "b" ? "black" : "white");
const int = (x: unknown, lo: number, hi: number, dflt: number) => (typeof x === "number" && Number.isFinite(x) ? Math.round(Math.min(hi, Math.max(lo, x))) : dflt);

/** POST /api/train/issue {courseId, lineId?, sans, expected} → {challengeId, epd, side} */
export async function issue(db: TrainDb, userId: string, body: unknown, now = new Date()): Promise<Result> {
  const b = (body ?? {}) as Record<string, unknown>;
  if (!isStr(b.courseId) || !COURSE_ID.test(b.courseId)) return bad("courseId");
  if (b.lineId != null && !isStr(b.lineId, 64)) return bad("lineId");
  if (!Array.isArray(b.sans) || b.sans.length > MAX_PLIES || !b.sans.every((s) => isStr(s, 10) && SAN.test(s))) return bad("sans");
  if (!isStr(b.expected, 10) || !SAN.test(b.expected)) return bad("expected");
  const sans = b.sans as string[];

  if ((await db.challengesSince(userId, new Date(now.getTime() - 60_000))) >= RATE_LIMIT_PER_MIN) return bad("rate limited", 429);

  // every ply must be a stored edge; the side comes from the position reached
  const walk = sans.length ? await db.walk(sans) : [];
  if (walk.length !== sans.length) return bad(`ply ${walk.length + 1} is not in the stored tree`);
  const epd = walk.length ? walk[walk.length - 1].to_epd : START_EPD;
  const side = sideOf(epd);
  if (!b.courseId.endsWith(`@${side}`)) return bad("not this course's move");

  // the claimed book move must be a stored edge here
  const edge = (await db.edgesFrom(epd)).find((e) => normSan(e.san) === normSan(b.expected as string));
  if (!edge) return bad("expected is not a stored move at this position");

  // ext challenges: difficulty capped at the last named-theory position on the line
  const firstExt = walk.findIndex((w) => w.is_ext);
  const capPly = firstExt === -1 ? walk.length : firstExt;
  const capEpd = capPly === 0 ? START_EPD : walk[capPly - 1].to_epd;

  const id = await db.insertChallenge({
    user_id: userId,
    course_id: b.courseId,
    line_id: (b.lineId as string | undefined) ?? null,
    side,
    sans,
    epd,
    // cards are keyed by the normalised SAN (no +/#), like the client and the migration
    expected: normSan(edge.san),
    ext: edge.is_ext,
    cap_epd: edge.is_ext ? capEpd : null,
    cap_ply: edge.is_ext ? capPly : null,
  });
  return { status: 200, body: { challengeId: id, epd, side } };
}

/**
 * POST /api/train/answer {challengeId, san, wrongAttempts, hintLevel, ms, retention?}
 * → {grade, card, rating, ratingDelta}. `san` is the move that resolved the
 * ply ("" after H3); a real mistake or H3 grades Again (ADR 0003).
 */
export async function answer(db: TrainDb, userId: string, body: unknown, now = new Date()): Promise<Result> {
  const b = (body ?? {}) as Record<string, unknown>;
  if (!isStr(b.challengeId, 64) || !UUID.test(b.challengeId)) return bad("challengeId");
  if (typeof b.san !== "string" || b.san.length > 10) return bad("san");
  const ch = await db.getChallenge(userId, b.challengeId);
  if (!ch) return bad("unknown challenge", 404);
  if (ch.answered) return bad("already answered", 409);
  if (now.getTime() - new Date(ch.issued_at).getTime() > CHALLENGE_TTL_MS) return bad("challenge expired", 410);

  const hintLevel = int(b.hintLevel, 0, 3, 0) as 0 | 1 | 2 | 3;
  const wrongAttempts = int(b.wrongAttempts, 0, 50, 0);
  const ms = int(b.ms, 0, 600_000, 0);
  const retention = typeof b.retention === "number" && b.retention >= 0.8 && b.retention <= 0.97 ? b.retention : 0.9;
  const answerSan = normSan(ch.expected);
  const correct = b.san !== "" && normSan(b.san) === answerSan;

  const card = (await db.getCard(userId, ch.side, ch.epd, answerSan)) ?? newCard(ch.side, ch.epd, answerSan, now);
  const grade = gradeFor({ correct, hintLevel, wrongAttempts, ms, reps: card.reps });
  const next: CardState = { ...review(card, grade, now, retention), lastCourseId: ch.course_id, ...(ch.line_id ? { lastLineId: ch.line_id } : {}), archived: false };
  const res = await db.commit({ userId, challengeId: ch.id, san: b.san, correct: grade !== "again", grade, hintLevel, ms, card: next });
  if (!res) return bad("challenge expired or already used", 409);
  return { status: 200, body: { grade, card: next, rating: res.rating, ratingDelta: res.rating_delta } };
}

/** POST /api/train/defer {cards: [{side, epd, answer, due}]}: later only, ≤ 7 days (enforced in SQL too). */
export async function defer(db: TrainDb, userId: string, body: unknown): Promise<Result> {
  const cards = (body as { cards?: unknown })?.cards;
  if (!Array.isArray(cards) || cards.length > 1000) return bad("cards");
  const ok = cards.every((c) => c && (c.side === "white" || c.side === "black") && isStr(c.epd, 100) && isStr(c.answer, 10) && isStr(c.due, 40) && !Number.isNaN(Date.parse(c.due)));
  if (!ok) return bad("cards");
  return { status: 200, body: { deferred: await db.defer(userId, cards) } };
}

/** POST /api/train/remap {moves: [{epd, answer}]}: migrated cards → the learner's book moves. */
export async function remap(db: TrainDb, userId: string, body: unknown): Promise<Result> {
  const moves = (body as { moves?: unknown })?.moves;
  if (!Array.isArray(moves) || moves.length > 5000 || !moves.every((m) => m && isStr(m.epd, 100) && isStr(m.answer, 10) && SAN.test(m.answer))) return bad("moves");
  return { status: 200, body: { remapped: await db.remap(userId, moves.map((m) => ({ epd: m.epd, answer: normSan(m.answer) }))) } };
}

/** POST /api/train/progress {courseId, mastery, lastLineId}: display-only, never feeds the leaderboard. */
export async function progress(db: TrainDb, userId: string, body: unknown): Promise<Result> {
  const b = (body ?? {}) as Record<string, unknown>;
  if (!isStr(b.courseId) || !COURSE_ID.test(b.courseId)) return bad("courseId");
  if (typeof b.mastery !== "number" || !(b.mastery >= 0 && b.mastery <= 1)) return bad("mastery");
  if (b.lastLineId != null && !isStr(b.lastLineId, 64)) return bad("lastLineId");
  await db.upsertProgress(userId, { course_id: b.courseId, mastery: b.mastery, last_line_id: (b.lastLineId as string | undefined) ?? null });
  return { status: 200, body: { ok: true } };
}
