"use client";
/**
 * Runs the v1 → v2 guest migration once (ADR 0003): only when `cot.v1.*`
 * keys exist, and only fetching the legacy map then. Order: backup
 * (`cot.v1.backup`) → v2 keys → marker → the live v1 keys are removed (the
 * backup keeps them). A failed backup write aborts before anything changes.
 */
import type { Dataset } from "@/lib/openings";
import type { LegacyMap } from "@/lib/openings-build/legacy";
import { DEFAULT_PREFS } from "@/lib/prefs";
import { KEYS, allCards, allCourseProgress, notifyProgress } from "./store";
import { MIGRATION_KEYS, V1_KEYS, datasetPlacer, migrateV1, sourceHash, type MigrationReport } from "./migrate-v1";

export function v1Snapshot(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of V1_KEYS) {
    const v = localStorage.getItem(k);
    if (v !== null) out[k] = v;
  }
  return out;
}

const ACTIVITY_MARK = "cot.v2.migratedActivity";
const removeLive = () => V1_KEYS.forEach((k) => localStorage.removeItem(k));

let running: Promise<MigrationReport | null> | null = null;

export function runGuestMigration(ds: Dataset, fetchLegacy: () => Promise<LegacyMap> = defaultFetch): Promise<MigrationReport | null> {
  running ??= run(ds, fetchLegacy).finally(() => (running = null));
  return running;
}

const defaultFetch = () => fetch("/data/legacy-map.v1.json").then((r) => (r.ok ? (r.json() as Promise<LegacyMap>) : Promise.reject(new Error(`legacy map: ${r.status}`))));

async function run(ds: Dataset, fetchLegacy: () => Promise<LegacyMap>): Promise<MigrationReport | null> {
  if (typeof window === "undefined") return null;
  const snapshot = v1Snapshot();
  if (!Object.keys(snapshot).length) return null;
  const hash = sourceHash(snapshot);
  if (localStorage.getItem(MIGRATION_KEYS.marker) === hash) {
    // migrated, but removing the live keys didn't finish last time
    removeLive();
    return null;
  }
  const legacy = await fetchLegacy();

  // 1. backup, before any v2 key (several runs keep one entry per source hash)
  try {
    const backup = JSON.parse(localStorage.getItem(MIGRATION_KEYS.backup) ?? "{}") as Record<string, unknown>;
    backup[hash] = { at: new Date().toISOString(), keys: snapshot };
    localStorage.setItem(MIGRATION_KEYS.backup, JSON.stringify(backup));
  } catch {
    return null; // no backup, no migration
  }

  // 2. v2 keys (existing v2 state wins)
  const out = migrateV1(snapshot, legacy, datasetPlacer(ds), { cards: allCards(), courses: allCourseProgress() });
  try {
    localStorage.setItem(KEYS.cards, JSON.stringify({ ...out.cards, ...allCards() }));
    localStorage.setItem(KEYS.courses, JSON.stringify({ ...allCourseProgress(), ...out.courseProgress }));
    // activity is additive: merged once per source (a retry after a quota error must not double-count)
    if (localStorage.getItem(ACTIVITY_MARK) !== hash) {
      const log = JSON.parse(localStorage.getItem(KEYS.activity) ?? "{}") as Record<string, number[]>;
      for (const [day, [n, ok]] of Object.entries(out.activity)) log[day] = [(log[day]?.[0] ?? 0) + n, (log[day]?.[1] ?? 0) + ok];
      localStorage.setItem(KEYS.activity, JSON.stringify(log));
      localStorage.setItem(ACTIVITY_MARK, hash);
    }
    if (out.attempts && localStorage.getItem(MIGRATION_KEYS.attempts) === null) localStorage.setItem(MIGRATION_KEYS.attempts, out.attempts);
    if (out.profile && localStorage.getItem(MIGRATION_KEYS.profile) === null) localStorage.setItem(MIGRATION_KEYS.profile, out.profile);
    if (out.prefs && localStorage.getItem(MIGRATION_KEYS.prefs) === null) {
      let v1: object = {};
      try {
        v1 = JSON.parse(out.prefs);
      } catch {
        // unreadable v1 prefs: defaults
      }
      localStorage.setItem(MIGRATION_KEYS.prefs, JSON.stringify({ ...DEFAULT_PREFS, ...v1 }));
    }
    localStorage.setItem(MIGRATION_KEYS.report, JSON.stringify(out.report));
    // 3. marker, then the live v1 keys go (the backup has them)
    localStorage.setItem(MIGRATION_KEYS.marker, hash);
  } catch {
    // quota: the marker isn't written, so the next load retries; the backup is intact
    return null;
  }
  removeLive();
  if (out.report.dropped.length) console.info(`[migration] ${out.report.dropped.length} v1 cards had no v2 position`, out.report.dropped);
  notifyProgress();
  window.dispatchEvent(new CustomEvent("cot:prefs"));
  return out.report;
}
