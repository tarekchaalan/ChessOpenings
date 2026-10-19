"use client";
/**
 * Global + weekly leaderboards, and Friends (you plus the players you follow,
 * same scores; friends_leaderboard in 0008). Rows come from server-side views
 * and functions over RPC-written ratings, so entries can't be forged.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { Medal, Trophy } from "lucide-react";
import { getSupabase, supabaseConfigured } from "@/lib/supabase/client";
import { useAuth } from "@/lib/supabase/AuthProvider";
import { friendsApi } from "@/lib/friends/api";
import FollowButton, { type FollowState } from "@/components/friends/FollowButton";

interface GlobalRow {
  rank: number;
  username: string;
  rating: number;
  attempts: number;
  correct: number;
}
interface WeeklyRow {
  rank: number;
  username: string;
  rating_gain: number;
  attempts: number;
  correct: number;
}

type Tab = "global" | "weekly" | "friends";

export default function LeaderboardClient() {
  const { username, user } = useAuth();
  const [tab, setTab] = useState<Tab>("global");
  const [global, setGlobal] = useState<GlobalRow[] | null>(null);
  const [weekly, setWeekly] = useState<WeeklyRow[] | null>(null);
  const [friends, setFriends] = useState<GlobalRow[] | null>(null);
  const [follows, setFollows] = useState<Record<string, FollowState>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const sb = getSupabase();
    if (!sb) return;
    Promise.all([
      sb.from("leaderboard_global").select("*"),
      sb.from("leaderboard_weekly").select("*"),
    ]).then(([g, w]) => {
      if (g.error || w.error) setError((g.error ?? w.error)!.message);
      setGlobal((g.data as GlobalRow[]) ?? []);
      setWeekly((w.data as WeeklyRow[]) ?? []);
    });
  }, []);

  useEffect(() => {
    if (!user) return;
    friendsApi.board().then(setFriends, (e) => setError(e.message));
    friendsApi.following().then(
      (rows) => setFollows(Object.fromEntries(rows.map((r) => [r.username, { following: r.status === "active", requested: r.status === "pending" }]))),
      () => {}
    );
  }, [user]);

  const setFollow = (u: string, st: FollowState) => {
    setFollows((f) => ({ ...f, [u]: st }));
    friendsApi.board().then(setFriends, () => {});
  };

  if (!supabaseConfigured()) {
    return (
      <div className="max-w-md mx-auto py-20 text-center">
        <Trophy className="mx-auto text-gold mb-3" size={28} />
        <h1 className="text-xl font-semibold mb-2">Leaderboard needs accounts</h1>
        <p className="text-sm text-muted">
          This deployment runs without Supabase, so there&apos;s no shared leaderboard (ratings are
          computed by the server). Your progress lives on the <Link href="/" className="text-accent underline">dashboard</Link>.
        </p>
      </div>
    );
  }

  const rows = tab === "global" ? global : tab === "weekly" ? weekly : friends;
  const tabs: Tab[] = user ? ["global", "weekly", "friends"] : ["global", "weekly"];

  return (
    <div className="max-w-2xl mx-auto py-8">
      <div className="flex items-center gap-3 mb-1">
        <Trophy className="text-gold" size={26} />
        <h1 className="text-2xl font-semibold tracking-tight">Leaderboard</h1>
      </div>
      <p className="text-muted text-sm mb-6">
        Ratings move only through server-graded quiz answers — play fast, play accurately.
      </p>

      <div className="flex gap-1 rounded-lg bg-surface-2 p-1 mb-4 max-w-sm">
        {tabs.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            aria-pressed={tab === t}
            className={`flex-1 h-9 text-sm rounded-md capitalize transition-colors ${
              tab === t ? "bg-surface font-medium shadow-sm" : "text-muted hover:text-foreground"
            }`}
          >
            {t === "weekly" ? "This week" : t === "friends" ? "Friends" : "All time"}
          </button>
        ))}
      </div>

      {error && <p className="text-sm text-danger mb-4">{error}</p>}

      <div className="rounded-lg border border-edge bg-surface overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-muted border-b border-edge">
              <th className="text-left font-normal px-4 py-2.5 w-14">#</th>
              <th className="text-left font-normal px-2 py-2.5">Player</th>
              <th className="text-right font-normal px-4 py-2.5">
                {tab === "weekly" ? "Rating gained" : "Rating"}
              </th>
              <th className="text-right font-normal px-4 py-2.5 hidden sm:table-cell">Accuracy</th>
            </tr>
          </thead>
          <tbody>
            {rows === null ? (
              Array.from({ length: 8 }).map((_, i) => (
                <tr key={i} className="border-b border-edge last:border-0 animate-pulse">
                  <td className="px-4 py-3" colSpan={4}>
                    <div className="h-4 rounded bg-surface-2" />
                  </td>
                </tr>
              ))
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-4 py-10 text-center text-muted">
                  {tab === "weekly"
                    ? "No qualifying players this week yet (5+ answers). Be the first!"
                    : tab === "friends"
                    ? "Follow players to see them here."
                    : "No ranked players yet (10+ answers to qualify). Be the first!"}
                </td>
              </tr>
            ) : (
              rows.map((r) => {
                const acc = r.attempts ? Math.round((r.correct / r.attempts) * 100) : 0;
                const me = username !== null && r.username === username;
                return (
                  <tr
                    key={r.username}
                    className={`border-b border-edge last:border-0 ${
                      me ? "bg-accent-soft" : ""
                    }`}
                  >
                    <td className="px-4 py-2.5">
                      {r.rank <= 3 ? (
                        <Medal
                          size={16}
                          className={
                            r.rank === 1
                              ? "text-gold"
                              : r.rank === 2
                              ? "text-neutral-400"
                              : "text-amber-700"
                          }
                        />
                      ) : (
                        <span className="text-muted font-mono text-xs">{r.rank}</span>
                      )}
                    </td>
                    <td className="px-2 py-2.5 font-medium">
                      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <Link href={`/u/${r.username}`} className="hover:underline break-all">
                          {r.username}
                        </Link>
                        {me && <span className="text-accent text-xs">you</span>}
                        {user && !me && (
                          <FollowButton
                            username={r.username}
                            size="sm"
                            state={follows[r.username] ?? { following: false, requested: false }}
                            onChange={(st) => setFollow(r.username, st)}
                          />
                        )}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono">
                      {tab !== "weekly"
                        ? (r as GlobalRow).rating.toLocaleString()
                        : `${(r as WeeklyRow).rating_gain >= 0 ? "+" : ""}${(r as WeeklyRow).rating_gain}`}
                    </td>
                    <td className="px-4 py-2.5 text-right text-muted hidden sm:table-cell">
                      {acc}%
                      <span className="text-xs"> ({r.attempts})</span>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-muted mt-4">
        All time requires 10+ answered positions; weekly requires 5+ this week. Weekly resets every
        Monday (UTC). Friends shows you and everyone you follow, with the same ratings.
      </p>
    </div>
  );
}
