"use client";
/**
 * "+N new lines" badges (§3.2 A, §4.8): the latest data build's per-hub row
 * deltas, dismissable per user (localStorage, best-effort).
 */
import { useEffect, useState } from "react";
import { subscribeDataset } from "./dataset-live";
import type { Changelog, ChangelogEntry } from "./openings-build/diff";

const SEEN_KEY = "cot.v2.badgesSeen";

function readSeen(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(SEEN_KEY) ?? "{}") as Record<string, string>;
  } catch {
    return {};
  }
}

export function useLatestChanges(): { entry: ChangelogEntry | null; seen: Record<string, string>; dismiss: (hub: string) => void } {
  const [entry, setEntry] = useState<ChangelogEntry | null>(null);
  const [seen, setSeen] = useState<Record<string, string>>({});
  const [tick, setTick] = useState(0);
  useEffect(() => subscribeDataset(() => setTick((t) => t + 1)), []);
  useEffect(() => {
    let alive = true;
    fetch("/data/openings.changelog.json", { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<Changelog>) : null))
      .then((log) => {
        if (!alive) return;
        setSeen(readSeen());
        setEntry(log?.entries[0] ?? null);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [tick]);
  const dismiss = (hub: string) => {
    if (!entry) return;
    const next = { ...readSeen(), [hub]: entry.toHash };
    try {
      localStorage.setItem(SEEN_KEY, JSON.stringify(next));
    } catch {
      // best-effort
    }
    setSeen(next);
  };
  return { entry, seen, dismiss };
}

/** New-line count to badge on a hub, or 0 (none, or dismissed for this build). */
export function newLinesFor(entry: ChangelogEntry | null, seen: Record<string, string>, hub: string): number {
  if (!entry) return 0;
  const d = entry.hubs[hub];
  if (!d || d.added <= 0) return 0;
  return seen[hub] === entry.toHash ? 0 : d.added;
}
