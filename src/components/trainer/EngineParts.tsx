"use client";
/**
 * Engine features (Phase 6, stretch 2): the mistake ladder's step 4 (an
 * off-book move gets the engine's verdict and refutation) and the eval bar
 * beside the board. Stockfish loads on first use; without it both stay hidden and the
 * coach keeps "Not in this course's book."
 */
import { useEffect, useRef, useState } from "react";
import { Chess } from "chess.js";
import { analyse, engineAvailable, type Analysis } from "@/lib/engine/engine";
import { barLabel, classify, formatScore, negate, pvToMoves, whiteShare, type Score } from "@/lib/engine/uci";
import { usePrefs } from "@/lib/prefs";
import { useHydrated } from "@/lib/hooks";
import { moveLabel, type EngineMove, type TrainerSession } from "@/lib/trainer/session";
import type { CourseLine } from "@/lib/openings-build/courses";

/** An analysis of one position, for the eval bar (`fen` is the position it describes). */
export interface Analysed {
  fen: string;
  a: Analysis | null;
}

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

/**
 * What If: after every what-if move, a MultiPV search of the position on the
 * board; its top three moves become numbered arrows and an engine message with
 * clickable moves. A result for a position the board has left is dropped.
 * Returns the latest analysis so the eval bar can show it instead of running
 * its own (competing) search.
 */
export function useWhatIfEngine(s: TrainerSession, ver: number, after: () => void): Analysed | null {
  const [res, setRes] = useState<Analysed | null>(null);
  const done = useRef<number | null>(null);
  useEffect(() => {
    const free = s.free;
    if (s.phase !== "free" || !free || !engineAvailable()) {
      done.current = null;
      return;
    }
    if (done.current === free.seq) return;
    done.current = free.seq;
    const seq = free.seq;
    const fen = fullFen(s.freeFen());
    const turn = new Chess(fen).turn();
    let alive = true;
    analyse(fen, { movetimeMs: 1000, multipv: 3 })
      .then((a) => {
        if (!alive) return;
        setRes({ fen, a });
        if (!a) return;
        const moves: EngineMove[] = [];
        for (const l of a.lines) {
          const m = pvToMoves(fen, l.pv, 1)[0];
          if (m && !moves.some((x) => x.san === m.san)) moves.push({ san: m.san, from: m.from, to: m.to, score: formatScore(turn === "w" ? l.score : negate(l.score)) });
        }
        if (s.engineSuggest(seq, moves, a.depth)) after();
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
    // `ver` is the session's version (it mutates in place)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ver]);
  return s.phase === "free" ? res : null;
}

/**
 * Vertical eval bar beside the board (on by default, toggled with E or the
 * toolbar). White's share fills from White's edge, so it follows the board's
 * orientation. Hidden without the engine. With `external` given (What If's own
 * search of the position on the board; null while it runs) the bar shows that
 * instead of starting a competing search.
 */
export function EvalBar({ fen, orientation, external }: { fen: string; orientation: "white" | "black"; external?: Analysed | null }) {
  const prefs = usePrefs();
  const hydrated = useHydrated();
  const [own, setOwn] = useState<Analysed | null>(null);
  const [broken, setBroken] = useState(false);
  const on = prefs.showEval;
  const delegated = external !== undefined;
  useEffect(() => {
    if (!on || delegated) return;
    let alive = true;
    const t = setTimeout(() => {
      analyse(fullFen(fen), { movetimeMs: 900 }).then((a) => {
        if (!alive) return;
        if (!a && !engineAvailable()) setBroken(true);
        setOwn({ fen, a });
      });
    }, 150);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [fen, on, delegated]);
  if (!hydrated || !on || !engineAvailable() || broken) return null;

  // the last result stays on screen while the next position is analysed (no flicker back to 50%):
  // What If's result when it has one, else the bar's own last search (the line's position)
  const res = (delegated ? external : null) ?? own;
  const a = res?.a ?? null;
  const fresh = res?.fen === fen || res?.fen === fullFen(fen);
  const turn = res ? new Chess(fullFen(res.fen)).turn() : "w";
  const whiteScore = a ? (turn === "w" ? a.score : negate(a.score)) : null;
  const share = whiteScore ? whiteShare(whiteScore) : 0.5;
  const best = fresh && a?.pv.length ? pvToMoves(fullFen(fen), a.pv, 1)[0]?.san : undefined;
  const text = whiteScore ? formatScore(whiteScore) : "…";
  const whiteAhead = share >= 0.5;
  // White's end is at the bottom when White is at the bottom of the board
  const whiteAtBottom = orientation === "white";
  const labelAtBottom = whiteAhead === whiteAtBottom;
  const title = a && fresh ? `${text} · depth ${a.depth}${best ? ` · best ${best}` : ""}` : "Evaluating…";
  return (
    <div
      className="eval-bar relative w-2.5 sm:w-5 md:w-6 shrink-0 rounded overflow-hidden border border-edge bg-[var(--bar-black)] flex"
      style={{ flexDirection: whiteAtBottom ? "column-reverse" : "column" }}
      role="img"
      aria-label={whiteScore ? `Engine evaluation ${text}` : "Engine evaluating"}
      title={title}
      data-testid="eval-bar"
      data-depth={a && fresh ? a.depth : undefined}
    >
      <div className="eval-fill bg-[var(--bar-white)]" style={{ height: `${share * 100}%` }} />
      <span
        className={`max-sm:hidden absolute inset-x-0 text-center font-mono font-semibold leading-none text-[9px] md:text-[10px] tracking-tighter ${labelAtBottom ? "bottom-1" : "top-1"} ${whiteAhead ? "text-[#1c1b18]" : "text-[#e8e6e1]"}`}
        data-testid="eval-text"
      >
        {whiteScore ? barLabel(whiteScore) : ""}
      </span>
    </div>
  );
}
