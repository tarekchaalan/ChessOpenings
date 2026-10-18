/**
 * TrainDb over Supabase (service role, server only). Every call is scoped to
 * the user id the route handler took from the verified JWT.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { CARD_COLUMNS, cardFromRow, type CardRow } from "@/lib/progress/card-row";
import { GRADE_NUM, type ChallengeRow, type TrainDb } from "./train";

export { CARD_COLUMNS, cardFromRow };

function check<T>(res: { data: T; error: { message: string } | null }): T {
  if (res.error) throw new Error(res.error.message);
  return res.data;
}

export function supabaseTrainDb(admin: SupabaseClient): TrainDb {
  return {
    async walk(sans) {
      return check(await admin.rpc("train_walk", { p_sans: sans })) ?? [];
    },
    async edgesFrom(epd) {
      return check(await admin.from("theory_edges").select("san, games, is_ext").eq("from_epd", epd)) ?? [];
    },
    async challengesSince(userId, since) {
      const res = await admin.from("train_challenges").select("id", { count: "exact", head: true }).eq("user_id", userId).gte("issued_at", since.toISOString());
      if (res.error) throw new Error(res.error.message);
      return res.count ?? 0;
    },
    async insertChallenge(c) {
      return (check(await admin.from("train_challenges").insert(c).select("id").single()) as { id: string }).id;
    },
    async getChallenge(userId, id) {
      return check(await admin.from("train_challenges").select("*").eq("id", id).eq("user_id", userId).maybeSingle()) as ChallengeRow | null;
    },
    async getCard(userId, side, epd, answer) {
      const row = check(await admin.from("srs_cards").select(CARD_COLUMNS).eq("user_id", userId).eq("side", side).eq("epd", epd).eq("answer_san", answer).maybeSingle());
      return row ? cardFromRow(row as unknown as CardRow) : null;
    },
    async commit(a) {
      const c = a.card;
      return check(
        await admin.rpc("train_commit", {
          p_user: a.userId,
          p_challenge: a.challengeId,
          p_san: a.san,
          p_correct: a.correct,
          p_grade: GRADE_NUM[a.grade],
          p_hint: a.hintLevel,
          p_ms: a.ms,
          p_card: {
            due: c.due,
            stability: c.stability,
            difficulty: c.difficulty,
            elapsed_days: c.elapsed_days,
            scheduled_days: c.scheduled_days,
            learning_steps: c.learning_steps,
            reps: c.reps,
            lapses: c.lapses,
            state: c.state,
            last_review: c.last_review,
            seen: c.seen,
            correct: c.correct,
          },
        })
      ) as { rating: number; rating_delta: number } | null;
    },
    async defer(userId, cards) {
      return check(await admin.rpc("train_defer", { p_user: userId, p_cards: cards })) as number;
    },
    async remap(userId, moves) {
      return check(await admin.rpc("train_remap", { p_user: userId, p_moves: moves })) as number;
    },
    async upsertProgress(userId, row) {
      check(await admin.from("course_progress").upsert({ user_id: userId, ...row, updated_at: new Date().toISOString() }, { onConflict: "user_id,course_id" }));
    },
  };
}
