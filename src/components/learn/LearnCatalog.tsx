"use client";
/** Opening catalog: featured families ranked by real-game popularity + search. */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo } from "react";
import { GraduationCap, ChevronRight } from "lucide-react";
import OpeningSearch from "@/components/OpeningSearch";
import { useDataset, useProgressSummary } from "@/lib/hooks";
import { openingBlurb } from "@/lib/explain";
import { defaultSide, openingCatalog } from "@/lib/openings";

export default function LearnCatalog() {
  const { ds } = useDataset();
  const { summary } = useProgressSummary();
  const router = useRouter();

  const catalog = useMemo(() => (ds ? openingCatalog(ds).slice(0, 30) : []), [ds]);
  const masteryByOpening = useMemo(() => {
    const m = new Map<number, number>();
    summary?.perOpening.forEach((p) => m.set(p.openingId, p.mastery));
    return m;
  }, [summary]);

  if (!ds) {
    return (
      <div className="py-8 space-y-4 animate-pulse">
        <div className="h-9 w-72 rounded bg-surface-2" />
        <div className="h-10 rounded-lg bg-surface-2 max-w-xl" />
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {Array.from({ length: 9 }).map((_, i) => (
            <div key={i} className="h-28 rounded-lg bg-surface-2" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="py-8">
      <div className="flex items-center gap-3 mb-1">
        <GraduationCap className="text-accent" size={26} />
        <h1 className="text-2xl font-semibold tracking-tight">Learn an opening</h1>
      </div>
      <p className="text-muted text-sm mb-6">
        Guided move-by-move walkthroughs of {ds.openings.length.toLocaleString()} named lines,
        with the ideas behind every move.
      </p>

      <div className="max-w-xl mb-8">
        <OpeningSearch ds={ds} onPick={(o) => router.push(`/learn/${o.id}`)} autoFocus />
      </div>

      <h2 className="text-xs uppercase tracking-wider text-muted mb-3">
        Most played in professional chess
      </h2>
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {catalog.map(({ root, variations }) => {
          const mastery = masteryByOpening.get(root.id);
          return (
            <Link
              key={root.id}
              href={`/learn/${root.id}`}
              className="group rounded-lg border border-edge bg-surface p-4 hover:border-accent transition-colors"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="font-medium leading-snug">{root.family}</div>
                <ChevronRight
                  size={16}
                  className="text-muted group-hover:text-accent group-hover:translate-x-0.5 transition-all shrink-0 mt-1"
                />
              </div>
              <div className="text-xs text-muted mt-1">{openingBlurb(ds, root)}</div>
              <div className="flex items-center gap-2 mt-3 text-xs text-muted">
                <span className="font-mono border border-edge rounded px-1.5 py-0.5">
                  {variations} line{variations === 1 ? "" : "s"}
                </span>
                <span className="border border-edge rounded px-1.5 py-0.5 capitalize">
                  play as {defaultSide(root)}
                </span>
                {mastery !== undefined && mastery > 0 && (
                  <span className="ml-auto text-accent font-medium">{mastery}% mastered</span>
                )}
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
