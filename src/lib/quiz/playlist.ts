/**
 * Quiz playlists: the top-N named variations of an opening family, drilled in
 * shuffled order. Each session line follows one variation; consecutive lines
 * start from where they diverge from the previous one, so the user isn't
 * re-asked the shared trunk every time.
 */
import type { Family, Opening } from "@/lib/openings";

export interface PlaylistLine {
  name: string;
  /** short name after the colon, e.g. "Najdorf Variation, English Attack" */
  variation: string | null;
  eco: string;
  sans: string[];
}

const isPrefixOf = (a: string[], b: string[]) =>
  a.length <= b.length && a.every((s, i) => b[i] === s);

/**
 * Top variations by real-game popularity, excluding lines that are plain
 * prefixes of an already-chosen deeper line (they add no new moves).
 * `size = Infinity` returns all distinct branches.
 */
export function buildPlaylist(family: Family, size: number): PlaylistLine[] {
  const sorted: Opening[] = [...family.lines].sort((a, b) => b.popularity - a.popularity);
  const chosen: Opening[] = [];
  for (const cand of sorted) {
    if (chosen.length >= size) break;
    if (chosen.some((c) => isPrefixOf(cand.sans, c.sans) || isPrefixOf(c.sans, cand.sans))) {
      continue;
    }
    chosen.push(cand);
  }
  // top-up with skipped lines if the dedupe filtered below the requested size
  if (chosen.length < size) {
    for (const cand of sorted) {
      if (chosen.length >= size) break;
      if (!chosen.includes(cand)) chosen.push(cand);
    }
  }
  return chosen.map((o) => ({ name: o.name, variation: o.variation, eco: o.eco, sans: o.sans }));
}

/** Distinct branch count for the playlist-size picker. */
export function distinctBranchCount(family: Family): number {
  return buildPlaylist(family, Infinity).length;
}

export function shuffled<T>(arr: T[]): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function commonPrefixLen(a: string[], b: string[]): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

/**
 * Where to start quizzing `target` after having just played `previous`:
 * at the divergence point, but always leaving at least two plies to answer,
 * and never beyond the target's own length.
 */
export function startPlyFor(target: string[], previous: string[] | null): number {
  if (!previous) return 0;
  const cpl = commonPrefixLen(target, previous);
  return Math.max(0, Math.min(cpl, target.length - 2));
}
