"use client";
/**
 * Course page (§3.2 C): one system for one side. Tier selector with
 * coverage, chapters → sections → lines (the line picker), each line with
 * its key moves, depth and reach. Modes and progress plug in from Phase 3/5.
 */
import { useMemo, useState } from "react";
import Link from "next/link";
import { ChevronDown, ChevronRight, Play } from "lucide-react";
import MiniBoard from "@/components/MiniBoard";
import { useDataset, useHydrated } from "@/lib/hooks";
import {
  courseHref,
  courseSummary,
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
import type { CourseLine } from "@/lib/openings-build/courses";
import type { Dataset } from "@/lib/openings";
import { reviewQueue } from "@/lib/trainer/plan";
import { allCards, courseProgress, useProgressVersion } from "@/lib/progress/store";

export type TierKey = "essentials" | "core" | "complete";
const TIER_LABEL: Record<TierKey, string> = { essentials: "Essentials", core: "Core", complete: "Complete" };

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

export function tierLines(course: Course, tier: TierKey): Set<number> {
  const main = course.lines.filter((l) => !l.early);
  const n = tier === "complete" ? course.lines.length : course.tiers[tier].lines;
  if (tier === "complete") return new Set(course.lines.map((l) => l.idx));
  return new Set(main.slice(0, n).map((l) => l.idx));
}

/** Moves of a line from its first branch after σ (what distinguishes it). */
export function keyMoves(course: Course, line: CourseLine, max = 6): string {
  const branches = line.branchPlies.filter((p) => p >= course.sigmaPly);
  const last = branches[branches.length - 1] ?? course.sigmaPly;
  const from = Math.max(course.sigmaPly, last - 3);
  return (from > course.sigmaPly ? "… " : "") + formatMoves(line.sans.slice(from), from, max);
}

function CourseView({ ds, hub, system }: { ds: Dataset; hub: RawHubSummary; system: RawSystemSummary }) {
  const course = useMemo(() => loadCourse(ds, system)!, [ds, system]);
  const summary = courseSummary(ds, system);
  const [tier, setTier] = useState<TierKey>("complete");
  const { entry } = useLatestChanges();
  const fresh = new Set(entry?.courses[course.id]?.added ?? []);
  const inTier = tierLines(course, tier);
  const tiers = (["essentials", "core", "complete"] as TierKey[]).filter(
    (t, i, all) => i === 0 || course.tiers[t].lines !== course.tiers[all[i - 1]].lines
  );
  const sigEpd = ds.nodes[system.signatureNode].epd;
  const sigmaLabel = hub.sigma.length ? formatMoves(hub.sigma.slice(-1), hub.sigma.length - 1) : "the first move";
  const title = system.name;

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
            {course.lines.length} lines · {course.chapters.length} chapter{course.chapters.length === 1 ? "" : "s"} · average depth {summary.avgDepth} plies
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
              </button>
            ))}
          </div>
          <p className="text-[11px] text-muted mt-1" title="Reach = probability of meeting a line, from master games after the signature position (not rating-banded).">
            Percentages are “of master games” in the pinned 2026 corpus, not rating-banded.
          </p>

          <ModeLinks ds={ds} course={course} hub={hub} system={system} tier={tier} />

          <h2 className="mt-6 text-sm font-medium text-muted uppercase tracking-wide">Chapters</h2>
          <ol className="mt-2 space-y-2" data-testid="chapters">
            {course.chapters.map((ch, ci) => {
              const shown = ch.lines.filter((li) => inTier.has(li));
              if (!shown.length) return null;
              return (
                <ChapterBlock key={ci} course={course} chapter={ch} shown={shown} fresh={fresh} hub={hub} system={system} defaultOpen={ci === 0} />
              );
            })}
          </ol>
        </div>
      </div>
    </div>
  );
}

function ChapterBlock({
  course,
  chapter,
  shown,
  fresh,
  hub,
  system,
  defaultOpen,
}: {
  course: Course;
  chapter: Course["chapters"][number];
  shown: number[];
  fresh: Set<string>;
  hub: RawHubSummary;
  system: RawSystemSummary;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const reach = shown.reduce((s, li) => s + course.lines[li].reach, 0);
  const groups = chapter.sections.length
    ? chapter.sections.map((s) => ({ name: s.name, lines: s.lines.filter((li) => shown.includes(li)) })).filter((g) => g.lines.length)
    : [{ name: "", lines: shown }];
  return (
    <li className="rounded-lg border border-edge bg-surface" data-testid="chapter">
      <button onClick={() => setOpen(!open)} aria-expanded={open} className="w-full flex items-center gap-2 px-4 py-3 text-left">
        {open ? <ChevronDown size={16} aria-hidden /> : <ChevronRight size={16} aria-hidden />}
        <span className="font-medium flex-1" data-testid="chapter-name">{chapter.name}</span>
        <span className="text-xs text-muted">{shown.length} line{shown.length === 1 ? "" : "s"}{reach > 0 && !course.lines[shown[0]].early ? ` · ${Math.round(reach * 100)}%` : ""}</span>
      </button>
      {open && (
        <div className="border-t border-edge">
          {groups.map((g, gi) => (
            <div key={gi}>
              {g.name && <div className="px-4 pt-2 text-xs font-medium text-muted">{g.name}</div>}
              <ul>
                {g.lines.map((li) => {
                  const l = course.lines[li];
                  return (
                    <li key={l.id} className="flex items-center gap-3 px-4 py-2 border-b border-edge last:border-0" data-testid="line-row">
                      <span className="w-2 h-2 rounded-full border border-muted shrink-0" title="New" aria-label="Status: new" />
                      <div className="min-w-0 flex-1">
                        <div className="text-sm truncate">
                          <span data-testid="line-name">{l.name}</span>
                          {fresh.has(l.id) && <span className="ml-2 text-[10px] uppercase text-accent font-semibold">New</span>}
                          {l.transposesTo !== null && <span className="ml-2 text-[11px] text-muted" title={`Continues as: ${course.lines[l.transposesTo].name}`}>↪ transposes</span>}
                        </div>
                        <div className="text-xs text-muted font-mono truncate">{keyMoves(course, l)}</div>
                      </div>
                      <div className="text-xs text-muted text-right shrink-0 w-24">
                        {l.sans.length} plies
                        <div>{l.early ? "early" : `${(l.reach * 100).toFixed(l.reach < 0.01 ? 1 : 0)}% reach`}</div>
                      </div>
                      <Link
                        href={`/train/${hub.slug}/${system.slug}/${system.side}?mode=learn&line=${l.id}`}
                        aria-label={`Learn ${l.name}`}
                        className="w-8 h-8 grid place-items-center rounded-md text-accent hover:bg-accent-soft shrink-0"
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

/** Learn / Review / Drill entry points with live counters (the mode cards land in Phase 4). */
function ModeLinks({ ds, course, hub, system, tier }: { ds: Dataset; course: Course; hub: RawHubSummary; system: RawSystemSummary; tier: TierKey }) {
  useProgressVersion();
  const mounted = useHydrated();
  const base = `/train/${hub.slug}/${system.slug}/${system.side}`;
  const progress = mounted ? courseProgress(course.id) : null;
  const fresh = progress ? [...tierLines(course, tier)].filter((li) => !progress.lines[course.lines[li].id]?.learnedAt).length : null;
  const due = mounted ? reviewQueue(modelOf(ds), course, allCards()).reduce((n, it) => n + it.plies.length, 0) : null;
  const cls = "px-3 min-h-[44px] md:min-h-[38px] inline-flex items-center rounded-lg border text-sm";
  return (
    <div className="mt-4 flex flex-wrap gap-2" data-testid="mode-links">
      <Link href={`${base}?mode=learn${tier !== "essentials" ? `&tier=${tier}` : ""}`} className={`${cls} border-accent bg-accent text-accent-fg font-medium`}>
        Learn{fresh !== null ? ` · ${fresh} new line${fresh === 1 ? "" : "s"}` : ""}
      </Link>
      <Link href={`${base}?mode=review`} className={`${cls} border-edge bg-surface hover:bg-surface-2`} aria-disabled={due === 0}>
        Review{due !== null ? ` · ${due} due` : ""}
      </Link>
      <Link href={`${base}?mode=drill`} className={`${cls} border-edge bg-surface hover:bg-surface-2`}>
        Drill
      </Link>
    </div>
  );
}

export { courseHref };
