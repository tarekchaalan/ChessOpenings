"use client";
/**
 * The opening explorer: browsable variation graph with a keyboard-driven
 * board, per-move popularity + win rates from real master games, and
 * optional live Lichess masters stats.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Copy,
  Check,
  GraduationCap,
  RotateCcw,
  Repeat,
  Swords,
} from "lucide-react";
import Board from "@/components/Board";
import OpeningSearch from "@/components/OpeningSearch";
import WinBar from "@/components/WinBar";
import { useDataset } from "@/lib/hooks";
import { LineState, replayLine, pushSan } from "@/lib/line";
import { fetchMasterStats, LiveStats } from "@/lib/lichess";
import {
  Dataset,
  MoveStat,
  nameForLine,
  nodeAt,
  Opening,
  sansToPgn,
} from "@/lib/openings";

export default function ExplorerClient() {
  const { ds, error } = useDataset();
  if (error) {
    return (
      <div className="py-20 text-center text-muted">
        Failed to load the opening dataset. <span className="font-mono text-xs">{error}</span>
      </div>
    );
  }
  if (!ds) return <ExplorerSkeleton />;
  return <Explorer ds={ds} />;
}

function ExplorerSkeleton() {
  return (
    <div className="grid lg:grid-cols-[minmax(0,1fr)_380px] gap-6 py-6 animate-pulse">
      <div className="mx-auto w-full max-w-[560px] aspect-square rounded-md bg-surface-2" />
      <div className="space-y-3">
        <div className="h-10 rounded-lg bg-surface-2" />
        <div className="h-64 rounded-lg bg-surface-2" />
      </div>
    </div>
  );
}

function Explorer({ ds }: { ds: Dataset }) {
  const router = useRouter();
  const params = useSearchParams();
  const [line, setLine] = useState<LineState>(() =>
    replayLine((params.get("line") ?? "").split(",").filter(Boolean))
  );
  const [future, setFuture] = useState<string[]>([]);
  const [orientation, setOrientation] = useState<"white" | "black">("white");
  const [selected, setSelected] = useState(0);
  const [live, setLive] = useState<LiveStats | null>(null);
  const lineRef = useRef(line);
  useEffect(() => {
    lineRef.current = line;
  }, [line]);

  // ── URL sync (deep-linkable lines) ────────────────────────────────────
  useEffect(() => {
    const q = line.sans.length ? `?line=${line.sans.join(",")}` : "";
    router.replace(`/explore${q}`, { scroll: false });
  }, [line, router]);

  // ── live lichess stats (silent fallback) ──────────────────────────────
  useEffect(() => {
    let alive = true;
    setLive(null);
    const t = setTimeout(() => {
      fetchMasterStats(line.fen).then((s) => alive && setLive(s));
    }, 350);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [line.fen]);

  const node = nodeAt(ds, line.epd);
  const opening = nameForLine(ds, line.epds);

  const candidates: MoveStat[] = useMemo(() => {
    if (!node) return [];
    return [...node.moves].sort(
      (a, b) => Number(b.inTheory) - Number(a.inTheory) || b.games - a.games
    );
  }, [node]);

  useEffect(() => setSelected(0), [line.epd]);

  const play = useCallback(
    (san: string) => {
      const next = pushSan(lineRef.current, san);
      if (!next) return;
      setFuture((f) => (f[0] === san ? f.slice(1) : []));
      setLine(next);
    },
    []
  );

  const back = useCallback(() => {
    const cur = lineRef.current;
    if (!cur.sans.length) return;
    setFuture((f) => [cur.sans[cur.sans.length - 1], ...f]);
    setLine(replayLine(cur.sans.slice(0, -1)));
  }, []);

  const forward = useCallback(() => {
    setFuture((f) => {
      if (f.length) {
        const next = pushSan(lineRef.current, f[0]);
        if (next) {
          setLine(next);
          return f.slice(1);
        }
      }
      return f;
    });
  }, []);

  const reset = useCallback(() => {
    setFuture([]);
    setLine(replayLine([]));
  }, []);

  const jumpTo = useCallback((ply: number) => {
    const cur = lineRef.current;
    setFuture((f) => [...cur.sans.slice(ply), ...f]);
    setLine(replayLine(cur.sans.slice(0, ply)));
  }, []);

  // ── keyboard ──────────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable) return;
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        back();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        if (future.length) forward();
        else if (candidates[selected]) play(candidates[selected].san);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelected((s) => Math.min(s + 1, candidates.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelected((s) => Math.max(s - 1, 0));
      } else if (e.key === "Enter" && candidates[selected]) {
        e.preventDefault();
        play(candidates[selected].san);
      } else if (e.key.toLowerCase() === "f") {
        setOrientation((o) => (o === "white" ? "black" : "white"));
      } else if (e.key === "Home" || e.key === "Backspace") {
        e.preventDefault();
        reset();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [back, forward, play, reset, candidates, selected, future.length]);

  const pickOpening = (o: Opening) => {
    setFuture([]);
    setLine(replayLine(o.sans));
  };

  return (
    <div className="py-6 grid lg:grid-cols-[minmax(0,1fr)_400px] gap-6 items-start">
      {/* ── board column ── */}
      <div className="mx-auto w-full max-w-[560px] lg:sticky lg:top-20">
        <OpeningHeader opening={opening} line={line} />
        <Board
          fen={line.fen}
          orientation={orientation}
          lastMove={line.lastMove}
          movableColor="both"
          onMove={play}
        />
        <BoardControls
          onBack={back}
          onForward={forward}
          onReset={reset}
          onFlip={() => setOrientation((o) => (o === "white" ? "black" : "white"))}
          canBack={line.sans.length > 0}
          canForward={future.length > 0}
        />
        <MoveBreadcrumb line={line} onJump={jumpTo} />
      </div>

      {/* ── panel column ── */}
      <div className="space-y-4">
        <OpeningSearch ds={ds} onPick={pickOpening} />
        <PositionStats node={node} live={live} />
        <MovesPanel
          ds={ds}
          candidates={candidates}
          selected={selected}
          onHover={setSelected}
          onPlay={play}
          live={live}
        />
        {opening && (
          <div className="flex gap-2">
            <Link
              href={`/learn/${opening.id}`}
              className="flex-1 flex items-center justify-center gap-2 h-10 rounded-lg bg-accent text-accent-fg text-sm font-medium hover:opacity-90 transition-opacity"
            >
              <GraduationCap size={16} /> Learn this opening
            </Link>
            <Link
              href={`/quiz/${opening.id}`}
              className="flex-1 flex items-center justify-center gap-2 h-10 rounded-lg border border-edge bg-surface text-sm font-medium hover:bg-surface-2 transition-colors"
            >
              <Swords size={16} /> Quiz me
            </Link>
          </div>
        )}
        <KeyboardHints />
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
function OpeningHeader({ opening, line }: { opening: Opening | null; line: LineState }) {
  const [copied, setCopied] = useState<"pgn" | "fen" | null>(null);
  const copy = (what: "pgn" | "fen") => {
    navigator.clipboard
      .writeText(what === "pgn" ? sansToPgn(line.sans) : line.fen)
      .then(() => {
        setCopied(what);
        setTimeout(() => setCopied(null), 1200);
      });
  };
  return (
    <div className="flex items-center gap-2 mb-3 min-h-10">
      <BookOpen size={16} className="text-accent shrink-0" />
      <div className="min-w-0 flex-1">
        {opening ? (
          <>
            <div className="font-medium leading-tight truncate">{opening.name}</div>
            <div className="text-xs text-muted font-mono">{opening.eco}</div>
          </>
        ) : (
          <div className="text-muted text-sm">
            {line.sans.length ? "Out of named theory" : "Starting position — play a move or search an opening"}
          </div>
        )}
      </div>
      {line.sans.length > 0 && (
        <div className="flex gap-1 shrink-0">
          <button
            onClick={() => copy("pgn")}
            className="text-xs flex items-center gap-1 px-2 py-1 rounded-md border border-edge text-muted hover:text-foreground hover:bg-surface-2 transition-colors"
            title="Copy PGN"
          >
            {copied === "pgn" ? <Check size={12} /> : <Copy size={12} />} PGN
          </button>
          <button
            onClick={() => copy("fen")}
            className="text-xs flex items-center gap-1 px-2 py-1 rounded-md border border-edge text-muted hover:text-foreground hover:bg-surface-2 transition-colors"
            title="Copy FEN"
          >
            {copied === "fen" ? <Check size={12} /> : <Copy size={12} />} FEN
          </button>
        </div>
      )}
    </div>
  );
}

function BoardControls({
  onBack,
  onForward,
  onReset,
  onFlip,
  canBack,
  canForward,
}: {
  onBack: () => void;
  onForward: () => void;
  onReset: () => void;
  onFlip: () => void;
  canBack: boolean;
  canForward: boolean;
}) {
  const btn =
    "flex-1 h-9 grid place-items-center rounded-md border border-edge bg-surface text-muted hover:text-foreground hover:bg-surface-2 transition-colors disabled:opacity-40 disabled:pointer-events-none";
  return (
    <div className="flex gap-2 mt-3">
      <button className={btn} onClick={onReset} disabled={!canBack} title="Reset (Home)">
        <RotateCcw size={15} />
      </button>
      <button className={btn} onClick={onBack} disabled={!canBack} title="Back (←)">
        <ArrowLeft size={16} />
      </button>
      <button className={btn} onClick={onForward} disabled={!canForward} title="Forward (→)">
        <ArrowRight size={16} />
      </button>
      <button className={btn} onClick={onFlip} title="Flip board (F)">
        <Repeat size={15} />
      </button>
    </div>
  );
}

function MoveBreadcrumb({ line, onJump }: { line: LineState; onJump: (ply: number) => void }) {
  if (!line.sans.length) return null;
  return (
    <div className="mt-3 flex flex-wrap gap-x-1 gap-y-1 text-sm leading-relaxed">
      {line.sans.map((san, i) => (
        <span key={i} className="inline-flex items-baseline">
          {i % 2 === 0 && <span className="text-muted text-xs mr-1 font-mono">{i / 2 + 1}.</span>}
          <button
            onClick={() => onJump(i + 1)}
            className={`px-1 rounded font-mono ${
              i === line.sans.length - 1
                ? "bg-accent-soft text-accent font-semibold"
                : "hover:bg-surface-2"
            }`}
          >
            {san}
          </button>
        </span>
      ))}
    </div>
  );
}

function PositionStats({
  node,
  live,
}: {
  node: ReturnType<typeof nodeAt>;
  live: LiveStats | null;
}) {
  const games = live?.total ?? node?.games ?? 0;
  const white = live?.white ?? node?.white ?? 0;
  const draws = live?.draws ?? node?.draws ?? 0;
  const black = live?.black ?? node?.black ?? 0;
  return (
    <div className="rounded-lg border border-edge bg-surface p-3">
      <div className="flex items-baseline justify-between mb-2">
        <span className="text-xs uppercase tracking-wide text-muted">Position results</span>
        <span className="text-xs text-muted">
          {games ? `${games.toLocaleString()} games` : "no games on record"}
          {live ? " · lichess masters" : games ? " · 2026 pro games" : ""}
        </span>
      </div>
      <WinBar white={white} draws={draws} black={black} className="h-5" />
    </div>
  );
}

function MovesPanel({
  ds,
  candidates,
  selected,
  onHover,
  onPlay,
  live,
}: {
  ds: Dataset;
  candidates: MoveStat[];
  selected: number;
  onHover: (i: number) => void;
  onPlay: (san: string) => void;
  live: LiveStats | null;
}) {
  if (!candidates.length) {
    return (
      <div className="rounded-lg border border-edge bg-surface p-6 text-center text-sm text-muted">
        End of recorded theory — play on freely, or step back.
      </div>
    );
  }
  const total = candidates.reduce((s, m) => s + m.games, 0);
  return (
    <div className="rounded-lg border border-edge bg-surface overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-xs text-muted border-b border-edge">
            <th className="text-left font-normal px-3 py-2">Move</th>
            <th className="text-right font-normal px-2 py-2 w-16">Games</th>
            <th className="text-left font-normal px-3 py-2 w-[45%]">Results (W/D/B)</th>
          </tr>
        </thead>
        <tbody>
          {candidates.map((m, i) => {
            const liveM = live?.moves.find((lm) => lm.san === m.san);
            const g = liveM?.total ?? m.games;
            const pct = total > 0 && m.games > 0 ? Math.round((m.games / total) * 100) : null;
            const destOpening =
              m.to >= 0 && ds.nodes[m.to].openingIdx !== -1
                ? ds.openings[ds.nodes[m.to].openingIdx]
                : null;
            return (
              <tr
                key={m.san}
                onMouseEnter={() => onHover(i)}
                onClick={() => onPlay(m.san)}
                className={`cursor-pointer border-b border-edge last:border-0 transition-colors ${
                  i === selected ? "bg-accent-soft" : "hover:bg-surface-2"
                }`}
              >
                <td className="px-3 py-2">
                  <div className="flex items-center gap-2">
                    <span className={`font-mono font-semibold ${m.inTheory ? "" : "text-muted"}`}>
                      {m.san}
                    </span>
                    {!m.inTheory && (
                      <span className="text-[10px] uppercase tracking-wide text-muted border border-edge rounded px-1">
                        off book
                      </span>
                    )}
                  </div>
                  {destOpening && (
                    <div className="text-xs text-muted truncate max-w-44" title={destOpening.name}>
                      → {destOpening.name}
                    </div>
                  )}
                </td>
                <td className="px-2 py-2 text-right font-mono text-xs text-muted">
                  {g ? g.toLocaleString() : "—"}
                  {pct !== null && <div className="text-[10px]">{pct}%</div>}
                </td>
                <td className="px-3 py-2">
                  <WinBar
                    white={liveM?.white ?? m.white}
                    draws={liveM?.draws ?? m.draws}
                    black={liveM?.black ?? m.black}
                    className="h-4"
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function KeyboardHints() {
  const kbd = "px-1.5 py-0.5 rounded border border-edge bg-surface-2 font-mono text-[10px]";
  return (
    <p className="text-xs text-muted leading-relaxed hidden lg:block">
      <span className={kbd}>←</span> back · <span className={kbd}>→</span>/<span className={kbd}>Enter</span> play
      selected · <span className={kbd}>↑↓</span> choose move · <span className={kbd}>F</span> flip ·{" "}
      <span className={kbd}>Home</span> reset — or drag pieces on the board.
    </p>
  );
}
