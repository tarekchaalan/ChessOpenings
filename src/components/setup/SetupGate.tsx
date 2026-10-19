"use client";
/**
 * Shows the setup modal (ADR 0008) on a signed-in player's first visit, which
 * is right after the email link verifies the account, and whenever Settings
 * asks for it. Also keeps the stored estimate and this browser's level in step
 * with the linked ratings as Insights syncs them.
 */
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { useAuth } from "@/lib/supabase/AuthProvider";
import { useInsights } from "@/lib/insights/client";
import { estimateRecord } from "@/lib/rating/estimate";
import { storeBand } from "@/lib/rating/level";
import { closeSetup, saveSetup, usePlayerEstimate, useSetup } from "@/lib/setup/client";
import SetupModal from "./SetupModal";

const LATER = "cot.setup.later";

function laterFor(uid: string): boolean {
  try {
    return window.sessionStorage.getItem(LATER) === uid;
  } catch {
    return false;
  }
}

export default function SetupGate() {
  const { user, loading, configured } = useAuth();
  const pathname = usePathname();
  const uid = user?.id ?? null;
  const st = useSetup(uid, loading);
  const ins = useInsights(uid, loading);
  const { estimate, level } = usePlayerEstimate(ins.data.accounts, st.setup);
  // "not now" lasts for this browser session
  const [later, setLater] = useState<string | null>(null);
  // once open, the modal stays mounted until it closes (Insights reloading must not unmount it mid-save)
  const [openFor, setOpenFor] = useState<string | null>(null);

  // the level this browser personalises with, and the stored estimate, follow the ratings
  useEffect(() => {
    if (loading) return;
    if (!uid) {
      storeBand(null);
      return;
    }
    if (!st.loaded || !ins.loaded || st.unavailable || !st.setup?.completed_at) return;
    storeBand(level?.band ?? null);
    if (estimate && estimate.elo !== st.setup.estimated_elo) {
      saveSetup({ estimated_elo: estimate.elo, estimate: estimateRecord(estimate) }).catch(() => {});
    }
  }, [loading, uid, st.loaded, st.unavailable, st.setup, ins.loaded, estimate, level]);

  const ready = configured && !!uid && st.loaded && !st.unavailable && ins.loaded && !pathname.startsWith("/auth");
  const wanted = ready && ((st.setup === null && later !== uid && !laterFor(uid)) || st.open);
  if (!uid || (!wanted && openFor !== uid)) return null;
  if (wanted && openFor !== uid) setOpenFor(uid);

  return (
    <SetupModal
      key={uid}
      linked={ins.data.accounts}
      setup={st.setup}
      onClose={() => {
        setOpenFor(null);
        closeSetup();
        // closed without finishing or skipping: ask again next session
        if (st.setup === null) {
          setLater(uid);
          try {
            window.sessionStorage.setItem(LATER, uid);
          } catch {
            // in-memory only
          }
        }
      }}
    />
  );
}
