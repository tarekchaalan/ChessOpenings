"use client";
/** Settings → Privacy (ADR 0007): one level per section, approve followers, and blocked players. */
import { useEffect, useState } from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { errorText, friendsApi } from "@/lib/friends/api";
import type { Level, PrivacySettings as Settings, Section } from "@/lib/friends/types";
import { LEVELS, LEVEL_LABEL, SECTIONS, SECTION_HELP, SECTION_LABEL, whoCanSee } from "@/lib/friends/visibility";
import { useAuth } from "@/lib/supabase/AuthProvider";

export default function PrivacySettings() {
  const { user, username, configured } = useAuth();
  const [s, setS] = useState<Settings | null>(null);
  const [blocks, setBlocks] = useState<{ username: string }[] | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  useEffect(() => {
    if (!user) return;
    friendsApi.privacy().then(setS, (e) => setMsg({ kind: "error", text: errorText(e) }));
    friendsApi.blocks().then(setBlocks, () => setBlocks([]));
  }, [user]);

  if (!configured || !user) {
    return (
      <section className="rounded-lg border border-edge bg-surface p-5">
        <h2 className="text-xs uppercase tracking-wider text-muted mb-3">Privacy</h2>
        <p className="text-sm text-muted">
          {configured ? (
            <>
              <Link href="/auth" className="text-accent underline">Sign in</Link> to choose what other players can see.
            </>
          ) : (
            "This deployment runs without accounts, so nothing is shared."
          )}
        </p>
      </section>
    );
  }

  const save = async (patch: Partial<Settings>, key: string) => {
    const before = s;
    setS((cur) => (cur ? { ...cur, ...patch } : cur));
    setSaving(key);
    setMsg(null);
    try {
      setS(await friendsApi.setPrivacy(patch));
      setMsg({ kind: "ok", text: "Saved." });
    } catch (e) {
      setS(before);
      setMsg({ kind: "error", text: errorText(e) });
    } finally {
      setSaving(null);
    }
  };

  const unblock = async (u: string) => {
    try {
      await friendsApi.unblock(u);
      setBlocks((b) => b?.filter((x) => x.username !== u) ?? null);
    } catch (e) {
      setMsg({ kind: "error", text: errorText(e) });
    }
  };

  return (
    <div className="space-y-4">
      <section className="rounded-lg border border-edge bg-surface p-5" aria-labelledby="privacy-title">
        <h2 id="privacy-title" className="text-xs uppercase tracking-wider text-muted mb-1">
          Who can see what
        </h2>
        <p className="text-sm text-muted mb-4">
          Your username, app rating and accuracy are always public (leaderboard). Everything else starts private.{" "}
          {username && (
            <Link href={`/u/${username}`} className="text-accent underline">
              Preview your profile
            </Link>
          )}
        </p>
        {!s ? (
          <div className="h-48 rounded bg-surface-2 animate-pulse motion-reduce:animate-none" />
        ) : (
          <div className="space-y-4">
            {SECTIONS.map((sec: Section) => (
              <div key={sec} className="grid sm:grid-cols-[1fr_12rem] gap-2 items-start">
                <div>
                  <label htmlFor={`privacy-${sec}`} className="text-sm font-medium">
                    {SECTION_LABEL[sec]}
                  </label>
                  <p className="text-xs text-muted" id={`privacy-${sec}-help`}>
                    {SECTION_HELP[sec]} {whoCanSee(s[sec])}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <select
                    id={`privacy-${sec}`}
                    aria-describedby={`privacy-${sec}-help`}
                    value={s[sec]}
                    disabled={saving !== null}
                    onChange={(e) => save({ [sec]: e.target.value as Level }, sec)}
                    className="w-full h-9 rounded-md border border-edge bg-background px-2 text-sm"
                  >
                    {LEVELS.map((l) => (
                      <option key={l} value={l}>
                        {LEVEL_LABEL[l]}
                      </option>
                    ))}
                  </select>
                  {saving === sec && <Loader2 size={14} className="animate-spin motion-reduce:animate-none text-muted" aria-hidden />}
                </div>
              </div>
            ))}
            <label className="flex items-start gap-2 pt-2 border-t border-edge">
              <input
                type="checkbox"
                className="mt-1"
                checked={s.approve_followers}
                disabled={saving !== null}
                onChange={(e) => save({ approve_followers: e.target.checked }, "approve")}
              />
              <span>
                <span className="text-sm font-medium">Approve followers</span>
                <span className="block text-xs text-muted">
                  New follows become requests you accept or decline. Turning this off keeps waiting requests waiting.
                </span>
              </span>
            </label>
          </div>
        )}
        <p aria-live="polite" className={`text-sm mt-3 ${msg?.kind === "error" ? "text-danger-ink" : "text-muted"}`}>
          {msg?.text}
        </p>
      </section>

      <section className="rounded-lg border border-edge bg-surface p-5" aria-labelledby="blocked-title">
        <h2 id="blocked-title" className="text-xs uppercase tracking-wider text-muted mb-3">
          Blocked players
        </h2>
        {blocks === null ? (
          <div className="h-10 rounded bg-surface-2 animate-pulse motion-reduce:animate-none" />
        ) : blocks.length === 0 ? (
          <p className="text-sm text-muted">Nobody. Block someone from the menu on their profile; they aren&apos;t told.</p>
        ) : (
          <ul className="divide-y divide-edge" data-testid="blocked-list">
            {blocks.map((b) => (
              <li key={b.username} className="py-2 flex items-center justify-between gap-2">
                <span className="font-medium break-all">{b.username}</span>
                <button type="button" onClick={() => unblock(b.username)} className="h-8 px-2.5 rounded-md border border-edge text-xs hover:bg-surface-2">
                  Unblock
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
