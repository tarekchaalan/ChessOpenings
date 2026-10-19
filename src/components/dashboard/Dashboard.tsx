"use client";
/**
 * Dashboard (§3.2 E), on the v2 progress store: Continue, due today with a
 * time estimate, streak, a 7-day review forecast, repeat offenders with a
 * Drill button each, what's new in the opening data, and the leaderboard
 * teaser when a backend is configured.
 */
import Link from "next/link";
import { AlarmClock, BookOpen, Flame, LineChart, RefreshCw, Target, Trophy } from "lucide-react";
import { useAuth } from "@/lib/supabase/AuthProvider";
import { useDataset, useHydrated } from "@/lib/hooks";
import { findSystem, hubSummary, loadCourse, parseCourseId } from "@/lib/courses-client";
import { reviewMinutes } from "@/lib/catalog-client";
import { activityLog, allCards, overridesFor, useProgressVersion } from "@/lib/progress/store";
import { isMature, isReviewable, type CardState } from "@/lib/srs/fsrs";
import { forecast, streak } from "@/lib/progress/stats";
import { getPrefs } from "@/lib/prefs";
import { useLatestChanges } from "@/lib/changelog-client";
import { summarizeEntry } from "@/lib/openings-build/diff";
import { ContinueRow } from "@/components/openings/CatalogClient";
import type { Dataset } from "@/lib/openings";
import { useInsights } from "@/lib/insights/client";
import { analyse as analyseGames, repeatDeviations } from "@/lib/insights/aggregate";
import { knownVerdicts } from "@/lib/insights/verdicts";
import { usePlayerLevel } from "@/lib/setup/client";
import { LevelCard, SuggestedForLevel } from "@/components/setup/LevelCards";

const DAY = 86400_000;

export default function Dashboard() {
  const { ds } = useDataset();
  useProgressVersion();
  const hydrated = useHydrated();
  const { user, username, configured, loading: authLoading } = useAuth();
  const { entry } = useLatestChanges();
  const { estimate, level } = usePlayerLevel();

  if (!ds || !hydrated) {
    return (
      <div className="py-8 space-y-4 animate-pulse">
        <div className="h-9 w-80 rounded bg-surface-2" />
        <div className="grid sm:grid-cols-4 gap-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-24 rounded-lg bg-surface-2" />
          ))}
        </div>
        <div className="h-64 rounded-lg bg-surface-2" />
      </div>
    );
  }

  const cards = Object.values(allCards());
  const now = new Date();
  const due = cards.filter((c) => isReviewable(c, now)).length;
  const mature = cards.filter((c) => !c.archived && isMature(c)).length;
  const days = streak(activityLog(), now);
  const prefs = getPrefs();
  const fc = forecast(cards, now, { cap: prefs.dailyReviewCap, retention: prefs.targetRetention });
  const started = cards.length > 0;

  return (
    <div className="py-8" data-testid="dashboard">
      <h1 className="text-2xl font-semibold tracking-tight mb-1">{user ? `Welcome back, ${username ?? "player"}` : "Your training board"}</h1>
      <p className="text-sm text-muted mb-6">
        {started ? "Review what's due, then learn something new." : "Pick an opening, learn a line move by move, then let the schedule bring it back."}
      </p>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-8">
        <Link
          href={due ? "/train/review" : "/openings"}
          data-testid="due-card"
          className={`rounded-lg border p-4 transition-colors ${due ? "border-gold/60 bg-surface hover:border-gold" : "border-edge bg-surface hover:border-accent"}`}
        >
          <div className="flex items-center gap-1.5 text-muted text-xs mb-1">
            <AlarmClock size={16} className={due ? "text-gold" : undefined} /> due today
          </div>
          <div className="text-2xl font-semibold leading-none">
            {due}
            <span className="text-xs text-muted font-normal ml-2">{due ? `~${reviewMinutes(due)} min · review now →` : "all clear"}</span>
          </div>
        </Link>
        <Stat icon={<Flame size={16} className={days ? "text-gold" : undefined} />} label="day streak" value={String(days)} />
        <Stat icon={<Target size={16} />} label="positions mastered" value={String(mature)} sub={cards.length ? `of ${cards.length} learned` : undefined} />
        <Stat icon={<BookOpen size={16} />} label="positions learned" value={String(cards.length)} />
      </div>

      {level && (
        <div className="mb-8">
          <SuggestedForLevel ds={ds} level={level} title={started ? "Suggested for your level" : "Start here"} />
        </div>
      )}

      {!started && !level && (
        <div className="mb-8 rounded-xl border border-edge bg-surface p-5">
          <h2 className="font-medium">Start with an opening</h2>
          <p className="text-sm text-muted mt-1">Each opening has courses for White and Black. Learn a line, recall it once, and Review brings it back before you forget.</p>
          <Link href="/openings" className="mt-3 inline-flex items-center gap-2 px-4 min-h-[44px] rounded-md bg-accent text-accent-fg text-sm font-medium">
            Browse openings
          </Link>
        </div>
      )}

      <ContinueRow ds={ds} />

      <div className="mt-8 grid lg:grid-cols-[1fr_340px] gap-6 items-start">
        <div className="space-y-8">
          <section data-testid="forecast">
            <h2 className="text-xs uppercase tracking-wider text-muted mb-3">Review forecast · next 7 days</h2>
            <Forecast counts={fc} now={now} />
          </section>
          <RepeatOffenders ds={ds} cards={cards} />
        </div>
        <aside className="space-y-4">
          {estimate && level && <LevelCard estimate={estimate} level={level} />}
          <InsightsCard ds={ds} userId={user?.id ?? null} authLoading={authLoading} />
          {entry && (
            <section className="rounded-lg border border-edge bg-surface p-4" data-testid="data-news">
              <h2 className="flex items-center gap-1.5 text-xs uppercase tracking-wider text-muted">
                <RefreshCw size={13} aria-hidden /> New in the openings data
              </h2>
              <p className="text-sm mt-2">{summarizeEntry(entry)}</p>
              <Link href="/changes" className="text-xs text-accent hover:underline">See all changes</Link>
            </section>
          )}
          {configured && (
            <section className="rounded-lg border border-edge bg-surface p-4">
              <h2 className="flex items-center gap-1.5 text-xs uppercase tracking-wider text-muted">
                <Trophy size={13} className="text-gold" aria-hidden /> Leaderboard
              </h2>
              <p className="text-sm text-muted mt-2">
                {user ? "See where you stand." : (
                  <>
                    <Link href="/auth" className="text-accent underline">Sign in</Link> to save progress and enter the leaderboard.
                  </>
                )}
              </p>
              <Link href="/leaderboard" className="text-xs text-accent hover:underline">Open the leaderboard</Link>
            </section>
          )}
          {!configured && (
            <p className="text-xs text-muted rounded-lg border border-edge bg-surface-2 px-4 py-3">
              Progress is stored in this browser. Configure Supabase (see README) to enable accounts, cross-device sync and the leaderboard.
            </p>
          )}
        </aside>
      </div>
    </div>
  );
}

/** Insights teaser: repeat deviations from the imported games ("3 positions you keep getting wrong"). */
function InsightsCard({ ds, userId, authLoading }: { ds: Dataset; userId: string | null; authLoading: boolean }) {
  const ins = useInsights(userId, authLoading);
  const groups = ins.loaded && ins.data.games.length ? repeatDeviations(ds, analyseGames(ds, ins.data.games)) : [];
  const verdicts = knownVerdicts(groups);
  const wrong = verdicts.filter((v) => v && v.verdict !== "playable").length;
  const linked = Object.keys(ins.data.accounts).length > 0;
  return (
    <section className="rounded-lg border border-edge bg-surface p-4" data-testid="insights-card">
      <h2 className="flex items-center gap-1.5 text-xs uppercase tracking-wider text-muted">
        <LineChart size={13} aria-hidden /> Insights
      </h2>
      <p className="text-sm mt-2">
        {!ins.loaded
          ? "Loading…"
          : !linked
            ? "Link Chess.com or Lichess to see where your own games leave book."
            : wrong
              ? `${wrong} position${wrong === 1 ? "" : "s"} you keep getting wrong.`
              : groups.length
                ? `${groups.length} position${groups.length === 1 ? "" : "s"} where you keep leaving book the same way.`
                : `${ins.data.games.length} games imported; no repeated mistakes found.`}
      </p>
      <Link href={wrong || groups.length ? "/insights#ins-repeat" : "/insights"} className="text-xs text-accent hover:underline">
        {linked ? "Open Insights" : "Link an account"}
      </Link>
    </section>
  );
}

function Stat({ icon, label, value, sub }: { icon: React.ReactNode; label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-edge bg-surface p-4">
      <div className="flex items-center gap-1.5 text-muted text-xs mb-1">
        {icon} {label}
      </div>
      <div className="text-2xl font-semibold leading-none">
        {value}
        {sub && <span className="text-xs text-muted font-normal ml-2">{sub}</span>}
      </div>
    </div>
  );
}

function Forecast({ counts, now }: { counts: number[]; now: Date }) {
  const max = Math.max(1, ...counts);
  // days are UTC calendar days (the activity log and the buckets use UTC dates)
  const label = (i: number) => (i === 0 ? "Today" : new Date(now.getTime() + i * DAY).toLocaleDateString(undefined, { weekday: "short", timeZone: "UTC" }));
  return (
    <div className="rounded-lg border border-edge bg-surface p-4">
      <div className="flex items-end gap-2 h-32" role="img" aria-label={`Reviews due: ${counts.map((c, i) => `${label(i)} ${c}`).join(", ")}`}>
        {counts.map((c, i) => (
          <div key={i} className="flex-1 flex flex-col items-center justify-end h-full gap-1">
            <span className="text-[11px] text-muted tabular-nums">{c || ""}</span>
            <div className={`w-full rounded-t ${i === 0 ? "bg-accent" : "bg-accent/45"}`} style={{ height: `${(c / max) * 100}%`, minHeight: c ? 3 : 0 }} />
          </div>
        ))}
      </div>
      <div className="flex gap-2 mt-1">
        {counts.map((_, i) => (
          <span key={i} className="flex-1 text-center text-[11px] text-muted">{label(i)}</span>
        ))}
      </div>
    </div>
  );
}

/** Positions with the most lapses, each with a Drill of the lines through it. */
function RepeatOffenders({ ds, cards }: { ds: Dataset; cards: CardState[] }) {
  const worst = cards
    .filter((c) => c.lapses > 0 && !c.archived && c.lastCourseId)
    .sort((a, b) => b.lapses - a.lapses || (a.due < b.due ? -1 : 1))
    .slice(0, 6);
  return (
    <section data-testid="repeat-offenders">
      <h2 className="text-xs uppercase tracking-wider text-muted mb-3">Repeat offenders</h2>
      {!worst.length ? (
        <p className="text-sm text-muted rounded-lg border border-dashed border-edge px-4 py-3">No position has tripped you up yet.</p>
      ) : (
        <ul className="rounded-lg border border-edge bg-surface divide-y divide-edge">
          {worst.map((c) => {
            const p = parseCourseId(c.lastCourseId!);
            const hub = p && hubSummary(ds, p.hub);
            const system = p && hub ? findSystem(ds, p.hub, p.system, p.side) : null;
            const course = system ? loadCourse(ds, system, overridesFor(c.lastCourseId!)) : null;
            const line = course?.lines.find((l) => l.id === c.lastLineId);
            return (
              <li key={`${c.side}|${c.epd}|${c.answer}`} className="flex items-center gap-3 px-3 py-2">
                <span className="text-xs font-mono text-danger w-14 shrink-0">{c.lapses} lapse{c.lapses === 1 ? "" : "s"}</span>
                <div className="min-w-0 flex-1">
                  <div className="text-sm truncate">{line?.name ?? system?.name ?? "A position"}</div>
                  <div className="text-xs text-muted truncate">{system ? `${system.name} · as ${system.side}` : c.side}</div>
                </div>
                {hub && system && (
                  <Link
                    href={`/train/${hub.slug}/${system.slug}/${system.side}?mode=drill&under=${encodeURIComponent(c.epd)}${line ? `&line=${line.id}` : ""}`}
                    className="text-xs px-3 min-h-[36px] inline-flex items-center rounded-md border border-edge hover:bg-surface-2 shrink-0"
                  >
                    Drill these
                  </Link>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
