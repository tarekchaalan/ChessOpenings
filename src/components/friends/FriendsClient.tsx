"use client";
/**
 * /friends (spec §2.5): the feed, people (Following / Followers / Requests /
 * Search) and Compare. Opening the page marks notifications read.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Bell, Check, Loader2, Search, Users, X } from "lucide-react";
import { errorText, friendsApi } from "@/lib/friends/api";
import { compareCourses, compareRatings } from "@/lib/friends/compare";
import { courseName } from "@/lib/friends/courses";
import { eventText, groupFeed } from "@/lib/friends/feed";
import type { CompareData, FeedEvent, FollowerRow, FollowingRow, NotificationRow, PrivacySettings, RequestRow, SearchResult } from "@/lib/friends/types";
import { PLATFORM_NAME } from "@/lib/insights/types";
import { useDataset } from "@/lib/hooks";
import { useAuth } from "@/lib/supabase/AuthProvider";
import FollowButton from "./FollowButton";
import ChallengeButton from "./ChallengeButton";
import PresetCard from "./PresetCard";

type Tab = "following" | "followers" | "requests" | "search";

export default function FriendsClient() {
  const { user, loading, configured } = useAuth();
  const [privacy, setPrivacy] = useState<PrivacySettings | null>(null);
  const [following, setFollowing] = useState<FollowingRow[] | null>(null);
  const [followers, setFollowers] = useState<FollowerRow[] | null>(null);
  const [requests, setRequests] = useState<RequestRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // bumped after any follow change to refetch the lists
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    if (!user) return;
    Promise.all([friendsApi.following(), friendsApi.followers(), friendsApi.requests()]).then(
      ([a, b, c]) => {
        setFollowing(a);
        setFollowers(b);
        setRequests(c);
      },
      (e) => setError(errorText(e))
    );
  }, [user, version]);

  useEffect(() => {
    if (!user) return;
    friendsApi.privacy().then(setPrivacy, (e) => setError(errorText(e)));
  }, [user]);

  if (!configured) {
    return <Notice title="Friends need accounts">This deployment runs without Supabase, so there are no accounts to follow.</Notice>;
  }
  if (loading) return <div className="max-w-5xl mx-auto py-8"><div className="h-40 rounded-lg bg-surface-2 animate-pulse motion-reduce:animate-none" /></div>;
  if (!user) {
    return (
      <Notice title="Follow other players">
        Sign in to follow players, see what your friends are learning and challenge them.{" "}
        <Link href="/auth" className="text-accent underline">
          Sign in
        </Link>
      </Notice>
    );
  }

  return (
    <div className="max-w-5xl mx-auto py-8 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
          <Users size={24} className="text-accent" /> Friends
        </h1>
        <p className="text-sm text-muted mt-1">
          Friends are players you follow who follow you back. Each player chooses what others see.
        </p>
      </div>
      {error && <p role="alert" className="text-sm text-danger-ink">{error}</p>}
      {privacy && !privacy.preset_answered && <PresetCard onDone={setPrivacy} />}
      <Notifications />
      <div className="grid lg:grid-cols-5 gap-6 items-start">
        <div className="lg:col-span-3 space-y-6 min-w-0">
          <Feed />
          <Compare following={following} />
        </div>
        <People
          className="lg:col-span-2 min-w-0"
          following={following}
          followers={followers}
          requests={requests}
          approve={privacy?.approve_followers ?? false}
          reload={reload}
        />
      </div>
    </div>
  );
}

// ── notifications ─────────────────────────────────────────────────────────
const NOTE_TEXT: Record<NotificationRow["kind"], string> = {
  new_follower: "started following you",
  follow_request: "asked to follow you",
  request_accepted: "accepted your follow request",
};

function Notifications() {
  const [rows, setRows] = useState<NotificationRow[] | null>(null);
  useEffect(() => {
    friendsApi.notifications().then((r) => {
      setRows(r);
      if (r.some((n) => !n.read)) friendsApi.markRead().catch(() => {});
    }, () => setRows([]));
  }, []);
  const unread = rows?.filter((n) => !n.read) ?? [];
  if (!unread.length) return null;
  return (
    <section aria-label="New" className="rounded-lg border border-edge bg-surface p-4" data-testid="notifications">
      <h2 className="text-xs uppercase tracking-wider text-muted mb-2 flex items-center gap-1.5">
        <Bell size={14} /> New
      </h2>
      <ul className="space-y-1 text-sm">
        {unread.map((n) => (
          <li key={`${n.username}:${n.kind}`}>
            <Link href={`/u/${n.username}`} className="font-medium hover:underline">
              {n.username}
            </Link>{" "}
            {NOTE_TEXT[n.kind]}
          </li>
        ))}
      </ul>
    </section>
  );
}

// ── feed ──────────────────────────────────────────────────────────────────
function Feed() {
  const { ds } = useDataset();
  const [events, setEvents] = useState<FeedEvent[] | null>(null);
  const [more, setMore] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback((before?: string) => {
    friendsApi
      .feed(before)
      .then(
        (page) => {
          setEvents((prev) => (before ? [...(prev ?? []), ...page] : page));
          setMore(page.length === 30);
        },
        (e) => {
          setError(errorText(e));
          setEvents((prev) => prev ?? []);
        }
      )
      .finally(() => setBusy(false));
  }, []);
  useEffect(() => load(), [load]);

  const groups = useMemo(() => groupFeed(events ?? []), [events]);
  const name = (id: string) => courseName(ds, id);
  const [now] = useState(() => Date.now());
  const today = new Date(now).toISOString().slice(0, 10);
  const yesterday = new Date(now - 86_400_000).toISOString().slice(0, 10);
  const dayLabel = (d: string) => (d === today ? "Today" : d === yesterday ? "Yesterday" : new Date(`${d}T12:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric" }));

  return (
    <section aria-labelledby="feed-title" className="rounded-lg border border-edge bg-surface p-5">
      <h2 id="feed-title" className="text-xs uppercase tracking-wider text-muted mb-3">
        Feed
      </h2>
      {error && <p role="alert" className="text-sm text-danger-ink mb-2">{error}</p>}
      {events === null ? (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => <div key={i} className="h-10 rounded bg-surface-2 animate-pulse motion-reduce:animate-none" />)}
        </div>
      ) : groups.length === 0 ? (
        <p className="text-sm text-muted">
          Nothing yet. Activity from players you follow shows up here when they share it.
        </p>
      ) : (
        <ol className="divide-y divide-edge" data-testid="feed">
          {groups.map((g) => (
            <li key={g.key} className="py-3">
              <p className="text-sm">
                <Link href={`/u/${g.username}`} className="font-semibold hover:underline">
                  {g.username}
                </Link>{" "}
                <span className="text-xs text-muted">· {dayLabel(g.day)}</span>
              </p>
              <ul className="mt-1 text-sm space-y-0.5">
                {g.items.map((e) => (
                  <li key={e.id}>{eventText(e, name)}</li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
      )}
      {events && events.length > 0 && more && (
        <button
          type="button"
          onClick={() => (setBusy(true), load(events[events.length - 1].updated_at))}
          disabled={busy}
          className="mt-3 h-9 px-3 rounded-md border border-edge text-sm hover:bg-surface-2 disabled:opacity-60"
        >
          {busy ? "Loading…" : "Older activity"}
        </button>
      )}
    </section>
  );
}

// ── people ────────────────────────────────────────────────────────────────
function People({
  className,
  following,
  followers,
  requests,
  approve,
  reload,
}: {
  className: string;
  following: FollowingRow[] | null;
  followers: FollowerRow[] | null;
  requests: RequestRow[] | null;
  approve: boolean;
  reload: () => void;
}) {
  const showRequests = approve || (requests?.length ?? 0) > 0;
  const tabs: { id: Tab; label: string }[] = [
    { id: "following", label: `Following${following ? ` (${following.length})` : ""}` },
    { id: "followers", label: `Followers${followers ? ` (${followers.length})` : ""}` },
    ...(showRequests ? [{ id: "requests" as Tab, label: `Requests${requests?.length ? ` (${requests.length})` : ""}` }] : []),
    { id: "search", label: "Search" },
  ];
  const [tab, setTab] = useState<Tab>("following");
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const active = tabs.some((t) => t.id === tab) ? tab : "following";

  const onKey = (e: React.KeyboardEvent, i: number) => {
    const n = e.key === "ArrowRight" ? i + 1 : e.key === "ArrowLeft" ? i - 1 : e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : null;
    if (n === null) return;
    e.preventDefault();
    const t = tabs[(n + tabs.length) % tabs.length];
    setTab(t.id);
    refs.current[t.id]?.focus();
  };

  return (
    <section aria-label="People" className={`rounded-lg border border-edge bg-surface p-4 ${className}`}>
      <div role="tablist" aria-label="People" className="flex flex-wrap gap-1 rounded-lg bg-surface-2 p-1 mb-3">
        {tabs.map((t, i) => (
          <button
            key={t.id}
            ref={(el) => {
              refs.current[t.id] = el;
            }}
            role="tab"
            id={`tab-${t.id}`}
            aria-selected={active === t.id}
            aria-controls={`panel-${t.id}`}
            tabIndex={active === t.id ? 0 : -1}
            onClick={() => setTab(t.id)}
            onKeyDown={(e) => onKey(e, i)}
            className={`flex-1 min-w-fit h-8 px-2 text-xs rounded-md whitespace-nowrap ${active === t.id ? "bg-surface font-medium shadow-sm" : "text-muted hover:text-foreground"}`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`panel-${active}`} aria-labelledby={`tab-${active}`} tabIndex={0}>
        {active === "following" && <FollowingList rows={following} reload={reload} />}
        {active === "followers" && <FollowersList rows={followers} reload={reload} />}
        {active === "requests" && <RequestsList rows={requests} reload={reload} />}
        {active === "search" && <SearchPanel reload={reload} />}
      </div>
    </section>
  );
}

function PersonLink({ username }: { username: string }) {
  return (
    <Link href={`/u/${username}`} className="font-medium hover:underline break-all">
      {username}
    </Link>
  );
}

function Rows<T>({ rows, empty, children }: { rows: T[] | null; empty: React.ReactNode; children: (r: T) => React.ReactNode }) {
  if (rows === null) return <div className="h-16 rounded bg-surface-2 animate-pulse motion-reduce:animate-none" />;
  if (!rows.length) return <p className="text-sm text-muted">{empty}</p>;
  return <ul className="divide-y divide-edge">{rows.map(children)}</ul>;
}

function FollowingList({ rows, reload }: { rows: FollowingRow[] | null; reload: () => void }) {
  return (
    <Rows rows={rows} empty="You don't follow anyone yet. Find players in Search or on the leaderboard.">
      {(r) => (
        <li key={r.username} className="py-2.5 flex flex-wrap items-center gap-2" data-testid={`following-${r.username}`}>
          <span className="min-w-0 flex-1">
            <PersonLink username={r.username} />
            {r.friends && <span className="ml-1.5 text-xs text-accent">friends</span>}
          </span>
          <ChallengeButton targets={r.challenge} size="sm" />
          <FollowButton username={r.username} size="sm" state={{ following: r.status === "active", requested: r.status === "pending" }} onChange={reload} />
        </li>
      )}
    </Rows>
  );
}

function FollowersList({ rows, reload }: { rows: FollowerRow[] | null; reload: () => void }) {
  return (
    <Rows rows={rows} empty="No followers yet. Share your profile link from your profile page.">
      {(r) => (
        <li key={r.username} className="py-2.5 flex flex-wrap items-center gap-2" data-testid={`follower-${r.username}`}>
          <span className="min-w-0 flex-1">
            <PersonLink username={r.username} />
          </span>
          <FollowButton username={r.username} size="sm" state={{ following: r.following, requested: r.requested }} onChange={reload} />
          <RemoveFollower username={r.username} onDone={reload} />
        </li>
      )}
    </Rows>
  );
}

function RemoveFollower({ username, onDone }: { username: string; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      aria-label={`Remove follower ${username}`}
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await friendsApi.removeFollower(username);
          onDone();
        } finally {
          setBusy(false);
        }
      }}
      className="w-8 h-8 grid place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-foreground disabled:opacity-60"
    >
      <X size={14} />
    </button>
  );
}

function RequestsList({ rows, reload }: { rows: RequestRow[] | null; reload: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const act = async (u: string, accept: boolean) => {
    setError(null);
    try {
      if (accept) await friendsApi.accept(u);
      else await friendsApi.decline(u);
      reload();
    } catch (e) {
      setError(errorText(e));
    }
  };
  return (
    <>
      {error && <p role="alert" className="text-sm text-danger-ink mb-2">{error}</p>}
      <Rows rows={rows} empty="No follow requests.">
        {(r) => (
          <li key={r.username} className="py-2.5 flex flex-wrap items-center gap-2" data-testid={`request-${r.username}`}>
            <span className="min-w-0 flex-1">
              <PersonLink username={r.username} />
            </span>
            <button type="button" onClick={() => act(r.username, true)} className="h-8 px-2.5 rounded-md bg-accent text-accent-fg text-xs font-medium inline-flex items-center gap-1">
              <Check size={13} /> Accept
            </button>
            <button type="button" onClick={() => act(r.username, false)} className="h-8 px-2.5 rounded-md border border-edge text-xs hover:bg-surface-2">
              Decline
            </button>
          </li>
        )}
      </Rows>
    </>
  );
}

function SearchPanel({ reload }: { reload: () => void }) {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<SearchResult[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const term = q.trim();
  const valid = /^[A-Za-z0-9_]{2,20}$/.test(term);
  const hint = !valid && term.length > 1 ? "Usernames use letters, digits and _ only." : null;

  useEffect(() => {
    const n = ++seq.current;
    if (!valid) return;
    const t = setTimeout(async () => {
      setBusy(true);
      try {
        const r = await friendsApi.search(term);
        if (n === seq.current) {
          setRows(r);
          setError(null);
        }
      } catch (e) {
        if (n === seq.current) setError(errorText(e));
      } finally {
        if (n === seq.current) setBusy(false);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [term, valid]);
  const shown = valid ? rows : null;

  return (
    <div>
      <label htmlFor="friend-search" className="text-xs text-muted">
        Find a player by username
      </label>
      <div className="relative mt-1">
        <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" aria-hidden />
        <input
          id="friend-search"
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          maxLength={20}
          placeholder="Start typing (2+ letters)"
          className="w-full h-10 pl-8 pr-8 rounded-md border border-edge bg-background text-sm"
        />
        {busy && <Loader2 size={14} className="absolute right-2.5 top-1/2 -translate-y-1/2 animate-spin motion-reduce:animate-none text-muted" aria-hidden />}
      </div>
      <div aria-live="polite" className="mt-2">
        {(hint ?? (valid && error)) && <p className="text-sm text-danger-ink">{hint ?? error}</p>}
        {shown && shown.length === 0 && <p className="text-sm text-muted">No players start with “{term}”.</p>}
        {shown && shown.length > 0 && (
          <ul className="divide-y divide-edge" data-testid="search-results">
            {shown.map((r) => (
              <li key={r.username} className="py-2.5 flex flex-wrap items-center gap-2">
                <span className="min-w-0 flex-1">
                  <PersonLink username={r.username} />
                  {r.follows_you && <span className="ml-1.5 text-xs text-muted">follows you</span>}
                </span>
                <FollowButton
                  username={r.username}
                  size="sm"
                  state={{ following: r.following, requested: r.requested }}
                  onChange={(s) => {
                    setRows((prev) => prev?.map((x) => (x.username === r.username ? { ...x, ...s } : x)) ?? null);
                    reload();
                  }}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// ── compare ───────────────────────────────────────────────────────────────
function Compare({ following }: { following: FollowingRow[] | null }) {
  const { ds } = useDataset();
  const options = (following ?? []).filter((r) => r.status === "active");
  const [who, setWho] = useState("");
  const [loaded, setData] = useState<CompareData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const data = who && loaded && loaded.them.username.toLowerCase() === who.toLowerCase() ? loaded : null;

  useEffect(() => {
    if (!who) return;
    let live = true;
    friendsApi.compare(who).then(
      (d) => live && (setData(d), setError(null)),
      (e) => live && setError(errorText(e))
    );
    return () => {
      live = false;
    };
  }, [who]);

  const courses = data ? compareCourses(data.me.learning, data.them.learning) : [];
  const ratings = data ? compareRatings(data.me.linked, data.them.linked) : [];

  return (
    <section aria-labelledby="compare-title" className="rounded-lg border border-edge bg-surface p-5">
      <h2 id="compare-title" className="text-xs uppercase tracking-wider text-muted mb-3">
        Compare
      </h2>
      {options.length === 0 ? (
        <p className="text-sm text-muted">Follow someone to compare your openings and ratings.</p>
      ) : (
        <>
          <label htmlFor="compare-with" className="text-sm">
            Compare with{" "}
          </label>
          <select id="compare-with" value={who} onChange={(e) => setWho(e.target.value)} className="h-9 rounded-md border border-edge bg-background px-2 text-sm">
            <option value="">choose a player</option>
            {options.map((o) => (
              <option key={o.username} value={o.username}>
                {o.username}
              </option>
            ))}
          </select>
        </>
      )}
      {error && <p role="alert" className="text-sm text-danger-ink mt-2">{error}</p>}
      {data && (
        <div className="mt-4 space-y-4" data-testid="compare">
          {data.them.learning === null && data.them.linked === null ? (
            <p className="text-sm text-muted">{data.them.username} doesn&apos;t share their learning or ratings with you.</p>
          ) : (
            <>
              <div>
                <h3 className="text-sm font-medium mb-1">Openings you both learn</h3>
                {data.them.learning === null ? (
                  <p className="text-sm text-muted">{data.them.username} keeps their courses private.</p>
                ) : courses.length === 0 ? (
                  <p className="text-sm text-muted">No courses in common yet.</p>
                ) : (
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-xs text-muted border-b border-edge">
                        <th scope="col" className="text-left font-normal py-1.5">Course</th>
                        <th scope="col" className="text-right font-normal py-1.5">You</th>
                        <th scope="col" className="text-right font-normal py-1.5 break-all">{data.them.username}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {courses.map((c) => (
                        <tr key={c.course_id} className="border-b border-edge last:border-0 align-top">
                          <th scope="row" className="text-left font-normal py-1.5 pr-2 break-words">{courseName(ds, c.course_id)}</th>
                          <td className="text-right py-1.5 text-xs whitespace-nowrap">
                            {c.me.mastery}% mastery
                            <br />
                            <span className="text-muted">{c.me.accuracy === null ? "—" : `${c.me.accuracy}% accuracy`}</span>
                          </td>
                          <td className="text-right py-1.5 text-xs whitespace-nowrap">
                            {c.them.mastery}% mastery
                            <br />
                            <span className="text-muted">{c.them.accuracy === null ? "—" : `${c.them.accuracy}% accuracy`}</span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
              <div>
                <h3 className="text-sm font-medium mb-1">Ratings on the same platform</h3>
                {data.them.linked === null ? (
                  <p className="text-sm text-muted">{data.them.username} keeps their linked accounts private.</p>
                ) : ratings.length === 0 ? (
                  <p className="text-sm text-muted">No platform and time class in common.</p>
                ) : (
                  <ul className="text-sm space-y-1">
                    {ratings.map((r) => (
                      <li key={`${r.platform}:${r.time_class}`}>
                        {PLATFORM_NAME[r.platform]} {r.time_class}: you <span className="font-mono">{r.me}</span>, {data.them.username}{" "}
                        <span className="font-mono">{r.them}</span>{" "}
                        <span className="text-muted">({r.diff >= 0 ? "+" : ""}{r.diff})</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}

function Notice({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="max-w-md mx-auto py-20 text-center">
      <Users className="mx-auto text-muted mb-3" size={28} />
      <h1 className="text-xl font-semibold mb-2">{title}</h1>
      <p className="text-sm text-muted">{children}</p>
    </div>
  );
}
