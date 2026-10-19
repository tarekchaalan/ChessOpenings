"use client";
/**
 * Openings catalog (§3.2 A): search, White/Black, filter chips, Continue,
 * Featured, All openings by ECO volume, Offbeat (collapsed). Cards show a
 * static mini-board at σ that replays the approach on hover.
 */
import { memo, useDeferredValue, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ChevronDown, ChevronRight, Play, Search, Sparkles, X } from "lucide-react";
import MiniBoard from "@/components/MiniBoard";
import WinBar from "@/components/WinBar";
import { useDataset, useHydrated } from "@/lib/hooks";
import { findSystem, formatMoves, hubHref, hubSummary, loadCourse, modelOf, parseCourseId, type RawHubSummary, type Side } from "@/lib/courses-client";
import { courseProgressInfo, ECO_VOLUMES, hubCard, reviewMinutes, rowTarget, searchCatalog, trainHref, type SearchHit } from "@/lib/catalog-client";
import { newLinesFor, useLatestChanges } from "@/lib/changelog-client";
import { allCards, allCourseProgress, overridesFor, useProgressVersion } from "@/lib/progress/store";
import { tierLines } from "@/lib/trainer/plan";
import type { Dataset } from "@/lib/openings";
import type { Level } from "@/lib/openings-build/catalog";
import { usePlayerLevel } from "@/lib/setup/client";
import { SuggestedForLevel } from "@/components/setup/LevelCards";
import type { Style } from "@/lib/openings-build/hubs";

const STYLES: Style[] = ["gambit", "solid", "sharp", "system"];
const LEVELS: Level[] = ["beginner", "intermediate", "advanced"];
const AGAINST = [
  { id: "e4", label: "Against 1.e4" },
  { id: "d4", label: "Against 1.d4" },
  { id: "other", label: "Against others" },
] as const;

export default function CatalogClient() {
  const { ds, error } = useDataset();
  if (error) return <p className="py-20 text-center text-muted">Couldn’t load the opening data ({error}).</p>;
  if (!ds) return <div className="py-8 space-y-4"><div className="h-10 rounded-lg bg-surface-2 animate-pulse" /><div className="h-96 rounded-lg bg-surface-2 animate-pulse" /></div>;
  return <Catalog ds={ds} />;
}

function Catalog({ ds }: { ds: Dataset }) {
  const params = useSearchParams();
  const [side, setSideState] = useState<Side>(params.get("side") === "black" ? "black" : "white");
  const [q, setQ] = useState(params.get("q") ?? "");
  const [against, setAgainst] = useState<Set<string>>(new Set());
  const [styles, setStyles] = useState<Set<Style>>(new Set());
  const [levels, setLevels] = useState<Set<Level>>(new Set());
  const { level } = usePlayerLevel();
  const { entry, seen, dismiss } = useLatestChanges();
  const hubs = ds.raw!.catalog!.hubs;

  const sync = (next: { side?: Side; q?: string }) => {
    const sp = new URLSearchParams();
    const s = next.side ?? side;
    const query = next.q ?? q;
    if (s === "black") sp.set("side", "black");
    if (query.trim()) sp.set("q", query.trim());
    // replaceState: a shareable URL without an App Router navigation per keystroke
    window.history.replaceState(null, "", `/openings${sp.size ? `?${sp}` : ""}`);
  };
  const setSide = (s: Side) => {
    setSideState(s);
    sync({ side: s });
  };

  const pass = (h: RawHubSummary, mineOnly = true) =>
    (!mineOnly || side !== "black" || !against.size || (h.against !== null && against.has(h.against))) &&
    (!styles.size || h.tags.some((t) => styles.has(t))) &&
    (!levels.size || levels.has(h.level));
  const mine = hubs.filter((h) => h.side === side && pass(h));
  const featured = mine.filter((h) => h.featured).sort((a, b) => b.games - a.games);
  const top = mine.filter((h) => h.placement === "top" && !h.featured);
  const offbeat = mine.filter((h) => h.placement === "offbeat" && !h.featured).sort((a, b) => b.games - a.games);
  const theirs = hubs.filter((h) => h.side !== side && h.placement === "top" && pass(h, false)).sort((a, b) => b.games - a.games);
  const filtering = against.size + styles.size + levels.size > 0;
  const deferredQ = useDeferredValue(q);
  const hits = useMemo(() => searchCatalog(ds, deferredQ, 40), [ds, deferredQ]);
  // progress is read once per store change, not per card
  const progressVersion = useProgressVersion();
  const hydrated = useHydrated();
  const started = useMemo(() => {
    void progressVersion;
    return hydrated ? startedProgress(ds) : new Map<string, ReturnType<typeof courseProgressInfo>>();
  }, [ds, hydrated, progressVersion]);

  const card = (h: RawHubSummary) => {
    const id = hubCard(ds, h, side).course?.id ?? null;
    return <HubCardView key={`${h.slug}@${side}`} ds={ds} hub={h} side={side} fresh={newLinesFor(entry, seen, h.slug)} onDismiss={dismiss} progress={(id && started.get(id)) || null} />;
  };

  return (
    <div className="py-6 space-y-6" data-testid="catalog">
      <div className="flex flex-col md:flex-row md:items-center gap-3">
        <div className="md:mr-auto flex items-baseline gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">Openings</h1>
          <Link href="/openings/map" className="text-sm text-accent hover:underline" data-testid="map-link">
            Map view
          </Link>
        </div>
        <div className="relative md:w-[420px]">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" aria-hidden />
          <input
            type="search"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              sync({ q: e.target.value });
            }}
            placeholder="Search: Najdorf, B90, e4 c5 Nf3 d6 d4…"
            aria-label="Search openings by name, ECO code or moves"
            data-testid="catalog-search"
            className="w-full h-11 pl-9 pr-3 rounded-lg border border-edge bg-surface text-sm"
          />
        </div>
        <div className="inline-flex rounded-lg border border-edge p-0.5 bg-surface self-start" role="radiogroup" aria-label="Play as">
          {(["white", "black"] as const).map((s) => (
            <button
              key={s}
              role="radio"
              aria-checked={side === s}
              onClick={() => setSide(s)}
              className={`px-4 min-h-[40px] text-sm rounded-md capitalize ${side === s ? "bg-accent text-accent-fg font-medium" : "text-muted hover:text-foreground"}`}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filters">
        {side === "black" && AGAINST.map((a) => <Chip key={a.id} on={against.has(a.id)} onClick={() => setAgainst(toggle(against, a.id))}>{a.label}</Chip>)}
        {STYLES.map((s) => <Chip key={s} on={styles.has(s)} onClick={() => setStyles(toggle(styles, s))}>{cap(s)}</Chip>)}
        {LEVELS.map((l) => <Chip key={l} on={levels.has(l)} onClick={() => setLevels(toggle(levels, l))}>{cap(l)}</Chip>)}
        {filtering && (
          <button onClick={() => (setAgainst(new Set()), setStyles(new Set()), setLevels(new Set()))} className="text-xs text-muted hover:text-foreground px-2">
            Clear filters
          </button>
        )}
      </div>

      {q.trim() ? (
        <SearchResults ds={ds} hits={hits} side={side} />
      ) : (
        <>
          <ContinueRow ds={ds} />
          {level && !filtering && (
            <div className="mt-6">
              <SuggestedForLevel ds={ds} level={level} sides={[side]} title="For your level" />
            </div>
          )}
          {featured.length > 0 && (
            <Section title="Featured">
              <Grid>{featured.map(card)}</Grid>
            </Section>
          )}
          <Section title="All openings">
            {ECO_VOLUMES.map(([letter, name]) => {
              const list = top.filter((h) => (h.eco?.[0] ?? "A")[0] === letter).sort((a, b) => b.games - a.games);
              if (!list.length) return null;
              return (
                <div key={letter} className="mb-6">
                  <h3 className="text-sm font-medium mb-2">
                    <span className="font-mono text-muted mr-1">{letter}</span> {name}
                  </h3>
                  <Grid>{list.map(card)}</Grid>
                </div>
              );
            })}
            {!top.length && !featured.length && <p className="text-sm text-muted">Nothing matches these filters.</p>}
          </Section>
          <Collapsible title={`Facing ${side === "white" ? "Black's defences" : "White's openings"} (${theirs.length})`} testid="their-openings">
            <p className="text-xs text-muted mb-3">The same openings, with the courses you play as {side}.</p>
            <Grid>{theirs.map(card)}</Grid>
          </Collapsible>
          <Collapsible title={`Offbeat & surprise weapons (${offbeat.length})`} testid="offbeat">
            <Grid>{offbeat.map(card)}</Grid>
          </Collapsible>
        </>
      )}
    </div>
  );
}

const cap = (s: string) => s[0].toUpperCase() + s.slice(1);
function toggle<T>(set: Set<T>, v: T): Set<T> {
  const n = new Set(set);
  if (n.has(v)) n.delete(v);
  else n.add(v);
  return n;
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={on}
      className={`text-xs px-3 min-h-[32px] rounded-full border ${on ? "border-accent bg-accent-soft text-accent font-medium" : "border-edge bg-surface text-muted hover:text-foreground"}`}
    >
      {children}
    </button>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="text-sm font-medium text-muted uppercase tracking-wide mb-3">{title}</h2>
      {children}
    </section>
  );
}

function Collapsible({ title, children, testid }: { title: string; children: React.ReactNode; testid: string }) {
  const [open, setOpen] = useState(false);
  return (
    <section data-testid={testid}>
      <button onClick={() => setOpen(!open)} aria-expanded={open} className="flex items-center gap-1 text-sm font-medium text-muted uppercase tracking-wide min-h-[40px]">
        {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />} {title}
      </button>
      {open && <div className="mt-2">{children}</div>}
    </section>
  );
}

function Grid({ children }: { children: React.ReactNode }) {
  return <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">{children}</div>;
}

/** Mastery of every started course (derived once per progress change). */
function startedProgress(ds: Dataset): Map<string, ReturnType<typeof courseProgressInfo>> {
  const out = new Map<string, ReturnType<typeof courseProgressInfo>>();
  const cards = allCards();
  for (const id of Object.keys(allCourseProgress())) {
    const p = parseCourseId(id);
    const system = p && findSystem(ds, p.hub, p.system, p.side);
    const course = system ? loadCourse(ds, system, overridesFor(id)) : null;
    if (course) out.set(id, courseProgressInfo(modelOf(ds), course, tierLines(course, "complete"), cards));
  }
  return out;
}

const HubCardView = memo(function HubCardView({
  ds,
  hub,
  side,
  fresh,
  onDismiss,
  progress,
}: {
  ds: Dataset;
  hub: RawHubSummary;
  side: Side;
  fresh: number;
  onDismiss: (slug: string) => void;
  progress: ReturnType<typeof courseProgressInfo> | null;
}) {
  const { system, course } = hubCard(ds, hub, side);
  const sigmaEpd = ds.nodes[hub.sigmaNode].epd;
  const moves = formatMoves(hub.sigma, 0, 6);
  return (
    <div className="hub-cell">
      <article className="relative rounded-xl border border-edge bg-surface hover:border-accent/60 transition-colors" data-testid="hub-card" data-hub={hub.slug}>
        {/* no viewport prefetch for 100+ cards (Next still prefetches on hover/focus) */}
        <Link prefetch={false} href={`${hubHref(hub.slug)}?side=${side}`} className="flex gap-3 p-3 rounded-xl focus-visible:outline-2 focus-visible:outline-accent">
          {/* the link's name is its visible text (title, moves, side badge); the board repeats the moves */}
          <div className="w-24 shrink-0">
            <MiniBoard fen={sigmaEpd} orientation={side} approach={hub.sigma} decorative />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-start gap-2">
              <h3 className="font-medium leading-snug flex-1 min-w-0">{hub.title}</h3>
              {progress && <ProgressRing value={progress.mastery} due={progress.due} />}
            </div>
            <div className="text-xs text-muted font-mono truncate mt-0.5">{moves}</div>
            <div className="mt-1.5 flex flex-wrap gap-1 text-[11px] text-muted">
              {course && (
                <span className="px-1.5 rounded bg-surface-2">
                  {course.essentials[0]} / {course.complete[0]} lines
                </span>
              )}
              {course && <span className="px-1.5 rounded bg-surface-2">depth {course.avgDepth}</span>}
              <span className="px-1.5 rounded bg-surface-2">{hub.games.toLocaleString()} games</span>
              <span className={`px-1.5 rounded border ${side === "white" ? "border-edge bg-white text-black" : "border-black bg-black text-white"}`}>{side === "white" ? "White" : "Black"}</span>
            </div>
            {hub.games >= 10 && <WinBar white={hub.wdl[0]} draws={hub.wdl[1]} black={hub.wdl[2]} className="h-1.5 mt-2" showLabels={false} />}
            {!system && <div className="text-[11px] text-muted mt-1">No course for {side} yet</div>}
          </div>
        </Link>
        {fresh > 0 && (
          <span data-testid="new-lines-badge" className="absolute -top-2 right-2 inline-flex items-center gap-1 rounded-full bg-accent text-accent-fg text-[11px] font-medium pl-2 pr-1 py-0.5 shadow">
            <Sparkles size={11} aria-hidden /> +{fresh} new line{fresh === 1 ? "" : "s"}
            <button aria-label={`Dismiss the new-lines badge for ${hub.title}`} onClick={() => onDismiss(hub.slug)} className="p-0.5 rounded hover:bg-black/15">
              <X size={11} />
            </button>
          </span>
        )}
      </article>
    </div>
  );
});

function ProgressRing({ value, due }: { value: number; due: number }) {
  const r = 9;
  const c = 2 * Math.PI * r;
  return (
    <span className="inline-flex items-center gap-1 shrink-0" title={`${Math.round(value * 100)}% mastered${due ? ` · ${due} due` : ""}`}>
      <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden>
        <circle cx="11" cy="11" r={r} fill="none" stroke="var(--border)" strokeWidth="3" />
        <circle cx="11" cy="11" r={r} fill="none" stroke="var(--accent)" strokeWidth="3" strokeDasharray={`${value * c} ${c}`} transform="rotate(-90 11 11)" strokeLinecap="round" />
      </svg>
      {due > 0 && <span className="text-[11px] font-medium text-accent">{due}</span>}
      <span className="sr-only">{Math.round(value * 100)}% mastered{due ? `, ${due} due` : ""}</span>
    </span>
  );
}

/** "Pick up where you left off", with due counts. */
export function ContinueRow({ ds }: { ds: Dataset }) {
  useProgressVersion();
  const hydrated = useHydrated();
  if (!hydrated) return null;
  const started = Object.values(allCourseProgress())
    .filter((p) => p.lastStudiedAt)
    .sort((a, b) => (b.lastStudiedAt! > a.lastStudiedAt! ? 1 : -1))
    .slice(0, 4);
  const items = started
    .map((p) => {
      const id = parseCourseId(p.courseId);
      const hub = id && hubSummary(ds, id.hub);
      const system = id && hub ? findSystem(ds, id.hub, id.system, id.side) : null;
      if (!hub || !system) return null;
      const course = loadCourse(ds, system, overridesFor(p.courseId));
      if (!course) return null;
      const info = courseProgressInfo(modelOf(ds), course, tierLines(course, "complete"), allCards());
      const last = course.lines.find((l) => l.id === p.lastLineId);
      return { p, hub, system, course, info, last };
    })
    .filter((x): x is NonNullable<typeof x> => !!x);
  if (!items.length) return null;
  return (
    <Section title="Continue">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" data-testid="continue-row">
        {items.map(({ p, hub, system, info, last }) => {
          const base = `/train/${hub.slug}/${system.slug}/${system.side}`;
          const href = info.due ? `${base}?mode=review` : `${base}?mode=learn`;
          return (
            <div key={p.courseId} className="rounded-xl border border-edge bg-surface p-3">
              <div className="text-sm font-medium truncate">{system.name}</div>
              <div className="text-xs text-muted truncate">{last ? `Last: ${last.name}` : `As ${system.side}`}</div>
              <div className="mt-2 flex items-center gap-2">
                <Link href={href} className="inline-flex items-center gap-1 text-sm px-3 min-h-[36px] rounded-md bg-accent text-accent-fg font-medium">
                  <Play size={13} aria-hidden /> Resume
                </Link>
                <span className="text-xs text-muted">
                  {info.due ? `${info.due} due · ~${reviewMinutes(info.due)} min` : `${Math.round(info.mastery * 100)}% mastered`}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </Section>
  );
}

function SearchResults({ ds, hits, side }: { ds: Dataset; hits: SearchHit[]; side: Side }) {
  if (!hits.length) return <p className="text-sm text-muted py-6">No opening matches that. Try a name (Najdorf), an ECO code (B90) or moves (e4 c5 Nf3).</p>;
  return (
    <ul className="divide-y divide-edge rounded-xl border border-edge bg-surface" data-testid="search-results">
      {hits.map((h) => {
        const t = rowTarget(ds, h.row, side);
        const hub = h.hub;
        return (
          <li key={h.row} className="flex items-center gap-3 px-4 py-2.5" data-testid="search-hit">
            <div className="min-w-0 flex-1">
              <div className="text-sm truncate">
                {hub ? (
                  <Link href={`${hubHref(hub.slug)}?side=${side}`} className="hover:text-accent font-medium">
                    {h.name}
                  </Link>
                ) : (
                  <span className="font-medium">{h.name}</span>
                )}
                {h.eco && <span className="ml-2 font-mono text-xs text-muted">{h.eco}</span>}
              </div>
              <div className="text-xs text-muted font-mono truncate">{formatMoves(h.sans, 0, 12)}</div>
            </div>
            {t && (
              <Link href={trainHref(t)} className="text-xs px-3 min-h-[36px] inline-flex items-center gap-1 rounded-md border border-edge hover:bg-surface-2 shrink-0" aria-label={`Learn ${h.name} as ${side}`}>
                <Play size={12} aria-hidden /> Learn as {side}
              </Link>
            )}
          </li>
        );
      })}
    </ul>
  );
}

