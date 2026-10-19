"use client";
/**
 * Engine features (Phase 6, stretch 2): the mistake ladder's step 4 (an
 * off-book move gets the engine's verdict and refutation) and the Stats tab's
 * eval bar. Stockfish loads on first use; without it both stay hidden and the
 * coach keeps "Not in this course's book."
 */
import { useEffect, useRef, useState } from "react";
import { Chess } from "chess.js";
import { analyse, engineAvailable, type Analysis } from "@/lib/engine/engine";
import { classify, formatScore, negate, pvToMoves, whiteShare, type Score } from "@/lib/engine/uci";
import { setPref, usePrefs } from "@/lib/prefs";
import { useHydrated } from "@/lib/hooks";
import { moveLabel, type TrainerSession } from "@/lib/trainer/session";
import type { CourseLine } from "@/lib/openings-build/courses";

/** chess.js and UCI want six FEN fields; the session's fens may be EPDs. */
export const fullFen = (f: string) => (f.trim().split(/\s+/).length >= 6 ? f : `${f.trim()} 0 1`);

const VERDICT_TITLE = { blunder: "Blunder", mistake: "Mistake", inaccuracy: "Inaccuracy", playable: "Close, but not the book move" } as const;

/**
 * After an off-book mistake: compare the position before and after it, and
 * post the engine's verdict with the refutation (2–4 plies) as the live
 * mistake message. Runs once per wrong move; a stale result is dropped.
 */
export function useEngineVerdict(s: TrainerSession, line: CourseLine, side: "white" | "black", ver: number, after: () => void, enabled: boolean): void {
  const done = useRef<number | null>(null);
  useEffect(() => {
    const w = s.wrong;
    if (!enabled || !w || w.soft || s.phase !== "wrong" || done.current === w.at || !engineAvailable()) return;
    const last = [...s.feed].reverse().find((m) => m.kind === "mistake");
    if (!last?.wrong?.offBook) return;
    done.current = w.at;
    const at = w.at;
    const ply = s.ply;
    const beforeFen = fullFen(s.fens[ply]);
    const afterFen = fullFen(w.fen);
    let alive = true;
    (async () => {
      const a = await analyse(beforeFen, { movetimeMs: 600 });
      const b = await analyse(afterFen, { movetimeMs: 900 });
      if (!alive || !a || !b) return;
      // both from the learner's side: before is theirs to move, after is the opponent's
      const before = a.score;
      const afterScore = negate(b.score);
      const { verdict } = classify(before, afterScore);
      const white = (x: Score) => (side === "white" ? x : negate(x));
      const moves = pvToMoves(afterFen, b.pv, 4);
      const reply = moves[0];
      const book = moveLabel(ply, line.sans[ply]);
      const text =
        verdict === "playable"
          ? `The engine rates it close (${formatScore(white(afterScore))} vs ${formatScore(white(before))}), but this course plays ${book}.`
          : reply
            ? `${moveLabel(ply + 1, reply.san)} punishes it (${formatScore(white(before))} → ${formatScore(white(afterScore))}). This course plays ${book}.`
            : `It drops the evaluation from ${formatScore(white(before))} to ${formatScore(white(afterScore))}. This course plays ${book}.`;
      const posted = s.engineVerdict(at, {
        title: `${VERDICT_TITLE[verdict]} (engine)`,
        text,
        arrows: reply && verdict !== "playable" ? [{ from: reply.from, to: reply.to, kind: "threat" }] : [],
        refute: verdict !== "playable" && moves.length ? { moves } : undefined,
      });
      if (posted) after();
    })().catch(() => undefined);
    return () => {
      alive = false;
    };
    // `ver` is the session's version (it mutates in place)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ver, enabled]);
}

/** Eval bar for the Stats tab: a toggle (off by default), hidden without the engine. */
export function EvalPanel({ fen }: { fen: string }) {
  const prefs = usePrefs();
  const hydrated = useHydrated();
  const [res, setRes] = useState<{ fen: string; a: Analysis | null } | null>(null);
  const [broken, setBroken] = useState(false);
  const on = prefs.evalBar;
  useEffect(() => {
    if (!on) return;
    let alive = true;
    const t = setTimeout(() => {
      analyse(fullFen(fen), { movetimeMs: 900 }).then((a) => {
        if (!alive) return;
        if (!a && !engineAvailable()) setBroken(true);
        setRes({ fen, a });
      });
    }, 150);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [fen, on]);
  if (!hydrated || !engineAvailable() || broken) return null;

  const current = res?.fen === fen ? res.a : null;
  const turn = new Chess(fullFen(fen)).turn();
  const whiteScore = current ? (turn === "w" ? current.score : negate(current.score)) : null;
  const best = current?.pv.length ? pvToMoves(fullFen(fen), current.pv, 1)[0]?.san : undefined;
  return (
    <div className="space-y-2" data-testid="eval-panel">
      <label className="flex items-center gap-2 text-sm cursor-pointer">
        <input type="checkbox" checked={on} onChange={(e) => setPref("evalBar", e.target.checked)} className="accent-[var(--accent)]" data-testid="eval-toggle" />
        Engine evaluation <span className="text-xs text-muted">(Stockfish 19 lite)</span>
      </label>
      {on && (
        <div aria-live="polite">
          <div className="h-3 rounded overflow-hidden flex border border-edge" role="img" aria-label={whiteScore ? `Evaluation ${formatScore(whiteScore)}` : "Evaluating"}>
            <div className="bg-[var(--bar-white)] transition-[width]" style={{ width: `${(whiteScore ? whiteShare(whiteScore) : 0.5) * 100}%` }} />
            <div className="flex-1 bg-[var(--bar-black)]" />
          </div>
          <div className="mt-1 text-xs text-muted flex justify-between" data-testid="eval-text">
            <span className="font-mono text-foreground">{whiteScore ? formatScore(whiteScore) : "…"}</span>
            <span>{current ? `depth ${current.depth}${best ? ` · best ${best}` : ""}` : "thinking"}</span>
          </div>
        </div>
      )}
    </div>
  );
}
