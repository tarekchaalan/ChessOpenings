"use client";
/**
 * Chessground board wrapper. chess.js is the rules oracle: it computes legal
 * destinations, applies moves, and reports the resulting SAN to the parent.
 * Shapes (arrows, ✓/✕ badges), square tints and promotion choice live here so
 * every screen draws the same vocabulary (lib/coach/brushes).
 */
import { useEffect, useRef, useState } from "react";
import { Chess, SQUARES, Square } from "chess.js";
import { Chessground } from "chessground";
import type { Api } from "chessground/api";
import type { Config } from "chessground/config";
import type { DrawShape } from "chessground/draw";
import type { Key } from "chessground/types";
import { BRUSHES, tintClass, type Tint } from "@/lib/coach/brushes";

import "chessground/assets/chessground.base.css";
import "chessground/assets/chessground.brown.css";
import "chessground/assets/chessground.cburnett.css";
import "@/styles/mini-pieces.css";

export interface BoardProps {
  /** FEN of the position to display */
  fen: string;
  orientation: "white" | "black";
  /** last move as [from, to] for highlighting */
  lastMove?: [string, string] | null;
  /** which color the user may move; null disables interaction */
  movableColor?: "white" | "black" | "both" | null;
  /** called with the SAN of a legal user move (after a promotion choice if needed) */
  onMove?: (san: string, move: { from: string; to: string }) => void;
  /** legacy: one green hint arrow */
  hintMove?: [string, string] | null;
  /** legacy: brief red flash for a wrong quiz answer */
  shake?: boolean;
  /** arrows and badges (see lib/coach/brushes) */
  shapes?: DrawShape[];
  /** square → tint */
  tints?: Record<string, Tint>;
  /** ms per move animation (0 = none, e.g. reduced motion) */
  animationMs?: number;
  /** accessible description of the position */
  label?: string;
}

function legalDests(chess: Chess): Map<Key, Key[]> {
  const dests = new Map<Key, Key[]>();
  for (const s of SQUARES) {
    const moves = chess.moves({ square: s as Square, verbose: true });
    if (moves.length) dests.set(s as Key, moves.map((m) => m.to as Key));
  }
  return dests;
}

const full = (fen: string) => (fen.split(" ").length < 6 ? fen + " 0 1" : fen);
const ROLES = [
  { p: "q", label: "Queen" },
  { p: "r", label: "Rook" },
  { p: "b", label: "Bishop" },
  { p: "n", label: "Knight" },
] as const;
const ROLE_NAME: Record<string, string> = { q: "queen", r: "rook", b: "bishop", n: "knight" };

export default function Board({
  fen,
  orientation,
  lastMove,
  movableColor = null,
  onMove,
  hintMove,
  shake,
  shapes,
  tints,
  animationMs = 180,
  label,
}: BoardProps) {
  const ref = useRef<HTMLDivElement>(null);
  const apiRef = useRef<Api | null>(null);
  const onMoveRef = useRef(onMove);
  const [promo, setPromo] = useState<{ from: string; to: string; color: "w" | "b" } | null>(null);
  useEffect(() => {
    onMoveRef.current = onMove;
  }, [onMove]);

  useEffect(() => {
    if (!ref.current) return;
    const api = Chessground(ref.current, {
      coordinates: true,
      animation: { duration: animationMs },
      // allow programmatic events (testing, demos); real input is unaffected
      trustAllEvents: true,
      drawable: { brushes: BRUSHES },
    });
    apiRef.current = api;
    return () => {
      api.destroy();
      apiRef.current = null;
    };
    // animation duration is applied on every update below
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const api = apiRef.current;
    if (!api) return;
    const chess = new Chess(full(fen));
    const turn = chess.turn() === "w" ? "white" : "black";
    const canMove = movableColor !== null && (movableColor === "both" || movableColor === turn) && !promo;

    // When the board already shows this position (e.g. the user just dragged
    // the move and we're waiting for it to be graded), don't re-set the fen.
    const alreadyThere = api.getFen() === fen.split(" ")[0];

    const custom = new Map<Key, string>();
    for (const [sq, t] of Object.entries(tints ?? {})) custom.set(sq as Key, tintClass(t));

    const config: Config = {
      ...(alreadyThere ? {} : { fen }),
      orientation,
      turnColor: turn,
      check: chess.inCheck(),
      lastMove: (lastMove ?? undefined) as Key[] | undefined,
      animation: { enabled: animationMs > 0, duration: animationMs },
      highlight: { lastMove: true, check: true, custom },
      movable: {
        free: false,
        color: canMove ? turn : undefined,
        dests: canMove ? legalDests(chess) : new Map(),
        showDests: true,
        events: {
          after: (orig, dest) => {
            const c = new Chess(full(fen));
            const piece = c.get(orig as Square);
            const rank = (dest as string)[1];
            if (piece?.type === "p" && (rank === "8" || rank === "1")) {
              setPromo({ from: orig as string, to: dest as string, color: piece.color });
              return;
            }
            let mv;
            try {
              mv = c.move({ from: orig as string, to: dest as string });
            } catch {
              return;
            }
            onMoveRef.current?.(mv.san, { from: mv.from, to: mv.to });
          },
        },
      },
      selectable: { enabled: true },
      draggable: { enabled: true, showGhost: true },
      premovable: { enabled: false },
      drawable: {
        enabled: true,
        brushes: BRUSHES,
        autoShapes: [
          ...(hintMove ? [{ orig: hintMove[0] as Key, dest: hintMove[1] as Key, brush: "green" }] : []),
          ...(shapes ?? []),
        ],
      },
    };
    api.set(config);
  }, [fen, orientation, lastMove, movableColor, hintMove, shapes, tints, animationMs, promo]);

  const choose = (p: string | null) => {
    const pending = promo;
    setPromo(null);
    if (!pending || !p) {
      apiRef.current?.set({ fen }); // cancelled: put the pawn back
      return;
    }
    const c = new Chess(full(fen));
    try {
      const mv = c.move({ from: pending.from, to: pending.to, promotion: p });
      onMoveRef.current?.(mv.san, { from: mv.from, to: mv.to });
    } catch {
      apiRef.current?.set({ fen });
    }
  };

  // promotion overlay: a column of four pieces on the destination file
  const file = promo ? "abcdefgh".indexOf(promo.to[0]) : 0;
  const col = orientation === "white" ? file : 7 - file;
  const fromTop = promo ? (orientation === "white") === (promo.to[1] === "8") : true;

  return (
    <div className={`board-shell ${shake ? "board-shake" : ""}`} aria-label={label ?? "Chess board"}>
      <div ref={ref} className="board-cg" />
      {promo && (
        <div className="promo-overlay" role="dialog" aria-label="Choose a promotion piece" onClick={() => choose(null)}>
          <div
            className="promo-column"
            style={{ left: `${col * 12.5}%`, ...(fromTop ? { top: 0 } : { bottom: 0 }), flexDirection: fromTop ? "column" : "column-reverse" }}
          >
            {ROLES.map((r) => (
              <button
                key={r.p}
                autoFocus={r.p === "q"}
                aria-label={`Promote to ${r.label}`}
                className="promo-piece cg-wrap"
                onClick={(e) => {
                  e.stopPropagation();
                  choose(r.p);
                }}
              >
                <span className={`mp ${promo.color === "w" ? "white" : "black"} ${ROLE_NAME[r.p]}`} />
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
