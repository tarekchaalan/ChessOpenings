"use client";
/**
 * Reduced motion (§3): the Settings choice ("system" follows the OS) is
 * mirrored on <html data-motion="reduce|full"> by <MotionSync/>, so CSS and
 * non-React code (MiniBoard's replay, the feed's scrolling) agree with it.
 */
import { useEffect } from "react";
import { usePrefs } from "@/lib/prefs";
import { useMediaQuery } from "@/lib/hooks";

/** Effective setting, as a hook. */
export function useReducedMotion(): boolean {
  const prefs = usePrefs();
  const os = useMediaQuery("(prefers-reduced-motion: reduce)");
  return prefs.motion === "reduce" || (prefs.motion === "system" && os);
}

/** Effective setting, outside React (falls back to the OS before <MotionSync/> ran). */
export function motionReduced(): boolean {
  if (typeof window === "undefined") return false;
  const m = document.documentElement.dataset.motion;
  return m ? m === "reduce" : window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function MotionSync() {
  const reduced = useReducedMotion();
  useEffect(() => {
    document.documentElement.dataset.motion = reduced ? "reduce" : "full";
  }, [reduced]);
  return null;
}
