"use client";
/**
 * Optional live stats from the Lichess opening explorer (masters database).
 * Purely additive: when the API is unreachable the app silently falls back to
 * the seeded corpus statistics baked into the dataset.
 */

export interface LiveStats {
  total: number;
  white: number;
  draws: number;
  black: number;
  moves: { san: string; total: number; white: number; draws: number; black: number }[];
}

const cache = new Map<string, LiveStats | null>();
let disabled = false;

export async function fetchMasterStats(fen: string): Promise<LiveStats | null> {
  if (disabled) return null;
  const key = fen.split(" ").slice(0, 4).join(" ");
  if (cache.has(key)) return cache.get(key) ?? null;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch(
      `https://explorer.lichess.ovh/masters?fen=${encodeURIComponent(fen)}&moves=12&topGames=0`,
      { signal: ctrl.signal }
    );
    clearTimeout(t);
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) disabled = true;
      cache.set(key, null);
      return null;
    }
    const data = await res.json();
    const stats: LiveStats = {
      white: data.white ?? 0,
      draws: data.draws ?? 0,
      black: data.black ?? 0,
      total: (data.white ?? 0) + (data.draws ?? 0) + (data.black ?? 0),
      moves: (data.moves ?? []).map((m: { san: string; white: number; draws: number; black: number }) => ({
        san: m.san,
        white: m.white,
        draws: m.draws,
        black: m.black,
        total: m.white + m.draws + m.black,
      })),
    };
    cache.set(key, stats);
    return stats;
  } catch {
    cache.set(key, null);
    return null;
  }
}
