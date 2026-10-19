"use client";
/**
 * v2 dataset loader with live updates (§4.8 Client).
 *
 *  - fetch openings.v2.meta.json with no-store → outputHash
 *  - fetch openings.v2.json?v=<outputHash> (long-cacheable)
 *  - dev: subscribe to the SSE route the watcher signals; prod: revalidate
 *    the meta on window focus at most every 10 minutes
 *  - on a hash change: swap the dataset in place, notify subscribers, and
 *    dispatch `cot:dataset-updated` with the matching changelog entry
 */
import { useEffect, useState } from "react";
import { parseDatasetV2, type Dataset } from "./openings";
import type { RawDatasetV2 } from "./openings-build/dataset";
import { summarizeEntry, type Changelog, type ChangelogEntry } from "./openings-build/diff";

export interface DatasetUpdate {
  outputHash: string;
  previousHash: string | null;
  entry: ChangelogEntry | null;
  summary: string;
}

const PROD_REVALIDATE_MS = 10 * 60_000;

let current: Dataset | null = null;
let loading: Promise<Dataset> | null = null;
const listeners = new Set<(ds: Dataset) => void>();
let liveStarted = false;
let lastCheck = 0;

interface MetaRef {
  outputHash: string;
  inputHash: string;
}

async function fetchMeta(): Promise<MetaRef> {
  const r = await fetch("/data/openings.v2.meta.json", { cache: "no-store" });
  if (!r.ok) throw new Error(`dataset meta fetch failed: ${r.status}`);
  return (await r.json()) as MetaRef;
}

/**
 * The watcher writes the dataset before the meta, so a long-cacheable
 * `?v=<hash>` URL could capture a *newer* file under an older label; the
 * dataset embeds its inputHash, which must match the meta we came from.
 */
async function fetchDataset(meta: MetaRef): Promise<Dataset> {
  for (const cache of ["force-cache", "no-store"] as const) {
    const r = await fetch(`/data/openings.v2.json?v=${meta.outputHash}`, { cache });
    if (!r.ok) throw new Error(`dataset fetch failed: ${r.status}`);
    const text = await r.text();
    // parse budget (§3, ≤ 150 ms): JSON + decoding, without the download
    const t0 = performance.now();
    const raw = JSON.parse(text) as RawDatasetV2;
    if (raw.inputHash === meta.inputHash) {
      const ds = parseDatasetV2(raw, meta.outputHash);
      performance.measure("cot:dataset-parse", { start: t0, end: performance.now() });
      return ds;
    }
  }
  throw new Error("dataset changed while loading; retrying on the next update");
}

export function loadDataset(): Promise<Dataset> {
  if (current) return Promise.resolve(current);
  if (!loading) {
    loading = fetchMeta()
      .then(fetchDataset)
      .then((ds) => {
        current = ds;
        lastCheck = Date.now();
        startLiveUpdates();
        return ds;
      })
      .catch((e) => {
        loading = null; // allow a retry
        throw e;
      });
  }
  return loading;
}

/** The current build's outputHash without loading the dataset (the loaded one's, once loaded). */
export async function currentOutputHash(): Promise<string> {
  return current?.outputHash ?? (await fetchMeta()).outputHash;
}

export function currentDataset(): Dataset | null {
  return current;
}

export function subscribeDataset(fn: (ds: Dataset) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

async function latestEntry(hash: string): Promise<ChangelogEntry | null> {
  try {
    const r = await fetch(`/data/openings.changelog.json?v=${hash}`, { cache: "no-store" });
    if (!r.ok) return null;
    const log = (await r.json()) as Changelog;
    return log.entries.find((e) => e.toHash === hash) ?? null;
  } catch {
    return null;
  }
}

let swapSeq = 0;

/** Swap to the build the meta currently names; later requests win over earlier ones. */
async function swapToLatest(): Promise<void> {
  if (!current) return;
  const seq = ++swapSeq;
  try {
    const meta = await fetchMeta();
    if (meta.outputHash === current.outputHash || seq !== swapSeq) return;
    const hash = meta.outputHash;
    const previousHash = current.outputHash ?? null;
    const [ds, entry] = await Promise.all([fetchDataset(meta), latestEntry(hash)]);
    if (seq !== swapSeq) return; // a newer swap started meanwhile
    current = ds;
    for (const fn of listeners) fn(ds);
    const update: DatasetUpdate = {
      outputHash: hash,
      previousHash,
      entry,
      summary: entry ? summarizeEntry(entry) : "Opening data refreshed",
    };
    window.dispatchEvent(new CustomEvent<DatasetUpdate>("cot:dataset-updated", { detail: update }));
  } catch {
    // keep the last good dataset; the next signal retries
  }
}

function startLiveUpdates(): void {
  if (liveStarted || typeof window === "undefined") return;
  liveStarted = true;
  if (process.env.NODE_ENV === "development" && typeof EventSource !== "undefined") {
    const es = new EventSource("/api/dev/openings");
    es.onmessage = (ev) => {
      try {
        const { outputHash } = JSON.parse(ev.data) as { outputHash: string | null };
        if (outputHash && outputHash !== current?.outputHash) void swapToLatest();
      } catch {
        // ignore malformed frames
      }
    };
    return;
  }
  window.addEventListener("focus", () => {
    if (Date.now() - lastCheck < PROD_REVALIDATE_MS) return;
    lastCheck = Date.now();
    void swapToLatest();
  });
}

/** React hook: the live v2 dataset (re-renders when the data changes). */
export function useLiveDataset(): { ds: Dataset | null; error: string | null } {
  const [ds, setDs] = useState<Dataset | null>(current);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    loadDataset()
      .then((d) => alive && setDs(d))
      .catch((e) => alive && setError(String(e)));
    const off = subscribeDataset((d) => alive && setDs(d));
    return () => {
      alive = false;
      off();
    };
  }, []);
  return { ds, error };
}
