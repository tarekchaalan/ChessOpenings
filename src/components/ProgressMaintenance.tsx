"use client";
/**
 * On load (and when the local day changes): the one-time v1 → v2 guest
 * migration, then the daily review cap's deferral (ADR 0003). Renders nothing.
 */
import { useCallback, useEffect, useState } from "react";
import { getPrefs } from "@/lib/prefs";
import { applyDailyCap } from "@/lib/progress/store";
import { useDataset } from "@/lib/hooks";
import { deferOnServer } from "@/lib/train-sync";

const V1_SOURCES = ["cot.v1.cards", "cot.v1.attempts", "cot.v1.profile", "cot.v1.openingProgress", "cot.v1.prefs"];
const hasV1 = () => {
  try {
    return V1_SOURCES.some((k) => localStorage.getItem(k) !== null);
  } catch {
    return false;
  }
};

const capToday = () => {
  const p = getPrefs();
  void deferOnServer(applyDailyCap(p.dailyReviewCap, p.targetRetention));
};

export default function ProgressMaintenance() {
  // null: not checked yet; true: a v1 migration must run first; false: ready
  const [migrate, setMigrate] = useState<boolean | null>(null);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- localStorage is only readable after mount
    setMigrate(hasV1());
  }, []);
  // the cap runs only once nothing is left to migrate (it must see the migrated cards)
  useEffect(() => {
    if (migrate !== false) return;
    capToday();
    window.addEventListener("focus", capToday);
    return () => window.removeEventListener("focus", capToday);
  }, [migrate]);
  const done = useCallback(() => setMigrate(false), []);
  return migrate ? <Migrate done={done} /> : null;
}

/** Mounted only for v1 users: it needs the v2 dataset (placement) and the legacy map. */
function Migrate({ done }: { done: () => void }) {
  const { ds } = useDataset();
  useEffect(() => {
    if (!ds) return;
    import("@/lib/progress/migrate-runner")
      .then((m) => m.runGuestMigration(ds))
      .catch((e) => console.warn("[migration] skipped:", e))
      .finally(done);
  }, [ds, done]);
  return null;
}
