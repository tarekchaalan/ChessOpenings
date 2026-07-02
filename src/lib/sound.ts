"use client";
/**
 * Board sounds (files in /public/audio). Sound choice is derived from the SAN:
 * check > promotion > capture > castle > plain move (self vs opponent).
 * Respects the `sound` preference; failures are silent (autoplay policies).
 */
import { getPrefs } from "./prefs";

const NAMES = [
  "move-self",
  "move-opponent",
  "capture",
  "castle",
  "move-check",
  "promote",
] as const;
export type SoundName = (typeof NAMES)[number];

const cache = new Map<SoundName, HTMLAudioElement>();

function get(name: SoundName): HTMLAudioElement | null {
  if (typeof window === "undefined") return null;
  let el = cache.get(name);
  if (!el) {
    el = new Audio(`/audio/${name}.wav`);
    el.preload = "auto";
    el.volume = 0.6;
    cache.set(name, el);
  }
  return el;
}

/** Warm the cache so the first move doesn't hitch on a network fetch. */
export function preloadSounds(): void {
  NAMES.forEach(get);
}

export function playSound(name: SoundName): void {
  if (!getPrefs().sound) return;
  const el = get(name);
  if (!el) return;
  try {
    el.currentTime = 0;
    void el.play().catch(() => {});
  } catch {
    // ignored — sound is best-effort
  }
}

export function soundForSan(san: string, self: boolean): SoundName {
  if (san.includes("+") || san.includes("#")) return "move-check";
  if (san.includes("=")) return "promote";
  if (san.includes("x")) return "capture";
  if (san.startsWith("O-O")) return "castle";
  return self ? "move-self" : "move-opponent";
}

export function playMoveSound(san: string, self: boolean): void {
  playSound(soundForSan(san, self));
}
