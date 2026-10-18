"use client";
/**
 * Signed-in training (ADR 0004): local-first, mirrored to the server.
 *
 * - Every graded answer is applied locally at once (the trainer never waits
 *   on the network), then re-graded by the server through
 *   /api/train/issue + /api/train/answer; the server's card replaces the
 *   local one.
 * - Server grading needs the server's theory to be the client's: when
 *   `dataset_version.hash` ≠ the dataset's outputHash (or the server isn't
 *   reachable / configured), answers stay local-only and a banner says the
 *   session won't count. They are not replayed later: the server can't
 *   re-validate past challenges.
 * - On sign-in: the account's cards are pulled into the local store (a
 *   server card replaces the local one when it was reviewed later), and on
 *   the first v2 sign-in, migrated cards are re-keyed to the learner's course
 *   book moves (/api/train/remap).
 * Guest mode never touches any of this.
 */
import { useEffect, useSyncExternalStore } from "react";
import type { Session } from "@supabase/supabase-js";
import { getSupabase } from "@/lib/supabase/client";
import { currentOutputHash, loadDataset } from "@/lib/dataset-live";
import type { CardState } from "@/lib/srs/fsrs";
import { cardKey } from "@/lib/srs/fsrs";
import { CARD_COLUMNS, cardFromRow, type CardRow } from "@/lib/progress/card-row";
import { KEYS, allCards, allCourseProgress, notifyProgress, putCard } from "@/lib/progress/store";

export type ServerMode = "off" | "checking" | "on" | "mismatch" | "unavailable";

let mode: ServerMode = "off";
const subs = new Set<() => void>();
const setMode = (m: ServerMode) => {
  if (m === mode) return;
  mode = m;
  subs.forEach((f) => f());
};
export const serverMode = () => mode;
const subscribe = (f: () => void) => {
  subs.add(f);
  return () => void subs.delete(f);
};
export function useServerMode(): ServerMode {
  return useSyncExternalStore(subscribe, serverMode, () => "off");
}

async function session(): Promise<Session | null> {
  const sb = getSupabase();
  return sb ? (await sb.auth.getSession()).data.session : null;
}

async function post(path: string, token: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(`/api/train/${path}`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, unknown> };
}

/** Decide the mode for this build and user (called by <ServerSync/>). */
export async function checkServer(outputHash: string, userId: string | null): Promise<ServerMode> {
  const sb = getSupabase();
  if (!sb || !userId) {
    setMode("off");
    return "off";
  }
  setMode("checking");
  const { data, error } = await sb.from("dataset_version").select("hash").maybeSingle();
  // no v2 schema yet (migration not applied) counts as "updating"
  const m: ServerMode = error ? "mismatch" : data?.hash === outputHash ? "on" : "mismatch";
  setMode(m);
  return m;
}

/** Mirror one graded ply to the server (fire-and-forget from the trainer). */
export async function gradeOnServer(a: {
  courseId: string;
  lineId: string;
  sans: string[];
  expected: string;
  outcome: { san: string; hintLevel: number; wrongAttempts: number; ms: number };
  retention: number;
}): Promise<void> {
  if (mode !== "on") return;
  const s = await session();
  if (!s) return;
  try {
    const iss = await post("issue", s.access_token, { courseId: a.courseId, lineId: a.lineId, sans: a.sans, expected: a.expected });
    if (iss.status === 503) return setMode("unavailable");
    if (iss.status !== 200) return console.warn("[train] issue rejected:", iss.json.message);
    const ans = await post("answer", s.access_token, { challengeId: iss.json.challengeId, ...a.outcome, retention: a.retention });
    if (ans.status !== 200) return console.warn("[train] answer rejected:", ans.json.message);
    // the server's card replaces ours unless ours is further along (built in guest
    // mode or while the server was updating: the server re-graded it from scratch)
    const srv = ans.json.card as CardState;
    const mine = allCards()[cardKey(srv.side, srv.epd, srv.answer)];
    if (!mine || srv.reps >= mine.reps) putCard(srv);
  } catch (e) {
    console.warn("[train] server grading failed:", e);
    setMode("unavailable");
  }
}

/** Mirror the daily cap's deferrals (later only, ≤ 7 days: enforced server-side). */
export async function deferOnServer(cards: CardState[]): Promise<void> {
  if (mode !== "on" || !cards.length) return;
  const s = await session();
  if (!s) return;
  await post("defer", s.access_token, { cards: cards.map((c) => ({ side: c.side, epd: c.epd, answer: c.answer, due: c.due })) }).catch(() => undefined);
}

/** Pull the account's cards (paged: PostgREST caps a response): a server card wins when it was reviewed later (or is missing locally). */
export async function pullCards(userId: string): Promise<number> {
  const sb = getSupabase();
  if (!sb) return 0;
  const PAGE = 1000;
  const rows: CardRow[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb.from("srs_cards").select(CARD_COLUMNS).eq("user_id", userId).order("epd").order("side").order("answer_san").range(from, from + PAGE - 1);
    if (error || !data) return 0;
    rows.push(...(data as unknown as CardRow[]));
    if (data.length < PAGE) break;
  }
  const local = allCards();
  let n = 0;
  for (const row of rows) {
    const c = cardFromRow(row);
    const k = cardKey(c.side, c.epd, c.answer);
    const mine = local[k];
    if (!mine || (c.last_review ?? "") > (mine.last_review ?? "")) {
      local[k] = c;
      n++;
    }
  }
  if (n) {
    try {
      localStorage.setItem(KEYS.cards, JSON.stringify(local));
    } catch {
      // storage full: the server copy stays authoritative
    }
    notifyProgress();
  }
  return n;
}

const remapKey = (userId: string) => `cot.v2.remapped.${userId}`;

/**
 * First v2 sign-in: re-key migrated server cards to this learner's book moves
 * (the server migration had no course logic). The courses: the account's
 * server course_progress and its migrated cards' courses, plus the local
 * enrolled ones. Once per account per browser, and only marked done when it
 * actually ran.
 */
export async function remapOnce(userId: string): Promise<number> {
  if (mode !== "on" || localStorage.getItem(remapKey(userId))) return 0;
  const sb = getSupabase();
  const s = await session();
  if (!sb || !s) return 0;
  const { count, error } = await sb.from("srs_cards").select("epd", { count: "exact", head: true }).eq("user_id", userId).eq("migrated_from", "sm2");
  if (error) return 0;
  let n = 0;
  if (count) {
    const [cp, lc] = await Promise.all([
      sb.from("course_progress").select("course_id").eq("user_id", userId),
      sb.from("srs_cards").select("last_course_id").eq("user_id", userId).eq("migrated_from", "sm2").not("last_course_id", "is", null).limit(1000),
    ]);
    const ids = new Set<string>(enrolledCourseIds());
    for (const r of (cp.data ?? []) as { course_id: string }[]) ids.add(r.course_id);
    for (const r of (lc.data ?? []) as { last_course_id: string }[]) ids.add(r.last_course_id);
    if (!ids.size) return 0; // nothing to map to yet: try again next sign-in
    const [{ bookMovesOf }, ds] = await Promise.all([import("@/lib/remap-moves"), loadDataset()]);
    const moves = bookMovesOf(ds, [...ids]).slice(0, 5000);
    if (!moves.length) return 0;
    const r = await post("remap", s.access_token, { moves });
    if (r.status !== 200) return 0; // retry next sign-in
    n = Number(r.json.remapped ?? 0);
  }
  localStorage.setItem(remapKey(userId), new Date().toISOString());
  return n;
}

/** The enrolled courses (any courseProgress entry), for the remap. */
export const enrolledCourseIds = () => Object.keys(allCourseProgress());

/**
 * <ServerSync/> helper: once per signed-in user. Only the build's hash is
 * needed to check the server; the dataset itself loads only for the one-time
 * remap, and only when the account has migrated cards.
 */
export function useServerSync(userId: string | null): void {
  useEffect(() => {
    let alive = true;
    (async () => {
      const m = await checkServer(await currentOutputHash(), userId);
      if (!alive || m !== "on" || !userId) return;
      await remapOnce(userId);
      if (!alive) return;
      await pullCards(userId);
      // deferrals made before the check finished (or offline) reach the server now
      const now = Date.now();
      await deferOnServer(Object.values(allCards()).filter((c) => c.deferredFrom && new Date(c.due).getTime() > now));
    })().catch((e) => console.warn("[train] sync failed:", e));
    return () => {
      alive = false;
    };
  }, [userId]);
}
