"use client";
/**
 * Static, lightweight board for cards and headers: plain DOM reusing the
 * chessground board/piece CSS (no chessground instance per card). With
 * `approach`, hovering/focusing replays the moves and rests on the final
 * position (desktop, no reduced motion).
 */
import { createElement, useEffect, useRef, useState } from "react";
import { Chess } from "chess.js";

import "chessground/assets/chessground.brown.css";
import "@/styles/mini-pieces.css";

const ROLE: Record<string, string> = { p: "pawn", n: "knight", b: "bishop", r: "rook", q: "queen", k: "king" };

function piecesOf(fen: string) {
  const out: { key: string; color: string; role: string; file: number; rank: number }[] = [];
  const rows = fen.split(" ")[0].split("/");
  rows.forEach((row, r) => {
    let f = 0;
    for (const ch of row) {
      if (/\d/.test(ch)) {
        f += Number(ch);
        continue;
      }
      out.push({ key: `${ch}${f}${r}`, color: ch === ch.toUpperCase() ? "white" : "black", role: ROLE[ch.toLowerCase()], file: f, rank: 7 - r });
      f++;
    }
  });
  return out;
}

export interface MiniBoardProps {
  /** final position (FEN or EPD) */
  fen: string;
  orientation?: "white" | "black";
  /** SAN moves from the start that lead to `fen`; enables the hover replay */
  approach?: string[];
  className?: string;
  label?: string;
}

const STEP_MS = 260;

export default function MiniBoard({ fen, orientation = "white", approach, className = "", label }: MiniBoardProps) {
  // replay frames are computed on the first hover, not for every card on mount
  const [frames, setFrames] = useState<{ key: string; list: string[] } | null>(null);
  const [frame, setFrame] = useState<number | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  const playRef = useRef<() => void>(() => {});
  useEffect(() => () => {
    if (timer.current) clearInterval(timer.current);
  }, []);

  const play = () => {
    if (!approach?.length || timer.current) return;
    if (typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    if (typeof window !== "undefined" && !window.matchMedia("(hover: hover)").matches) return;
    const key = approach.join(" ");
    let list = frames?.key === key ? frames.list : null;
    if (!list) {
      const c = new Chess();
      list = [c.fen()];
      for (const san of approach) {
        try {
          c.move(san);
        } catch {
          break;
        }
        list.push(c.fen());
      }
      setFrames({ key, list });
    }
    const total = list.length;
    let i = 0;
    setFrame(0);
    timer.current = setInterval(() => {
      i++;
      if (i >= total) {
        if (timer.current) clearInterval(timer.current);
        timer.current = null;
        setFrame(null);
        return;
      }
      setFrame(i);
    }, STEP_MS);
  };
  useEffect(() => {
    playRef.current = play;
  });
  // the card's link (not this div) takes focus: replay on its focus and hover too
  useEffect(() => {
    const host = boardRef.current?.closest("a, button");
    if (!host) return;
    const go = () => playRef.current();
    host.addEventListener("focus", go);
    host.addEventListener("mouseenter", go);
    return () => {
      host.removeEventListener("focus", go);
      host.removeEventListener("mouseenter", go);
    };
  }, []);

  const shown = frame !== null && frames ? frames.list[frame] ?? fen : fen;
  const pieces = piecesOf(shown);
  const flip = orientation === "black";
  return (
    <div
      ref={boardRef}
      className={`mini-board ${className}`}
      onMouseEnter={play}
      onFocus={play}
      role="img"
      aria-label={label ?? "Chess position"}
    >
      {createElement("cg-board")}
      {pieces.map((p) => (
        <span
          key={p.key}
          className={`mp ${p.color} ${p.role}`}
          style={{ transform: `translate(${(flip ? 7 - p.file : p.file) * 100}%, ${(flip ? p.rank : 7 - p.rank) * 100}%)` }}
        />
      ))}
    </div>
  );
}
