"use client";
/**
 * Trainer (§3.2 D): /train/[hub]/[system]/[side]?mode=learn|recall|review|drill&line=<id>
 * and /train/review (the cross-course due queue). This file resolves what to
 * train (a "run": one line in one mode) and hands it to TrainerView, which
 * drives the pure session engine (lib/trainer/session).
 */
import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useDataset } from "@/lib/hooks";
import { courseHref, findSystem, hubSummary, modelOf, type RawHubSummary, type RawSystemSummary, type Side } from "@/lib/courses-client";
import type { Dataset } from "@/lib/openings";
import { chapterTrunk, moveLabel, type Mode } from "@/lib/trainer/session";
import { normSan } from "@/lib/openings-build/model";
import { drillPick, nextLearnLine, reviewQueue, type TierKey } from "@/lib/trainer/plan";
import { courseFor, globalQueue, learnStart } from "@/lib/trainer/client";
import { allCards, courseProgress } from "@/lib/progress/store";
import { getPrefs } from "@/lib/prefs";
import TrainerView, { type Run } from "./TrainerView";

const MODES: Mode[] = ["learn", "recall", "review", "drill"];
let runSeq = 1;

export default function TrainerClient({ hub, system, side }: { hub: string; system: string; side: Side }) {
  const { ds, error } = useDataset();
  if (error) return <p className="py-20 text-center text-muted">Couldn’t load the opening data ({error}).</p>;
  if (!ds) return <div className="py-8 h-[70vh] rounded-lg bg-surface-2 animate-pulse" />;
  const h = hubSummary(ds, hub);
  const s = h ? findSystem(ds, hub, system, side) : null;
  if (!h || !s) {
    return (
      <div className="py-20 text-center">
        <p className="text-muted">This course isn’t in the current opening data.</p>
        <Link href="/openings" className="text-accent hover:underline text-sm">Browse all openings</Link>
      </div>
    );
  }
  // not keyed on the dataset hash: a live data update must not reset a line in progress
  return <CourseTrainer key={`${h.slug}|${s.slug}|${s.side}`} ds={ds} hub={h} system={s} />;
}

function CourseTrainer({ ds, hub, system }: { ds: Dataset; hub: RawHubSummary; system: RawSystemSummary }) {
  const params = useSearchParams();
  const router = useRouter();
  const mode = (MODES.includes(params.get("mode") as Mode) ? params.get("mode") : "learn") as Mode;
  const tier = (["essentials", "core", "complete"].includes(params.get("tier") ?? "") ? params.get("tier") : "essentials") as TierKey;
  const chapters = params.get("ch") ? params.get("ch")!.split(",").map(Number) : null;
  const fromStart = params.get("full") === "1";

  const initial = useMemo((): Run | null => {
    const course = courseFor(ds, system);
    const byId = (id: string | null) => (id ? course.lines.find((l) => l.id === id) ?? null : null);
    const base = { ds, hub, system, course, tier, chapters, fromStart };
    if (mode === "review") {
      const q = reviewQueue(modelOf(ds), course, allCards(), new Date(), getPrefs().targetRetention);
      const item = q[0];
      if (!item) return null;
      return { ...base, key: runSeq++, mode, line: item.line, startPly: item.startPly, endPly: item.endPly, graded: new Set(item.plies), queueLeft: q.length - 1 };
    }
    if (mode === "drill") {
      const want = byId(params.get("line"));
      const pick = want ? { line: want.idx, startPly: chapterTrunk(course, want) } : drillPick(course, chapters, null);
      if (!pick) return null;
      return { ...base, key: runSeq++, mode, line: pick.line, startPly: fromStart ? 0 : pick.startPly };
    }
    const progress = courseProgress(course.id);
    const line = byId(params.get("line")) ?? nextLearnLine(course, tier, (id) => !!progress.lines[id]?.learnedAt) ?? course.lines[0];
    if (mode === "recall") return { ...base, key: runSeq++, mode, line: line.idx, startPly: Number(params.get("from") ?? 0) || 0 };
    // arriving from "Make it my move" at another system's choice
    const at = Number(params.get("at"));
    const play = params.get("play");
    if (play && Number.isInteger(at) && at > 0 && normSan(line.sans[at] ?? "") === normSan(play)) {
      return {
        ...base,
        key: runSeq++,
        mode: "learn",
        line: line.idx,
        startPly: at,
        pendingMove: play,
        notice: { title: "Switched course", text: `${system.name} is the course that plays ${moveLabel(at, play)}.` },
      };
    }
    return { ...base, key: runSeq++, mode: "learn", line: line.idx, startPly: learnStart(ds, course, line.idx, getPrefs().skipKnown) };
    // the first run is fixed at mount; later runs come from the view's actions
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ds, system]);

  const [run, setRun] = useState<Run | null>(initial);
  const start = useCallback(
    (r: Omit<Run, "key">) => {
      const next = { ...r, key: runSeq++ };
      setRun(next);
      // keep the URL shareable without navigating
      const q = new URLSearchParams({ mode: next.mode, line: next.course.lines[next.line].id });
      if (next.mode === "recall") q.set("from", String(next.startPly));
      if (next.tier !== "essentials") q.set("tier", next.tier);
      if (next.mode === "drill" && next.chapters) q.set("ch", next.chapters.join(","));
      if (next.mode === "drill" && next.fromStart) q.set("full", "1");
      window.history.replaceState(null, "", `/train/${next.hub.slug}/${next.system.slug}/${next.system.side}?${q}`);
    },
    []
  );

  if (!run) {
    return (
      <div className="py-20 text-center space-y-2">
        <p className="text-lg font-medium">{mode === "review" ? "Nothing due in this course." : "Nothing to train here yet."}</p>
        <Link href={courseHref(hub.slug, system.slug, system.side)} className="text-accent hover:underline text-sm">Back to the course</Link>
        {mode === "review" && (
          <button className="block mx-auto text-sm text-muted hover:text-foreground" onClick={() => router.push("/train/review")}>
            Review all courses
          </button>
        )}
      </div>
    );
  }
  return <TrainerView key={run.key} ds={run.ds} run={run} start={start} />;
}

/** /train/review: due cards across every course, line by line. */
export function GlobalReview() {
  const { ds, error } = useDataset();
  if (error) return <p className="py-20 text-center text-muted">Couldn’t load the opening data ({error}).</p>;
  if (!ds) return <div className="py-8 h-[70vh] rounded-lg bg-surface-2 animate-pulse" />;
  return <GlobalReviewInner ds={ds} />;
}

function GlobalReviewInner({ ds }: { ds: Dataset }) {
  const first = useMemo(() => {
    const q = globalQueue(ds, getPrefs().targetRetention);
    if (!q.length) return null;
    const { item, hub, system, course } = q[0];
    return { key: runSeq++, ds, hub, system, course, mode: "review" as Mode, line: item.line, startPly: item.startPly, endPly: item.endPly, graded: new Set(item.plies), queueLeft: q.length - 1, tier: "essentials" as TierKey, chapters: null, fromStart: false, global: true };
    // computed once per dataset; the view asks for the next item itself
  }, [ds]);
  const [run, setRun] = useState<Run | null>(first);
  const start = useCallback((r: Omit<Run, "key">) => setRun({ ...r, key: runSeq++ }), []);
  if (!run) {
    return (
      <div className="py-20 text-center space-y-2">
        <p className="text-lg font-medium">All caught up.</p>
        <p className="text-sm text-muted">Nothing is due right now.</p>
        <Link href="/openings" className="text-accent hover:underline text-sm">Learn something new</Link>
      </div>
    );
  }
  return <TrainerView key={run.key} ds={run.ds} run={run} start={start} />;
}
