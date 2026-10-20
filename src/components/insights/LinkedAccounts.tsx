"use client";
/**
 * Link a Chess.com / Lichess username (ADR 0006): check that it exists (show
 * the profile name and ratings), then import. Linked accounts show their
 * ratings, the last sync, Re-sync and Unlink. Used on /insights and in
 * Settings → Account. A platform with OAuth (ADR 0009: Lichess, and Chess.com
 * once approved) is connected only by signing in to it, which links it
 * verified; a guest's button signs them in with it. Without OAuth the
 * username is typed and stays unverified. The outcome comes back on the URL.
 */
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { BadgeCheck, Check, Link2, Loader2, LogIn, RefreshCw, Trash2 } from "lucide-react";
import { checkUsername, linkAccount, readScope, setIncludeBullet, syncAccount, unlinkAccount } from "@/lib/insights/client";
import { InsightsFetchError, validUsername, type Profile } from "@/lib/insights/fetch";
import { PLATFORM_NAME, PLATFORMS, TIME_CLASSES, type LinkedAccount, type Platform, type Ratings } from "@/lib/insights/types";
import type { InsightsStatus } from "@/lib/insights/client";
import { callbackErrorMessage } from "@/lib/auth";
import { isOAuthProvider, oauthEnabled, oauthStartUrl } from "@/lib/oauth/providers";

export function RatingsLine({ ratings }: { ratings: Ratings }) {
  const parts = TIME_CLASSES.filter((tc) => ratings[tc]).map((tc) => `${tc} ${ratings[tc]!.rating}${ratings[tc]!.provisional ? " (provisional)" : ""}`);
  return <span>{parts.length ? parts.join(" · ") : "no rated games yet"}</span>;
}

const ago = (iso: string | null) => {
  if (!iso) return "never";
  const m = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
};

export default function LinkedAccounts({
  accounts,
  status,
  signedIn,
  showStatus = false,
}: {
  accounts: Partial<Record<Platform, LinkedAccount>>;
  status: InsightsStatus;
  signedIn: boolean;
  /** show import progress and errors inline (Settings; /insights has its own status bar) */
  showStatus?: boolean;
}) {
  const [bullet, setBullet] = useState(() => readScope().timeClasses.includes("bullet"));
  const typed = PLATFORMS.filter((p) => !oauthEnabled(p));
  const connected = PLATFORMS.filter(oauthEnabled);
  return (
    <div className="space-y-4" data-testid="linked-accounts">
      <OAuthNotice />
      {PLATFORMS.map((p) => (
        <PlatformRow key={p} platform={p} account={accounts[p] ?? null} status={status} showStatus={showStatus} signedIn={signedIn} />
      ))}
      <label className="flex items-center gap-2 text-sm text-muted">
        <input
          type="checkbox"
          checked={bullet}
          onChange={(e) => {
            setBullet(e.target.checked);
            setIncludeBullet(e.target.checked);
          }}
          className="w-4 h-4 accent-[var(--accent)]"
        />
        Include bullet games in imports
      </label>
      <p className="text-xs text-muted">
        Your browser fetches your last 350 public, rated games straight from lichess.org and chess.com.
        {signedIn ? " We save a summary of each game's opening to your account; unlinking deletes it." : " As a guest, the summaries stay in this browser."}{" "}
        {connected.length > 0 && ` ${connected.map((p) => PLATFORM_NAME[p]).join(" and ")} ${connected.length === 1 ? "is" : "are"} connected by signing in, so the account is verified and you can sign in here with it.`}
        {typed.length > 0 && ` A typed ${typed.map((p) => PLATFORM_NAME[p]).join(" or ")} username isn't verified: anyone can type a public name.`}
      </p>
    </div>
  );
}

/**
 * The outcome of a verify round trip (?oauth=lichess&verified=1 or
 * &oauth_error=…), shown once; the query is then removed from the URL.
 */
function OAuthNotice() {
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  useEffect(() => {
    const url = new URL(window.location.href);
    const p = url.searchParams.get("oauth");
    if (!isOAuthProvider(p)) return;
    const error = url.searchParams.get("oauth_error");
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the query is only readable after mount
    setNotice(error ? { kind: "error", text: callbackErrorMessage(error)! } : { kind: "ok", text: `${PLATFORM_NAME[p]} connected and verified. You can also sign in with it now.` });
    for (const k of ["oauth", "oauth_error", "verified"]) url.searchParams.delete(k);
    window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
  }, []);
  if (!notice) return null;
  return (
    <p role={notice.kind === "error" ? "alert" : "status"} className={`text-sm ${notice.kind === "error" ? "text-danger-ink" : "text-accent"}`} data-testid="oauth-notice">
      {notice.text}
    </p>
  );
}

/** Sign in to the platform and come back here: links it for a signed-in player, signs a guest in with it. */
function OAuthLink({ platform, signedIn, label, primary = false, testId }: { platform: Platform; signedIn: boolean; label: string; primary?: boolean; testId: string }) {
  const path = usePathname();
  return (
    <a
      href={oauthStartUrl(platform, signedIn ? "link" : "signin", path)}
      className={`inline-flex items-center gap-2 px-4 min-h-[40px] rounded-md text-sm ${primary ? "bg-accent text-accent-fg font-medium hover:opacity-90" : "border border-edge bg-surface hover:bg-surface-2"}`}
      data-testid={testId}
    >
      {primary ? <LogIn size={14} aria-hidden /> : <BadgeCheck size={14} aria-hidden />} {label}
    </a>
  );
}

function PlatformRow({
  platform,
  account,
  status,
  showStatus,
  signedIn,
}: {
  platform: Platform;
  account: LinkedAccount | null;
  status: InsightsStatus;
  showStatus: boolean;
  signedIn: boolean;
}) {
  const name = PLATFORM_NAME[platform];
  /** connected by signing in to the platform, never by a typed name */
  const oauth = oauthEnabled(platform);
  const [input, setInput] = useState("");
  const [checking, setChecking] = useState(false);
  const [found, setFound] = useState<Profile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmUnlink, setConfirmUnlink] = useState(false);
  const busy = status.phase === "syncing" && status.platform === platform;
  const id = `link-${platform}`;

  const check = async (e: React.FormEvent) => {
    e.preventDefault();
    setFound(null);
    setError(null);
    if (!validUsername(input)) {
      setError("Usernames are 2–30 letters, digits, - or _.");
      return;
    }
    setChecking(true);
    try {
      setFound(await checkUsername(platform, input));
    } catch (err) {
      setError(err instanceof InsightsFetchError ? err.message : "Something went wrong. Try again.");
    } finally {
      setChecking(false);
    }
  };

  const confirm = async () => {
    if (!found) return;
    if (await linkAccount(found)) {
      setFound(null);
      setInput("");
      void syncAccount(platform);
    }
  };

  if (account) {
    return (
      <div className="rounded-lg border border-edge p-4" data-testid={`linked-${platform}`}>
        <div className="flex flex-wrap items-baseline gap-x-2">
          <h3 className="font-medium">{name}</h3>
          <span className="text-sm">{account.username}</span>
          {account.verified ? (
            <span className="text-xs text-accent inline-flex items-center gap-1 self-center" data-testid={`verified-${platform}`}>
              <BadgeCheck size={13} aria-hidden /> verified
            </span>
          ) : (
            <span className="text-xs text-muted">linked, not verified</span>
          )}
        </div>
        <p className="text-xs text-muted mt-1">
          <RatingsLine ratings={account.ratings} /> · synced {ago(account.lastSyncedAt)}
        </p>
        <div className="flex flex-wrap gap-2 mt-3">
          <button
            onClick={() => void syncAccount(platform)}
            disabled={status.phase === "syncing"}
            className="inline-flex items-center gap-2 px-3 min-h-[40px] rounded-md border border-edge bg-surface text-sm hover:bg-surface-2 disabled:opacity-50"
          >
            {busy ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <RefreshCw size={14} aria-hidden />}
            {busy ? "Importing…" : "Re-sync"}
          </button>
          {oauth && !account.verified && (
            <OAuthLink platform={platform} signedIn={signedIn} label={signedIn ? `Verify with ${name}` : `Sign in with ${name} to verify`} testId={`verify-${platform}`} />
          )}
          <button
            onClick={() => {
              if (!confirmUnlink) {
                setConfirmUnlink(true);
                setTimeout(() => setConfirmUnlink(false), 4000);
                return;
              }
              void unlinkAccount(platform);
            }}
            disabled={busy}
            className={`inline-flex items-center gap-2 px-3 min-h-[40px] rounded-md border text-sm disabled:opacity-50 ${
              confirmUnlink ? "border-danger bg-danger text-white" : "border-edge bg-surface text-danger-ink hover:border-danger"
            }`}
          >
            <Trash2 size={14} aria-hidden />
            {confirmUnlink ? "Click again: unlink and delete its games" : "Unlink"}
          </button>
        </div>
        {showStatus && status.platform === platform && status.phase === "syncing" && (
          <p className="text-xs text-muted mt-2" aria-live="polite">
            Importing: {status.progress?.label ?? "starting"}
          </p>
        )}
        {showStatus && status.platform === platform && status.phase === "error" && (
          <p role="alert" className="text-sm text-danger-ink mt-2">
            {status.message}
          </p>
        )}
        {showStatus && status.last?.platform === platform && status.phase === "idle" && (
          <p role="status" className="text-xs text-muted mt-2">
            {status.last.added ? `${status.last.added} new games imported.` : "No new games."}
          </p>
        )}
      </div>
    );
  }

  if (oauth) {
    return (
      <div className="rounded-lg border border-edge p-4" data-testid={`link-${platform}`}>
        <h3 className="font-medium mb-2">{name}</h3>
        <OAuthLink platform={platform} signedIn={signedIn} label={signedIn ? `Connect ${name}` : `Continue with ${name}`} primary testId={`connect-${platform}`} />
        <p className="text-xs text-muted mt-2">
          {signedIn
            ? `You sign in on ${name}; the account you sign in with is linked and verified, and its games are imported.`
            : `Signs you in here with your ${name} account (or creates one) and links it, verified.`}
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-edge p-4" data-testid={`link-${platform}`}>
      <h3 className="font-medium mb-2">{name}</h3>
      <form onSubmit={check} className="flex gap-2">
        <label htmlFor={id} className="sr-only">
          {name} username
        </label>
        <input
          id={id}
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            setFound(null);
            setError(null);
          }}
          maxLength={30}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          placeholder={`${name} username`}
          className="flex-1 min-w-0 h-10 px-3 rounded-lg border border-edge bg-surface text-sm outline-none focus:border-accent transition-colors"
        />
        <button
          type="submit"
          disabled={checking || !input.trim()}
          className="px-4 h-10 rounded-lg border border-edge bg-surface text-sm hover:bg-surface-2 disabled:opacity-50 inline-flex items-center gap-2 shrink-0"
        >
          {checking ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Check size={14} aria-hidden />}
          Check
        </button>
      </form>
      {error && (
        <p role="alert" className="text-sm text-danger-ink mt-2">
          {error}
        </p>
      )}
      {found && (
        <div className="mt-3 rounded-md bg-surface-2 p-3" role="status">
          <p className="text-sm">
            Found <span className="font-medium">{found.username}</span> on {name}.
          </p>
          <p className="text-xs text-muted mt-0.5">
            <RatingsLine ratings={found.ratings} />
          </p>
          <button
            onClick={() => void confirm()}
            className="mt-2 inline-flex items-center gap-2 px-4 min-h-[40px] rounded-md bg-accent text-accent-fg text-sm font-medium hover:opacity-90"
          >
            <Link2 size={14} aria-hidden /> Link and import games
          </button>
        </div>
      )}
    </div>
  );
}
