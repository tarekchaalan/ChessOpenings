"use client";
import { useEffect, useMemo, useState } from "react";
import { Dataset, loadLegacyDataset } from "./openings";
import { useLiveDataset } from "./dataset-live";
import { useAuth } from "./supabase/AuthProvider";
import { getSupabase } from "./supabase/client";
import { localReader } from "./progress/local";
import { remoteReader } from "./progress/remote";
import type { ProgressReader, ProgressSummary } from "./progress/types";
import { LocalQuizBackend } from "./quiz/local";
import { RemoteQuizBackend } from "./quiz/remote";
import type { QuizBackend } from "./quiz/types";

/** The live v2 dataset (stable row ids, hot-reloads when the data changes). */
export function useDataset(): { ds: Dataset | null; error: string | null } {
  return useLiveDataset();
}

/**
 * The legacy v1 dataset, whose row indices are still the identity used by
 * the Learn/Quiz screens and guest progress until Phases 4–5 replace them.
 */
export function useLegacyDataset(): { ds: Dataset | null; error: string | null } {
  const [ds, setDs] = useState<Dataset | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    loadLegacyDataset().then(setDs).catch((e) => setError(String(e)));
  }, []);
  return { ds, error };
}

export function useProgressReader(): ProgressReader {
  const { user } = useAuth();
  return useMemo(() => {
    const sb = getSupabase();
    if (user && sb) return remoteReader(sb, user.id);
    return localReader;
  }, [user]);
}

export function useProgressSummary(): { summary: ProgressSummary | null; reload: () => void } {
  const reader = useProgressReader();
  const [summary, setSummary] = useState<ProgressSummary | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    reader.summary().then((s) => alive && setSummary(s));
    return () => {
      alive = false;
    };
  }, [reader, tick]);
  return { summary, reload: () => setTick((t) => t + 1) };
}

export function useQuizBackend(ds: Dataset | null): QuizBackend | null {
  const { user } = useAuth();
  return useMemo(() => {
    if (!ds) return null;
    const sb = getSupabase();
    if (user && sb) return new RemoteQuizBackend(sb);
    return new LocalQuizBackend(ds);
  }, [ds, user]);
}

/** Media-query hook used for responsive board sizing. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(query);
    setMatches(mq.matches);
    const fn = (e: MediaQueryListEvent) => setMatches(e.matches);
    mq.addEventListener("change", fn);
    return () => mq.removeEventListener("change", fn);
  }, [query]);
  return matches;
}
