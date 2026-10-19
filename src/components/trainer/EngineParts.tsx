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

/**
 * Vertical eval bar beside the board (on by default, toggled with E or the
 * toolbar). White's share fills from White's edge, so it follows the board's
 * orientation. Hidden without the engine.
 */
export function EvalBar({ fen, orientation }: { fen: string; orientation: "white" | "black" }) {
  const prefs = usePrefs();
  const hydrated = useHydrated();
  const [res, setRes] = useState<{ fen: string; a: Analysis | null } | null>(null);
  const [broken, setBroken] = useState(false);
  const on = prefs.showEval;
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
  if (!hydrated || !on || !engineAvailable() || broken) return null;

  // keep the last result on screen while the next position is analysed (no flicker back to 50%)
  const a = res?.a ?? null;
  const fresh = res?.fen === fen;
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
