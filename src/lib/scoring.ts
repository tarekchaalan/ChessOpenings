/**
 * Quiz scoring: every answered position is an Elo-style game against the
 * position's difficulty. Mirrored server-side in plpgsql for authenticated
 * play (the leaderboard rating is only ever written by the server RPC).
 */

export const START_RATING = 800;
export const RATING_FLOOR = 100;
const K = 24;

/**
 * Position difficulty grows with depth into theory and with the rarity of the
 * expected move (rare book moves are harder to know than universal ones).
 */
export function positionDifficulty(ply: number, nodeGames: number, moveGames: number): number {
  const depth = 600 + ply * 55;
  const rarity =
    nodeGames > 0 && moveGames > 0
      ? Math.min(600, Math.round(300 * Math.log10(Math.max(1, nodeGames / moveGames))))
      : 150;
  return Math.min(2800, depth + rarity);
}

export function expectedScore(rating: number, difficulty: number): number {
  return 1 / (1 + Math.pow(10, (difficulty - rating) / 400));
}

/** Speed multiplies the gain (never the loss): instant answers earn full K. */
export function ratingDelta(rating: number, difficulty: number, correct: boolean, ms: number): number {
  const exp = expectedScore(rating, difficulty);
  if (!correct) return Math.round(K * (0 - exp));
  const speed = ms <= 3000 ? 1 : ms >= 20000 ? 0.5 : 1 - (0.5 * (ms - 3000)) / 17000;
  return Math.max(1, Math.round(K * (1 - exp) * speed));
}

export function applyDelta(rating: number, delta: number): number {
  return Math.max(RATING_FLOOR, rating + delta);
}

/** Session summary score used on the results screen (not the leaderboard). */
export function sessionAccuracy(correctCount: number, total: number): number {
  return total === 0 ? 0 : Math.round((correctCount / total) * 100);
}
