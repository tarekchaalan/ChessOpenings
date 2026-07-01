/** One server- (or engine-) issued quiz position awaiting the user's move. */
export interface Challenge {
  id: string;
  /** SAN moves from the start position, opponent's latest move last */
  sans: string[];
  /** the position the user must answer */
  epd: string;
  ply: number;
  /** no more theory in this line — start a new line instead of answering */
  done: boolean;
}

export interface AnswerResult {
  correct: boolean;
  /** all theory moves that would have been accepted */
  expected: string[];
  /** the most popular expected move (shown as "book answer") */
  best: string;
  ratingDelta: number;
  rating: number;
  /** whether theory continues after the (corrected) move */
  lineContinues: boolean;
  /** next review due for this position, ISO */
  due: string | null;
}

export interface QuizBackend {
  kind: "local" | "remote";
  /** Start or continue a line. Pass the previous challenge id to continue after a correct answer. */
  issue(openingId: number, side: "white" | "black", prevId: string | null): Promise<Challenge>;
  /** Issue a challenge that replays a due SRS card's line (review mode). */
  issueReview(openingId: number, epd: string, lineSans: string[]): Promise<Challenge>;
  answer(challengeId: string, san: string, ms: number, usedHint: boolean): Promise<AnswerResult>;
}
