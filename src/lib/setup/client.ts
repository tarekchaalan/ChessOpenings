"use client";
/**
 * Player setup state (ADR 0008): the signed-in player's onboarding answers
 * (get_setup / save_setup in 0009), the estimate computed live from their
 * linked accounts, and the level everything personalises from.
 */
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { getSupabase } from "@/lib/supabase/client";
import { useAuth } from "@/lib/supabase/AuthProvider";
import { useInsights } from "@/lib/insights/client";
import type { LinkedAccount, Platform } from "@/lib/insights/types";
import { estimateElo, type Estimate, type SelfLevel } from "@/lib/rating/estimate";
import { levelOf, type PlayerLevel } from "@/lib/rating/level";

export interface Setup {
  completed_at: string | null;
  skipped: boolean;
  self_level: SelfLevel | null;
  estimated_elo: number | null;
  estimate: Record<string, unknown>;
  updated_at: string;
}

interface State {
  userId: string | null;
  loaded: boolean;
  /** null = no row yet: show the setup modal */
  setup: Setup | null;
  /** the modal was asked for (Settings → "Run setup again") */
  open: boolean;
  /** get_setup failed (e.g. the migration isn't applied): never block the app on it */
  unavailable: boolean;
}

let state: State = { userId: null, loaded: false, setup: null, open: false, unavailable: false };
const subs = new Set<() => void>();
const set = (patch: Partial<State>) => {
  state = { ...state, ...patch };
  subs.forEach((f) => f());
};
const subscribe = (f: () => void) => {
  subs.add(f);
  return () => void subs.delete(f);
};
const SERVER: State = { userId: null, loaded: false, setup: null, open: false, unavailable: false };

let loading: Promise<void> | null = null;
export function loadSetup(userId: string | null): Promise<void> {
  if (state.loaded && state.userId === userId) return Promise.resolve();
  if (loading && state.userId === userId) return loading;
  set({ userId, loaded: false, setup: null, unavailable: false });
  const sb = getSupabase();
  if (!userId || !sb) {
    set({ loaded: true });
    return Promise.resolve();
  }
  loading = (async () => {
    const { data, error } = await sb.rpc("get_setup");
    if (state.userId !== userId) return;
    if (error) set({ loaded: true, unavailable: true });
    else set({ loaded: true, setup: (data as Setup | null) ?? null });
  })().finally(() => {
    loading = null;
  });
  return loading;
}

export interface SetupPatch {
  complete?: boolean;
  skipped?: boolean;
  self_level?: SelfLevel | null;
  estimated_elo?: number | null;
  estimate?: Record<string, unknown>;
}

export async function saveSetup(patch: SetupPatch): Promise<Setup> {
  const sb = getSupabase();
  if (!sb) throw new Error("Accounts aren't configured on this deployment.");
  const { data, error } = await sb.rpc("save_setup", { p: patch });
  if (error) throw new Error(error.message);
  set({ setup: data as Setup });
  return data as Setup;
}

export const openSetup = () => set({ open: true });
export const closeSetup = () => set({ open: false });

export function useSetup(userId: string | null, authLoading: boolean): State {
  const s = useSyncExternalStore(subscribe, () => state, () => SERVER);
  useEffect(() => {
    if (authLoading) return;
    if (!state.loaded || state.userId !== userId) void loadSetup(userId);
  }, [userId, authLoading]);
  return s;
}

/** The estimate from the linked accounts' ratings and the stored self-level (null when neither gives one). */
export function usePlayerEstimate(accounts: Partial<Record<Platform, LinkedAccount>>, setup: Setup | null): { estimate: Estimate | null; level: PlayerLevel | null } {
  return useMemo(() => {
    const estimate = estimateElo(accounts, setup?.self_level ?? null);
    return { estimate, level: estimate ? levelOf(estimate.elo) : null };
  }, [accounts, setup?.self_level]);
}

/**
 * The signed-in player's estimate and level, for any page (dashboard, catalog,
 * Insights, Settings): live from the linked ratings and the stored answers.
 * Guests and players who skipped setup without linking get nulls.
 */
export function usePlayerLevel(): { estimate: Estimate | null; level: PlayerLevel | null; setup: Setup | null; loaded: boolean; signedIn: boolean } {
  const { user, loading } = useAuth();
  const uid = user?.id ?? null;
  const st = useSetup(uid, loading);
  const ins = useInsights(uid, loading);
  const { estimate, level } = usePlayerEstimate(ins.data.accounts, st.setup);
  return { estimate: uid ? estimate : null, level: uid ? level : null, setup: st.setup, loaded: !loading && st.loaded && ins.loaded, signedIn: !!uid };
}
