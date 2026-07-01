/**
 * Server-side progress reads for signed-in users. All writes happen inside
 * the quiz RPCs (see supabase/migrations) — the client only ever reads.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { START_RATING } from "@/lib/scoring";
import type { SrsCard } from "@/lib/srs";
import type { Attempt, OpeningProgress, ProgressReader, ProgressSummary } from "./types";

export function remoteReader(sb: SupabaseClient, userId: string): ProgressReader {
  return {
    kind: "remote",
    async summary(): Promise<ProgressSummary> {
      const [profileQ, progressQ, attemptsQ, dueQ, streakQ] = await Promise.all([
        sb.from("profiles").select("rating, attempts, correct").eq("id", userId).single(),
        sb
          .from("opening_progress")
          .select("opening_id, seen, correct, streak, best_streak, mastery, updated_at")
          .eq("user_id", userId)
          .order("updated_at", { ascending: false }),
        sb
          .from("quiz_attempts")
          .select("opening_id, epd, san, correct, ms, rating_before, rating_after, created_at")
          .eq("user_id", userId)
          .order("created_at", { ascending: false })
          .limit(20),
        sb
          .from("srs_cards")
          .select("epd", { count: "exact", head: true })
          .eq("user_id", userId)
          .lte("due", new Date().toISOString()),
        sb.rpc("daily_streak"),
      ]);

      const perOpening: OpeningProgress[] = (progressQ.data ?? []).map((p) => ({
        openingId: p.opening_id,
        seen: p.seen,
        correct: p.correct,
        streak: p.streak,
        bestStreak: p.best_streak,
        mastery: Number(p.mastery),
        updatedAt: p.updated_at,
      }));
      const recentAttempts: Attempt[] = (attemptsQ.data ?? []).map((a) => ({
        openingId: a.opening_id,
        epd: a.epd,
        san: a.san,
        correct: a.correct,
        ms: a.ms,
        ratingBefore: a.rating_before,
        ratingAfter: a.rating_after,
        at: a.created_at,
      }));
      return {
        rating: profileQ.data?.rating ?? START_RATING,
        attempts: profileQ.data?.attempts ?? 0,
        correct: profileQ.data?.correct ?? 0,
        dailyStreak: (streakQ.data as number) ?? 0,
        dueCount: dueQ.count ?? 0,
        perOpening,
        recentAttempts,
      };
    },
    async cards(): Promise<SrsCard[]> {
      const { data } = await sb
        .from("srs_cards")
        .select("opening_id, epd, line_san, ease, interval_days, reps, lapses, due, seen, correct")
        .eq("user_id", userId);
      return (data ?? []).map((c) => ({
        openingId: c.opening_id,
        epd: c.epd,
        lineSans: c.line_san,
        ease: Number(c.ease),
        intervalDays: Number(c.interval_days),
        reps: c.reps,
        lapses: c.lapses,
        due: c.due,
        seen: c.seen,
        correct: c.correct,
      }));
    },
  };
}
