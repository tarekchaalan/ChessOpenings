/**
 * Authenticated quiz backend: every challenge is issued and graded by
 * Supabase RPCs so ratings and SRS state can't be forged from the client.
 * Contract mirrors lib/quiz/local.ts exactly.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AnswerResult, Challenge, QuizBackend } from "./types";

interface RpcChallenge {
  id: string;
  sans: string[];
  epd: string;
  ply: number;
  done: boolean;
}

interface RpcAnswer {
  correct: boolean;
  expected: string[];
  best: string;
  rating_delta: number;
  rating: number;
  line_continues: boolean;
  due: string | null;
}

export class RemoteQuizBackend implements QuizBackend {
  kind = "remote" as const;

  constructor(private sb: SupabaseClient) {}

  async issue(openingId: number, side: "white" | "black", prevId: string | null): Promise<Challenge> {
    const { data, error } = await this.sb.rpc("issue_challenge", {
      p_opening_id: openingId,
      p_side: side,
      p_prev: prevId,
    });
    if (error) throw new Error(error.message);
    return data as RpcChallenge;
  }

  async issueReview(openingId: number, epd: string, lineSans: string[]): Promise<Challenge> {
    const { data, error } = await this.sb.rpc("issue_review_challenge", {
      p_opening_id: openingId,
      p_epd: epd,
      p_line: lineSans,
    });
    if (error) throw new Error(error.message);
    return data as RpcChallenge;
  }

  async answer(challengeId: string, san: string, ms: number, usedHint: boolean): Promise<AnswerResult> {
    const { data, error } = await this.sb.rpc("answer_challenge", {
      p_challenge: challengeId,
      p_san: san,
      p_ms: ms,
      p_hint: usedHint,
    });
    if (error) throw new Error(error.message);
    const r = data as RpcAnswer;
    return {
      correct: r.correct,
      expected: r.expected,
      best: r.best,
      ratingDelta: r.rating_delta,
      rating: r.rating,
      lineContinues: r.line_continues,
      due: r.due,
    };
  }
}
