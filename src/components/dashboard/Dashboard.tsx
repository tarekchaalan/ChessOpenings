"use client";
/**
 * The home dashboard: rating, streaks, review queue, per-opening mastery,
 * and quick entry points. Renders identically for guests (local progress)
 * and signed-in players (server progress).
 */
import Link from "next/link";
import { useMemo } from "react";
import {
  AlarmClock,
  BookOpen,
  ChevronRight,
  Flame,
  GraduationCap,
  Sparkles,
  Swords,
  Target,
  Trophy,
} from "lucide-react";
import { useAuth } from "@/lib/supabase/AuthProvider";
import { useLegacyDataset, useProgressSummary } from "@/lib/hooks";
import { openingCatalog } from "@/lib/openings";

export default function Dashboard() {
  const { ds } = useLegacyDataset();
  const { summary } = useProgressSummary();
  const { user, username, configured } = useAuth();

  const hasActivity = (summary?.attempts ?? 0) > 0;

  if (!ds || !summary) {
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

  return (
    <div className="py-8">
      <h1 className="text-2xl font-semibold tracking-tight mb-1">
        {user ? `Welcome back, ${username ?? "player"}` : "Your training board"}
      </h1>
      <p className="text-sm text-muted mb-6">
        {hasActivity
          ? "Keep the streak alive — the review queue knows what you're about to forget."
          : "Learn an opening move by move, then quiz yourself until it sticks."}
      </p>

      {!hasActivity && <GettingStarted ds={ds} />}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-8">
        <StatCard
          icon={<Target size={16} />}
          label={user ? "rating" : "practice rating"}
          value={summary.rating.toLocaleString()}
        />
        <StatCard
          icon={<Flame size={16} className={summary.dailyStreak > 0 ? "text-gold" : undefined} />}
          label="day streak"
          value={String(summary.dailyStreak)}
        />
        <StatCard
          icon={<Sparkles size={16} />}
          label="accuracy"
          value={summary.attempts ? `${Math.round((summary.correct / summary.attempts) * 100)}%` : "—"}
          sub={summary.attempts ? `${summary.attempts.toLocaleString()} answers` : undefined}
        />
        <Link
          href={summary.dueCount > 0 ? "/quiz/review" : "/quiz"}
          className={`rounded-lg border p-4 transition-colors ${
            summary.dueCount > 0
              ? "border-gold/60 bg-surface hover:border-gold"
              : "border-edge bg-surface hover:border-accent"
          }`}
        >
          <div className="flex items-center gap-1.5 text-muted text-xs mb-1">
            <AlarmClock size={16} className={summary.dueCount > 0 ? "text-gold" : undefined} />
            due for review
          </div>
          <div className="text-2xl font-semibold leading-none">
            {summary.dueCount}
            <span className="text-xs text-muted font-normal ml-2">
              {summary.dueCount > 0 ? "review now →" : "all clear"}
            </span>
          </div>
        </Link>
      </div>

      {!configured && (
        <div className="text-xs text-muted mb-8 rounded-lg border border-edge bg-surface-2 px-4 py-3">
          Progress is stored in this browser. Configure Supabase (see README) to enable accounts,
          cross-device sync and the leaderboard.
        </div>
      )}
      {configured && !user && (
        <div className="flex items-center gap-3 text-sm mb-8 rounded-lg border border-edge bg-surface px-4 py-3">
          <Trophy size={16} className="text-gold shrink-0" />
          <span className="text-muted">
            You&apos;re training as a guest.{" "}
            <Link href="/auth" className="text-accent underline">
              Sign in
            </Link>{" "}
            to save progress and enter the leaderboard.
          </span>
        </div>
      )}

      {hasActivity && (
        <div className="grid lg:grid-cols-[1fr_340px] gap-6 items-start">
          <section>
            <h2 className="text-xs uppercase tracking-wider text-muted mb-3">Your openings</h2>
            <div className="space-y-2">
              {summary.perOpening.slice(0, 12).map((p) => {
                const o = ds.openings[p.openingId];
                if (!o) return null;
                const acc = p.seen ? Math.round((p.correct / p.seen) * 100) : 0;
                return (
                  <div
                    key={p.openingId}
                    className="rounded-lg border border-edge bg-surface p-3 flex items-center gap-3"
                  >
                    <span className="font-mono text-xs text-accent w-8 shrink-0">{o.eco}</span>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium truncate">{o.name}</div>
                      <div className="flex items-center gap-2 mt-1.5">
                        <div className="h-1.5 flex-1 rounded-full bg-surface-2 overflow-hidden">
                          <div
                            className="h-full bg-accent transition-all"
                            style={{ width: `${p.mastery}%` }}
                          />
                        </div>
                        <span className="text-xs text-muted font-mono w-9 text-right">
                          {p.mastery}%
                        </span>
                      </div>
                    </div>
                    <div className="text-right text-xs text-muted shrink-0 w-20">
                      <div>{acc}% acc</div>
                      <div className="flex items-center justify-end gap-0.5">
                        <Flame size={11} className={p.streak > 2 ? "text-gold" : ""} />
                        {p.streak} streak
                      </div>
                    </div>
                    <div className="flex flex-col gap-1 shrink-0">
                      <Link
                        href={`/quiz/${p.openingId}`}
                        className="text-xs px-2 py-1 rounded bg-accent text-accent-fg hover:opacity-90"
                      >
                        quiz
                      </Link>
                      <Link
                        href={`/learn/${p.openingId}`}
                        className="text-xs px-2 py-1 rounded border border-edge text-muted hover:text-foreground text-center"
                      >
                        learn
                      </Link>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          <section>
            <h2 className="text-xs uppercase tracking-wider text-muted mb-3">Recent answers</h2>
            <div className="rounded-lg border border-edge bg-surface divide-y divide-[var(--border)]">
              {summary.recentAttempts.slice(0, 10).map((a, i) => {
                const o = ds.openings[a.openingId];
                return (
                  <div key={i} className="px-3 py-2 flex items-center gap-2 text-sm">
                    <span
                      className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                        a.correct ? "bg-accent" : "bg-danger"
                      }`}
                    />
                    <span className="font-mono text-xs">{a.san}</span>
                    <span className="text-xs text-muted truncate flex-1">{o?.name ?? ""}</span>
                    <span
                      className={`text-xs font-mono shrink-0 ${
                        a.ratingAfter - a.ratingBefore >= 0 ? "text-accent" : "text-danger"
                      }`}
                    >
                      {a.ratingAfter - a.ratingBefore >= 0 ? "+" : ""}
                      {a.ratingAfter - a.ratingBefore}
                    </span>
                  </div>
                );
              })}
              {!summary.recentAttempts.length && (
                <div className="px-3 py-6 text-center text-sm text-muted">No answers yet.</div>
              )}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

function StatCard({
  icon,
  label,
  value,
  sub,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="rounded-lg border border-edge bg-surface p-4">
      <div className="flex items-center gap-1.5 text-muted text-xs mb-1">
        {icon}
        {label}
      </div>
      <div className="text-2xl font-semibold leading-none">
        {value}
        {sub && <span className="text-xs text-muted font-normal ml-2">{sub}</span>}
      </div>
    </div>
  );
}

function GettingStarted({ ds }: { ds: NonNullable<ReturnType<typeof useLegacyDataset>["ds"]> }) {
  const picks = useMemo(() => openingCatalog(ds).slice(0, 3), [ds]);
  const steps = [
    {
      icon: <BookOpen size={18} />,
      title: "Explore",
      text: "Browse every named opening with real master-game stats.",
      href: "/explore",
      cta: "Open the explorer",
    },
    {
      icon: <GraduationCap size={18} />,
      title: "Learn",
      text: "Walk a mainline move by move with explanations and hints.",
      href: picks[0] ? `/learn/${picks[0].root.id}` : "/learn",
      cta: picks[0] ? `Start with the ${picks[0].root.family}` : "Pick an opening",
    },
    {
      icon: <Swords size={18} />,
      title: "Quiz",
      text: "The app plays the opponent — you produce the book move.",
      href: picks[0] ? `/quiz/${picks[0].root.id}` : "/quiz",
      cta: "Test yourself",
    },
  ];
  return (
    <div className="grid sm:grid-cols-3 gap-3 mb-8">
      {steps.map((s, i) => (
        <Link
          key={i}
          href={s.href}
          className="group rounded-lg border border-edge bg-surface p-4 hover:border-accent transition-colors"
        >
          <div className="flex items-center gap-2 text-accent mb-2">
            {s.icon}
            <span className="font-medium text-foreground">
              {i + 1}. {s.title}
            </span>
          </div>
          <p className="text-sm text-muted mb-3">{s.text}</p>
          <span className="text-sm text-accent flex items-center gap-1">
            {s.cta}
            <ChevronRight size={14} className="group-hover:translate-x-0.5 transition-transform" />
          </span>
        </Link>
      ))}
    </div>
  );
}
