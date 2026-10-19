"use client";
/**
 * /u/[username] (spec §2.3). Everything comes from get_profile, which returns
 * only the sections this viewer may see; a hidden section renders nothing.
 * The owner gets a "view as" preview; others get follow, challenge and a menu.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Ban, BookOpen, Copy, Flame, Link2, MoreHorizontal, Swords, Trophy, UserMinus, Users } from "lucide-react";
import { errorText, friendsApi } from "@/lib/friends/api";
import { accuracy } from "@/lib/friends/compare";
import { courseLink, courseName } from "@/lib/friends/courses";
import type { PlayedOpening, PrivacySettings, Profile, ViewAs } from "@/lib/friends/types";
import { PLATFORM_NAME, TIME_CLASSES } from "@/lib/insights/types";
import { useDataset } from "@/lib/hooks";
import { useAuth } from "@/lib/supabase/AuthProvider";
import FollowButton from "./FollowButton";
import ChallengeButton from "./ChallengeButton";
import PresetCard from "./PresetCard";

const VIEW_AS: { id: ViewAs | null; label: string }[] = [
  { id: null, label: "You" },
  { id: "everyone", label: "Everyone" },
  { id: "follower", label: "A follower" },
  { id: "friend", label: "A friend" },
];

export default function ProfileClient({ username }: { username: string }) {
  const { user, username: me, loading: authLoading, configured } = useAuth();
  const { ds } = useDataset();
  const [viewAs, setViewAs] = useState<ViewAs | null>(null);
  const [profile, setProfile] = useState<Profile | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [privacy, setPrivacy] = useState<PrivacySettings | null>(null);
  const [showPreset, setShowPreset] = useState(false);

  // bumped after an action (follow, remove) to refetch
  const [version, setVersion] = useState(0);
  const load = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    if (!configured || authLoading) return;
    let live = true;
    friendsApi.profile(username, viewAs ?? undefined).then(
      (p) => live && (setError(null), setProfile(p)),
      (e) => live && (setError(errorText(e)), setProfile(null))
    );
    return () => {
      live = false;
    };
  }, [configured, authLoading, username, viewAs, version, user?.id]);

  useEffect(() => {
    if (!user) return;
    friendsApi.privacy().then(setPrivacy, () => {});
  }, [user]);

  if (!configured) {
    return <Empty title="Profiles need accounts">This deployment runs without Supabase, so there are no player profiles.</Empty>;
  }
  if (profile === undefined) return <div className="max-w-3xl mx-auto py-8"><div className="h-40 rounded-lg bg-surface-2 animate-pulse motion-reduce:animate-none" /></div>;
  if (profile === null) {
    return (
      <Empty title="No such player">
        {error ?? (
          <>
            There&apos;s no player called <strong>{username}</strong>. <Link href="/friends" className="text-accent underline">Search for players</Link>.
          </>
        )}
      </Empty>
    );
  }

  const rel = profile.relationship;
  // previews carry no relationship, so ownership comes from the signed-in name
  const owner = rel?.self === true || (!!me && me.toLowerCase() === profile.username.toLowerCase());
  const name = (id: string) => courseName(ds, id);

  return (
    <div className="max-w-3xl mx-auto py-8 space-y-4">
      <header className="rounded-lg border border-edge bg-surface p-5">
        <div className="flex flex-wrap items-start gap-3">
          <div className="min-w-0 flex-1">
            <h1 className="text-2xl font-semibold tracking-tight break-all flex flex-wrap items-center gap-2">
              {profile.username}
              {rel?.friends && !profile.preview && (
                <span className="text-xs font-medium rounded-full bg-accent-soft text-accent px-2 py-0.5" data-testid="friends-badge">
                  Friends
                </span>
              )}
              {rel?.follows_you && !rel.friends && <span className="text-xs font-normal text-muted">follows you</span>}
            </h1>
            <p className="text-sm text-muted mt-1 flex flex-wrap gap-x-4 gap-y-1">
              <span data-testid="follower-count">
                <strong className="text-foreground">{profile.followers}</strong> {profile.followers === 1 ? "follower" : "followers"}
              </span>
              <span data-testid="following-count">
                <strong className="text-foreground">{profile.following}</strong> following
              </span>
              <span>
                <Trophy size={13} className="inline -mt-0.5 text-gold" aria-hidden /> app rating <strong className="text-foreground">{profile.rating}</strong>
                {profile.attempts > 0 && <> · {Math.round((100 * profile.correct) / profile.attempts)}% accuracy</>}
              </span>
            </p>
          </div>
          {!owner && rel && (
            <div className="flex flex-wrap items-start gap-2">
              <FollowButton
                username={profile.username}
                state={{ following: rel.following, requested: rel.requested }}
                approve={rel.approve_followers}
                onChange={() => load()}
                onFollowed={() => privacy && !privacy.preset_answered && setShowPreset(true)}
              />
              <ChallengeButton targets={profile.challenge} />
              <ProfileMenu username={profile.username} followsYou={rel.follows_you} onDone={load} />
            </div>
          )}
          {!rel && !user && <FollowButton username={profile.username} state={{ following: false, requested: false }} />}
        </div>
        <ShareLink username={profile.username} />
        {owner && (
          <div className="mt-4 flex flex-wrap items-center gap-2" role="group" aria-label="View your profile as">
            <span className="text-xs text-muted">View as:</span>
            {VIEW_AS.map((v) => (
              <button
                key={v.label}
                type="button"
                aria-pressed={viewAs === v.id}
                onClick={() => setViewAs(v.id)}
                className={`h-8 px-3 rounded-md text-xs ${viewAs === v.id ? "bg-accent text-accent-fg font-medium" : "bg-surface-2 text-muted hover:text-foreground"}`}
              >
                {v.label}
              </button>
            ))}
          </div>
        )}
        {profile.preview && (
          <p className="text-xs text-muted mt-2" role="status">
            Previewing what {viewAs === "everyone" ? "anyone with the link" : viewAs === "follower" ? "a follower" : "a friend"} sees.{" "}
            <Link href="/settings?tab=privacy" className="underline">
              Change who sees what
            </Link>
          </p>
        )}
      </header>

      {showPreset && <PresetCard onDone={(s) => (setPrivacy(s), setShowPreset(false))} />}

      {profile.some_private && <p className="text-sm text-muted">Some of this profile is private.</p>}

      {profile.linked && profile.linked.length > 0 && (
        <Section title="Ratings" icon={<Swords size={14} />}>
          <ul className="grid sm:grid-cols-2 gap-3">
            {profile.linked.map((a) => (
              <li key={a.platform} className="rounded-md border border-edge p-3">
                <p className="text-sm font-medium">
                  {PLATFORM_NAME[a.platform]} · <span className="font-mono break-all">{a.username}</span>
                </p>
                <p className="text-xs text-muted">imported from {PLATFORM_NAME[a.platform]}{a.verified ? "" : " · unverified"}</p>
                <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
                  {TIME_CLASSES.filter((tc) => a.ratings[tc]).map((tc) => (
                    <div key={tc} className="contents">
                      <dt className="text-muted capitalize">{tc}</dt>
                      <dd className="font-mono text-right">{a.ratings[tc]!.rating}{a.ratings[tc]!.provisional ? "?" : ""}</dd>
                    </div>
                  ))}
                </dl>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {profile.learning && (
        <Section title="Learning now" icon={<BookOpen size={14} />}>
          {profile.learning.length === 0 ? (
            <p className="text-sm text-muted">No courses started yet.</p>
          ) : (
            <ul className="divide-y divide-edge">
              {profile.learning.map((c) => {
                const acc = accuracy(c.correct, c.seen);
                const href = courseLink(c.course_id);
                const mastery = Math.round(Math.min(1, Math.max(0, Number(c.mastery) || 0)) * 100);
                return (
                  <li key={c.course_id} className="py-2.5 flex flex-wrap items-center gap-x-4 gap-y-1">
                    <span className="font-medium min-w-0 flex-1 break-words">{name(c.course_id)}</span>
                    <span className="text-xs text-muted">
                      {mastery}% mastery · {acc === null ? "no answers yet" : `${acc}% of ${c.seen} answers`}
                    </span>
                    {href && !owner && (
                      <Link href={href} className="text-xs text-accent underline">
                        Learn this too
                      </Link>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </Section>
      )}

      {profile.stats && (
        <Section title="Stats" icon={<Flame size={14} />}>
          <dl className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Stat label="Day streak" value={profile.stats.streak} />
            <Stat label="Lines trained" value={profile.stats.lines_trained} />
            <Stat label="Graded moves this week" value={profile.stats.moves_this_week} />
            <Stat label="Accuracy" value={profile.stats.attempts ? `${Math.round((100 * profile.stats.correct) / profile.stats.attempts)}%` : "—"} />
          </dl>
        </Section>
      )}

      {profile.played && profile.played.length > 0 && <Played rows={profile.played} />}
    </div>
  );
}

function Played({ rows }: { rows: PlayedOpening[] }) {
  return (
    <Section title="Openings they play" icon={<Users size={14} />}>
      <div className="grid sm:grid-cols-2 gap-4">
        {(["white", "black"] as const).map((color) => {
          const list = rows.filter((r) => r.color === color);
          if (!list.length) return null;
          return (
            <div key={color}>
              <h3 className="text-xs text-muted mb-1 capitalize">As {color}</h3>
              <table className="w-full text-sm">
                <thead className="sr-only">
                  <tr>
                    <th>Opening</th>
                    <th>Games</th>
                    <th>Wins / draws / losses</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((r) => (
                    <tr key={r.name} className="border-b border-edge last:border-0">
                      <td className="py-1.5 pr-2 break-words">{r.name}</td>
                      <td className="py-1.5 text-right font-mono text-xs whitespace-nowrap">{r.games}</td>
                      <td className="py-1.5 pl-2 text-right text-xs text-muted whitespace-nowrap">
                        +{r.wins} ={r.draws} −{r.losses}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        })}
      </div>
      <p className="text-xs text-muted mt-2">From games imported through Insights.</p>
    </Section>
  );
}

function ProfileMenu({ username, followsYou, onDone }: { username: string; followsYou: boolean; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  const run = async (what: "block" | "remove") => {
    setOpen(false);
    if (what === "block" && !window.confirm(`Block ${username}? You'll stop following each other and won't see each other anywhere in Friends. They won't be told.`)) return;
    try {
      if (what === "block") await friendsApi.block(username);
      else await friendsApi.removeFollower(username);
      setMsg(what === "block" ? `${username} is blocked. Unblock in Settings → Privacy.` : `${username} no longer follows you.`);
      if (what === "block") window.location.assign("/friends");
      else onDone();
    } catch (e) {
      setMsg(errorText(e));
    }
  };

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        aria-label="More actions"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="w-9 h-9 grid place-items-center rounded-md border border-edge bg-surface hover:bg-surface-2"
      >
        <MoreHorizontal size={16} />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 mt-1 w-48 rounded-lg border border-edge bg-surface shadow-lg py-1 z-20">
          {followsYou && (
            <button role="menuitem" type="button" onClick={() => run("remove")} className="w-full text-left px-3 py-2 text-sm hover:bg-surface-2 flex items-center gap-2">
              <UserMinus size={14} /> Remove follower
            </button>
          )}
          <button role="menuitem" type="button" onClick={() => run("block")} className="w-full text-left px-3 py-2 text-sm text-danger-ink hover:bg-surface-2 flex items-center gap-2">
            <Ban size={14} /> Block
          </button>
        </div>
      )}
      {msg && (
        <p role="status" className="absolute right-0 mt-1 w-56 text-xs text-muted">
          {msg}
        </p>
      )}
    </div>
  );
}

function ShareLink({ username }: { username: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/u/${encodeURIComponent(username)}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };
  return (
    <button type="button" onClick={copy} className="mt-3 inline-flex items-center gap-1.5 text-xs text-muted hover:text-foreground">
      {copied ? <Copy size={13} /> : <Link2 size={13} />}
      <span aria-live="polite">{copied ? "Link copied" : "Copy profile link"}</span>
    </button>
  );
}

function Section({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-edge bg-surface p-5" aria-label={title}>
      <h2 className="text-xs uppercase tracking-wider text-muted mb-3 flex items-center gap-1.5">
        {icon}
        {title}
      </h2>
      {children}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-md bg-surface-2 p-3">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="text-xl font-semibold font-mono">{value}</dd>
    </div>
  );
}

function Empty({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="max-w-md mx-auto py-20 text-center">
      <Users className="mx-auto text-muted mb-3" size={28} />
      <h1 className="text-xl font-semibold mb-2">{title}</h1>
      <p className="text-sm text-muted">{children}</p>
    </div>
  );
}
