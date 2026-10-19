"use client";
/**
 * Verdicts on repeat deviations (ADR 0006 § Repeat mistakes): the Lichess
 * server analysis when a game had it, else Stockfish through the existing
 * worker under a budget (ENGINE.positions searches of ENGINE.movetimeMs, one
 * at a time, cancelled on unmount), cached per browser. `classify()` with the
 * trainer's thresholds decides; "playable" means the player's own sideline.
 */
import { useEffect, useMemo, useState } from "react";
import { Chess } from "chess.js";
import { analyse, engineAvailable } from "@/lib/engine/engine";
import { classify, negate, type Score, type Verdict } from "@/lib/engine/uci";
import type { RepeatGroup } from "./aggregate";
import { ENGINE } from "./weights";

export interface GroupVerdict {
  verdict: Verdict;
  /** centipawns lost, from the player's side */
  drop: number;
  source: "lichess" | "engine";
}

const CACHE_KEY = "cot.v2.insights.verdicts";
const cacheKey = (g: RepeatGroup) => `${g.epd}|${g.playedSan}|${ENGINE.movetimeMs}`;

function readCache(): Record<string, GroupVerdict> {
  try {
    return JSON.parse(localStorage.getItem(CACHE_KEY) ?? "{}") as Record<string, GroupVerdict>;
  } catch {
    return {};
  }
}
function writeCache(c: Record<string, GroupVerdict>) {
  try {
    // keep it small: the newest 200 entries
    const entries = Object.entries(c).slice(-200);
    localStorage.setItem(CACHE_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // a cache only
  }
}

export function lichessVerdict(g: RepeatGroup): GroupVerdict | null {
  if (g.evalBefore === null || g.evalAfter === null) return null;
  const { verdict, drop } = classify({ cp: g.evalBefore }, { cp: g.evalAfter });
  return { verdict, drop, source: "lichess" };
}

/** Engine verdict for one group: best play before vs. after the player's move, both from the player's side. */
async function engineVerdict(g: RepeatGroup): Promise<GroupVerdict | null> {
  const fen = `${g.epd} 0 1`;
  const before = await analyse(fen, { movetimeMs: ENGINE.movetimeMs });
  if (!before) return null;
  const c = new Chess(fen);
  try {
    c.move(g.playedSan);
  } catch {
    return null;
  }
  if (c.isCheckmate()) return { verdict: "playable", drop: 0, source: "engine" };
  const after = await analyse(c.fen(), { movetimeMs: ENGINE.movetimeMs });
  if (!after) return null;
  const { verdict, drop } = classify(before.score as Score, negate(after.score as Score));
  return { verdict, drop, source: "engine" };
}

export type VerdictState = Record<string, GroupVerdict | "pending" | "none">;

/**
 * Verdicts for the groups, keyed like `verdictKey`. Lichess and cached ones
 * resolve at once; the first ENGINE.positions others are searched in order.
 */
export function useVerdicts(groups: RepeatGroup[]): VerdictState {
  const ids = groups.map(cacheKey).join("\n");
  // known verdicts (Lichess, cache) and the engine's to-do list, per group set
  const plan = useMemo(() => {
    const cache = typeof window === "undefined" ? {} : readCache();
    const known: Record<string, GroupVerdict> = {};
    const todo: RepeatGroup[] = [];
    for (const g of groups) {
      const v = lichessVerdict(g) ?? cache[cacheKey(g)];
      if (v) known[cacheKey(g)] = v;
      else if (engineAvailable() && todo.length < ENGINE.positions) todo.push(g);
    }
    return { known, todo };
    // groups are identified by their keys
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids]);
  const [found, setFound] = useState<Record<string, GroupVerdict | "none">>({});
  useEffect(() => {
    let cancelled = false;
    const cache = readCache();
    (async () => {
      for (const g of plan.todo) {
        // a newer request supersedes a running search, so an unmount stops after the current one
        const v = await engineVerdict(g);
        if (cancelled) return;
        const k = cacheKey(g);
        if (v) {
          cache[k] = v;
          writeCache(cache);
        }
        setFound((s) => ({ ...s, [k]: v ?? "none" }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [plan]);
  const out: VerdictState = {};
  const pending = new Set(plan.todo.map(cacheKey));
  for (const g of groups) {
    const k = cacheKey(g);
    out[k] = plan.known[k] ?? found[k] ?? (pending.has(k) ? "pending" : "none");
  }
  return out;
}

export const verdictKey = cacheKey;

/** Verdicts known without running the engine: Lichess analysis and this browser's cache (dashboard). */
export function knownVerdicts(groups: RepeatGroup[]): (GroupVerdict | null)[] {
  const cache = readCache();
  return groups.map((g) => lichessVerdict(g) ?? cache[cacheKey(g)] ?? null);
}
