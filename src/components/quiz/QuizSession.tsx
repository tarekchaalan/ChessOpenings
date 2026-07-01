"use client";
/**
 * The quiz loop: the app plays the opponent's moves from real theory
 * (frequency-weighted) and the user must produce a correct book move.
 * Answers are graded for accuracy + speed, feed the SRS scheduler, and move
 * the player's rating. Works identically against the local (guest) engine
 * and the server RPCs (signed in).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  Check,
  Flag,
  Lightbulb,
  RotateCcw,
  Timer,
  TrendingDown,
  TrendingUp,
  X,
} from "lucide-react";
import Board from "@/components/Board";
import { useDataset, useQuizBackend } from "@/lib/hooks";
import { replayLine, LineState, pushSan } from "@/lib/line";
import { Dataset, nameForLine } from "@/lib/openings";
import type { SrsCard } from "@/lib/srs";
import type { AnswerResult, Challenge } from "@/lib/quiz/types";

const SESSION_TARGET = 12;
const OPPONENT_MOVE_MS = 450;
const FAST_REPLAY_MS = 130;

export interface QuizConfig {
  mode: "opening" | "review";
  openingId?: number;
  side?: "white" | "black";
  reviewCards?: SrsCard[];
}

type Phase = "loading" | "animating" | "awaiting" | "feedback" | "done" | "error";

interface MissedPosition {
  lineSans: string[];
  played: string;
  best: string;
  openingName: string;
}

export default function QuizSession({ config, title }: { config: QuizConfig; title: string }) {
  const { ds } = useDataset();
  const backend = useQuizBackend(ds);

  const [phase, setPhase] = useState<Phase>("loading");
  const [line, setLine] = useState<LineState>(() => replayLine([]));
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [feedback, setFeedback] = useState<AnswerResult | null>(null);
  const [hintShown, setHintShown] = useState(false);
  const [hintArrow, setHintArrow] = useState<[string, string] | null>(null);
  const [shake, setShake] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [answered, setAnswered] = useState(0);
  const [correctCount, setCorrectCount] = useState(0);
  const [streak, setStreak] = useState(0);
  const [ratingNow, setRatingNow] = useState<number | null>(null);
  const [ratingDeltaSum, setRatingDeltaSum] = useState(0);
  const [missed, setMissed] = useState<MissedPosition[]>([]);
  const [elapsed, setElapsed] = useState(0);

  const startedAt = useRef<number>(0);
  const reviewIdx = useRef(0);
  const animTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lineRef = useRef(line);
  useEffect(() => {
    lineRef.current = line;
  }, [line]);
  const openingName = useMemo(
    () => (ds ? nameForLine(ds, line.epds)?.name ?? null : null),
    [ds, line]
  );
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (animTimer.current) clearTimeout(animTimer.current);
    };
  }, []);

  const side: "white" | "black" =
    config.mode === "review"
      ? (config.reviewCards?.[reviewIdx.current]?.lineSans.length ?? 0) % 2 === 0
        ? "white"
        : "black"
      : config.side ?? "white";

  // ── position timer ─────────────────────────────────────────────────────
  useEffect(() => {
    if (phase !== "awaiting") return;
    const t = setInterval(() => setElapsed(Date.now() - startedAt.current), 250);
    return () => clearInterval(t);
  }, [phase]);

  /** Animate from the currently displayed line to the challenge position. */
  const animateTo = useCallback((target: Challenge, from: LineState) => {
    const targetSans = target.sans;
    const shared =
      from.sans.length <= targetSans.length &&
      from.sans.every((s, i) => s === targetSans[i]);

    let baseSans: string[];
    if (shared) {
      baseSans = from.sans;
    } else {
      // new line: jump near the end, then animate the last opponent move
      baseSans = targetSans.slice(0, Math.max(0, targetSans.length - 1));
      setLine(replayLine(baseSans));
    }
    const pending = targetSans.slice(baseSans.length);
    const stepDelay = shared ? OPPONENT_MOVE_MS : Math.max(FAST_REPLAY_MS, OPPONENT_MOVE_MS - pending.length * 40);

    setPhase("animating");
    const step = (sans: string[], remaining: string[]) => {
      if (!alive.current) return;
      if (!remaining.length) {
        setPhase("awaiting");
        setElapsed(0);
        startedAt.current = Date.now();
        return;
      }
      animTimer.current = setTimeout(() => {
        const next = [...sans, remaining[0]];
        setLine(replayLine(next));
        step(next, remaining.slice(1));
      }, stepDelay);
    };
    step(baseSans, pending);
  }, []);

  const finish = useCallback(() => setPhase("done"), []);

  /** Fetch the next challenge (continue line, new line, or next review card). */
  const nextChallenge = useCallback(
    async (prevId: string | null, currentLine: LineState) => {
      if (!backend) return;
      try {
        let ch: Challenge;
        if (config.mode === "review") {
          const cards = config.reviewCards ?? [];
          if (reviewIdx.current >= cards.length) {
            finish();
            return;
          }
          const card = cards[reviewIdx.current];
          ch = await backend.issueReview(card.openingId, card.epd, card.lineSans);
          if (ch.done) {
            // theory moved on; skip this stale card
            reviewIdx.current++;
            nextChallenge(null, currentLine);
            return;
          }
        } else {
          ch = await backend.issue(config.openingId!, side, prevId);
          if (ch.done) {
            // line exhausted — start a new line from the top
            if (prevId !== null) {
              nextChallenge(null, currentLine);
              return;
            }
            finish();
            return;
          }
        }
        if (!alive.current) return;
        setChallenge(ch);
        setFeedback(null);
        setHintShown(false);
        setHintArrow(null);
        animateTo(ch, currentLine);
      } catch (e) {
        setErrorMsg(e instanceof Error ? e.message : String(e));
        setPhase("error");
      }
    },
    [backend, config, side, animateTo, finish]
  );

  // kick off first challenge once the backend is ready
  const started = useRef(false);
  useEffect(() => {
    if (backend && !started.current) {
      started.current = true;
      nextChallenge(null, replayLine([]));
    }
  }, [backend, nextChallenge]);

  const submit = useCallback(
    async (san: string, gaveUp = false) => {
      if (!backend || !challenge || phase !== "awaiting") return;
      const ms = Math.max(200, Date.now() - startedAt.current);
      setPhase("feedback");
      try {
        const res = await backend.answer(challenge.id, gaveUp ? "--" : san, ms, hintShown);
        if (!alive.current) return;
        setFeedback(res);
        setAnswered((n) => n + 1);
        setRatingNow(res.rating);
        setRatingDeltaSum((s) => s + res.ratingDelta);

        const lineNow = lineRef.current;
        if (res.correct) {
          setCorrectCount((c) => c + 1);
          setStreak((s) => s + 1);
          const advanced = pushSan(lineNow, san);
          if (advanced) setLine(advanced);
          const doneCount = answered + 1;
          setTimeout(() => {
            if (!alive.current) return;
            if (config.mode === "review") reviewIdx.current++;
            if (doneCount >= SESSION_TARGET) finish();
            else nextChallenge(config.mode === "review" ? null : challenge.id, advanced ?? lineNow);
          }, 700);
        } else {
          setStreak(0);
          setShake(true);
          setTimeout(() => setShake(false), 400);
          setMissed((m) => [
            ...m,
            {
              lineSans: challenge.sans,
              played: gaveUp ? "(gave up)" : san,
              best: res.best,
              openingName: openingName ?? "",
            },
          ]);
          // show the book move on the board after a beat
          setTimeout(() => {
            if (!alive.current) return;
            const corrected = pushSan(lineNow, res.best);
            if (corrected) {
              setLine(corrected);
              setHintArrow(null);
            }
          }, 900);
        }
      } catch (e) {
        setErrorMsg(e instanceof Error ? e.message : String(e));
        setPhase("error");
      }
    },
    [backend, challenge, phase, hintShown, answered, config.mode, finish, nextChallenge] // eslint-disable-line react-hooks/exhaustive-deps
  );

  const continueAfterMiss = useCallback(() => {
    const doneCount = answered;
    if (doneCount >= SESSION_TARGET) {
      finish();
      return;
    }
    if (config.mode === "review") reviewIdx.current++;
    nextChallenge(null, lineRef.current);
  }, [answered, config.mode, finish, nextChallenge]);

  if (!ds || !backend) return <SessionSkeleton />;
  if (phase === "error") {
    return (
      <div className="py-20 text-center">
        <p className="text-danger mb-3">Something went wrong: {errorMsg}</p>
        <Link href="/quiz" className="text-accent underline text-sm">
          Back to quiz home
        </Link>
      </div>
    );
  }
  if (phase === "done") {
    return (
      <SessionSummary
        title={title}
        answered={answered}
        correct={correctCount}
        ratingDeltaSum={ratingDeltaSum}
        rating={ratingNow}
        missed={missed}
        isRemote={backend.kind === "remote"}
        retryHref={config.mode === "review" ? "/quiz" : `/quiz/${config.openingId}`}
      />
    );
  }

  const userTurn = phase === "awaiting";
  const seconds = Math.floor(elapsed / 1000);

  return (
    <div className="py-6 grid lg:grid-cols-[minmax(0,1fr)_380px] gap-6 items-start">
      <div className="mx-auto w-full max-w-[560px]">
        <div className="flex items-center justify-between mb-3 min-h-8 gap-3">
          <div className="min-w-0">
            <div className="font-medium truncate">{openingName ?? title}</div>
            <div className="text-xs text-muted">
              playing as <span className="capitalize font-medium">{side}</span>
            </div>
          </div>
          <div
            className={`flex items-center gap-1.5 font-mono text-sm px-2 py-1 rounded-md border ${
              userTurn && seconds >= 12
                ? "border-danger text-danger"
                : "border-edge text-muted"
            }`}
          >
            <Timer size={14} />
            {userTurn ? `${seconds}s` : "…"}
          </div>
        </div>

        <Board
          fen={line.fen}
          orientation={side}
          lastMove={line.lastMove}
          movableColor={userTurn ? side : null}
          onMove={(san) => submit(san)}
          hintMove={hintArrow}
          shake={shake}
        />

        <div className="flex gap-2 mt-3">
          <button
            onClick={() => {
              if (!ds || !challenge || phase !== "awaiting") return;
              setHintShown(true);
            }}
            disabled={!userTurn || hintShown}
            className="flex-1 h-9 flex items-center justify-center gap-2 rounded-md border border-edge bg-surface text-sm text-muted hover:text-foreground hover:bg-surface-2 transition-colors disabled:opacity-40"
            title="Show a hint (reduces the SRS grade)"
          >
            <Lightbulb size={15} /> {hintShown ? "hint shown below" : "Hint"}
          </button>
          <button
            onClick={() => submit("--", true)}
            disabled={!userTurn}
            className="flex-1 h-9 flex items-center justify-center gap-2 rounded-md border border-edge bg-surface text-sm text-muted hover:text-danger transition-colors disabled:opacity-40"
          >
            <Flag size={14} /> Give up
          </button>
        </div>

        {hintShown && userTurn && challenge && (
          <HintText ds={ds} challenge={challenge} />
        )}
      </div>

      <div className="space-y-4">
        <ScoreBoard
          answered={answered}
          target={SESSION_TARGET}
          correct={correctCount}
          streak={streak}
          rating={ratingNow}
          ratingDeltaSum={ratingDeltaSum}
          isRemote={backend.kind === "remote"}
        />

        {phase === "feedback" && feedback && (
          <FeedbackCard feedback={feedback} onContinue={continueAfterMiss} />
        )}
        {phase === "animating" && (
          <div className="rounded-lg border border-edge bg-surface p-4 text-sm text-muted">
            Opponent is playing theory…
          </div>
        )}
        {userTurn && !feedback && (
          <div className="rounded-lg border border-edge bg-surface p-4 text-sm">
            <span className="text-muted">Your move — play the book move for</span>{" "}
            <span className="font-medium capitalize">{side}</span>.
            <div className="text-xs text-muted mt-2">
              Answer fast for a bigger rating gain. Any named-theory move counts.
            </div>
          </div>
        )}

        <MoveHistory line={line} />
      </div>
    </div>
  );
}

function HintText({ ds, challenge }: { ds: Dataset; challenge: Challenge }) {
  // The hint reveals how many book moves exist and the first letter/piece of the top one.
  const node = ds.byEpd.get(challenge.epd);
  const moves = node !== undefined ? ds.nodes[node].moves.filter((m) => m.inTheory) : [];
  const top = moves[0];
  return (
    <div className="mt-2 text-xs rounded-md border border-gold/40 bg-surface px-3 py-2">
      {top ? (
        <>
          <span className="text-muted">Top book move starts with</span>{" "}
          <span className="font-mono font-bold text-gold">
            {top.san.startsWith("O") ? "O-O…" : top.san[0] === top.san[0].toUpperCase() && "NBRQK".includes(top.san[0]) ? top.san[0] : top.san[0] + "-pawn"}
          </span>
          {moves.length > 1 && (
            <span className="text-muted"> · {moves.length} moves are book here</span>
          )}
        </>
      ) : (
        <span className="text-muted">No stored hint for this position.</span>
      )}
    </div>
  );
}

function ScoreBoard({
  answered,
  target,
  correct,
  streak,
  rating,
  ratingDeltaSum,
  isRemote,
}: {
  answered: number;
  target: number;
  correct: number;
  streak: number;
  rating: number | null;
  ratingDeltaSum: number;
  isRemote: boolean;
}) {
  const acc = answered ? Math.round((correct / answered) * 100) : null;
  return (
    <div className="rounded-lg border border-edge bg-surface p-4">
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs uppercase tracking-wide text-muted">Session</span>
        <span className="text-xs text-muted font-mono">
          {answered}/{target}
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-surface-2 overflow-hidden mb-4">
        <div
          className="h-full bg-accent transition-all"
          style={{ width: `${(answered / target) * 100}%` }}
        />
      </div>
      <div className="grid grid-cols-3 gap-2 text-center">
        <div>
          <div className="text-lg font-semibold">{acc === null ? "—" : `${acc}%`}</div>
          <div className="text-[11px] text-muted">accuracy</div>
        </div>
        <div>
          <div className="text-lg font-semibold">{streak}</div>
          <div className="text-[11px] text-muted">streak</div>
        </div>
        <div>
          <div className="text-lg font-semibold flex items-center justify-center gap-1">
            {rating ?? "—"}
            {ratingDeltaSum !== 0 && (
              <span
                className={`text-xs flex items-center ${
                  ratingDeltaSum > 0 ? "text-accent" : "text-danger"
                }`}
              >
                {ratingDeltaSum > 0 ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
                {ratingDeltaSum > 0 ? "+" : ""}
                {ratingDeltaSum}
              </span>
            )}
          </div>
          <div className="text-[11px] text-muted">{isRemote ? "rating" : "practice rating"}</div>
        </div>
      </div>
    </div>
  );
}

function FeedbackCard({
  feedback,
  onContinue,
}: {
  feedback: AnswerResult;
  onContinue: () => void;
}) {
  if (feedback.correct) {
    return (
      <div className="rounded-lg border border-accent bg-accent-soft p-4 flex items-center gap-3">
        <span className="w-8 h-8 rounded-full bg-accent text-accent-fg grid place-items-center shrink-0">
          <Check size={17} strokeWidth={3} />
        </span>
        <div className="text-sm">
          <span className="font-medium">Book move!</span>{" "}
          <span className="text-muted">
            {feedback.ratingDelta > 0 ? `+${feedback.ratingDelta} rating` : ""}
          </span>
        </div>
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-danger/50 bg-surface p-4">
      <div className="flex items-center gap-3 mb-2">
        <span className="w-8 h-8 rounded-full bg-danger text-white grid place-items-center shrink-0">
          <X size={17} strokeWidth={3} />
        </span>
        <div className="text-sm">
          <div className="font-medium">
            Not theory — the book move was{" "}
            <span className="font-mono font-bold">{feedback.best}</span>
          </div>
          {feedback.expected.length > 1 && (
            <div className="text-xs text-muted mt-0.5">
              also accepted: {feedback.expected.filter((s) => s !== feedback.best).join(", ")}
            </div>
          )}
          <div className="text-xs text-muted mt-0.5">
            {feedback.ratingDelta} rating · this position will come back for review
          </div>
        </div>
      </div>
      <button
        onClick={onContinue}
        className="w-full h-9 rounded-md bg-accent text-accent-fg text-sm font-medium hover:opacity-90 transition-opacity"
      >
        Continue
      </button>
    </div>
  );
}

function MoveHistory({ line }: { line: LineState }) {
  if (!line.sans.length) return null;
  return (
    <div className="rounded-lg border border-edge bg-surface p-3 text-sm leading-relaxed">
      <div className="text-xs uppercase tracking-wide text-muted mb-1.5">Line so far</div>
      <div className="flex flex-wrap gap-x-1 font-mono text-[13px]">
        {line.sans.map((san, i) => (
          <span key={i}>
            {i % 2 === 0 && <span className="text-muted mr-0.5">{i / 2 + 1}.</span>}
            <span className={i === line.sans.length - 1 ? "font-bold text-accent" : ""}>{san}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

function SessionSkeleton() {
  return (
    <div className="py-6 grid lg:grid-cols-[minmax(0,1fr)_380px] gap-6 animate-pulse">
      <div className="mx-auto w-full max-w-[560px] aspect-square rounded-md bg-surface-2" />
      <div className="space-y-3">
        <div className="h-32 rounded-lg bg-surface-2" />
        <div className="h-24 rounded-lg bg-surface-2" />
      </div>
    </div>
  );
}

function SessionSummary({
  title,
  answered,
  correct,
  ratingDeltaSum,
  rating,
  missed,
  isRemote,
  retryHref,
}: {
  title: string;
  answered: number;
  correct: number;
  ratingDeltaSum: number;
  rating: number | null;
  missed: MissedPosition[];
  isRemote: boolean;
  retryHref: string;
}) {
  const acc = answered ? Math.round((correct / answered) * 100) : 0;
  return (
    <div className="max-w-xl mx-auto py-10">
      <h1 className="text-2xl font-semibold tracking-tight mb-1">Session complete</h1>
      <p className="text-muted text-sm mb-6">{title}</p>

      <div className="grid grid-cols-3 gap-3 mb-6">
        <div className="rounded-lg border border-edge bg-surface p-4 text-center">
          <div className="text-2xl font-semibold">{acc}%</div>
          <div className="text-xs text-muted mt-1">
            accuracy ({correct}/{answered})
          </div>
        </div>
        <div className="rounded-lg border border-edge bg-surface p-4 text-center">
          <div
            className={`text-2xl font-semibold ${
              ratingDeltaSum > 0 ? "text-accent" : ratingDeltaSum < 0 ? "text-danger" : ""
            }`}
          >
            {ratingDeltaSum > 0 ? "+" : ""}
            {ratingDeltaSum}
          </div>
          <div className="text-xs text-muted mt-1">rating change</div>
        </div>
        <div className="rounded-lg border border-edge bg-surface p-4 text-center">
          <div className="text-2xl font-semibold">{rating ?? "—"}</div>
          <div className="text-xs text-muted mt-1">{isRemote ? "rating" : "practice rating"}</div>
        </div>
      </div>

      {missed.length > 0 && (
        <div className="rounded-lg border border-edge bg-surface p-4 mb-6">
          <div className="text-xs uppercase tracking-wide text-muted mb-2">
            Missed positions — scheduled for review
          </div>
          <ul className="space-y-2 text-sm">
            {missed.map((m, i) => (
              <li key={i} className="flex items-baseline gap-2">
                <span className="font-mono text-xs text-muted truncate flex-1">
                  {m.lineSans.join(" ") || "start"}
                </span>
                <span className="font-mono text-danger line-through">{m.played}</span>
                <span className="font-mono font-bold text-accent">{m.best}</span>
                <Link
                  href={`/explore?line=${[...m.lineSans, m.best].join(",")}`}
                  className="text-xs text-accent underline shrink-0"
                >
                  explore
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex gap-2">
        <Link
          href={retryHref}
          className="flex-1 h-10 flex items-center justify-center gap-2 rounded-lg bg-accent text-accent-fg text-sm font-medium hover:opacity-90"
        >
          <RotateCcw size={15} /> Train again
        </Link>
        <Link
          href="/"
          className="flex-1 h-10 flex items-center justify-center rounded-lg border border-edge bg-surface text-sm hover:bg-surface-2"
        >
          Dashboard
        </Link>
      </div>
      {!isRemote && (
        <p className="text-xs text-muted mt-4 text-center">
          You&apos;re practicing as a guest — <Link href="/auth" className="text-accent underline">create an account</Link> to
          save progress across devices and join the leaderboard.
        </p>
      )}
    </div>
  );
}
