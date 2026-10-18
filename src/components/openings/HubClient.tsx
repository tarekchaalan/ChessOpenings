"use client";
/**
 * Hub page (§3.2 B): the opening at its signature position, a side switch,
 * and "Choose your system": each system is a course.
 */
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ChevronDown, ChevronRight, Sparkles, Star, X } from "lucide-react";
import MiniBoard from "@/components/MiniBoard";
import WinBar from "@/components/WinBar";
import { useDataset } from "@/lib/hooks";
import {
  catalogOf,
  courseHref,
  courseSummary,
  formatMoves,
  hubHref,
  hubSummary,
  systemsFor,
  type RawHubSummary,
  type RawSystemSummary,
  type Side,
} from "@/lib/courses-client";
import { newLinesFor, useLatestChanges } from "@/lib/changelog-client";
import type { Dataset } from "@/lib/openings";
import { useStartedCourse } from "@/lib/use-course-progress";

export default function HubClient({ slug }: { slug: string }) {
  const { ds, error } = useDataset();
  if (error) return <p className="py-20 text-center text-muted">Couldn’t load the opening data ({error}).</p>;
  if (!ds) return <HubSkeleton />;
  const hub = hubSummary(ds, slug);
  if (!hub) {
    return (
      <div className="py-20 text-center">
        <p className="text-muted">No opening called “{slug}” in the current data.</p>
        <Link href="/openings" className="text-accent hover:underline text-sm">Browse all openings</Link>
      </div>
    );
  }
  return <Hub ds={ds} hub={hub} />;
}

function HubSkeleton() {
  return (
    <div className="py-8 grid md:grid-cols-[280px_1fr] gap-8 animate-pulse">
      <div className="aspect-square rounded-md bg-surface-2" />
      <div className="space-y-3">
        <div className="h-8 w-2/3 rounded bg-surface-2" />
        <div className="h-24 rounded bg-surface-2" />
        <div className="h-48 rounded bg-surface-2" />
      </div>
    </div>
  );
}

const pct = (x: number, total: number) => (total ? Math.round((x / total) * 100) : 0);

export function hubDescription(hub: RawHubSummary): string {
  if (hub.description) return hub.description;
  const [w, d, b] = hub.wdl;
  const total = w + d + b;
  const moves = formatMoves(hub.sigma);
  const eco = hub.eco ? (hub.eco[0] === hub.eco[1] ? hub.eco[0] : `${hub.eco[0]}–${hub.eco[1]}`) : null;
  const base = `${hub.title} starts after ${moves}${eco ? ` (${eco})` : ""} and covers ${hub.rows} named line${hub.rows === 1 ? "" : "s"}.`;
  if (total < 10) return `${base} It is rare in master play: fewer than 10 master games reach this position.`;
  return `${base} ${total.toLocaleString()} master games reach this position; White scores ${pct(w + d / 2, total)}% (${pct(d, total)}% draws).`;
}

function Hub({ ds, hub }: { ds: Dataset; hub: RawHubSummary }) {
  const router = useRouter();
  const params = useSearchParams();
  const initial = (params.get("side") as Side | null) ?? hub.side;
  const [side, setSide] = useState<Side>(initial === "black" ? "black" : "white");
  const { entry, seen, dismiss } = useLatestChanges();
  const fresh = newLinesFor(entry, seen, hub.slug);
  const systems = systemsFor(ds, hub, side);
  const roots = systems.filter((s) => s.parent === -1);
  const cat = catalogOf(ds)!;
  const sigmaEpd = ds.nodes[hub.sigmaNode].epd;

  // a hub with a single system for this side goes straight to its course
  const only = systems.length === 1 ? systems[0].slug : null;
  const stay = params.get("stay") === "1";
  useEffect(() => {
    if (only && !stay) router.replace(courseHref(hub.slug, only, side) + "?from=hub");
  }, [only, stay, hub.slug, side, router]);

  const siblings = [...hub.siblings, ...(hub.minorSiblings ?? [])]
    .map((s) => cat.hubs.find((h) => h.slug === s))
    .filter((h): h is RawHubSummary => !!h);
  const parent = hub.parent ? cat.hubs.find((h) => h.slug === hub.parent) : null;

  return (
    <div className="py-8">
      <nav aria-label="Breadcrumb" className="text-sm text-muted mb-4">
        <Link href="/openings" className="hover:text-foreground">Openings</Link>
        {parent && (
          <>
            {" › "}
            <Link href={hubHref(parent.slug)} className="hover:text-foreground">{parent.title}</Link>
          </>
        )}
        {" › "}
        <span className="text-foreground">{hub.title}</span>
      </nav>

      <div className="grid md:grid-cols-[280px_1fr] gap-8 items-start">
        <div className="max-w-[280px] w-full mx-auto">
          <MiniBoard fen={sigmaEpd} orientation={side} approach={hub.sigma} label={`${hub.title} signature position`} />
          <div className="mt-2 text-xs text-muted font-mono">{formatMoves(hub.sigma)}</div>
          <WinBar white={hub.wdl[0]} draws={hub.wdl[1]} black={hub.wdl[2]} className="h-3 mt-2" />
          <div className="text-[11px] text-muted mt-1">{hub.games.toLocaleString()} master games reach this position</div>
        </div>

        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight" data-testid="hub-title">{hub.title}</h1>
            {hub.eco && <span className="font-mono text-xs text-muted">{hub.eco[0] === hub.eco[1] ? hub.eco[0] : `${hub.eco[0]}–${hub.eco[1]}`}</span>}
            {fresh > 0 && (
              <span data-testid="new-lines-badge" className="inline-flex items-center gap-1 rounded-full bg-accent-soft text-accent text-xs font-medium pl-2 pr-1 py-0.5">
                <Sparkles size={12} aria-hidden /> +{fresh} new line{fresh === 1 ? "" : "s"}
                <button aria-label={`Dismiss the new-lines badge for ${hub.title}`} onClick={() => dismiss(hub.slug)} className="p-0.5 rounded hover:bg-surface-2">
                  <X size={11} />
                </button>
              </span>
            )}
          </div>
          <p className="mt-2 text-sm text-muted leading-relaxed max-w-2xl">{hubDescription(hub)}</p>
          {hub.moveOrderNote && (
            <p className="mt-2 text-xs text-muted" data-testid="move-order-note">
              Assumes {formatMoves(hub.sigma)}.{" "}
              {siblings.length ? (
                <>
                  Other move orders: see{" "}
                  {siblings.slice(0, 3).map((s, i) => (
                    <span key={s.slug}>
                      {i > 0 && ", "}
                      <Link href={`${hubHref(s.slug)}?side=${side}`} className="text-accent hover:underline">{s.title}</Link>
                    </span>
                  ))}
                  {siblings.length > 3 ? ` and ${siblings.length - 3} more below` : ""}; early deviations are chapters in each course.
                </>
              ) : (
                "Other move orders are covered as early-deviation chapters in each course."
              )}
            </p>
          )}

          <div className="mt-5 inline-flex rounded-lg border border-edge p-0.5 bg-surface" role="radiogroup" aria-label="Play as">
            {(["white", "black"] as const).map((s) => (
              <button
                key={s}
                role="radio"
                aria-checked={side === s}
                onClick={() => setSide(s)}
                className={`px-3 py-1.5 text-sm rounded-md capitalize ${side === s ? "bg-accent text-accent-fg font-medium" : "text-muted hover:text-foreground"}`}
              >
                As {s}
              </button>
            ))}
          </div>

          <h2 className="mt-6 text-sm font-medium text-muted uppercase tracking-wide">Choose your system</h2>
          {!roots.length && <p className="mt-3 text-sm text-muted">No course for this side in the current data.</p>}
          <ul className="mt-3 space-y-2" data-testid="system-list">
            {roots.slice(0, 8).map((s) => (
              <SystemRow key={s.slug} ds={ds} hub={hub} system={s} systems={systems} side={side} />
            ))}
          </ul>
          {roots.length > 8 && (
            <details className="mt-3">
              <summary className="text-sm text-accent cursor-pointer">More systems ({roots.length - 8})</summary>
              <ul className="mt-2 space-y-2">
                {roots.slice(8).map((s) => (
                  <SystemRow key={s.slug} ds={ds} hub={hub} system={s} systems={systems} side={side} />
                ))}
              </ul>
            </details>
          )}

          {siblings.length > 0 && (
            <div className="mt-8">
              <h2 className="text-sm font-medium text-muted uppercase tracking-wide">Related openings</h2>
              <p className="text-xs text-muted mt-1">Other {hub.side === "white" ? "White" : "Black"} moves before this position lead to:</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {siblings.map((s) => (
                  <Link key={s.slug} href={`${hubHref(s.slug)}?side=${side}`} className="text-sm px-3 py-1.5 rounded-md border border-edge bg-surface hover:bg-surface-2">
                    {s.title}
                  </Link>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function SystemRow({
  ds,
  hub,
  system,
  systems,
  side,
}: {
  ds: Dataset;
  hub: RawHubSummary;
  system: RawSystemSummary;
  systems: RawSystemSummary[];
  side: Side;
}) {
  const [open, setOpen] = useState(false);
  const c = courseSummary(ds, system);
  const cat = catalogOf(ds)!;
  const variants = useMemo(() => {
    const out: RawSystemSummary[] = [];
    const walk = (idx: number) => {
      for (const s of systems) {
        const si = cat.systems.indexOf(s);
        if (s.parent === idx) {
          out.push(s);
          walk(si);
        }
      }
    };
    walk(cat.systems.indexOf(system));
    return out;
  }, [systems, system, cat.systems]);
  const progress = useStartedCourse(ds, c.id);
  // reach: share of the master games at σ that go into this system; tags from its own position
  // transpositions can bring more games into a system than pass through σ: cap at 100%
  const share = hub.games >= 10 && system.signatureNode !== hub.sigmaNode ? Math.min(1, c.games / hub.games) : null;
  const reach = share === null ? null : share > 0 && share < 0.01 ? "<1" : String(Math.round(share * 100));
  const sig = ds.nodes[system.signatureNode];
  const tags: string[] = [];
  if (/gambit/i.test(system.name)) tags.push("gambit");
  if (sig.games >= 30) {
    if ((sig.white + sig.black) / sig.games >= 0.66) tags.push("sharp");
    else if (sig.draws / sig.games >= 0.4) tags.push("solid");
  }
  const label = system.name.startsWith(hub.title) ? system.name.slice(hub.title.length).replace(/^[:,]\s*/, "") || "Main system" : system.name;
  return (
    <li className="rounded-lg border border-edge bg-surface">
      <Link href={courseHref(hub.slug, system.slug, side)} className="flex items-center gap-3 px-4 py-3 hover:bg-surface-2 rounded-lg" data-testid="system-row">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="font-medium break-words min-w-0">{label}</span>
            {system.recommended && (
              <span className="inline-flex items-center gap-1 text-[11px] text-gold border border-gold/40 rounded px-1.5">
                <Star size={10} aria-hidden /> Recommended
              </span>
            )}
          </div>
          <div className="text-xs text-muted font-mono truncate">{system.defining.join(" ") || formatMoves(hub.sigma)}</div>
        </div>
        <div className="text-right text-xs text-muted shrink-0">
          <div>
            {reach !== null && <span className="text-foreground font-medium">{reach}% reach · </span>}
            {c.essentials[0]} essential · {c.lines} lines
          </div>
          <div>avg {c.avgDepth} plies · {c.games.toLocaleString()} games</div>
          {(tags.length > 0 || progress) && (
            <div className="mt-0.5 flex gap-1 justify-end items-center">
              {tags.map((t) => (
                <span key={t} className="px-1.5 rounded bg-surface-2 capitalize">{t}</span>
              ))}
              {progress && (
                <span className="text-accent font-medium" data-testid="system-progress">
                  {Math.round(progress.mastery * 100)}% mastered{progress.due ? ` · ${progress.due} due` : ""}
                </span>
              )}
            </div>
          )}
        </div>
        <ChevronRight size={16} className="text-muted shrink-0" aria-hidden />
      </Link>
      {variants.length > 0 && (
        <div className="border-t border-edge px-4 py-2">
          <button onClick={() => setOpen(!open)} className="text-xs text-muted hover:text-foreground inline-flex items-center gap-1" aria-expanded={open}>
            {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />} {variants.length} variant{variants.length === 1 ? "" : "s"} with a different move choice
          </button>
          {open && (
            <ul className="mt-1 space-y-1">
              {variants.map((v) => (
                <li key={v.slug}>
                  <Link href={courseHref(hub.slug, v.slug, side)} className="text-sm hover:text-accent">
                    {v.name.split(" · ").slice(1).join(" · ") || v.name}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  );
}
