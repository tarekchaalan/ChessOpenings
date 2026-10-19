"use client";
/**
 * Insights state for the page and Settings (ADR 0006): one store for guests
 * (localStorage) and signed-in players (Supabase rows read under RLS, writes
 * through /api/insights/*). Games are fetched by the browser, summarised here
 * and only the summaries are kept.
 */
import { useEffect, useSyncExternalStore } from "react";
import { loadDataset } from "@/lib/dataset-live";
import { modelOf } from "@/lib/courses-client";
import { getSupabase } from "@/lib/supabase/client";
import { fromRow, type GameRow } from "@/lib/server/insights";
import { maxBookPly } from "./book";
import { fetchGames, InsightsFetchError, lookupProfile, type FetchProgress, type FetchResult, type Profile } from "./fetch";
import { DEFAULT_SCOPE, type ImportScope } from "./filter";
import { EMPTY, GUEST_CAP, INSIGHTS_KEY, mergeGames, readLocal, releaseLock, takeLock, withoutPlatform, writeLocal, type InsightsData } from "./local";
import { rematch, summarize } from "./summarize";
import { PLATFORM_NAME, type LinkedAccount, type Platform, type Summary } from "./types";

export const STALE_MS = 24 * 3_600_000;
const SYNC_CHUNK = 200;
const SCOPE_KEY = `${INSIGHTS_KEY}.bullet`;
const SERVER_CAP = 1000;

export interface InsightsStatus {
  phase: "idle" | "loading" | "syncing" | "error";
  platform?: Platform;
  progress?: FetchProgress;
  message?: string;
  /** last import: new games kept and games skipped by reason */
  last?: { platform: Platform; added: number; skipped: FetchResult["skipped"] };
}

interface State {
  /** null = guest */
  userId: string | null;
  loaded: boolean;
  data: InsightsData;
  status: InsightsStatus;
  /** signed-in only: the server answered 503 / the tables don't exist; Insights stays local */
  serverless: boolean;
}

let state: State = { userId: null, loaded: false, data: EMPTY, status: { phase: "idle" }, serverless: false };
const subs = new Set<() => void>();
const set = (patch: Partial<State>) => {
  state = { ...state, ...patch };
  subs.forEach((f) => f());
};
const subscribe = (f: () => void) => {
  subs.add(f);
  return () => void subs.delete(f);
};
const SERVER_SNAPSHOT: State = { userId: null, loaded: false, data: EMPTY, status: { phase: "idle" }, serverless: false };

const storage = (): Storage | null => {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
};
const tabId = Math.random().toString(36).slice(2);

export function readScope(): ImportScope {
  let bullet = false;
  try {
    bullet = storage()?.getItem(SCOPE_KEY) === "1";
  } catch {
    bullet = false;
  }
  return bullet ? { ...DEFAULT_SCOPE, timeClasses: ["bullet", ...DEFAULT_SCOPE.timeClasses] } : DEFAULT_SCOPE;
}
export function setIncludeBullet(on: boolean): void {
  try {
    if (on) storage()?.setItem(SCOPE_KEY, "1");
    else storage()?.removeItem(SCOPE_KEY);
  } catch {
    // a per-browser convenience only
  }
  subs.forEach((f) => f());
}

async function token(): Promise<string | null> {
  const sb = getSupabase();
  return sb ? (await sb.auth.getSession()).data.session?.access_token ?? null : null;
}

async function post(action: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const t = await token();
  if (!t) return { status: 401, json: { message: "Sign in again to save Insights." } };
  const r = await fetch(`/api/insights/${action}`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${t}` }, body: JSON.stringify(body) });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, unknown> };
}

const signedIn = () => state.userId !== null && !state.serverless;

function persist(data: InsightsData) {
  if (!signedIn()) writeLocal(storage(), data);
  set({ data });
}

// ── loading ─────────────────────────────────────────────────────────────────

async function loadServer(): Promise<InsightsData | null> {
  const sb = getSupabase();
  if (!sb) return null;
  const acc = await sb.from("linked_accounts").select("platform, username, verified, ratings, linked_at, last_synced_at, last_game_at");
  if (acc.error) return null;
  const accounts: InsightsData["accounts"] = {};
  for (const a of acc.data as { platform: Platform; username: string; verified: boolean; ratings: LinkedAccount["ratings"]; linked_at: string; last_synced_at: string | null; last_game_at: string | null }[]) {
    accounts[a.platform] = { platform: a.platform, username: a.username, verified: a.verified, ratings: a.ratings ?? {}, linkedAt: a.linked_at, lastSyncedAt: a.last_synced_at, lastGameAt: a.last_game_at };
  }
  const games: Summary[] = [];
  // PostgREST caps a response: page through
  for (let from = 0; ; from += 1000) {
    const page = await sb.from("game_summaries").select("*").order("played_at", { ascending: false }).range(from, from + 999);
    if (page.error) return null;
    games.push(...(page.data as GameRow[]).map(fromRow));
    if (page.data.length < 1000) break;
  }
  return { accounts, games };
}

let loading: { userId: string | null; done: Promise<void> } | null = null;

/** Load (or reload) for this user; re-matches summaries made on an older dataset. */
export function loadInsights(userId: string | null): Promise<void> {
  if (loading && loading.userId === userId) return loading.done;
  const done = load(userId).finally(() => {
    if (loading?.done === done) loading = null;
  });
  loading = { userId, done };
  return done;
}

async function load(userId: string | null): Promise<void> {
  set({ userId, loaded: false, status: { phase: "loading" }, serverless: false });
  let data: InsightsData = EMPTY;
  if (userId) {
    const server = await loadServer();
    if (server) data = server;
    else set({ serverless: true });
  }
  if (!userId || state.serverless) data = readLocal(storage());
  if (state.userId !== userId) return; // the user changed meanwhile
  set({ data, loaded: true, status: { phase: "idle" } });
  await rematchAll();
}

async function rematchAll(): Promise<void> {
  const ds = await loadDataset();
  const hash = ds.outputHash ?? "";
  const stale = state.data.games.filter((g) => g.datasetHash !== hash);
  if (!stale.length) return;
  const model = modelOf(ds);
  const n = maxBookPly(model);
  const fresh = stale.map((g) => rematch(model, g, hash, n));
  persist({ ...state.data, games: mergeGames(state.data.games, fresh, signedIn() ? SERVER_CAP : GUEST_CAP) });
  if (signedIn()) {
    for (const p of ["lichess", "chesscom"] as const) {
      const rows = fresh.filter((g) => g.platform === p);
      for (let i = 0; i < rows.length; i += SYNC_CHUNK) await post("sync", { platform: p, games: rows.slice(i, i + SYNC_CHUNK) });
    }
  }
}

// ── actions ─────────────────────────────────────────────────────────────────

export async function checkUsername(platform: Platform, username: string): Promise<Profile> {
  return lookupProfile(platform, username);
}

/** Link (or re-link) a platform username; a different username replaces the old one's games. */
export async function linkAccount(p: Profile): Promise<boolean> {
  const old = state.data.accounts[p.platform];
  const same = old && old.username.toLowerCase() === p.username.toLowerCase();
  const account: LinkedAccount = {
    platform: p.platform,
    username: p.username,
    verified: false,
    ratings: p.ratings,
    linkedAt: same ? old!.linkedAt : new Date().toISOString(),
    lastSyncedAt: same ? old!.lastSyncedAt : null,
    lastGameAt: same ? old!.lastGameAt : null,
  };
  if (signedIn()) {
    const r = await post("link", { platform: p.platform, username: p.username, ratings: p.ratings });
    if (r.status !== 200) {
      set({ status: { phase: "error", platform: p.platform, message: String(r.json.message ?? `Couldn't link the account (${r.status}).`) } });
      return false;
    }
  }
  const base = same ? state.data : withoutPlatform(state.data, p.platform);
  persist({ ...base, accounts: { ...base.accounts, [p.platform]: account } });
  return true;
}

export async function unlinkAccount(platform: Platform): Promise<void> {
  if (signedIn()) {
    const r = await post("unlink", { platform });
    if (r.status !== 200) {
      set({ status: { phase: "error", platform, message: String(r.json.message ?? `Couldn't unlink (${r.status}).`) } });
      return;
    }
  }
  persist(withoutPlatform(state.data, platform));
  set({ status: { phase: "idle" } });
}

let aborter: AbortController | null = null;
export function cancelSync(): void {
  aborter?.abort();
}

/** Import new games for one linked platform (incremental: only games after the newest one we have). */
export async function syncAccount(platform: Platform): Promise<void> {
  const account = state.data.accounts[platform];
  if (!account || state.status.phase === "syncing") return;
  const st = storage();
  if (!takeLock(st, platform, tabId)) {
    set({ status: { phase: "error", platform, message: `An import from ${PLATFORM_NAME[platform]} is already running in another tab.` } });
    return;
  }
  aborter = new AbortController();
  set({ status: { phase: "syncing", platform, progress: { read: 0, kept: 0, fraction: 0, label: "Starting" } } });
  try {
    const ds = await loadDataset();
    const model = modelOf(ds);
    const n = maxBookPly(model);
    const hash = ds.outputHash ?? "";
    const profile = await lookupProfile(platform, account.username).catch(() => null);
    const res = await fetchGames(platform, {
      username: account.username,
      scope: readScope(),
      since: account.lastGameAt ? new Date(account.lastGameAt) : null,
      signal: aborter.signal,
      onProgress: (progress) => set({ status: { phase: "syncing", platform, progress } }),
    });
    const known = new Set(state.data.games.filter((g) => g.platform === platform).map((g) => g.gameId));
    const summaries = res.games.map((g) => summarize(model, g, hash, n)).filter((s): s is Summary => !!s);
    const added = summaries.filter((s) => !known.has(s.gameId)).length;
    const ratings = profile?.ratings ?? account.ratings;
    if (signedIn()) {
      for (let i = 0; i < Math.max(1, summaries.length); i += SYNC_CHUNK) {
        const r = await post("sync", { platform, ratings, games: summaries.slice(i, i + SYNC_CHUNK) });
        if (r.status !== 200) throw new InsightsFetchError("bad-response", platform, String(r.json.message ?? `Couldn't save the import (${r.status}).`));
      }
    }
    const newest = [account.lastGameAt, ...summaries.map((s) => s.playedAt)].filter((x): x is string => !!x).sort().pop() ?? null;
    const cur = state.data;
    persist({
      accounts: { ...cur.accounts, [platform]: { ...account, ratings, lastSyncedAt: new Date().toISOString(), lastGameAt: newest } },
      games: mergeGames(cur.games, summaries, signedIn() ? SERVER_CAP : GUEST_CAP),
    });
    set({ status: { phase: "idle", last: { platform, added, skipped: res.skipped } } });
  } catch (e) {
    if ((e as Error)?.name === "AbortError") set({ status: { phase: "idle" } });
    else set({ status: { phase: "error", platform, message: e instanceof InsightsFetchError ? e.message : "The import failed. Try again." } });
  } finally {
    releaseLock(st, platform, tabId);
    aborter = null;
  }
}

/** Sync every linked platform whose last sync is older than STALE_MS. */
export async function syncStale(now = Date.now()): Promise<void> {
  for (const a of Object.values(state.data.accounts)) {
    if (!a) continue;
    if (!a.lastSyncedAt || now - Date.parse(a.lastSyncedAt) > STALE_MS) await syncAccount(a.platform);
  }
}

/** Guest insights in this browser, for "Save to your account" after signing in. */
export function guestData(): InsightsData {
  return readLocal(storage());
}

export async function saveGuestToAccount(): Promise<void> {
  const guest = guestData();
  if (!signedIn()) return;
  for (const a of Object.values(guest.accounts)) {
    if (!a) continue;
    const ok = await linkAccount({ platform: a.platform, username: a.username, ratings: a.ratings });
    if (!ok) return;
    const rows = guest.games.filter((g) => g.platform === a.platform);
    for (let i = 0; i < rows.length; i += SYNC_CHUNK) await post("sync", { platform: a.platform, ratings: a.ratings, games: rows.slice(i, i + SYNC_CHUNK) });
  }
  writeLocal(storage(), EMPTY);
  await loadInsights(state.userId);
}

export function clearGuest(): void {
  writeLocal(storage(), EMPTY);
  if (!signedIn()) set({ data: EMPTY, status: { phase: "idle" } });
}

export function useInsights(userId: string | null, authLoading: boolean): State {
  const s = useSyncExternalStore(subscribe, () => state, () => SERVER_SNAPSHOT);
  useEffect(() => {
    if (authLoading) return;
    if (!state.loaded || state.userId !== userId) void loadInsights(userId);
  }, [userId, authLoading]);
  return s;
}
