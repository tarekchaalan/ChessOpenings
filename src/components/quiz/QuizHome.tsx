"use client";
/** Quiz home: the review-due queue plus an opening picker. */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo } from "react";
import { AlarmClock, ChevronRight, Swords } from "lucide-react";
import OpeningSearch from "@/components/OpeningSearch";
import { useLegacyDataset, useProgressSummary } from "@/lib/hooks";
import { defaultSide, openingCatalog } from "@/lib/openings";

export default function QuizHome() {
  const { ds } = useLegacyDataset();
  const { summary } = useProgressSummary();
  const router = useRouter();

  const featured = useMemo(() => (ds ? openingCatalog(ds).slice(0, 12) : []), [ds]);
  const recent = useMemo(() => {
    if (!ds || !summary) return [];
    return summary.perOpening
      .slice(0, 6)
      .map((p) => ({ p, o: ds.openings[p.openingId] }))
      .filter((x) => x.o);
  }, [ds, summary]);

  if (!ds) {
    return (
      <div className="py-8 space-y-4 animate-pulse">
        <div className="h-9 w-64 rounded bg-surface-2" />
        <div className="h-24 rounded-lg bg-surface-2" />
        <div className="h-64 rounded-lg bg-surface-2" />
      </div>
    );
  }

  const due = summary?.dueCount ?? 0;

  return (
    <div className="py-8 max-w-3xl">
      <div className="flex items-center gap-3 mb-1">
        <Swords className="text-accent" size={26} />
        <h1 className="text-2xl font-semibold tracking-tight">Quiz yourself</h1>
      </div>
      <p className="text-muted text-sm mb-6">
        The app plays the opponent from real master theory — you find the book move. Fast, correct
        answers raise your rating; misses come back on a spaced-repetition schedule.
      </p>

      <Link
        href={due > 0 ? "/quiz/review" : "#"}
        aria-disabled={due === 0}
        className={`flex items-center gap-4 rounded-lg border p-4 mb-8 transition-colors ${
          due > 0
            ? "border-gold/50 bg-surface hover:border-gold"
            : "border-edge bg-surface-2 opacity-70 pointer-events-none"
        }`}
      >
        <span
          className={`w-11 h-11 rounded-full grid place-items-center shrink-0 ${
            due > 0 ? "bg-gold text-white" : "bg-surface text-muted border border-edge"
          }`}
        >
          <AlarmClock size={20} />
        </span>
        <div className="flex-1">
          <div className="font-medium">
            {due > 0 ? `${due} position${due === 1 ? "" : "s"} due for review` : "Review queue is clear"}
          </div>
          <div className="text-xs text-muted">
            {due > 0
              ? "The scheduler resurfaces exactly what you were about to forget."
              : "Miss a quiz move and it will appear here at the right moment."}
          </div>
        </div>
        {due > 0 && <ChevronRight size={18} className="text-muted" />}
      </Link>

      <div className="mb-8">
        <h2 className="text-xs uppercase tracking-wider text-muted mb-2">Pick an opening</h2>
        <OpeningSearch ds={ds} onPick={(o) => router.push(`/quiz/${o.id}`)} />
      </div>

      {recent.length > 0 && (
        <div className="mb-8">
          <h2 className="text-xs uppercase tracking-wider text-muted mb-3">Continue training</h2>
          <div className="grid sm:grid-cols-2 gap-2">
            {recent.map(({ p, o }) => (
              <Link
                key={o.id}
                href={`/quiz/${o.id}`}
                className="flex items-center gap-3 rounded-lg border border-edge bg-surface px-3 py-2.5 hover:border-accent transition-colors"
              >
                <span className="font-mono text-xs text-accent w-8">{o.eco}</span>
                <span className="text-sm truncate flex-1">{o.name}</span>
                <span className="text-xs text-muted shrink-0">{p.mastery}%</span>
              </Link>
            ))}
          </div>
        </div>
      )}

      <h2 className="text-xs uppercase tracking-wider text-muted mb-3">Popular openings</h2>
      <div className="grid sm:grid-cols-2 gap-2">
        {featured.map(({ root }) => (
          <Link
            key={root.id}
            href={`/quiz/${root.id}`}
            className="flex items-center gap-3 rounded-lg border border-edge bg-surface px-3 py-2.5 hover:border-accent transition-colors"
          >
            <span className="font-mono text-xs text-accent w-8">{root.eco}</span>
            <span className="text-sm truncate flex-1">{root.family}</span>
            <span className="text-xs text-muted capitalize shrink-0">as {defaultSide(root)}</span>
          </Link>
        ))}
      </div>
    </div>
  );
}
