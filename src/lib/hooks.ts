"use client";
import { useCallback, useSyncExternalStore } from "react";
import type { Dataset } from "./openings";
import { useLiveDataset } from "./dataset-live";

/** The live v2 dataset (stable row ids, hot-reloads when the data changes). */
export function useDataset(): { ds: Dataset | null; error: string | null } {
  return useLiveDataset();
}

export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const mq = window.matchMedia(query);
      mq.addEventListener("change", onChange);
      return () => mq.removeEventListener("change", onChange);
    },
    [query]
  );
  return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches, () => false);
}

const noopSubscribe = () => () => {};
/** True after hydration (client-only state such as localStorage), false during SSR. */
export function useHydrated(): boolean {
  return useSyncExternalStore(noopSubscribe, () => true, () => false);
}
