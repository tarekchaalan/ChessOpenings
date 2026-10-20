"use client";
/**
 * Settings → Account: the Lichess / Chess.com identities the player can sign in
 * with (ADR 0009, own rows of oauth_identities under RLS), and "Connect" for the
 * rest. Connecting also verifies the linked account. Hidden when no provider
 * is configured.
 */
import { useEffect, useState } from "react";
import { BadgeCheck, LogIn } from "lucide-react";
import { getSupabase } from "@/lib/supabase/client";
import { PLATFORM_NAME, PLATFORMS, type Platform } from "@/lib/insights/types";
import { isPlaceholderEmail, oauthEnabled, oauthStartUrl } from "@/lib/oauth/providers";

export default function SignInMethods({ userId, email }: { userId: string; email: string }) {
  const providers = PLATFORMS.filter(oauthEnabled);
  // null while loading; a failed read (e.g. migration 0010 not applied) shows none connected
  const [names, setNames] = useState<Partial<Record<Platform, string>> | null>(null);

  useEffect(() => {
    const sb = getSupabase();
    if (!sb) return;
    let alive = true;
    void sb
      .from("oauth_identities")
      .select("provider, username")
      .eq("user_id", userId)
      .then(({ data }) => {
        if (alive) setNames(Object.fromEntries(((data ?? []) as { provider: Platform; username: string }[]).map((r) => [r.provider, r.username])));
      });
    return () => {
      alive = false;
    };
  }, [userId]);

  if (!providers.length) return null;
  return (
    <section className="rounded-lg border border-edge bg-surface p-5" data-testid="sign-in-methods">
      <h2 className="text-xs uppercase tracking-wider text-muted mb-3">Sign-in methods</h2>
      {isPlaceholderEmail(email) && (
        <p className="text-sm text-muted mb-3">You created this account with {providers.length === 1 ? PLATFORM_NAME[providers[0]] : "a chess site"}, so it has no email or password.</p>
      )}
      <ul className="space-y-2">
        {providers.map((p) => (
          <li key={p} className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm">{PLATFORM_NAME[p]}</span>
            {!names ? (
              <span className="h-5 w-24 rounded bg-surface-2 animate-pulse" aria-hidden />
            ) : names[p] ? (
              <span className="text-sm inline-flex items-center gap-1.5">
                <BadgeCheck size={14} className="text-accent" aria-hidden /> {names[p]}
              </span>
            ) : (
              <a
                href={oauthStartUrl(p, "link", "/settings")}
                className="inline-flex items-center gap-2 px-3 min-h-[36px] rounded-md border border-edge bg-surface text-sm hover:bg-surface-2"
                data-testid={`connect-${p}`}
              >
                <LogIn size={14} aria-hidden /> Connect
              </a>
            )}
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted mt-3">A connected account signs in here and marks it verified under Chess.com and Lichess below.</p>
    </section>
  );
}
