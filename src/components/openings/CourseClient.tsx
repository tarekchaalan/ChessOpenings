"use client";
/**
 * Course page (§3.2 C): one system for one side. Header with the tier
 * selector and mastery; mode cards with live counters; chapters → sections
 * → lines (the line picker) with status dots; a tree view; the learner's
 * alternatives; and the Course Explorer.
 */
import { useMemo, useState } from "react";
import Link from "next/link";
import { BookOpen, ChevronDown, ChevronRight, Dumbbell, GitBranch, GraduationCap, Play, RotateCcw, Undo2 } from "lucide-react";
import { Chess } from "chess.js";
import MiniBoard from "@/components/MiniBoard";
import Board from "@/components/Board";
import { useDataset, useHydrated } from "@/lib/hooks";
import {
  courseHref,
  findSystem,
  formatMoves,
  hubHref,
  hubSummary,
  loadCourse,
  modelOf,
  type Course,
  type RawHubSummary,
  type RawSystemSummary,
  type Side,
} from "@/lib/courses-client";
import { useLatestChanges } from "@/lib/changelog-client";
import { courseProgressInfo, lineProgress, reviewMinutes, type LineStatus } from "@/lib/catalog-client";
import { reviewQueue, tierAddsPerDay, tierLines as tierLineList, type TierKey } from "@/lib/trainer/plan";
import { defaultTier, TIER_LABEL } from "@/lib/rating/level";
import { allCards, allCourseProgress, courseProgress, overridesFor, setOverride, useProgressVersion } from "@/lib/progress/store";
import { linesLearnedToday } from "@/lib/srs/workload";
import { usePrefs } from "@/lib/prefs";
import { arrowShapes, type Arrow } from "@/lib/coach/brushes";
import type { CourseLine } from "@/lib/openings-build/courses";
import type { Dataset } from "@/lib/openings";


export default function CourseClient({ hub, system, side }: { hub: string; system: string; side: Side }) {
  const { ds, error } = useDataset();
  if (error) return <p className="py-20 text-center text-muted">Couldn’t load the opening data ({error}).</p>;
  if (!ds) return <div className="py-8 h-96 rounded-lg bg-surface-2 animate-pulse" />;
  const h = hubSummary(ds, hub);
  const s = h ? findSystem(ds, hub, system, side) : null;
  if (!h || !s) {
    return (
      <div className="py-20 text-center">
        <p className="text-muted">This course isn’t in the current opening data.</p>
        {h ? (
          <Link href={hubHref(h.slug)} className="text-accent hover:underline text-sm">Back to {h.title}</Link>
        ) : (
          <Link href="/openings" className="text-accent hover:underline text-sm">Browse all openings</Link>
        )}
      </div>
    );
  }
  return <CourseView ds={ds} hub={h} system={s} />;
}

/** Moves of a line from its first branch after σ (what distinguishes it). */
export function keyMoves(course: Course, line: CourseLine, max = 6): string {
  const branches = line.branchPlies.filter((p) => p >= course.sigmaPly);
  const last = branches[branches.length - 1] ?? course.sigmaPly;
  const from = Math.max(course.sigmaPly, last - 3);
  return (from > course.sigmaPly ? "… " : "") + formatMoves(line.sans.slice(from), from, max);
}

const STATUS_LABEL: Record<LineStatus, string> = { new: "New", learning: "Learning", due: "Due", mastered: "Mastered" };
function StatusDot({ status }: { status: LineStatus }) {
  const cls =
    status === "mastered" ? "bg-accent border-accent" : status === "due" ? "bg-gold border-gold" : status === "learning" ? "bg-accent/40 border-accent" : "border-muted";
  return <span className={`w-2.5 h-2.5 rounded-full border shrink-0 ${cls}`} role="img" aria-label={`Status: ${STATUS_LABEL[status].toLowerCase()}`} title={STATUS_LABEL[status]} data-status={status} />;
}

const ago = (iso: string | null) => {
  if (!iso) return null;
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86400_000);
  return d <= 0 ? "today" : d === 1 ? "yesterday" : `${d} days ago`;
};

function CourseView({ ds, hub, system }: { ds: Dataset; hub: RawHubSummary; system: RawSystemSummary }) {
  const version = useProgressVersion();
  const prefs = usePrefs();
  const hydrated = useHydrated();
  const courseId = `${hub.slug}/${system.slug}@${system.side}`;
  const overrides = hydrated ? overridesFor(courseId) : {};
  const ovKey = JSON.stringify(overrides);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- overrides are compared by value
  const course = useMemo(() => loadCourse(ds, system, overrides)!, [ds, system, ovKey]);
  const model = modelOf(ds);
  // starts at the depth for the player's level (ADR 0008; stored in this browser, so after hydration), else everything
  const [picked, setTier] = useState<TierKey | null>(null);
  const tierPick: TierKey = picked ?? (hydrated ? defaultTier() : "complete");
  const [view, setView] = useState<"chapters" | "tree" | "explorer">("chapters");
  const { entry } = useLatestChanges();
  const fresh = new Set(entry?.courses[course.id]?.added ?? []);
  const tiers = (["essentials", "core", "complete"] as TierKey[]).filter(
    (t, i, all) => i === 0 || course.tiers[t].lines !== course.tiers[all[i - 1]].lines
  );
  // a tier equal to the one below it isn't shown: select the largest shown one instead
  const tier = tiers.includes(tierPick) ? tierPick : tiers[tiers.length - 1];
  const inTier = useMemo(() => new Set(tierLineList(course, tier)), [course, tier]);
  const sigEpd = ds.nodes[system.signatureNode].epd;
  const sigmaLabel = hub.sigma.length ? formatMoves(hub.sigma.slice(-1), hub.sigma.length - 1) : "the first move";
  const title = system.name;
  const cards = hydrated ? allCards() : {};
  const status = (l: CourseLine) => lineProgress(model, course, l, cards);
  const info = courseProgressInfo(model, course, [...inTier], cards);
  const base = `/train/${hub.slug}/${system.slug}/${system.side}`;
  const tierQ = tier !== "essentials" ? `&tier=${tier}` : "";
  const newLines = [...inTier].filter((li) => status(course.lines[li]).status === "new").length;
  const queue = hydrated ? reviewQueue(model, course, cards) : [];
  const dueCards = queue.reduce((n, it) => n + it.plies.length, 0);
  const recommended = dueCards ? "review" : newLines ? "learn" : "drill";
  // the daily new-line cap (§4.9): a suggestion, Learn still works past it
  const newToday = hydrated ? Math.max(0, prefs.dailyNewLines - linesLearnedToday(allCourseProgress())) : prefs.dailyNewLines;
  const learnSub = !newLines ? "all learned" : newToday ? `${newLines} new line${newLines === 1 ? "" : "s"} · ${Math.min(newToday, newLines)} today` : `${newLines} new · today’s ${prefs.dailyNewLines} done`;
  // "Core adds ~11 reviews/day next week"
  const tierKey = tiers.join();
  const adds = useMemo(() => {
    if (!hydrated) return null;
    const c = allCards();
    const learned = (id: string) => !!courseProgress(course.id).lines[id]?.learnedAt;
    const opts = { perDay: prefs.dailyNewLines, retention: prefs.targetRetention, cap: prefs.dailyReviewCap };
    return Object.fromEntries(tiers.map((t) => [t, Math.round(tierAddsPerDay(model, course, t, c, learned, opts))])) as Partial<Record<TierKey, number>>;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `version` stands for the learner's cards
  }, [hydrated, course, model, version, prefs.dailyNewLines, prefs.targetRetention, prefs.dailyReviewCap, tierKey]);

  return (
    <div className="py-8">
      <nav aria-label="Breadcrumb" className="text-sm text-muted mb-4">
        <Link href="/openings" className="hover:text-foreground">Openings</Link>
        {" › "}
        <Link href={`${hubHref(hub.slug)}?side=${system.side}&stay=1`} className="hover:text-foreground">{hub.title}</Link>
        {" › "}
        <span className="text-foreground">{title.startsWith(hub.title) ? title.slice(hub.title.length).replace(/^[:,]\s*/, "") || "Main system" : title}</span>
      </nav>

      <div className="grid md:grid-cols-[240px_1fr] gap-8 items-start">
        <div className="max-w-[240px] w-full mx-auto">
          <MiniBoard fen={sigEpd} orientation={system.side} label={`${title} position`} />
          <div className="mt-2 text-xs text-muted">
            You play <span className="font-medium text-foreground capitalize">{system.side}</span>
            {system.defining.length > 0 && <> · defining moves <span className="font-mono">{system.defining.join(" ")}</span></>}
          </div>
        </div>
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight" data-testid="course-title">{title}</h1>
          <p className="text-sm text-muted mt-1">
            {course.lines.length} lines · {course.chapters.length} chapter{course.chapters.length === 1 ? "" : "s"} · average depth{" "}
            {(course.lines.reduce((s, l) => s + l.sans.length, 0) / (course.lines.length || 1)).toFixed(1)} plies
          </p>

          <div className="mt-4 flex flex-wrap gap-2" role="radiogroup" aria-label="Depth">
            {tiers.map((t) => (
              <button
                key={t}
                role="radio"
                aria-checked={tier === t}
                onClick={() => setTier(t)}
                className={`text-left px-3 py-2 rounded-lg border text-sm ${tier === t ? "border-accent bg-accent-soft" : "border-edge bg-surface hover:bg-surface-2"}`}
              >
                <div className="font-medium">{TIER_LABEL[t]} · {course.tiers[t].lines} lines</div>
                <div className="text-xs text-muted">covers {Math.round(course.tiers[t].coverage * 100)}% of master games after {sigmaLabel}</div>
                {adds?.[t] != null && (
                  <div className="text-xs text-muted" data-testid={`tier-adds-${t}`} title={`If you learn ${prefs.dailyNewLines} new lines a day; simulated with your cards and settings`}>
                    {adds[t] ? `adds ~${adds[t]} review${adds[t] === 1 ? "" : "s"}/day next week` : "nothing new to add"}
                  </div>
                )}
              </button>
            ))}
          </div>
          <p className="text-[11px] text-muted mt-1" title="Reach = probability of meeting a line, from master games after the signature position (not rating-banded).">
            Percentages are “of master games” in the pinned 2026 corpus, not rating-banded.
          </p>

          {/* mastery */}
          <div className="mt-4" data-testid="course-mastery">
            <div className="flex justify-between text-xs text-muted">
              <span>{Math.round(info.mastery * 100)}% mastered ({info.mature} of {info.total} positions)</span>
              <span>{dueCards ? `${dueCards} due` : info.known ? "nothing due" : "not started"}</span>
            </div>
            <div className="mt-1 h-2 rounded-full bg-surface-2 overflow-hidden" role="progressbar" aria-label="Mastery" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(info.mastery * 100)}>
              <div className="h-full bg-accent" style={{ width: `${info.mastery * 100}%` }} />
              <div className="h-full bg-accent/40 -mt-2" style={{ width: `${(info.known / (info.total || 1)) * 100}%` }} />
            </div>
          </div>

          {/* mode cards */}
          <div className="mt-4 grid grid-cols-1 sm:grid-cols-3 gap-2" data-testid="mode-cards">
            <ModeCard href={`${base}?mode=learn${tierQ}`} icon={<GraduationCap size={18} />} title="Learn" sub={learnSub} recommended={recommended === "learn"} testid="mode-learn" />
            <ModeCard href={`${base}?mode=review`} icon={<RotateCcw size={18} />} title="Review" sub={dueCards ? `${dueCards} due · ~${reviewMinutes(dueCards)} min` : "nothing due"} recommended={recommended === "review"} testid="mode-review" />
            <ModeCard href={`${base}?mode=drill`} icon={<Dumbbell size={18} />} title="Drill" sub="shuffle chapters · no schedule" recommended={recommended === "drill"} testid="mode-drill" />
          </div>

          <div className="mt-6 flex items-center gap-1 border-b border-edge" role="tablist" aria-label="Course view">
            {(
              [
                ["chapters", "Chapters", <BookOpen key="c" size={14} />],
                ["tree", "Tree", <GitBranch key="t" size={14} />],
                ["explorer", "Course Explorer", <Play key="e" size={14} />],
              ] as const
            ).map(([id, label, icon]) => (
              <button
                key={id}
                role="tab"
                aria-selected={view === id}
                onClick={() => setView(id)}
                className={`inline-flex items-center gap-1.5 px-3 min-h-[40px] text-sm border-b-2 -mb-px ${view === id ? "border-accent font-medium" : "border-transparent text-muted hover:text-foreground"}`}
                data-testid={`view-${id}`}
              >
                {icon} {label}
              </button>
            ))}
          </div>

          {view === "chapters" && (
            <ol className="mt-3 space-y-2" data-testid="chapters">
              {course.chapters.map((ch, ci) => {
                const shown = ch.lines.filter((li) => inTier.has(li));
                if (!shown.length) return null;
                return <ChapterBlock key={ci} course={course} chapter={ch} shown={shown} fresh={fresh} base={base} status={status} defaultOpen={ci === 0} />;
              })}
            </ol>
          )}
          {view === "tree" && <CourseTree course={course} base={base} inTier={inTier} />}
          {view === "explorer" && <CourseExplorer ds={ds} course={course} base={base} status={status} />}

          <Alternatives model={model} course={course} courseId={courseId} overrides={overrides} />
        </div>
      </div>
    </div>
  );
}

function ModeCard({ href, icon, title, sub, recommended, testid }: { href: string; icon: React.ReactNode; title: string; sub: string; recommended: boolean; testid: string }) {
  return (
    <Link
      href={href}
      data-testid={testid}
      className={`relative rounded-xl border px-4 py-3 min-h-[64px] flex items-center gap-3 ${recommended ? "border-accent bg-accent-soft" : "border-edge bg-surface hover:bg-surface-2"}`}
    >
      <span className={recommended ? "text-accent" : "text-muted"}>{icon}</span>
      <span className="min-w-0">
        <span className="block font-medium">{title}</span>
        <span className="block text-xs text-muted truncate">{sub}</span>
      </span>
      {recommended && <span className="absolute top-1.5 right-2 text-[10px] font-semibold uppercase tracking-wide text-accent">Next</span>}
    </Link>
  );
}

function ChapterBlock({
  course,
  chapter,
  shown,
  fresh,
  base,
  status,
  defaultOpen,
}: {
  course: Course;
  chapter: Course["chapters"][number];
  shown: number[];
  fresh: Set<string>;
  base: string;
  status: (l: CourseLine) => ReturnType<typeof lineProgress>;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const reach = shown.reduce((s, li) => s + course.lines[li].reach, 0);
  const done = shown.filter((li) => status(course.lines[li]).status !== "new").length;
  const groups = chapter.sections.length
    ? chapter.sections.map((s) => ({ name: s.name, lines: s.lines.filter((li) => shown.includes(li)) })).filter((g) => g.lines.length)
    : [{ name: "", lines: shown }];
  return (
    <li className="rounded-lg border border-edge bg-surface" data-testid="chapter">
      <button onClick={() => setOpen(!open)} aria-expanded={open} className="w-full flex items-center gap-2 px-4 py-3 text-left">
        {open ? <ChevronDown size={16} aria-hidden /> : <ChevronRight size={16} aria-hidden />}
        <span className="font-medium flex-1 min-w-0">
          <span data-testid="chapter-name">{chapter.name}</span>
          <span className="block h-1 mt-1.5 rounded-full bg-surface-2 overflow-hidden max-w-[240px]" aria-hidden>
            <span className="block h-full bg-accent" style={{ width: `${(done / shown.length) * 100}%` }} />
          </span>
        </span>
        <span className="text-xs text-muted">
          {done}/{shown.length} started{reach > 0 && !course.lines[shown[0]].early ? ` · ${Math.round(reach * 100)}%` : ""}
        </span>
      </button>
      {open && (
        <div className="border-t border-edge">
          {groups.map((g, gi) => (
            <div key={gi}>
              {g.name && <div className="px-4 pt-2 text-xs font-medium text-muted">{g.name}</div>}
              <ul>
                {g.lines.map((li) => {
                  const l = course.lines[li];
                  const st = status(l);
                  const href = st.status === "due" ? `${base}?mode=recall&line=${l.id}&from=0` : `${base}?mode=learn&line=${l.id}`;
                  const last = ago(st.lastReviewed);
                  return (
                    <li key={l.id} className="flex items-center gap-3 px-4 py-2 border-b border-edge last:border-0" data-testid="line-row">
                      <StatusDot status={st.status} />
                      <div className="min-w-0 flex-1">
                        <div className="text-sm truncate">
                          <span data-testid="line-name">{l.name}</span>
                          {fresh.has(l.id) && <span className="ml-2 text-[10px] uppercase text-accent font-semibold">New</span>}
                          {l.transposesTo !== null && <span className="ml-2 text-[11px] text-muted" title={`Continues as: ${course.lines[l.transposesTo].name}`}>↪ transposes</span>}
                        </div>
                        <div className="text-xs text-muted font-mono truncate">{keyMoves(course, l)}</div>
                      </div>
                      <div className="text-xs text-muted text-right shrink-0 w-28">
                        {l.sans.length} plies · {l.early ? "early" : `${(l.reach * 100).toFixed(l.reach < 0.01 ? 1 : 0)}%`}
                        <div>{last ? `reviewed ${last}` : STATUS_LABEL[st.status]}</div>
                      </div>
                      <Link
                        href={href}
                        aria-label={`${st.status === "due" ? "Review" : st.status === "new" ? "Learn" : "Relearn"} ${l.name}`}
                        className="w-9 h-9 grid place-items-center rounded-md text-accent hover:bg-accent-soft shrink-0"
                      >
                        <Play size={15} />
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      )}
    </li>
  );
}

// ── tree view ─────────────────────────────────────────────────────────────

interface TreeNode {
  ply: number;
  san: string;
  /** a course line through this node (opens the trainer here) */
  line: number;
  children: TreeNode[];
  transposesTo: number | null;
}

function buildTree(course: Course, inTier: Set<number>): TreeNode[] {
  const root: TreeNode = { ply: -1, san: "", line: -1, children: [], transposesTo: null };
  for (const l of course.lines) {
    if (!inTier.has(l.idx)) continue;
    let cur = root;
    l.sans.forEach((san, p) => {
      let next = cur.children.find((c) => c.san === san);
      if (!next) cur.children.push((next = { ply: p, san, line: l.idx, children: [], transposesTo: null }));
      cur = next;
    });
    if (l.transposesTo !== null) cur.transposesTo = l.transposesTo;
  }
  return root.children;
}

function CourseTree({ course, base, inTier }: { course: Course; base: string; inTier: Set<number> }) {
  const tree = useMemo(() => buildTree(course, inTier), [course, inTier]);
  return (
    <div className="mt-3 rounded-lg border border-edge bg-surface p-3 text-sm font-mono overflow-x-auto" data-testid="course-tree">
      <TreeRun nodes={tree} course={course} base={base} depth={0} />
    </div>
  );
}

/** A run of single-child moves on one row; branches indent below it. */
function TreeRun({ nodes, course, base, depth }: { nodes: TreeNode[]; course: Course; base: string; depth: number }) {
  return (
    <ul className={depth ? "pl-4 border-l border-edge ml-1" : ""}>
      {nodes.map((n) => (
        <TreeBranch key={`${n.ply}-${n.san}`} node={n} course={course} base={base} depth={depth} />
      ))}
    </ul>
  );
}

function TreeBranch({ node, course, base, depth }: { node: TreeNode; course: Course; base: string; depth: number }) {
  const [open, setOpen] = useState(depth < 2);
  const run: TreeNode[] = [node];
  let cur = node;
  while (cur.children.length === 1) {
    cur = cur.children[0];
    run.push(cur);
  }
  const learnerPly = (p: number) => (p % 2 === 0) === (course.side === "white");
  const line = course.lines[node.line];
  return (
    <li className="py-0.5">
      <div className="flex flex-wrap items-baseline gap-x-1">
        {cur.children.length > 1 && (
          <button
            onClick={() => setOpen(!open)}
            aria-expanded={open}
            aria-label={`${open ? "Collapse" : "Expand"} the replies after ${cur.ply % 2 === 0 ? `${cur.ply / 2 + 1}.` : `${Math.floor(cur.ply / 2) + 1}…`}${cur.san}`}
            className="text-muted w-4"
          >
            {open ? "▾" : "▸"}
          </button>
        )}
        {run.map((n) => (
          <Link
            key={n.ply}
            href={`${base}?mode=learn&line=${course.lines[n.line].id}&start=${n.ply}`}
            className={`hover:text-accent ${learnerPly(n.ply) ? "font-bold" : "text-muted"}`}
            title={`Learn from here (${course.lines[n.line].name})`}
          >
            {n.ply % 2 === 0 ? `${n.ply / 2 + 1}.${n.san}` : n === node ? `${Math.floor(n.ply / 2) + 1}…${n.san}` : n.san}
          </Link>
        ))}
        {cur.transposesTo !== null && (
          <Link href={`${base}?mode=learn&line=${course.lines[cur.transposesTo].id}`} className="text-[11px] text-accent font-sans" title="This position continues in another line">
            ↪ {course.lines[cur.transposesTo].name}
          </Link>
        )}
        {!cur.children.length && cur.transposesTo === null && <span className="text-[11px] text-muted font-sans">· {line.name}</span>}
      </div>
      {open && cur.children.length > 1 && <TreeRun nodes={cur.children} course={course} base={base} depth={depth + 1} />}
    </li>
  );
}

// ── course explorer ───────────────────────────────────────────────────────

function CourseExplorer({ ds, course, base, status }: { ds: Dataset; course: Course; base: string; status: (l: CourseLine) => ReturnType<typeof lineProgress> }) {
  const model = modelOf(ds);
  const [sans, setSans] = useState<string[]>([]);
  const [arrows, setArrows] = useState(true);
  const state = useMemo(() => {
    const c = new Chess();
    let last: [string, string] | null = null;
    for (const s of sans) {
      const m = c.move(s);
      last = [m.from, m.to];
    }
    return { fen: c.fen(), last, chess: c };
  }, [sans]);
  const epd = state.fen.split(" ").slice(0, 4).join(" ");
  const node = model.byEpd.get(epd);
  const through = useMemo(() => (node === undefined ? [] : course.lines.filter((l) => l.nodes.includes(node))), [course, node]);
  // the course's moves here: the learner's book move (green) and the opponent's tries (blue)
  const shapes = useMemo(() => {
    if (!arrows || node === undefined) return [];
    const out: Arrow[] = [];
    const seen = new Set<string>();
    for (const l of through) {
      const i = l.nodes.indexOf(node);
      const san = l.sans[i];
      if (!san || seen.has(san)) continue;
      seen.add(san);
      const c = new Chess(state.fen);
      const m = c.move(san);
      const learner = (i % 2 === 0) === (course.side === "white");
      out.push({ from: m.from, to: m.to, kind: learner ? "play" : "alt" });
    }
    return arrowShapes(out);
  }, [arrows, node, through, state.fen, course.side]);
  return (
    <div className="mt-3 grid lg:grid-cols-[minmax(0,1fr)_280px] gap-4" data-testid="course-explorer">
      <div className="max-w-[440px]">
        <Board fen={state.fen} orientation={course.side} lastMove={state.last} movableColor="both" onMove={(san) => setSans((s) => [...s, san])} shapes={shapes} label="Course Explorer board" />
        <div className="mt-2 flex items-center gap-2 text-sm">
          <button onClick={() => setSans((s) => s.slice(0, -1))} disabled={!sans.length} className="inline-flex items-center gap-1 px-3 min-h-[36px] rounded-md border border-edge disabled:opacity-40">
            <Undo2 size={14} /> Back
          </button>
          <button onClick={() => setSans([])} disabled={!sans.length} className="px-3 min-h-[36px] rounded-md border border-edge disabled:opacity-40">Reset</button>
          <label className="ml-auto inline-flex items-center gap-2 text-xs text-muted">
            <input type="checkbox" checked={arrows} onChange={(e) => setArrows(e.target.checked)} className="accent-[var(--accent)]" /> Course arrows
          </label>
        </div>
        <p className="mt-2 text-xs font-mono text-muted break-words" data-testid="explorer-moves">{sans.length ? formatMoves(sans) : "Play any move on the board."}</p>
      </div>
      <div>
        <h3 className="text-xs font-medium text-muted uppercase tracking-wide">Lines through this position</h3>
        {!through.length && <p className="mt-2 text-sm text-muted">{node === undefined ? "Out of book." : "No line of this course passes here."}</p>}
        <ul className="mt-2 space-y-1" data-testid="lines-through">
          {through.slice(0, 30).map((l) => {
            const st = status(l);
            const at = l.nodes.indexOf(node!);
            return (
              <li key={l.id} className="flex items-center gap-2 text-sm">
                <StatusDot status={st.status} />
                <span className="truncate flex-1">{l.name}</span>
                <Link
                  href={st.status === "due" ? `${base}?mode=recall&line=${l.id}&from=${at}` : `${base}?mode=learn&line=${l.id}&start=${at}`}
                  aria-label={`${st.status === "due" ? "Review" : "Learn"} ${l.name} from here`}
                  className="w-8 h-8 grid place-items-center rounded-md text-accent hover:bg-accent-soft shrink-0"
                >
                  <Play size={13} />
                </Link>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

// ── the learner's alternatives ────────────────────────────────────────────

function Alternatives({ model, course, courseId, overrides }: { model: ReturnType<typeof modelOf>; course: Course; courseId: string; overrides: Record<string, string> }) {
  const entries = Object.entries(overrides);
  if (!entries.length) return null;
  return (
    <section className="mt-8" data-testid="alternatives">
      <h2 className="text-sm font-medium text-muted uppercase tracking-wide">Your alternatives</h2>
      <ul className="mt-2 space-y-1">
        {entries.map(([epd, san]) => {
          const node = model.byEpd.get(epd);
          const line = node === undefined ? null : course.lines.find((l) => l.nodes.includes(node));
          const ply = line && node !== undefined ? line.nodes.indexOf(node) : null;
          return (
            <li key={epd} className="flex items-center gap-3 text-sm rounded-lg border border-edge bg-surface px-3 py-2">
              <span className="font-mono">{ply !== null ? formatMoves([san], ply) : san}</span>
              <span className="text-xs text-muted truncate flex-1">{line ? `instead of the book move, in ${line.name}` : "instead of the book move"}</span>
              <button onClick={() => setOverride(courseId, epd, null)} className="text-xs px-3 min-h-[32px] rounded-md border border-edge hover:bg-surface-2">
                Revert
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export { courseHref };
