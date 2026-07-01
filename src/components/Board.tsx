"use client";
/**
 * Chessground board wrapper. chess.js is the rules oracle: it computes legal
 * destinations, applies moves, and reports the resulting SAN to the parent.
 */
import { useEffect, useRef } from "react";
import { Chess, SQUARES, Square } from "chess.js";
import { Chessground } from "chessground";
import type { Api } from "chessground/api";
import type { Config } from "chessground/config";
import type { Key } from "chessground/types";

import "chessground/assets/chessground.base.css";
import "chessground/assets/chessground.brown.css";
import "chessground/assets/chessground.cburnett.css";

export interface BoardProps {
  /** FEN of the position to display */
  fen: string;
  orientation: "white" | "black";
  /** last move as [from, to] for highlighting */
  lastMove?: [string, string] | null;
  /** which color the user may move; null disables interaction */
  movableColor?: "white" | "black" | "both" | null;
  /** called with the SAN of a legal user move */
  onMove?: (san: string) => void;
  /** green hint arrow(s) drawn on the board, e.g. from a Learn-mode hint */
  hintMove?: [string, string] | null;
  /** brief red flash for a wrong quiz answer */
  shake?: boolean;
}

function legalDests(chess: Chess): Map<Key, Key[]> {
  const dests = new Map<Key, Key[]>();
  for (const s of SQUARES) {
    const moves = chess.moves({ square: s as Square, verbose: true });
    if (moves.length) dests.set(s as Key, moves.map((m) => m.to as Key));
  }
  return dests;
}

export default function Board({
  fen,
  orientation,
  lastMove,
  movableColor = null,
  onMove,
  hintMove,
  shake,
}: BoardProps) {
  const ref = useRef<HTMLDivElement>(null);
  const apiRef = useRef<Api | null>(null);
  const onMoveRef = useRef(onMove);
  useEffect(() => {
    onMoveRef.current = onMove;
  }, [onMove]);

  useEffect(() => {
    if (!ref.current) return;
    const api = Chessground(ref.current, {
      coordinates: true,
      animation: { duration: 180 },
      // allow programmatic events (testing, demos); real input is unaffected
      trustAllEvents: true,
    });
    apiRef.current = api;
    return () => {
      api.destroy();
      apiRef.current = null;
    };
  }, []);

  useEffect(() => {
    const api = apiRef.current;
    if (!api) return;
    const chess = new Chess(fen.split(" ").length < 6 ? fen + " 0 1" : fen);
    const turn = chess.turn() === "w" ? "white" : "black";
    const canMove =
      movableColor !== null && (movableColor === "both" || movableColor === turn);

    const config: Config = {
      fen,
      orientation,
      turnColor: turn,
      check: chess.inCheck(),
      lastMove: (lastMove ?? undefined) as Key[] | undefined,
      movable: {
        free: false,
        color: canMove ? turn : undefined,
        dests: canMove ? legalDests(chess) : new Map(),
        showDests: true,
        events: {
          after: (orig, dest) => {
            const c = new Chess(fen.split(" ").length < 6 ? fen + " 0 1" : fen);
            let mv;
            try {
              mv = c.move({ from: orig as string, to: dest as string, promotion: "q" });
            } catch {
              return;
            }
            onMoveRef.current?.(mv.san);
          },
        },
      },
      selectable: { enabled: true },
      draggable: { enabled: true, showGhost: true },
      premovable: { enabled: false },
      drawable: {
        enabled: true,
        autoShapes: hintMove
          ? [{ orig: hintMove[0] as Key, dest: hintMove[1] as Key, brush: "green" }]
          : [],
      },
    };
    api.set(config);
  }, [fen, orientation, lastMove, movableColor, hintMove]);

  return (
    <div className={`board-shell ${shake ? "board-shake" : ""}`}>
      <div ref={ref} className="board-cg" />
    </div>
  );
}
