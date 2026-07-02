"use client";
/** Device-local UI preferences (theme lives in next-themes; these are the rest). */
import { useEffect, useState } from "react";

const KEY = "cot.v1.prefs";

export interface Prefs {
  /** show next-move hint arrows by default in Learn mode */
  learnHints: boolean;
}

export const DEFAULT_PREFS: Prefs = {
  learnHints: true,
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
