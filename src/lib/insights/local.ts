/**
 * Guest store for Insights (ADR 0006): linked usernames and game summaries in
 * localStorage key `cot.v2.insights`, never sent anywhere. Also the merge rule
 * both stores use: one row per (platform, gameId), newest first, capped per
 * platform. Reads never throw; writes are best-effort (private mode, quota).
 */
import type { LinkedAccount, Platform, Summary } from "./types";

export const INSIGHTS_KEY = "cot.v2.insights";
/** newest games kept per platform in the browser */
export const GUEST_CAP = 400;

export interface InsightsData {
  accounts: Partial<Record<Platform, LinkedAccount>>;
  games: Summary[];
}

export const EMPTY: InsightsData = { accounts: {}, games: [] };

const key = (s: Pick<Summary, "platform" | "gameId">) => `${s.platform}:${s.gameId}`;

/** Incoming rows replace existing ones with the same id; newest first; at most `cap` per platform. */
export function mergeGames(existing: Summary[], incoming: Summary[], cap: number): Summary[] {
  const byId = new Map(existing.map((s) => [key(s), s]));
  for (const s of incoming) byId.set(key(s), s);
  const all = [...byId.values()].sort((a, b) => b.playedAt.localeCompare(a.playedAt) || key(a).localeCompare(key(b)));
  const per = new Map<Platform, number>();
  return all.filter((s) => {
    const n = (per.get(s.platform) ?? 0) + 1;
    per.set(s.platform, n);
    return n <= cap;
  });
}

export function readLocal(storage: Pick<Storage, "getItem"> | null): InsightsData {
  if (!storage) return EMPTY;
  try {
    const raw = storage.getItem(INSIGHTS_KEY);
    if (!raw) return EMPTY;
    const d = JSON.parse(raw) as InsightsData;
    return d && typeof d === "object" && Array.isArray(d.games) && d.accounts && typeof d.accounts === "object" ? d : EMPTY;
  } catch {
    return EMPTY;
  }
}

export function writeLocal(storage: Pick<Storage, "setItem" | "removeItem"> | null, d: InsightsData): void {
  if (!storage) return;
  try {
    if (!Object.keys(d.accounts).length && !d.games.length) storage.removeItem(INSIGHTS_KEY);
    else storage.setItem(INSIGHTS_KEY, JSON.stringify(d));
  } catch {
    // storage unavailable or full: Insights stays in memory for this visit
  }
}

/** Drop one platform: its account and its games. */
export function withoutPlatform(d: InsightsData, platform: Platform): InsightsData {
  const accounts = { ...d.accounts };
  delete accounts[platform];
  return { accounts, games: d.games.filter((g) => g.platform !== platform) };
}

/** Cross-tab import lock with a TTL (one import per platform at a time). */
export const LOCK_TTL_MS = 3 * 60_000;
export function takeLock(storage: Pick<Storage, "getItem" | "setItem"> | null, platform: Platform, owner: string, now = Date.now()): boolean {
  if (!storage) return true;
  const k = `${INSIGHTS_KEY}.lock.${platform}`;
  try {
    const cur = JSON.parse(storage.getItem(k) ?? "null") as { owner: string; at: number } | null;
    if (cur && cur.owner !== owner && now - cur.at < LOCK_TTL_MS) return false;
    storage.setItem(k, JSON.stringify({ owner, at: now }));
    return true;
  } catch {
    return true;
  }
}
export function releaseLock(storage: Pick<Storage, "getItem" | "removeItem"> | null, platform: Platform, owner: string): void {
  if (!storage) return;
  const k = `${INSIGHTS_KEY}.lock.${platform}`;
  try {
    const cur = JSON.parse(storage.getItem(k) ?? "null") as { owner: string } | null;
    if (!cur || cur.owner === owner) storage.removeItem(k);
  } catch {
    // nothing to release
  }
}
