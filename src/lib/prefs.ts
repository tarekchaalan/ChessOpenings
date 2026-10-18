"use client";
/** Device-local UI preferences (theme lives in next-themes; these are the rest). */
import { useEffect, useState } from "react";

const KEY = "cot.v1.prefs";

export type BoardTheme = "brown" | "blue" | "green" | "gray";
export type MotionPref = "system" | "reduce" | "full";

export interface Prefs {
  /** show next-move hint arrows by default in Learn mode */
  learnHints: boolean;
  /** board move/capture sounds */
  sound: boolean;
  /** delay before the opponent's reply, ms (0–1500) */
  replyDelayMs: number;
  /** Learn fast-forwards the approach and trunk you already know */
  skipKnown: boolean;
  /** new lines per day */
  dailyNewLines: number;
  /** reviews per day; the overflow is deferred, never dropped */
  dailyReviewCap: number;
  /** FSRS target retention */
  targetRetention: number;
  boardTheme: BoardTheme;
  /** eval bar in the trainer's Stats tab (needs the engine; hidden without it) */
  evalBar: boolean;
  /** reduced motion: follow the OS, or force it on/off */
  motion: MotionPref;
}

export const DEFAULT_PREFS: Prefs = {
  learnHints: true,
  sound: true,
  replyDelayMs: 500,
  skipKnown: true,
  dailyNewLines: 5,
  dailyReviewCap: 150,
  targetRetention: 0.9,
  boardTheme: "brown",
  evalBar: false,
  motion: "system",
};

export function getPrefs(): Prefs {
  if (typeof window === "undefined") return DEFAULT_PREFS;
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...DEFAULT_PREFS, ...JSON.parse(raw) } : DEFAULT_PREFS;
  } catch {
    return DEFAULT_PREFS;
  }
}

export function setPref<K extends keyof Prefs>(key: K, value: Prefs[K]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...getPrefs(), [key]: value }));
    window.dispatchEvent(new CustomEvent("cot:prefs"));
  } catch {
    // storage unavailable — preferences are best-effort
  }
}

export function usePrefs(): Prefs {
  const [prefs, setPrefs] = useState<Prefs>(DEFAULT_PREFS);
  useEffect(() => {
    const sync = () => setPrefs(getPrefs());
    sync();
    window.addEventListener("cot:prefs", sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener("cot:prefs", sync);
      window.removeEventListener("storage", sync);
    };
  }, []);
  return prefs;
}

/** Wipes all guest-mode progress and preferences from this browser. */
export function clearLocalData(): void {
  for (const k of Object.keys(localStorage)) {
    if (k.startsWith("cot.v1.")) localStorage.removeItem(k);
  }
}
