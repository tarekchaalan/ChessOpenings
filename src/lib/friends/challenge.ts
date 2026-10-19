/**
 * Challenge a friend (spec §2.7, ADR 0007). URLs are built only from the
 * friend's linked username as stored on our side, encoded.
 *
 * Verified 2026-10-19:
 *   - Chess.com /play/{u} redirects to /play/online/new?isInvited=1&opponent={u}.
 *   - Lichess /?user={u}#friend is what Lichess's own "Challenge to a game"
 *     button links to (lila UserShow.scala, UserList.scala).
 */
import { PLATFORM_NAME } from "@/lib/insights/types";
import type { ChallengeTarget, Platform } from "./types";

export function challengeUrl(platform: Platform, username: string): string {
  const u = encodeURIComponent(username);
  return platform === "lichess" ? `https://lichess.org/?user=${u}#friend` : `https://www.chess.com/play/${u}`;
}

/** The fallback when a challenge link stops working: their profile on that site. */
export function platformProfileUrl(platform: Platform, username: string): string {
  const u = encodeURIComponent(username);
  return platform === "lichess" ? `https://lichess.org/@/${u}` : `https://www.chess.com/member/${u}`;
}

export type ChallengePlan =
  | { kind: "none" }
  | { kind: "direct"; target: ChallengeTarget; href: string; label: string }
  | { kind: "choose"; targets: ChallengeTarget[] };

/** None → no button; one platform → straight there; two → ask which. */
export function challengePlan(targets: ChallengeTarget[] | null | undefined): ChallengePlan {
  const list = (targets ?? []).filter((t) => t.their_username);
  if (list.length === 0) return { kind: "none" };
  if (list.length === 1) {
    const t = list[0];
    return { kind: "direct", target: t, href: challengeUrl(t.platform, t.their_username), label: `Challenge on ${PLATFORM_NAME[t.platform]}` };
  }
  return { kind: "choose", targets: list };
}
