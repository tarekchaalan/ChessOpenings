"use client";
/**
 * The trainer screen (§3.2 D): board + name breadcrumb + move chips +
 * controls on the left, the Coach / Lines / Stats panel on the right (a
 * bottom sheet on phones). Drives one TrainerSession: fast-forward and
 * opponent timers, persistence of card events, scrubbing, keyboard.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronLeft, ChevronRight, ChevronUp, ChevronDown, Keyboard, RotateCcw, Settings, ArrowUpDown, Check, Star } from "lucide-react";
import Board from "@/components/Board";
import WinBar from "@/components/WinBar";
import CoachFeed from "./CoachFeed";
import { getPrefs, usePrefs } from "@/lib/prefs";
import { useReducedMotion } from "@/lib/motion";
import { playMoveSound } from "@/lib/sound";
import { arrowShapes, badgeShape } from "@/lib/coach/brushes";
import { courseHref, findSystem, hubHref, loadCourse, modelOf, parseCourseId, systemsFor, type Course, type RawHubSummary, type RawSystemSummary } from "@/lib/courses-client";
import { normSan } from "@/lib/openings-build/model";
import type { Dataset } from "@/lib/openings";
import { chapterTrunk, definesName, moveLabel, nameAt, TrainerSession, type ActionKind, type FeedMsg, type Mode } from "@/lib/trainer/session";
import { drillPick, nextLearnLine, reviewQueue, startsAtMove, type TierKey } from "@/lib/trainer/plan";
import { sanToWords } from "@/lib/trainer/words";
import { linesLearnedToday } from "@/lib/srs/workload";
import { gradeOnServer, serverMode, useServerMode } from "@/lib/train-sync";
import { allCards, allCourseProgress, courseProgress, getCard, gradeCard, introduceCard, markLine, overridesFor, setOverride, useProgressVersion } from "@/lib/progress/store";
import { annotationsOf, courseFor, globalQueue, learnStart } from "@/lib/trainer/client";

export interface Run {
  key: number;
  /** the dataset the run was planned on (node indices are only valid within it) */
  ds: Dataset;
  hub: RawHubSummary;
  system: RawSystemSummary;
  course: Course;
  mode: Mode;
  line: number;
  startPly: number;
  endPly?: number;
  graded?: Set<number>;
  /** Review: lines left in the queue after this one */
  queueLeft?: number;
  tier: TierKey;
  chapters: number[] | null;
  fromStart: boolean;
  /** Drill only below this position (node of run.ds) */
  under?: number | null;
  /** cross-course review (/train/review) */
  global?: boolean;
  /** "Make it my move": replay this move once the session reaches startPly */
  pendingMove?: string;
  /** coach note posted before the pending move */
  notice?: { title: string; text: string };
}

const MODE_LABEL: Record<Mode, string> = { learn: "Learn", recall: "Recall", review: "Review", drill: "Drill" };
const TRY_AGAIN_MIN_MS = 900;

export default function TrainerView({ ds, run, start }: { ds: Dataset; run: Run; start: (r: Omit<Run, "key">) => void }) {
  const prefs = usePrefs();
  const router = useRouter();
  const model = modelOf(ds);
  const { course } = run;
  const side = course.side;
  const line = course.lines[run.line];
  useProgressVersion(); // line ✓ marks and branch dots follow the store

  const reduced = useReducedMotion();

  const [s] = useState(() => {
    const p = getPrefs();
    const enrolled = Object.keys(allCourseProgress()).filter((id) => id !== course.id);
    const sess = new TrainerSession({
      model,
      course,
      line,
      mode: run.mode,
      annotations: annotationsOf(ds),
      startPly: run.startPly,
      endPly: run.endPly,
      gradedPlies: run.graded,
      playArrows: p.learnHints,
      lineDone: (li) => !!courseProgress(course.id).lines[course.lines[li].id]?.learnedAt,
      repsOf: (epd, answer) => getCard(side, epd, answer)?.reps ?? 0,
      switchSystem: (node, norm) => {
        const other = systemsFor(ds, run.hub, side).filter((x) => x.slug !== run.system.slug && x.choices.some(([n, m]) => n === node && m === norm));
        return (other.find((x) => x.parent < 0) ?? other[0])?.slug ?? null;
      },
      enrolledMove: (epd, norm) => {
        const node = model.byEpd.get(epd);
        if (node === undefined) return null;
        for (const id of enrolled) {
          const pc = parseCourseId(id);
          const sys = pc && pc.side === side ? findSystem(ds, pc.hub, pc.system, pc.side) : null;
          if (!sys) continue;
          const book = courseFor(ds, sys).bookMoves.get(node);
          if (book && normSan(book) === norm) return { courseName: sys.name, san: book };
        }
        return null;
      },
    });
    if (run.pendingMove) {
      sess.skipFF();
      sess.note(
        run.notice?.title ?? "Your alternative",
        run.notice?.text ?? `${moveLabel(sess.ply, run.pendingMove)} is now your move in this course. Revert it on the course page.`
      );
      sess.play(run.pendingMove);
    }
    return sess;
  });
  const [ver, setVer] = useState(0);
  const bump = useCallback(() => setVer((v) => v + 1), []);
  useEffect(() => {
    if (!performance.getEntriesByName("cot:move", "mark").length) return;
    // rAF + a macrotask ≈ just after the frame that shows the feedback
    let t: ReturnType<typeof setTimeout> | undefined;
    const id = requestAnimationFrame(() => {
      t = setTimeout(() => {
        if (!performance.getEntriesByName("cot:move", "mark").length) return;
        performance.measure("cot:move-feedback", "cot:move");
        performance.clearMarks("cot:move");
      }, 0);
    });
    return () => {
      cancelAnimationFrame(id);
      clearTimeout(t);
    };
  }, [ver]);
  const [view, setView] = useState<{ ply: number; id: number | null } | null>(null);
  const [tab, setTab] = useState<"coach" | "lines" | "stats">("coach");
  const [flipped, setFlipped] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [help, setHelp] = useState(false);
  const [announce, setAnnounce] = useState("");
  const ended = useRef(false);

  const where = useMemo(() => ({ courseId: course.id, lineId: line.id }), [course.id, line.id]);
  const flush = useCallback(() => {
    for (const e of s.drainEvents()) {
      if (e.type === "introduce") introduceCard(side, e.epd, e.answer, where);
      else {
        const retention = getPrefs().targetRetention;
        gradeCard(side, e.epd, e.answer, e.grade!, where, retention);
        // signed in: the server re-grades the same outcome (ADR 0004); its card replaces ours
        if (e.outcome && serverMode() === "on") {
          void gradeOnServer({ courseId: where.courseId, lineId: where.lineId, sans: line.sans.slice(0, e.ply), expected: line.sans[e.ply], outcome: e.outcome, retention });
        }
      }
    }
  }, [s, side, where, line]);
  const after = useCallback(() => {
    flush();
    bump();
  }, [flush, bump]);

  const moverColor = (ply: number) => (ply % 2 === 0 ? "white" : "black");

  // a "Make it my move" replay happens in the initializer: persist it right away
  useEffect(() => {
    flush();
  }, [flush]);

  // ── timers: fast-forward and opponent replies ─────────────────────────────
  useEffect(() => {
    if (s.phase === "ff") {
      const t = setTimeout(() => {
        s.ffStep();
        after();
      }, reduced ? 40 : 120);
      return () => clearTimeout(t);
    }
    if (s.phase === "opponent") {
      const last = s.feed[s.feed.length - 1];
      const branch = last?.kind === "branch" && last.ply === s.ply;
      const anim = reduced ? 0 : 200;
      const t = setTimeout(() => {
        const ply = s.ply;
        const san = s.bookSan();
        s.opponentMove();
        playMoveSound(san, false);
        setAnnounce(sanToWords(san, moverColor(ply)));
        after();
      }, prefs.replyDelayMs + anim + (branch ? 1400 : 0));
      return () => clearTimeout(t);
    }
    if (s.phase === "end" && !ended.current) {
      ended.current = true;
      if (run.mode !== "drill") markLine(course.id, line.id, run.mode === "learn" ? "learned" : "reviewed");
      bump();
    }
  }, [ver, s, after, bump, reduced, prefs.replyDelayMs, run.mode, course.id, line.id]);

  // ── actions ───────────────────────────────────────────────────────────────
  const live = view === null;
  const playMove = useCallback(
    (san: string): string => {
      if (!live) return "ignored";
      performance.mark("cot:move"); // move → feedback budget (§3, ≤ 50 ms), measured after the next paint
      const ply = s.ply;
      const r = s.play(san);
      if (r === "ignored" || r === "illegal") performance.clearMarks("cot:move");
      if (r === "correct" || r === "wrong" || r === "soft") {
        playMoveSound(san, true);
        setAnnounce(sanToWords(san, moverColor(ply)) + (r === "correct" ? ", correct" : r === "soft" ? ", also theory" : ", not the book move"));
      }
      after();
      return r;
    },
    [s, after, live]
  );

  /** The wrong move stays on the board ≥ 900 ms, whatever takes it back. */
  const afterWrong = useCallback(
    (fn: () => void) => {
      const w = s.wrong;
      const wait = w ? Math.max(0, TRY_AGAIN_MIN_MS - (Date.now() - w.at)) : 0;
      setTimeout(() => {
        fn();
        after();
      }, wait);
    },
    [s, after]
  );
  const tryAgain = useCallback(() => {
    if (s.wrong) afterWrong(() => s.tryAgain());
  }, [s, afterWrong]);
  const showMe = useCallback(() => afterWrong(() => s.showMe()), [s, afterWrong]);

  const makeMine = useCallback(() => {
    const w = s.wrong;
    if (!w) return;
    const ply = s.ply;
    const node = line.nodes[ply];
    const norm = normSan(w.san);
    const prefix = [...line.sans.slice(0, ply).map(normSan), norm];
    const matches = (c: Course) => c.lines.find((l) => prefix.every((x, i) => normSan(l.sans[i] ?? "") === x));
    if (course.systemNodes.has(node)) {
      const slug = s.ctx.switchSystem?.(node, norm);
      const sys = slug ? systemsFor(ds, run.hub, side).find((x) => x.slug === slug) : null;
      if (!sys) return;
      const other = courseFor(ds, sys);
      const l = matches(other) ?? other.lines[0];
      router.push(`/train/${run.hub.slug}/${sys.slug}/${side}?mode=learn&line=${l.id}&at=${ply}&play=${encodeURIComponent(w.san)}`);
      return;
    }
    // derive with the override first; only keep it if the course then has the line
    const epd = model.nodes[node].epd;
    const trial = loadCourse(ds, run.system, { ...overridesFor(course.id), [epd]: norm });
    if (!trial || !matches(trial)) {
      s.note("Can't make that your move", "This course can't be rebuilt around it. Explore the line instead.");
      after();
      return;
    }
    setOverride(course.id, epd, norm);
    const nc = courseFor(ds, run.system);
    const nl = matches(nc)!;
    start({ ...run, course: nc, line: nl.idx, startPly: ply, pendingMove: w.san, mode: "learn", endPly: undefined, graded: undefined });
  }, [s, line, course, ds, run, side, router, model, start, after]);

  const onAction = useCallback(
    (a: ActionKind, m: FeedMsg) => {
      if (a === "try") tryAgain();
      else if (a === "show") showMe();
      else if (a === "skip-ff") {
        s.skipFF();
        after();
      } else if (a === "make-mine") makeMine();
      else if (a === "explore" && m.wrong) {
        const moves = [...line.sans.slice(0, m.ply), m.wrong.san].join(",");
        router.push(`/explore?line=${encodeURIComponent(moves)}`);
      }
    },
    [tryAgain, showMe, s, after, makeMine, line, router]
  );

  const switchLine = useCallback(
    (li: number, atPly?: number) => {
      const startPly =
        atPly ?? (run.mode === "drill" ? (run.fromStart ? 0 : chapterTrunk(course, course.lines[li])) : learnStart(ds, course, li, getPrefs().skipKnown));
      start({ ...run, line: li, startPly, mode: run.mode === "drill" ? "drill" : "learn", endPly: undefined, graded: undefined, pendingMove: undefined });
    },
    [run, course, ds, start]
  );

  const restart = useCallback(() => {
    // plies graded in this run stay graded: a restart can't turn a lapse into a Good
    let graded = run.graded;
    if (run.mode === "recall" || run.mode === "review") {
      const base = run.graded ?? new Set(s.learnerPlies(run.startPly, s.endPly));
      graded = new Set([...base].filter((p) => !s.gradedDone.has(p)));
    }
    start({ ...run, graded, pendingMove: undefined });
  }, [run, start, s]);

  // ── what the board shows ─────────────────────────────────────────────────
  const livePly = s.ply;
  const shownPly = view ? view.ply : livePly;
  const viewMsg = view?.id ? s.feed.find((m) => m.id === view.id) ?? null : null;
  const fen = view ? s.fens[view.ply] : s.wrong ? s.wrong.fen : s.fens[livePly];
  const lastMove: [string, string] | null = view
    ? view.ply > 0
      ? [s.moves[view.ply - 1].from, s.moves[view.ply - 1].to]
      : null
    : s.wrong
      ? [s.wrong.from, s.wrong.to]
      : livePly > 0
        ? [s.moves[livePly - 1].from, s.moves[livePly - 1].to]
        : null;
  const shapes = useMemo(() => {
    if (view) return arrowShapes(viewMsg?.arrows ?? []);
    return [
      ...arrowShapes(s.arrows),
      ...(s.okSquare ? [badgeShape(s.okSquare, "ok")] : []),
      ...(s.wrong ? [badgeShape(s.wrong.to, s.wrong.soft ? "bad" : "bad")] : []),
    ];
    // the session mutates in place; `ver` is its version
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ver, view, viewMsg]);
  const tints = view ? viewMsg?.tints : s.tints;
  const orientation = flipped ? (side === "white" ? "black" : "white") : side;
  const canMove = live && s.phase === "await";

  const scrub = useCallback(
    (ply: number) => {
      const p = Math.max(0, Math.min(livePly, ply));
      setView(p === livePly && !s.wrong ? null : { ply: p, id: null });
    },
    [livePly, s.wrong]
  );
  const selectMsg = useCallback(
    (m: FeedMsg) => {
      if (m.ply === livePly && !view && !m.arrows?.length) return;
      setView({ ply: Math.min(m.ply, livePly), id: m.id });
    },
    [livePly, view]
  );

  // ── end-of-line actions ──────────────────────────────────────────────────
  const isEnd = s.phase === "end";
  const endQueue = useMemo(() => (isEnd && run.global ? globalQueue(ds, getPrefs().targetRetention) : null), [isEnd, run.global, ds]);
  const learned = (id: string) => !!courseProgress(course.id).lines[id]?.learnedAt;
  const endActions: { label: string; go: () => void; id: string }[] = [];
  if (s.phase === "end") {
    if (run.mode === "learn") {
      endActions.push({ id: "recall", label: "Recall it now", go: () => start({ ...run, mode: "recall", pendingMove: undefined }) });
    }
    if (run.mode === "learn" || run.mode === "recall") {
      const next = nextLearnLine(course, run.tier, learned, line.idx);
      if (next) {
        endActions.push({
          id: "next",
          // past the daily new-line cap (§4.9) it's offered, not suggested
          label: `${linesLearnedToday(allCourseProgress()) >= getPrefs().dailyNewLines ? "Today’s new lines are done. Learn one more anyway" : "Next line"}: ${next.name} — starts at move ${startsAtMove(line, next)}`,
          go: () => start({ ...run, mode: "learn", line: next.idx, startPly: learnStart(ds, course, next.idx, getPrefs().skipKnown), pendingMove: undefined }),
        });
      }
    }
    if (run.mode === "review") {
      if (run.global) {
        const q = endQueue ?? [];
        if (q.length) {
          const n = q[0];
          endActions.push({
            id: "next",
            label: `Next due line (${q.length} left)`,
            go: () => start({ ...run, hub: n.hub, system: n.system, course: n.course, line: n.item.line, startPly: n.item.startPly, endPly: n.item.endPly, graded: new Set(n.item.plies), queueLeft: q.length - 1 }),
          });
        }
      } else {
        const q = reviewQueue(model, course, allCards(), new Date(), getPrefs().targetRetention);
        if (q.length) {
          endActions.push({
            id: "next",
            label: `Next due line (${q.length} left)`,
            go: () => start({ ...run, line: q[0].line, startPly: q[0].startPly, endPly: q[0].endPly, graded: new Set(q[0].plies), queueLeft: q.length - 1 }),
          });
        }
      }
    }
    if (run.mode === "drill") {
      const pick = drillPick(course, run.chapters, line.idx, Math.random, run.under ?? null);
      if (pick) endActions.push({ id: "next", label: "Next drill line", go: () => switchLine(pick.line, run.fromStart ? 0 : pick.startPly) });
    }
  }

  // ── keyboard (§3.4) ──────────────────────────────────────────────────────
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {});
  useEffect(() => {
    keyRef.current = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key;
      if (k === "ArrowLeft") scrub(shownPly - 1);
      else if (k === "ArrowRight") scrub(shownPly + 1);
      else if (k === "Escape") {
        if (help) setHelp(false);
        else if (s.phase === "ff") {
          s.skipFF();
          after();
        } else if (view) setView(null);
        else if (sheetOpen) setSheetOpen(false);
        else return;
      } else if (k === " " || k === "Enter") {
        if (t && (t.tagName === "BUTTON" || t.tagName === "A")) return; // let the focused control act
        if (s.phase === "ff") {
          s.skipFF();
          after();
        } else if (view) setView(null);
        else if (s.phase === "wrong") tryAgain();
        else if (s.phase === "end" && endActions[0]) endActions[0].go();
        else return;
      } else if (k === "h" || k === "H") {
        s.hintStep();
        after();
      } else if (k === "s" || k === "S") {
        showMe();
      } else if (k === "p" || k === "P") {
        s.showPlan();
        after();
      } else if (k === "f" || k === "F") setFlipped((f) => !f);
      else if (k === "l" || k === "L") setTab((x) => (x === "lines" ? "coach" : "lines"));
      else if (k === "?") setHelp((h) => !h);
      else if (k === "m" || k === "M") document.getElementById("san-input")?.focus();
      else return;
      e.preventDefault();
    };
  });
  useEffect(() => {
    const h = (e: KeyboardEvent) => keyRef.current(e);
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  // ── render ───────────────────────────────────────────────────────────────
  const name = nameAt(model, line, s.wrong && !view ? livePly : shownPly);
  const lastMistake = [...s.feed].reverse().find((m) => m.kind === "mistake");
  const lastFF = s.feed.find((m) => m.kind === "ff");
  const liveId = s.phase === "wrong" && lastMistake ? lastMistake.id : s.phase === "ff" && lastFF ? lastFF.id : null;
  const progress = s.endPly ? Math.min(1, livePly / s.endPly) : 0;
  const courseUrl = courseHref(run.hub.slug, run.system.slug, side);

  const srv = useServerMode();
  const graded = run.mode === "recall" || run.mode === "review";
  return (
    <div className={`trainer py-4 md:py-6 max-md:pb-[34vh] ${reduced ? "reduced" : ""}`} data-testid="trainer" data-mode={run.mode} data-phase={s.phase} data-ply={livePly}>
      <div className="sr-only" aria-live="polite" data-testid="announce">{announce}</div>
      {graded && (srv === "mismatch" || srv === "unavailable") && (
        <p role="status" data-testid="server-banner" className="mb-3 rounded-lg border border-edge bg-surface-2 px-3 py-2 text-xs text-muted">
          {srv === "mismatch" ? "Server theory is updating" : "Server grading is unavailable"} — your progress is saved in this browser, but this session
          won’t count toward the leaderboard.
        </p>
      )}
      <div className="grid gap-4 md:gap-6 md:grid-cols-[minmax(0,1fr)_320px] lg:grid-cols-[minmax(0,640px)_minmax(360px,440px)] items-start">
        <div className="md:sticky md:top-4 min-w-0">
          <div className={`board-theme-${prefs.boardTheme}`} data-testid="board">
            <Board
              fen={fen}
              orientation={orientation}
              lastMove={lastMove}
              movableColor={canMove ? side : null}
              onMove={(san) => playMove(san)}
              shapes={shapes}
              tints={tints}
              animationMs={reduced ? 0 : s.phase === "ff" ? 90 : 180}
              label={`Board, ${name.row?.name ?? "start position"}. ${side === "white" ? "You play White" : "You play Black"}.`}
            />
          </div>

          {/* name breadcrumb, cross-fading per ply */}
          <div className="mt-2 flex items-center gap-2 min-h-[24px]" data-testid="name-crumb">
            <div key={name.row?.idx ?? -1} className="crumb-fade text-sm truncate flex-1">
              {name.crumb.length ? name.crumb.join(" › ") : <span className="text-muted">Starting position</span>}
            </div>
            {name.eco && <span className="font-mono text-xs text-muted">{name.eco}</span>}
          </div>

          <MoveChips s={s} shownPly={shownPly} livePly={livePly} startPly={run.startPly} mode={run.mode} onScrub={(p) => scrub(p)} model={model} />

          <div className="mt-2 flex items-center gap-1" role="toolbar" aria-label="Board controls">
            <IconBtn label="Restart line" onClick={restart}><RotateCcw size={16} /></IconBtn>
            <IconBtn label="Back (←)" onClick={() => scrub(shownPly - 1)} disabled={shownPly === 0}><ChevronLeft size={18} /></IconBtn>
            <IconBtn label="Forward (→)" onClick={() => scrub(shownPly + 1)} disabled={live}><ChevronRight size={18} /></IconBtn>
            <IconBtn label="Flip board (F)" onClick={() => setFlipped((f) => !f)}><ArrowUpDown size={16} /></IconBtn>
            <IconBtn label="Keyboard shortcuts (?)" onClick={() => setHelp(true)}><Keyboard size={16} /></IconBtn>
            <Link href="/settings" aria-label="Settings" title="Settings" className="w-11 h-11 md:w-9 md:h-9 grid place-items-center rounded-md text-muted hover:text-foreground hover:bg-surface-2">
              <Settings size={16} />
            </Link>
            {!live && (
              <button onClick={() => setView(null)} className="ml-auto text-sm px-3 min-h-[44px] md:min-h-[36px] rounded-md bg-accent text-accent-fg font-medium" data-testid="back-to-live">
                Back to live
              </button>
            )}
          </div>
        </div>

        <aside
          className={`trainer-panel flex flex-col min-w-0 md:h-[calc(100vh-7rem)] md:max-h-[860px] max-md:fixed max-md:inset-x-0 max-md:bottom-0 max-md:z-30 max-md:bg-background max-md:border-t max-md:border-edge max-md:rounded-t-2xl max-md:shadow-[0_-8px_24px_rgb(0_0_0/0.18)] max-md:px-4 ${
            sheetOpen ? "max-md:h-[78vh]" : "max-md:h-[30vh]"
          }`}
          data-testid="coach-panel"
          aria-label="Trainer panel"
        >
          <button
            className="md:hidden mx-auto w-full flex items-center justify-center min-h-[44px] text-muted"
            onClick={() => setSheetOpen((o) => !o)}
            aria-expanded={sheetOpen}
            aria-label={sheetOpen ? "Collapse the coach" : "Expand the coach"}
            data-testid="sheet-handle"
          >
            <span className="w-10 h-1.5 rounded-full bg-edge mr-2" aria-hidden />
            {sheetOpen ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
          </button>
          <div className="text-xs text-muted truncate">
            <Link href={hubHref(run.hub.slug)} className="hover:text-foreground">{run.hub.title}</Link>
            {" › "}
            <Link href={courseUrl} className="hover:text-foreground">{run.system.name.replace(new RegExp(`^${escapeRe(run.hub.title)}[:,]?\\s*`), "") || "Main system"}</Link>
            {" · "}
            <span className="text-foreground font-medium">{MODE_LABEL[run.mode]}</span>
            {run.queueLeft !== undefined && run.mode === "review" && <span> · {run.queueLeft} more due</span>}
          </div>
          <div className="mt-1 h-1.5 rounded-full bg-surface-2 overflow-hidden" role="progressbar" aria-label="Line progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}>
            <div className="h-full bg-accent transition-[width] duration-300" style={{ width: `${progress * 100}%` }} />
          </div>

          <div className="mt-1 md:mt-2 flex gap-1 border-b border-edge" role="tablist" aria-label="Panel">
            {(["coach", "lines", "stats"] as const).map((t) => (
              <button
                key={t}
                role="tab"
                aria-selected={tab === t}
                onClick={() => setTab(t)}
                className={`px-3 min-h-[44px] md:min-h-[40px] text-sm capitalize border-b-2 -mb-px ${tab === t ? "border-accent text-foreground font-medium" : "border-transparent text-muted hover:text-foreground"}`}
                data-testid={`tab-${t}`}
              >
                {t}
              </button>
            ))}
          </div>

          <div className="flex-1 overflow-y-auto pt-2 pr-1 min-h-0" role="tabpanel">
            {tab === "coach" && (
              <CoachFeed
                feed={s.feed}
                selected={view?.id ?? null}
                onSelect={selectMsg}
                actions={{
                  onAction,
                  onOption: run.mode === "learn" ? (li) => switchLine(li, s.feed.find((m) => m.kind === "branch" && m.options?.some((o) => o.line === li))?.ply) : undefined,
                  liveId,
                  optionsClickable: run.mode === "learn",
                  lineDone: (li) => learned(course.lines[li].id),
                }}
                endSlot={
                  s.phase === "end" ? (
                    <div className="flex flex-wrap gap-2 pt-1" data-testid="end-actions">
                      {endActions.map((a, i) => (
                        <button
                          key={a.id}
                          data-testid={`end-${a.id}`}
                          onClick={a.go}
                          className={`text-sm px-3 rounded-md min-h-[44px] text-left ${i === 0 ? "bg-accent text-accent-fg font-medium" : "border border-edge bg-surface hover:bg-surface-2"}`}
                        >
                          {a.label}
                        </button>
                      ))}
                      <Link href={courseUrl} className="text-sm px-3 rounded-md min-h-[44px] inline-flex items-center border border-edge bg-surface hover:bg-surface-2">
                        Back to course
                      </Link>
                    </div>
                  ) : null
                }
              />
            )}
            {tab === "lines" && run.mode === "drill" && (
              <DrillSetup
                course={course}
                chapters={run.chapters}
                fromStart={run.fromStart}
                onChange={(chapters, fromStart) => {
                  const pick = drillPick(course, chapters, null, Math.random, run.under ?? null);
                  if (pick) start({ ...run, chapters, fromStart, line: pick.line, startPly: fromStart ? 0 : pick.startPly, pendingMove: undefined });
                }}
              />
            )}
            {tab === "lines" && <LinesTab course={course} current={line.idx} clickable={run.mode === "learn" || run.mode === "drill"} onPick={(li) => switchLine(li)} learned={learned} />}
            {tab === "stats" && <StatsTab ds={ds} node={line.nodes[Math.min(shownPly, line.nodes.length - 1)]} />}
          </div>

          <div className={sheetOpen ? "" : "max-md:hidden"}>
            <SanInput disabled={!canMove} onSubmit={playMove} />
          </div>
          {s.phase === "await" && run.mode !== "learn" && (
            <div className="flex gap-2 pb-2">
              <button onClick={() => (s.hintStep(), after())} disabled={s.hint >= 3} className="text-sm px-3 rounded-md min-h-[44px] md:min-h-[36px] border border-edge bg-surface hover:bg-surface-2 disabled:opacity-50" data-testid="hint-btn">
                Hint{s.hint ? ` (${s.hint}/3)` : ""} <kbd className="text-[10px] text-muted">H</kbd>
              </button>
              <button onClick={showMe} className="text-sm px-3 rounded-md min-h-[44px] md:min-h-[36px] border border-edge bg-surface hover:bg-surface-2">
                Show <kbd className="text-[10px] text-muted">S</kbd>
              </button>
            </div>
          )}
        </aside>
      </div>
      {help && <ShortcutSheet onClose={() => setHelp(false)} />}
    </div>
  );
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function IconBtn({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className="w-11 h-11 md:w-9 md:h-9 grid place-items-center rounded-md text-muted hover:text-foreground hover:bg-surface-2 disabled:opacity-40"
    >
      {children}
    </button>
  );
}

function MoveChips({
  s,
  shownPly,
  livePly,
  startPly,
  mode,
  onScrub,
  model,
}: {
  s: TrainerSession;
  shownPly: number;
  livePly: number;
  startPly: number;
  mode: Mode;
  onScrub: (ply: number) => void;
  model: ReturnType<typeof modelOf>;
}) {
  const line = s.ctx.line;
  return (
    <ol className="mt-2 flex flex-wrap gap-1 text-[13px] font-mono" aria-label="Moves" data-testid="move-chips">
      {line.sans.slice(0, livePly).map((san, p) => {
        const current = p === shownPly - 1;
        const trunk = (mode === "review" || mode === "drill") && p < startPly;
        const star = definesName(model, line, p);
        return (
          <li key={p}>
            <button
              onClick={() => onScrub(p + 1)}
              aria-current={current ? "step" : undefined}
              aria-label={`${moveLabel(p, san)}${star ? ", names an opening" : ""}`}
              className={`chip-flash px-1.5 py-0.5 rounded min-h-[28px] ${current ? "bg-accent text-accent-fg" : "hover:bg-surface-2"} ${trunk && !current ? "opacity-50" : ""}`}
              data-testid="move-chip"
            >
              {p % 2 === 0 ? `${p / 2 + 1}.${san}` : p === 0 || p === startPly ? `${Math.floor(p / 2) + 1}…${san}` : san}
              {star && <Star size={9} className="inline -mt-2 ml-0.5 text-gold" fill="currentColor" aria-hidden />}
            </button>
          </li>
        );
      })}
      {s.wrong && (
        <li>
          <span className="px-1.5 py-0.5 rounded bg-danger/15 text-danger-ink line-through" data-testid="wrong-chip">{s.wrong.san}</span>
        </li>
      )}
    </ol>
  );
}

function DrillSetup({ course, chapters, fromStart, onChange }: { course: Course; chapters: number[] | null; fromStart: boolean; onChange: (chapters: number[] | null, fromStart: boolean) => void }) {
  const all = course.chapters.map((_, i) => i);
  const on = new Set(chapters ?? all);
  const toggle = (i: number) => {
    const next = new Set(on);
    if (next.has(i)) next.delete(i);
    else next.add(i);
    if (!next.size) return;
    onChange(next.size === all.length ? null : [...next].sort((a, b) => a - b), fromStart);
  };
  return (
    <fieldset className="mb-4 text-sm" data-testid="drill-setup">
      <legend className="text-xs font-medium text-muted uppercase tracking-wide">Drill these chapters</legend>
      <ul className="mt-1">
        {course.chapters.map((ch, i) => (
          <li key={i}>
            <label className="flex items-center gap-2 min-h-[36px]">
              <input type="checkbox" checked={on.has(i)} onChange={() => toggle(i)} className="accent-[var(--accent)]" />
              <span className="flex-1 truncate">{ch.name}</span>
              <span className="text-xs text-muted">{ch.lines.length}</span>
            </label>
          </li>
        ))}
      </ul>
      <label className="mt-2 flex items-center gap-2 min-h-[36px]">
        <input type="checkbox" checked={fromStart} onChange={(e) => onChange(chapters, e.target.checked)} className="accent-[var(--accent)]" />
        From move 1 (instead of where each line leaves its chapter)
      </label>
    </fieldset>
  );
}

function LinesTab({ course, current, clickable, onPick, learned }: { course: Course; current: number; clickable: boolean; onPick: (li: number) => void; learned: (id: string) => boolean }) {
  return (
    <div className="space-y-3 text-sm" data-testid="lines-tab">
      {course.chapters.map((ch, ci) => (
        <div key={ci}>
          <div className="text-xs font-medium text-muted uppercase tracking-wide">{ch.name}</div>
          <ul className="mt-1">
            {ch.lines.map((li) => {
              const l = course.lines[li];
              const done = learned(l.id);
              const isCur = li === current;
              const body = (
                <>
                  <span className="w-4 shrink-0">{done ? <Check size={13} className="text-accent" aria-label="learned" /> : null}</span>
                  <span className={`truncate ${isCur ? "font-medium text-accent" : done ? "" : "text-muted"}`}>{l.name}</span>
                </>
              );
              return (
                <li key={l.id}>
                  {clickable && !isCur ? (
                    <button onClick={() => onPick(li)} className="w-full flex items-center gap-1 text-left px-1 rounded hover:bg-surface-2 min-h-[32px]">{body}</button>
                  ) : (
                    <div className={`flex items-center gap-1 px-1 min-h-[32px] ${isCur ? "bg-accent-soft rounded" : ""}`} aria-current={isCur ? "true" : undefined}>{body}</div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}

function StatsTab({ ds, node }: { ds: Dataset; node: number }) {
  const nd = modelOf(ds).nodes[node];
  const moves = [...nd.moves].filter((m) => m.games > 0).sort((a, b) => b.games - a.games).slice(0, 8);
  return (
    <div className="text-sm space-y-3" data-testid="stats-tab">
      <div>
        <div className="text-xs text-muted">{nd.games.toLocaleString()} master games reach this position</div>
        {nd.games > 0 && <WinBar white={nd.w} draws={nd.d} black={nd.b} className="h-3 mt-1" />}
      </div>
      {moves.length > 0 && (
        <table className="w-full text-[13px]">
          <thead>
            <tr className="text-xs text-muted text-left">
              <th className="font-normal py-1">Move</th>
              <th className="font-normal">Masters</th>
              <th className="font-normal w-1/2">W / D / L</th>
            </tr>
          </thead>
          <tbody>
            {moves.map((m) => (
              <tr key={m.san} className="border-t border-edge">
                <td className="py-1 font-mono">
                  {m.san}
                  {m.theory && <span className="ml-1 text-[10px] text-muted" title="Named theory">●</span>}
                </td>
                <td className="tabular-nums">{Math.round((m.games / nd.games) * 100)}%</td>
                <td>
                  <WinBar white={m.w} draws={m.d} black={m.b} className="h-2.5" showLabels={false} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function SanInput({ disabled, onSubmit }: { disabled: boolean; onSubmit: (san: string) => string }) {
  const [text, setText] = useState("");
  const [err, setErr] = useState<string | null>(null);
  return (
    <form
      className="py-2 flex gap-2 items-start"
      onSubmit={(e) => {
        e.preventDefault();
        const san = text.trim();
        if (!san) return;
        const r = onSubmit(san);
        if (r === "illegal") setErr(`“${san}” isn't a legal move here.`);
        else {
          setErr(null);
          setText("");
        }
      }}
    >
      <label className="sr-only" htmlFor="san-input">Type your move (SAN)</label>
      <div className="flex-1">
        <input
          id="san-input"
          data-testid="san-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") (e.target as HTMLInputElement).blur();
          }}
          disabled={disabled}
          placeholder="Type a move, e.g. Nf3"
          autoComplete="off"
          spellCheck={false}
          className="w-full h-11 md:h-9 px-3 rounded-md border border-edge bg-surface text-sm font-mono disabled:opacity-50"
        />
        {err && <p className="text-xs text-danger mt-1" role="alert">{err}</p>}
      </div>
      <button type="submit" disabled={disabled} className="h-11 md:h-9 px-3 rounded-md border border-edge bg-surface text-sm disabled:opacity-50">Play</button>
    </form>
  );
}

function ShortcutSheet({ onClose }: { onClose: () => void }) {
  const keys: [string, string][] = [
    ["← / →", "Step back / forward through the moves"],
    ["Space / Enter", "Continue · skip the replay · try again"],
    ["H", "Next hint (idea → piece → arrow)"],
    ["S", "Show the move"],
    ["P", "Plan arrows (Learn)"],
    ["F", "Flip the board"],
    ["L", "Lines tab"],
    ["M", "Type a move (SAN), then Enter · Esc returns to the board"],
    ["Esc", "Skip the replay · back to live · close"],
    ["?", "This sheet"],
  ];
  return (
    <div className="fixed inset-0 z-50 bg-black/40 grid place-items-center p-4" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label="Keyboard shortcuts" className="bg-surface rounded-xl border border-edge p-5 w-full max-w-sm shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="font-medium">Keyboard shortcuts</h2>
        <dl className="mt-3 space-y-1.5 text-sm">
          {keys.map(([k, v]) => (
            <div key={k} className="flex gap-3">
              <dt className="w-28 shrink-0 font-mono text-xs pt-0.5">{k}</dt>
              <dd className="text-muted">{v}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-3 text-xs text-muted">You can also type moves in SAN in the box under the coach.</p>
        <button autoFocus onClick={onClose} className="mt-4 w-full min-h-[44px] rounded-md bg-accent text-accent-fg text-sm font-medium">Close</button>
      </div>
    </div>
  );
}
