"use client";
/**
 * /insights (spec §3.2): link Chess.com / Lichess, import recent games, and
 * answer where the openings go wrong, how they score, and what to learn
 * next. Every number comes from the imported games; every finding links into
 * the trainer.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ArrowDown, ArrowUp, ChevronsUpDown, GraduationCap, Loader2, TriangleAlert } from "lucide-react";
import MiniBoard from "@/components/MiniBoard";
import LinkedAccounts, { RatingsLine } from "@/components/insights/LinkedAccounts";
import { useAuth } from "@/lib/supabase/AuthProvider";
import { useDataset } from "@/lib/hooks";
import { moveLabel } from "@/lib/openings-build/courses";
import { analyse, byOpening, repeatDeviations, summary, type OpeningRow, type RepeatGroup } from "@/lib/insights/aggregate";
import { playerBand } from "@/lib/insights/bands";
import { cancelSync, clearGuest, guestData, saveGuestToAccount, syncStale, useInsights, type InsightsStatus } from "@/lib/insights/client";
import { recommend, type Rec } from "@/lib/insights/recommend";
import { useVerdicts, verdictKey, type GroupVerdict } from "@/lib/insights/verdicts";
import { MIN_GAMES } from "@/lib/insights/weights";
import { PLATFORM_NAME, PLATFORMS, TIME_CLASSES, type LinkedAccount, type Platform, type Ratings, type Side } from "@/lib/insights/types";
import type { Dataset } from "@/lib/openings";

const pct = (x: number) => `${Math.round(x * 100)}%`;
const cap = (s: Side) => (s === "white" ? "White" : "Black");
const fmtDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
/** mean plies in book → the move number where the game leaves book */
const moveOf = (plies: number) => Math.floor(plies / 2) + 1;

export default function InsightsClient() {
  const { user, loading: authLoading, configured } = useAuth();
  const { ds } = useDataset();
  const ins = useInsights(user?.id ?? null, authLoading);
  const linked = PLATFORMS.filter((p) => ins.data.accounts[p]);
  const signedIn = !!user && !ins.serverless;

  // re-sync stale accounts once per visit
  const autoSynced = useRef(false);
  useEffect(() => {
    if (!ins.loaded || autoSynced.current) return;
    autoSynced.current = true;
    void syncStale();
  }, [ins.loaded]);

  return (
    <div className="py-8" data-testid="insights">
      <h1 className="text-2xl font-semibold tracking-tight mb-1">Insights</h1>
      <p className="text-sm text-muted mb-6">Your own Chess.com and Lichess games: where your openings go wrong, how they score, and what to learn next.</p>

      {!ins.loaded ? (
        <div className="h-40 rounded-lg bg-surface-2 animate-pulse" />
      ) : (
        <>
          <StatusBar status={ins.status} />
          {user && ins.serverless && (
            <p className="text-xs text-muted rounded-lg border border-edge bg-surface-2 px-4 py-3 mb-4">
              Account storage for Insights isn&apos;t set up on this deployment yet, so these insights are kept in this browser.
            </p>
          )}
          {signedIn && <GuestSavePrompt hasServerData={linked.length > 0} />}

          {!linked.length ? (
            <section className="rounded-xl border border-edge bg-surface p-5 mb-8" data-testid="insights-onboarding">
              <h2 className="font-medium">Link your Chess.com or Lichess account</h2>
              <p className="text-sm text-muted mt-1 mb-4">
                Enter your username. We import your recent rated games and compare every opening move with the theory in this trainer.
                {!user && configured && (
                  <>
                    {" "}
                    You&apos;re a guest: results stay in this browser. <Link href="/auth" className="text-accent underline">Sign in</Link> to keep them on your account.
                  </>
                )}
              </p>
              <LinkedAccounts accounts={ins.data.accounts} status={ins.status} signedIn={signedIn} />
            </section>
          ) : !ds ? (
            <div className="h-64 rounded-lg bg-surface-2 animate-pulse" />
          ) : (
            <Report ds={ds} games={ins.data.games} accounts={ins.data.accounts} status={ins.status} signedIn={signedIn} />
          )}
        </>
      )}
    </div>
  );
}

function StatusBar({ status }: { status: InsightsStatus }) {
  if (status.phase === "syncing" && status.platform) {
    const p = status.progress;
    return (
      <div className="rounded-lg border border-edge bg-surface px-4 py-3 mb-4" data-testid="import-progress">
        <div className="flex items-center gap-2 text-sm">
          <Loader2 size={14} className="animate-spin motion-reduce:animate-none" aria-hidden />
          <span aria-live="polite">
            Importing from {PLATFORM_NAME[status.platform]}: {p?.label ?? "starting"}
            {p && p.kept ? ` · ${p.kept} games kept` : ""}
          </span>
          <button onClick={cancelSync} className="ml-auto text-xs text-muted underline hover:text-foreground">
            Cancel
          </button>
        </div>
        <div
          role="progressbar"
          aria-label={`Import from ${PLATFORM_NAME[status.platform]}`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={p?.fraction != null ? Math.round(p.fraction * 100) : undefined}
          className="mt-2 h-1.5 rounded bg-surface-2 overflow-hidden"
        >
          <div className="h-full bg-accent transition-[width] motion-reduce:transition-none" style={{ width: `${Math.round((p?.fraction ?? 0) * 100)}%` }} />
        </div>
      </div>
    );
  }
  if (status.phase === "error" && status.message) {
    return (
      <p role="alert" className="flex items-center gap-2 rounded-lg border border-danger/50 bg-surface px-4 py-3 mb-4 text-sm text-danger-ink" data-testid="import-error">
        <TriangleAlert size={15} aria-hidden /> {status.message}
      </p>
    );
  }
  if (status.last) {
    const skipped = Object.values(status.last.skipped).reduce((a, b) => a + (b ?? 0), 0);
    return (
      <p role="status" className="text-sm text-muted mb-4" data-testid="import-done">
        {PLATFORM_NAME[status.last.platform]}: {status.last.added ? `${status.last.added} new game${status.last.added === 1 ? "" : "s"} imported` : "no new games"}
        {skipped ? ` · ${skipped} skipped (unrated, variants or other time controls)` : ""}.
      </p>
    );
  }
  return null;
}

function GuestSavePrompt({ hasServerData }: { hasServerData: boolean }) {
  const [guest] = useState(() => guestData());
  const [busy, setBusy] = useState(false);
  const [gone, setGone] = useState(false);
  const n = guest.games.length;
  if (gone || hasServerData || !Object.keys(guest.accounts).length) return null;
  return (
    <div className="rounded-lg border border-accent/50 bg-accent-soft px-4 py-3 mb-4 text-sm flex flex-wrap items-center gap-3" data-testid="guest-save">
      <span>
        This browser has insights from before you signed in ({n} game{n === 1 ? "" : "s"}).
      </span>
      <button
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          await saveGuestToAccount();
          setBusy(false);
          setGone(true);
        }}
        className="px-3 min-h-[36px] rounded-md bg-accent text-accent-fg text-sm font-medium disabled:opacity-50"
      >
        Save them to your account
      </button>
      <button
        onClick={() => {
          clearGuest();
          setGone(true);
        }}
        className="text-xs underline text-muted"
      >
        Discard
      </button>
    </div>
  );
}

function Report({
  ds,
  games: raw,
  accounts,
  status,
  signedIn,
}: {
  ds: Dataset;
  games: Parameters<typeof analyse>[1];
  accounts: Partial<Record<Platform, LinkedAccount>>;
  status: InsightsStatus;
  signedIn: boolean;
}) {
  const games = useMemo(() => analyse(ds, raw), [ds, raw]);
  const rows = useMemo(() => byOpening(ds, games), [ds, games]);
  const repeats = useMemo(() => repeatDeviations(ds, games), [ds, games]);
  const sum = useMemo(() => summary(games), [games]);
  const ratings = useMemo(() => Object.fromEntries(PLATFORMS.filter((p) => accounts[p]).map((p) => [p, accounts[p]!.ratings])) as Partial<Record<Platform, Ratings>>, [accounts]);
  const band = useMemo(() => playerBand(games, ratings), [games, ratings]);
  const recs = useMemo(() => recommend(ds, games, rows, band), [ds, games, rows, band]);

  return (
    <div className="space-y-10">
      <section aria-labelledby="ins-summary" data-testid="insights-summary">
        <h2 id="ins-summary" className="text-xs uppercase tracking-wider text-muted mb-3">
          Summary
        </h2>
        <div className="grid sm:grid-cols-3 gap-3">
          <div className="rounded-lg border border-edge bg-surface p-4">
            <div className="text-xs text-muted mb-1">games imported</div>
            <div className="text-2xl font-semibold leading-none">{sum.games}</div>
            <div className="text-xs text-muted mt-2">
              {sum.from && sum.to ? `${fmtDate(sum.from)} – ${fmtDate(sum.to)}` : "no games in the window yet"}
            </div>
          </div>
          {PLATFORMS.filter((p) => accounts[p]).map((p) => (
            <div key={p} className="rounded-lg border border-edge bg-surface p-4">
              <div className="text-xs text-muted mb-1">
                {PLATFORM_NAME[p]} · {accounts[p]!.username}
              </div>
              <div className="text-sm">
                <RatingsLine ratings={accounts[p]!.ratings} />
              </div>
              <div className="text-xs text-muted mt-2">
                {TIME_CLASSES.filter((tc) => sum.perPlatform[p]?.[tc])
                  .map((tc) => `${sum.perPlatform[p]![tc]} ${tc}`)
                  .join(" · ") || "no games imported"}
              </div>
            </div>
          ))}
        </div>
        {!sum.games && status.phase !== "syncing" && (
          <p className="text-sm text-muted mt-3">No rated games in the last 3 months in the time controls you import. Play a few, or include bullet below.</p>
        )}
      </section>

      {sum.games > 0 && (
        <>
          <Recommendations recs={recs} band={band} />
          <RepeatMistakes groups={repeats} />
          <LeaveBook rows={rows} />
          <Results rows={rows} />
        </>
      )}

      <section aria-labelledby="ins-accounts" className="rounded-xl border border-edge bg-surface p-5">
        <h2 id="ins-accounts" className="text-xs uppercase tracking-wider text-muted mb-3">
          Linked accounts
        </h2>
        <LinkedAccounts accounts={accounts} status={status} signedIn={signedIn} />
      </section>
    </div>
  );
}

// ── Recommendations ─────────────────────────────────────────────────────────

const KIND: Record<Rec["kind"], { label: string; cls: string }> = {
  fix: { label: "Fix", cls: "text-danger-ink border-danger/50" },
  fill: { label: "Fill", cls: "text-gold-ink border-gold/60" },
  grow: { label: "Grow", cls: "text-accent border-accent/50" },
};

function Recommendations({ recs, band }: { recs: Rec[]; band: ReturnType<typeof playerBand> }) {
  return (
    <section aria-labelledby="ins-recs" data-testid="insights-recs">
      <h2 id="ins-recs" className="text-xs uppercase tracking-wider text-muted mb-1">
        Recommended for you
      </h2>
      <p className="text-xs text-muted mb-3">
        {band
          ? `Your level: ${band.name} (${PLATFORM_NAME[band.platform]} ${band.timeClass} ${band.rating}${band.provisional ? ", provisional" : ""}). Bands are per platform; ratings aren't converted.`
          : "No rating for the time control you play most, so suggestions aren't tuned to a level."}{" "}
        Grow suggestions are based on how common an opening is and your style, not on win rates at your level.
      </p>
      {!recs.length ? (
        <p className="text-sm text-muted rounded-lg border border-dashed border-edge px-4 py-3">Nothing to suggest yet: import more games.</p>
      ) : (
        <ul className="grid md:grid-cols-2 gap-3">
          {recs.map((r) => (
            <li key={`${r.kind}|${r.link.course}`} className="rounded-lg border border-edge bg-surface p-4 flex flex-col" data-testid="rec">
              <div className="flex items-center gap-2">
                <span className={`text-[11px] uppercase tracking-wider border rounded px-1.5 py-0.5 ${KIND[r.kind].cls}`}>{KIND[r.kind].label}</span>
                <span className="text-xs text-muted">as {cap(r.color)}</span>
              </div>
              <h3 className="font-medium mt-2">{r.title}</h3>
              <p className="text-sm text-muted mt-1 flex-1">{r.reason}</p>
              <div className="flex flex-wrap gap-2 mt-3">
                <Link href={r.link.train} className="inline-flex items-center gap-1.5 px-3 min-h-[40px] rounded-md bg-accent text-accent-fg text-sm font-medium hover:opacity-90">
                  <GraduationCap size={14} aria-hidden /> Start learning
                </Link>
                <Link href={r.link.course} className="inline-flex items-center px-3 min-h-[40px] rounded-md border border-edge text-sm hover:bg-surface-2">
                  Open course
                </Link>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ── Repeat mistakes ─────────────────────────────────────────────────────────

function VerdictBadge({ v }: { v: GroupVerdict | "pending" | "none" | undefined }) {
  if (!v || v === "none") return <span className="text-xs text-muted">not evaluated</span>;
  if (v === "pending")
    return (
      <span className="text-xs text-muted inline-flex items-center gap-1">
        <Loader2 size={12} className="animate-spin motion-reduce:animate-none" aria-hidden /> evaluating
      </span>
    );
  const src = v.source === "lichess" ? "Lichess analysis" : "Stockfish";
  if (v.verdict === "playable") return <span className="text-xs text-accent">Your sideline: playable ({src})</span>;
  const label = v.verdict === "blunder" ? "Blunder" : v.verdict === "mistake" ? "Mistake" : "Inaccuracy";
  return (
    <span className="text-xs text-danger-ink">
      {label}: about {(v.drop / 100).toFixed(1)} pawns lost ({src})
    </span>
  );
}

function RepeatMistakes({ groups }: { groups: RepeatGroup[] }) {
  const shown = groups.slice(0, 12);
  const verdicts = useVerdicts(shown);
  return (
    <section aria-labelledby="ins-repeat" data-testid="insights-repeats">
      <h2 id="ins-repeat" className="text-xs uppercase tracking-wider text-muted mb-1">
        Repeat mistakes
      </h2>
      <p className="text-xs text-muted mb-3">Positions where you played the same move out of book in two or more games. The verdict says whether it costs you.</p>
      {!shown.length ? (
        <p className="text-sm text-muted rounded-lg border border-dashed border-edge px-4 py-3">No position where you left book the same way twice.</p>
      ) : (
        <ul className="grid sm:grid-cols-2 gap-3">
          {shown.map((g) => (
            <li key={verdictKey(g)} className="min-w-0 rounded-lg border border-edge bg-surface p-3 flex gap-3" data-testid="repeat">
              <div className="w-24 shrink-0">
                <MiniBoard fen={g.epd} orientation={g.color} approach={g.plies} label={`Position after ${g.plies.length ? g.plies.join(" ") : "the start"}`} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium truncate">{g.name}</div>
                <div className="text-sm mt-0.5">
                  You played <span className="font-medium">{moveLabel(g.plies.length, g.playedSan)}</span> {g.games}×
                </div>
                <div className="text-xs text-muted">
                  Theory: <span>{g.bookSans.slice(0, 3).map((s) => moveLabel(g.plies.length, s)).join(", ") || "—"}</span>
                </div>
                <div className="text-xs text-muted">
                  You scored {pct(g.score)} ({g.w} won, {g.d} drawn, {g.l} lost)
                </div>
                <VerdictBadge v={verdicts[verdictKey(g)]} />
                <div>
                  <Link href={g.link.train} className="mt-2 inline-flex items-center gap-1.5 px-3 min-h-[36px] rounded-md border border-edge text-sm hover:bg-surface-2">
                    <GraduationCap size={14} aria-hidden /> Train this line
                  </Link>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ── Where you leave book ────────────────────────────────────────────────────

function LeaveBook({ rows }: { rows: OpeningRow[] }) {
  const shown = rows.filter((r) => r.enough).slice(0, 10);
  return (
    <section aria-labelledby="ins-leave" data-testid="insights-leave">
      <h2 id="ins-leave" className="text-xs uppercase tracking-wider text-muted mb-1">
        Where you leave book
      </h2>
      <p className="text-xs text-muted mb-3">For each opening you play at least {MIN_GAMES} times: the move where the game leaves theory on average, who left first, and how you scored after.</p>
      {!shown.length ? (
        <p className="text-sm text-muted rounded-lg border border-dashed border-edge px-4 py-3">No opening with {MIN_GAMES}+ games yet.</p>
      ) : (
        <ul className="rounded-lg border border-edge bg-surface divide-y divide-edge">
          {shown.map((r) => (
            <li key={`${r.family}|${r.color}`} className="px-4 py-3 flex flex-wrap items-center gap-x-6 gap-y-1">
              <div className="min-w-0 flex-1 basis-56">
                <div className="text-sm font-medium">{r.family}</div>
                <div className="text-xs text-muted">
                  as {cap(r.color)} · {r.games} games · leaves book around move {moveOf(r.avgBookPly)}
                </div>
              </div>
              <div className="text-xs text-muted basis-40">
                You left first: {pct(r.byMe.games / r.games)}
                {r.byMe.games ? `, scored ${pct(r.byMe.score)}` : ""}
              </div>
              <div className="text-xs text-muted basis-44">
                Opponent left first: {pct(r.byOpp.games / r.games)}
                {r.byOpp.games ? `, you scored ${pct(r.byOpp.score)}` : ""}
              </div>
              <Link href={r.link.train} className="text-xs px-3 min-h-[36px] inline-flex items-center rounded-md border border-edge hover:bg-surface-2 shrink-0">
                Train where you leave
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ── Results by opening ──────────────────────────────────────────────────────

type SortKey = "family" | "games" | "score" | "w" | "d" | "l";

function Results({ rows }: { rows: OpeningRow[] }) {
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "games", desc: true });
  const shown = rows.filter((r) => r.enough);
  const hidden = rows.length - shown.length;
  const sorted = [...shown].sort((a, b) => {
    const d = sort.key === "family" ? a.family.localeCompare(b.family) : (a[sort.key] as number) - (b[sort.key] as number);
    return (sort.desc ? -d : d) || b.games - a.games;
  });
  const th = (key: SortKey, label: string, align = "text-right") => {
    const active = sort.key === key;
    return (
      <th scope="col" aria-sort={active ? (sort.desc ? "descending" : "ascending") : "none"} className={`font-normal px-3 py-2.5 ${align}`}>
        <button onClick={() => setSort({ key, desc: active ? !sort.desc : key !== "family" })} className="inline-flex items-center gap-1 hover:text-foreground">
          {label}
          {active ? sort.desc ? <ArrowDown size={12} aria-hidden /> : <ArrowUp size={12} aria-hidden /> : <ChevronsUpDown size={12} aria-hidden />}
        </button>
      </th>
    );
  };
  return (
    <section aria-labelledby="ins-results" data-testid="insights-results">
      <h2 id="ins-results" className="text-xs uppercase tracking-wider text-muted mb-3">
        Results by opening
      </h2>
      {!shown.length ? (
        <p className="text-sm text-muted rounded-lg border border-dashed border-edge px-4 py-3">No opening with {MIN_GAMES}+ games yet.</p>
      ) : (
        <>
          <div className="hidden sm:block rounded-lg border border-edge bg-surface overflow-hidden">
            <table className="w-full text-sm">
              <caption className="sr-only">Results by opening and colour, from your imported games</caption>
              <thead>
                <tr className="text-xs text-muted border-b border-edge">
                  {th("family", "Opening", "text-left")}
                  <th scope="col" className="font-normal px-3 py-2.5 text-left">
                    Colour
                  </th>
                  {th("games", "Games")}
                  {th("w", "Won")}
                  {th("d", "Drawn")}
                  {th("l", "Lost")}
                  {th("score", "Score")}
                </tr>
              </thead>
              <tbody>
                {sorted.map((r) => (
                  <tr key={`${r.family}|${r.color}`} className="border-b border-edge last:border-0">
                    <td className="px-3 py-2">
                      <Link href={r.link.course} className="hover:underline">
                        {r.family}
                      </Link>
                    </td>
                    <td className="px-3 py-2 text-muted">{cap(r.color)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{r.games}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{r.w}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{r.d}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{r.l}</td>
                    <td className="px-3 py-2 text-right tabular-nums font-medium">{pct(r.score)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="sm:hidden rounded-lg border border-edge bg-surface divide-y divide-edge">
            {sorted.map((r) => (
              <li key={`${r.family}|${r.color}`} className="px-4 py-3">
                <Link href={r.link.course} className="text-sm font-medium hover:underline">
                  {r.family}
                </Link>
                <div className="text-xs text-muted">
                  as {cap(r.color)} · {r.games} games · {r.w} won, {r.d} drawn, {r.l} lost · score {pct(r.score)}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
      {hidden > 0 && <p className="text-xs text-muted mt-2">{hidden} opening{hidden === 1 ? "" : "s"} with fewer than {MIN_GAMES} games not shown.</p>}
    </section>
  );
}
