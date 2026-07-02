"use client";
/**
 * Learn mode: a guided walkthrough of an opening's mainline with move-by-move
 * explanations, next-expected-move hints, and branch points into key sidelines.
 * The user can advance with buttons/keys or by playing the expected move on
 * the board.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Chess, Move } from "chess.js";
import { getPrefs, setPref } from "@/lib/prefs";
import {
  ArrowLeft,
  ArrowRight,
  CornerDownRight,
  Eye,
  EyeOff,
  GraduationCap,
  PartyPopper,
  RotateCcw,
  Swords,
} from "lucide-react";
import Board from "@/components/Board";
import WinBar from "@/components/WinBar";
import { useDataset } from "@/lib/hooks";
import { explainMove, fenToEpd, openingBlurb } from "@/lib/explain";
import { greedyMainline } from "@/lib/mainline";
import {
  Dataset,
  defaultSide,
  Family,
  familyNextMoves,
  familyOf,
  nameForLine,
  nodeAt,
  START_EPD,
  sansToPgn,
} from "@/lib/openings";
import { START_FEN } from "@/lib/line";

interface WalkStep {
  san: string;
  from: string;
  to: string;
  fenAfter: string;
  epdAfter: string;
  explanation: string;
}

export default function LearnClient({ openingId }: { openingId: number }) {
  const { ds } = useDataset();
  if (!ds) {
    return (
      <div className="py-6 grid lg:grid-cols-[minmax(0,1fr)_400px] gap-6 animate-pulse">
        <div className="mx-auto w-full max-w-[560px] aspect-square rounded-md bg-surface-2" />
        <div className="h-96 rounded-lg bg-surface-2" />
      </div>
    );
  }
  const opening = ds.openings[openingId];
  if (!opening) {
    return (
      <div className="py-20 text-center text-muted">
        Opening not found.{" "}
        <Link href="/learn" className="text-accent underline">
          Back to the catalog
        </Link>
      </div>
    );
  }
  return <Walkthrough ds={ds} openingId={openingId} />;
}

function buildSteps(ds: Dataset, sans: string[]): WalkStep[] {
  const chess = new Chess();
  const steps: WalkStep[] = [];
  const prefix: string[] = [];
  for (const san of sans) {
    let mv: Move;
    try {
      mv = chess.move(san);
    } catch {
      break;
    }
    steps.push({
      san: mv.san,
      from: mv.from,
      to: mv.to,
      fenAfter: chess.fen(),
      epdAfter: fenToEpd(chess.fen()),
      explanation: explainMove(ds, prefix, mv, chess),
    });
    prefix.push(mv.san);
  }
  return steps;
}

function Walkthrough({ ds, openingId }: { ds: Dataset; openingId: number }) {
  const opening = ds.openings[openingId];
  const family: Family = useMemo(() => familyOf(ds, openingId), [ds, openingId]);
  const side = defaultSide(opening);

  const [lineSans, setLineSans] = useState<string[]>(() => greedyMainline(ds, family, opening.sans));
  const [ply, setPly] = useState(0);
  const [hints, setHintsState] = useState(true);
  const [shake, setShake] = useState(false);

  // default from device preference; toggling remembers the choice
  useEffect(() => {
    setHintsState(getPrefs().learnHints);
  }, []);
  const setHints = useCallback((update: boolean | ((h: boolean) => boolean)) => {
    setHintsState((prev) => {
      const next = typeof update === "function" ? update(prev) : update;
      setPref("learnHints", next);
      return next;
    });
  }, []);

  const steps = useMemo(() => buildSteps(ds, lineSans), [ds, lineSans]);
  const done = ply >= steps.length;
  const fen = ply === 0 ? START_FEN : steps[ply - 1].fenAfter;
  const epd = ply === 0 ? START_EPD : steps[ply - 1].epdAfter;
  const nextStep = done ? null : steps[ply];
  const lastMove: [string, string] | null = ply > 0 ? [steps[ply - 1].from, steps[ply - 1].to] : null;

  const currentName = useMemo(
    () => nameForLine(ds, [START_EPD, ...steps.slice(0, ply).map((s) => s.epdAfter)]) ?? opening,
    [ds, steps, ply, opening]
  );

  // sidelines available at the current position (other than the mainline move)
  const alternatives = useMemo(() => {
    const prefix = steps.slice(0, ply).map((s) => s.san);
    return familyNextMoves(ds, family, prefix, epd)
      .filter((m) => m.san !== nextStep?.san)
      .slice(0, 4)
      .map((m) => {
        const chess = new Chess(fen);
        try {
          chess.move(m.san);
        } catch {
          return null;
        }
        const destEpd = fenToEpd(chess.fen());
        const destNode = nodeAt(ds, destEpd);
        const named = destNode && destNode.openingIdx !== -1 ? ds.openings[destNode.openingIdx] : null;
        return { san: m.san, games: m.games, name: named?.name ?? null };
      })
      .filter(Boolean) as { san: string; games: number; name: string | null }[];
  }, [ds, family, steps, ply, epd, fen, nextStep]);

  const advance = useCallback(() => setPly((p) => Math.min(p + 1, steps.length)), [steps.length]);
  const backOne = useCallback(() => setPly((p) => Math.max(p - 1, 0)), []);

  const onUserMove = useCallback(
    (san: string) => {
      if (!nextStep) return;
      if (san === nextStep.san) {
        advance();
      } else {
        setShake(true);
        setTimeout(() => setShake(false), 400);
      }
    },
    [nextStep, advance]
  );

  const branchTo = useCallback(
    (san: string) => {
      const prefix = [...steps.slice(0, ply).map((s) => s.san), san];
      setLineSans(greedyMainline(ds, family, prefix));
      setPly(prefix.length);
    },
    [ds, family, steps, ply]
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") return;
      if (e.key === "ArrowRight" || e.key === " " || e.key === "Enter") {
        e.preventDefault();
        advance();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        backOne();
      } else if (e.key.toLowerCase() === "h") {
        setHints((h) => !h);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [advance, backOne]);

  const node = nodeAt(ds, epd);

  return (
    <div className="py-6 grid lg:grid-cols-[minmax(0,1fr)_400px] gap-6 items-start">
      <div className="mx-auto w-full max-w-[560px] lg:sticky lg:top-20">
        <div className="flex items-center gap-2 mb-3 min-h-10">
          <GraduationCap size={18} className="text-accent shrink-0" />
          <div className="min-w-0">
            <div className="font-medium leading-tight truncate">{currentName.name}</div>
            <div className="text-xs text-muted font-mono">{currentName.eco}</div>
          </div>
          <div className="ml-auto text-xs text-muted whitespace-nowrap">
            move {Math.min(ply + 1, steps.length)} / {steps.length}
          </div>
        </div>
        <Board
          fen={fen}
          orientation={side}
          lastMove={lastMove}
          movableColor="both"
          onMove={onUserMove}
          hintMove={hints && nextStep ? [nextStep.from, nextStep.to] : null}
          shake={shake}
        />
        <div className="flex gap-2 mt-3">
          <ControlBtn onClick={() => setPly(0)} disabled={ply === 0} title="Restart">
            <RotateCcw size={15} />
          </ControlBtn>
          <ControlBtn onClick={backOne} disabled={ply === 0} title="Back (←)">
            <ArrowLeft size={16} />
          </ControlBtn>
          <ControlBtn onClick={advance} disabled={done} title="Next (→ / Space)">
            <ArrowRight size={16} />
          </ControlBtn>
          <button
            onClick={() => setHints((h) => !h)}
            title="Toggle hint arrows (H)"
            className={`flex-1 h-9 flex items-center justify-center gap-2 rounded-md border text-xs transition-colors ${
              hints
                ? "border-accent text-accent bg-accent-soft"
                : "border-edge bg-surface text-muted hover:text-foreground"
            }`}
          >
            {hints ? <Eye size={14} /> : <EyeOff size={14} />} hints
          </button>
        </div>
        <ProgressDots total={steps.length} current={ply} />
      </div>

      <div className="space-y-4">
        {done ? (
          <div className="rounded-lg border border-accent bg-accent-soft p-5">
            <div className="flex items-center gap-2 text-accent font-medium mb-2">
              <PartyPopper size={18} /> Line complete!
            </div>
            <p className="text-sm mb-4">
              You walked the full line of the <strong>{currentName.name}</strong>. Time to make it
              stick — quiz yourself and the scheduler will bring back anything you miss.
            </p>
            <div className="flex gap-2">
              <Link
                href={`/quiz/${openingId}`}
                className="flex-1 flex items-center justify-center gap-2 h-10 rounded-lg bg-accent text-accent-fg text-sm font-medium hover:opacity-90"
              >
                <Swords size={15} /> Quiz this opening
              </Link>
              <button
                onClick={() => setPly(0)}
                className="px-4 h-10 rounded-lg border border-edge bg-surface text-sm hover:bg-surface-2"
              >
                Replay
              </button>
            </div>
          </div>
        ) : (
          <div className="rounded-lg border border-edge bg-surface p-4">
            <div className="text-xs tracking-wide text-muted mb-2">
              {ply === 0 ? (
                <span className="uppercase">About this opening</span>
              ) : (
                <span className="font-mono font-semibold text-foreground">
                  {moveLabel(ply - 1)} {steps[ply - 1].san}
                </span>
              )}
            </div>
            <p className="text-sm leading-relaxed">
              {ply === 0 ? openingBlurb(ds, opening) + " Follow the green arrow — or press → — to walk the mainline." : steps[ply - 1].explanation}
            </p>
            {nextStep && hints && (
              <p className="text-xs text-muted mt-3">
                Next expected move: <span className="font-mono font-semibold text-accent">{moveLabel(ply)} {nextStep.san}</span>
              </p>
            )}
          </div>
        )}

        {!done && alternatives.length > 0 && (
          <div className="rounded-lg border border-edge bg-surface p-4">
            <div className="text-xs uppercase tracking-wide text-muted mb-2">
              Key sidelines here
            </div>
            <div className="space-y-1">
              {alternatives.map((a) => (
                <button
                  key={a.san}
                  onClick={() => branchTo(a.san)}
                  className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm hover:bg-surface-2 transition-colors text-left"
                >
                  <CornerDownRight size={13} className="text-muted shrink-0" />
                  <span className="font-mono font-semibold">{a.san}</span>
                  <span className="text-xs text-muted truncate">{a.name ?? "sideline"}</span>
                  {a.games > 0 && (
                    <span className="ml-auto text-xs text-muted font-mono shrink-0">
                      {a.games.toLocaleString()}
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>
        )}

        {node && node.games > 0 && (
          <div className="rounded-lg border border-edge bg-surface p-3">
            <div className="flex items-baseline justify-between mb-2 text-xs text-muted">
              <span className="uppercase tracking-wide">Results from here</span>
              <span>{node.games.toLocaleString()} pro games</span>
            </div>
            <WinBar white={node.white} draws={node.draws} black={node.black} className="h-4" />
          </div>
        )}

        <div className="text-xs text-muted leading-relaxed">
          <span className="font-mono">{sansToPgn(lineSans.slice(0, ply)) || "—"}</span>
        </div>
      </div>
    </div>
  );
}

function moveLabel(plyIdx: number): string {
  return plyIdx % 2 === 0 ? `${plyIdx / 2 + 1}.` : `${(plyIdx - 1) / 2 + 1}…`;
}

function ControlBtn({
  children,
  onClick,
  disabled,
  title,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  title: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="flex-1 h-9 grid place-items-center rounded-md border border-edge bg-surface text-muted hover:text-foreground hover:bg-surface-2 transition-colors disabled:opacity-40 disabled:pointer-events-none"
    >
      {children}
    </button>
  );
}

function ProgressDots({ total, current }: { total: number; current: number }) {
  if (total < 2) return null;
  return (
    <div className="flex gap-1 mt-3">
      {Array.from({ length: total }).map((_, i) => (
        <div
          key={i}
          className={`h-1 flex-1 rounded-full transition-colors ${
            i < current ? "bg-accent" : "bg-surface-2"
          }`}
        />
      ))}
    </div>
  );
}
