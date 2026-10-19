"use client";
/**
 * The estimate on the page (ADR 0008): the level card (dashboard, Settings)
 * and "Suggested for your level" (dashboard, catalog).
 */
import Link from "next/link";
import { GraduationCap, Sparkles } from "lucide-react";
import type { Dataset } from "@/lib/openings";
import { basisText, SELF_LEVELS, type Estimate } from "@/lib/rating/estimate";
import { starterCourses, type PlayerLevel } from "@/lib/rating/level";
import { openSetup } from "@/lib/setup/client";
import type { Side } from "@/lib/insights/types";

export function LevelCard({ estimate, level, compact = false }: { estimate: Estimate; level: PlayerLevel; compact?: boolean }) {
  const from =
    estimate.source === "ratings"
      ? estimate.basis.slice(0, 2).map(basisText).join(" · ")
      : `what you told us (${SELF_LEVELS.find((l) => l.id === estimate.self)?.label.toLowerCase()})`;
  return (
    <section className="rounded-lg border border-edge bg-surface p-4" data-testid="level-card" aria-labelledby="level-card-title">
      <h2 id="level-card-title" className="flex items-center gap-1.5 text-xs uppercase tracking-wider text-muted">
        <Sparkles size={13} className="text-accent" aria-hidden /> Estimated Elo
      </h2>
      <p className="mt-1">
        <span className="text-2xl font-semibold font-mono">≈ {estimate.elo}</span>{" "}
        <span className="text-sm font-medium">{level.name}</span>
      </p>
      <p className="text-xs text-muted mt-1">
        Likely {estimate.low}–{estimate.high}, from {from}.
      </p>
      {!compact && (
        <button type="button" onClick={openSetup} className="text-xs text-accent hover:underline mt-1">
          Update accounts or level
        </button>
      )}
    </section>
  );
}

export function SuggestedForLevel({ ds, level, sides = ["white", "black"], title = "Suggested for your level" }: { ds: Dataset; level: PlayerLevel; sides?: Side[]; title?: string }) {
  const groups = sides.map((side) => ({ side, list: starterCourses(ds, level, side) })).filter((g) => g.list.length);
  if (!groups.length) return null;
  return (
    <section aria-labelledby="suggested-title" data-testid="suggested-for-level">
      <h2 id="suggested-title" className="text-xs uppercase tracking-wider text-muted mb-3 flex items-center gap-1.5">
        <GraduationCap size={14} aria-hidden /> {title} · {level.name}
      </h2>
      <div className={`grid gap-3 ${groups.length > 1 ? "sm:grid-cols-2" : ""}`}>
        {groups.map((g) => (
          <div key={g.side} className="rounded-lg border border-edge bg-surface p-4">
            <h3 className="text-sm font-medium mb-2">As {g.side === "white" ? "White" : "Black"}</h3>
            <ul className="space-y-2">
              {g.list.map((c) => (
                <li key={c.hub} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <Link href={c.link.course} className="text-sm text-accent hover:underline break-words min-w-0">
                    {c.title}
                  </Link>
                  <span className="text-xs text-muted capitalize">{c.level}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}
