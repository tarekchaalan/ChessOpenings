"use client";
/**
 * First-login setup (ADR 0008): link Lichess / Chess.com (by signing in to it
 * where the platform has OAuth, ADR 0009; else a checked username), tell us your level
 * when no linked rating is reliable yet, then see the estimated Elo and what
 * it sets up. Finishing links the accounts (as Insights does), stores the
 * answers (save_setup), sets the level's defaults and imports games in the
 * background.
 */
import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { BadgeCheck, Check, Loader2, LogIn, Sparkles, X } from "lucide-react";
import { checkUsername, linkAccount, syncAccount } from "@/lib/insights/client";
import { InsightsFetchError, validUsername, type Profile } from "@/lib/insights/fetch";
import { PLATFORM_NAME, PLATFORMS, type LinkedAccount, type Platform } from "@/lib/insights/types";
import { RatingsLine } from "@/components/insights/LinkedAccounts";
import { basisText, estimateElo, estimateRecord, ignoredText, SELF_LEVELS, type Estimate, type SelfLevel } from "@/lib/rating/estimate";
import { levelOf, storeBand, TIER_LABEL } from "@/lib/rating/level";
import { resumeSetupAfterRedirect, saveSetup, type Setup } from "@/lib/setup/client";
import { oauthEnabled, oauthStartUrl } from "@/lib/oauth/providers";
import { DEFAULT_PREFS, getPrefs, setPref } from "@/lib/prefs";

type Step = "accounts" | "level" | "result";

const CONFIDENCE: Record<Estimate["confidence"], string> = { high: "solid", medium: "fair", low: "rough" };
const CATALOG_LABEL = { beginner: "Beginner", intermediate: "Intermediate", advanced: "Advanced" } as const;

export default function SetupModal({
  linked,
  setup,
  onClose,
}: {
  /** accounts already linked (re-running setup, or linked from Insights before) */
  linked: Partial<Record<Platform, LinkedAccount>>;
  setup: Setup | null;
  /** "Not now": closed without answering */
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [step, setStep] = useState<Step>("accounts");
  const [found, setFound] = useState<Partial<Record<Platform, Profile>>>(() =>
    Object.fromEntries(Object.values(linked).filter((a): a is LinkedAccount => !!a).map((a) => [a.platform, { platform: a.platform, username: a.username, ratings: a.ratings }]))
  );
  const [self, setSelf] = useState<SelfLevel | null>(setup?.self_level ?? null);
  const [busy, setBusy] = useState<"finish" | "skip" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const d = dialog.current;
    if (d && !d.open) d.showModal();
  }, []);

  const fromRatings = estimateElo(found);
  const estimate = estimateElo(found, self);
  const level = estimate ? levelOf(estimate.elo) : null;

  const next = () => setStep(fromRatings ? "result" : "level");
  // accounts → (level, when no linked rating counts) → result
  const total = fromRatings && step !== "level" ? 2 : 3;

  const finish = async () => {
    if (!estimate || !level) return;
    setBusy("finish");
    setError(null);
    try {
      // the gate only opens this once Insights has loaded for this player
      const toLink = Object.values(found).filter((p): p is Profile => !!p);
      for (const p of toLink) {
        if (linked[p.platform]?.username.toLowerCase() === p.username.toLowerCase()) continue;
        if (!(await linkAccount(p))) throw new Error(`Couldn't link ${PLATFORM_NAME[p.platform]}. Try again, or skip it for now.`);
      }
      await saveSetup({
        complete: true,
        skipped: false,
        self_level: estimate.source === "self" ? self : null,
        estimated_elo: estimate.elo,
        estimate: estimateRecord(estimate),
      });
      storeBand(level.band);
      // only when the player hasn't chosen their own number yet
      if (getPrefs().dailyNewLines === DEFAULT_PREFS.dailyNewLines) setPref("dailyNewLines", level.newLines);
      dialog.current?.close();
      // games for Insights, one platform at a time, after the modal is gone
      void (async () => {
        for (const p of toLink) await syncAccount(p.platform);
      })();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong. Try again.");
      setBusy(null);
    }
  };

  const skip = async () => {
    setBusy("skip");
    setError(null);
    try {
      await saveSetup({ skipped: true });
      dialog.current?.close();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong. Try again.");
      setBusy(null);
    }
  };

  return (
    <dialog
      ref={dialog}
      aria-labelledby="setup-title"
      aria-describedby="setup-desc"
      onCancel={(e) => {
        // Esc: "not now", not a skip
        e.preventDefault();
        dialog.current?.close();
      }}
      onClose={onClose}
      className="m-auto w-[min(34rem,calc(100vw-2rem))] max-h-[calc(100dvh-2rem)] overflow-y-auto rounded-xl border border-edge bg-surface text-foreground p-0 shadow-xl backdrop:bg-black/60"
      data-testid="setup-modal"
    >
      <div className="p-5 sm:p-6">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-xs text-muted" aria-live="polite">
              Step {step === "accounts" ? 1 : step === "level" ? 2 : total} of {total}
            </p>
            <h2 id="setup-title" className="text-lg font-semibold mt-0.5">
              {step === "accounts" ? "Link your chess accounts" : step === "level" ? "How would you describe your chess?" : "Your starting point"}
            </h2>
          </div>
          <button type="button" onClick={() => dialog.current?.close()} aria-label="Not now" className="w-9 h-9 grid place-items-center rounded-md text-muted hover:bg-surface-2 shrink-0">
            <X size={16} />
          </button>
        </div>

        {step === "accounts" && (
          <div>
            <p id="setup-desc" className="text-sm text-muted mt-2">
              Your Lichess and Chess.com ratings give us an estimated Elo, so suggestions, course depth and your daily plan fit your level. Link one, both or neither.
            </p>
            <div className="mt-4 space-y-4">
              {PLATFORMS.map((p) =>
                oauthEnabled(p) ? (
                  <ConnectField key={p} platform={p} account={linked[p] ?? null} />
                ) : (
                  <AccountField key={p} platform={p} profile={found[p] ?? null} onFound={(prof) => setFound((f) => ({ ...f, [p]: prof ?? undefined }))} />
                )
              )}
            </div>
            <p className="text-xs text-muted mt-3">
              {PLATFORMS.some(oauthEnabled) && "Connecting takes you to sign in on that site and back here; the account you sign in with is linked, verified. "}
              {PLATFORMS.some((p) => !oauthEnabled(p)) && "A typed username is checked by your browser on the site. "}
              We keep the username, ratings and a summary of each game&apos;s opening.
            </p>
            <div className="mt-5 flex flex-wrap items-center justify-between gap-2">
              <button type="button" onClick={() => setStep("level")} className="text-sm text-muted hover:text-foreground underline">
                I don&apos;t play online
              </button>
              <button
                type="button"
                onClick={next}
                disabled={!Object.values(found).some(Boolean)}
                className="h-10 px-4 rounded-md bg-accent text-accent-fg text-sm font-medium hover:opacity-90 disabled:opacity-50"
              >
                Continue
              </button>
            </div>
          </div>
        )}

        {step === "level" && (
          <div>
            {fromRatings === null && Object.values(found).some(Boolean) && <NewAccountNote found={found} />}
            <p id="setup-desc" className="text-sm text-muted mt-2">
              Pick the closest. You can link an account later and the estimate will follow your ratings.
            </p>
            <fieldset className="mt-4 space-y-2">
              <legend className="sr-only">Your level</legend>
              {SELF_LEVELS.map((l) => (
                <label key={l.id} className={`flex items-start gap-3 rounded-lg border p-3 cursor-pointer ${self === l.id ? "border-accent bg-accent-soft" : "border-edge hover:bg-surface-2"}`}>
                  <input type="radio" name="self-level" value={l.id} checked={self === l.id} onChange={() => setSelf(l.id)} className="mt-1 accent-[var(--accent)]" />
                  <span>
                    <span className="text-sm font-medium block">{l.label}</span>
                    <span className="text-xs text-muted">{l.help}</span>
                  </span>
                </label>
              ))}
            </fieldset>
            <div className="mt-5 flex items-center justify-between gap-2">
              <button type="button" onClick={() => setStep("accounts")} className="h-10 px-3 rounded-md border border-edge text-sm hover:bg-surface-2">
                Back
              </button>
              <button type="button" onClick={() => setStep("result")} disabled={!self} className="h-10 px-4 rounded-md bg-accent text-accent-fg text-sm font-medium hover:opacity-90 disabled:opacity-50">
                Continue
              </button>
            </div>
          </div>
        )}

        {step === "result" && estimate && level && (
          <div>
            <div className="mt-3 rounded-lg bg-accent-soft p-4" data-testid="setup-estimate">
              <p className="text-xs text-muted flex items-center gap-1.5">
                <Sparkles size={13} className="text-accent" aria-hidden /> Estimated Elo
              </p>
              <p className="text-3xl font-semibold font-mono mt-0.5">≈ {estimate.elo}</p>
              <p className="text-sm mt-1">
                <strong>{level.name}</strong> · likely {estimate.low}–{estimate.high} ({CONFIDENCE[estimate.confidence]} estimate)
              </p>
            </div>
            <div id="setup-desc" className="mt-3 text-sm">
              {estimate.source === "ratings" ? (
                <>
                  <p className="text-muted">From:</p>
                  <ul className="list-disc pl-5">
                    {estimate.basis.map((b) => (
                      <li key={`${b.platform}:${b.timeClass}`}>{basisText(b)}</li>
                    ))}
                  </ul>
                </>
              ) : (
                <p className="text-muted">From what you told us: {SELF_LEVELS.find((l) => l.id === estimate.self)?.label}.</p>
              )}
              {estimate.ignored.length > 0 && (
                <ul className="mt-2 text-xs text-muted space-y-0.5">
                  {estimate.ignored.map((i) => (
                    <li key={`${i.platform}:${i.timeClass}`}>{ignoredText(i)}</li>
                  ))}
                </ul>
              )}
              <p className="text-xs text-muted mt-2">Ratings on different sites aren&apos;t the same scale; this converts them approximately.</p>
            </div>
            <h3 className="text-sm font-medium mt-4">What this sets up</h3>
            <ul className="mt-1 text-sm space-y-1" data-testid="setup-effects">
              <li>
                <Check size={14} className="inline -mt-0.5 text-accent" aria-hidden /> Suggested openings at {level.catalog.slice(0, 2).map((c) => CATALOG_LABEL[c]).join(" and ")} level
              </li>
              <li>
                <Check size={14} className="inline -mt-0.5 text-accent" aria-hidden /> Courses start at <strong>{TIER_LABEL[level.tier]}</strong> depth
              </li>
              <li>
                <Check size={14} className="inline -mt-0.5 text-accent" aria-hidden />{" "}
                {getPrefs().dailyNewLines === DEFAULT_PREFS.dailyNewLines ? `${level.newLines} new lines a day` : `Your ${getPrefs().dailyNewLines} new lines a day stay as you set them`}
              </li>
              {Object.values(found).some(Boolean) && (
                <li>
                  <Check size={14} className="inline -mt-0.5 text-accent" aria-hidden /> Your recent games are imported for Insights
                </li>
              )}
            </ul>
            <p className="text-xs text-muted mt-3">Your leaderboard rating is separate: it starts at 800 and moves only with your answers.</p>
            <div className="mt-5 flex items-center justify-between gap-2">
              <button type="button" onClick={() => setStep(fromRatings ? "accounts" : "level")} className="h-10 px-3 rounded-md border border-edge text-sm hover:bg-surface-2">
                Back
              </button>
              <button
                type="button"
                onClick={finish}
                disabled={busy !== null}
                className="inline-flex items-center gap-1.5 h-10 px-4 rounded-md bg-accent text-accent-fg text-sm font-medium hover:opacity-90 disabled:opacity-60"
              >
                {busy === "finish" && <Loader2 size={14} className="animate-spin motion-reduce:animate-none" />}
                Start training
              </button>
            </div>
          </div>
        )}

        {error && (
          <p role="alert" className="text-sm text-danger-ink mt-3">
            {error}
          </p>
        )}
        <div className="mt-5 pt-4 border-t border-edge text-center">
          <button type="button" onClick={skip} disabled={busy !== null} className="text-xs text-muted hover:text-foreground underline disabled:opacity-60">
            {busy === "skip" ? "Skipping…" : "Skip setup (you can run it later from Settings)"}
          </button>
        </div>
      </div>
    </dialog>
  );
}

/** A platform with OAuth: connected (by the round trip, so it comes in through `linked`) or a Connect button. */
function ConnectField({ platform, account }: { platform: Platform; account: LinkedAccount | null }) {
  const path = usePathname();
  const name = PLATFORM_NAME[platform];
  const start = (label: string, testId: string) => (
    <a
      href={oauthStartUrl(platform, "link", path)}
      onClick={resumeSetupAfterRedirect}
      className="mt-2 inline-flex items-center gap-1.5 h-10 px-3 rounded-md border border-edge text-sm hover:bg-surface-2"
      data-testid={testId}
    >
      <LogIn size={14} aria-hidden /> {label}
    </a>
  );
  return (
    <div className="rounded-lg border border-edge p-3" data-testid={`setup-${platform}`}>
      <p className="text-sm font-medium">{name}</p>
      {account ? (
        <>
          <p className="text-sm mt-2 flex items-start gap-1.5" data-testid={`setup-${platform}-found`}>
            {account.verified ? <BadgeCheck size={15} className="text-accent mt-0.5 shrink-0" aria-hidden /> : <Check size={15} className="text-muted mt-0.5 shrink-0" aria-hidden />}
            <span>
              <strong className="break-all">{account.username}</strong>: <RatingsLine ratings={account.ratings} />
              {account.verified ? <span className="sr-only"> (verified)</span> : <span className="text-muted"> (not verified)</span>}
            </span>
          </p>
          {!account.verified && start(`Verify with ${name}`, `setup-${platform}-verify`)}
        </>
      ) : (
        start(`Connect ${name}`, `setup-${platform}-connect`)
      )}
    </div>
  );
}

function AccountField({ platform, profile, onFound }: { platform: Platform; profile: Profile | null; onFound: (p: Profile | null) => void }) {
  const [name, setName] = useState(profile?.username ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = `setup-${platform}`;

  const check = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const u = name.trim();
    if (!u) return;
    if (!validUsername(u)) {
      setError("That isn't a valid username.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      onFound(await checkUsername(platform, u));
    } catch (err) {
      onFound(null);
      setError(err instanceof InsightsFetchError ? err.message : "Couldn't check that username. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={check} className="rounded-lg border border-edge p-3" data-testid={`setup-${platform}`}>
      <label htmlFor={id} className="text-sm font-medium">
        {PLATFORM_NAME[platform]} username
      </label>
      <div className="mt-1 flex gap-2">
        <input
          id={id}
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            if (profile) onFound(null);
          }}
          autoComplete="off"
          spellCheck={false}
          maxLength={30}
          placeholder={platform === "lichess" ? "lichess.org/@/…" : "chess.com/member/…"}
          className="flex-1 min-w-0 h-10 rounded-md border border-edge bg-background px-3 text-sm"
        />
        <button type="submit" disabled={busy || !name.trim()} className="h-10 px-3 rounded-md border border-edge text-sm hover:bg-surface-2 disabled:opacity-50 inline-flex items-center gap-1.5">
          {busy && <Loader2 size={14} className="animate-spin motion-reduce:animate-none" />}
          Check
        </button>
      </div>
      <div aria-live="polite">
        {profile && (
          <p className="text-sm mt-2 flex items-start gap-1.5" data-testid={`setup-${platform}-found`}>
            <Check size={15} className="text-accent mt-0.5 shrink-0" aria-hidden />
            <span>
              <strong className="break-all">{profile.username}</strong>: <RatingsLine ratings={profile.ratings} />
            </span>
          </p>
        )}
        {error && <p className="text-sm text-danger-ink mt-2">{error}</p>}
      </div>
    </form>
  );
}

function NewAccountNote({ found }: { found: Partial<Record<Platform, Profile>> }) {
  const est = estimateElo(found);
  if (est) return null;
  const ignored = estimateElo(found, "casual")?.ignored ?? [];
  return (
    <div className="mt-2 rounded-md border border-gold/50 p-3 text-sm" data-testid="setup-new-account">
      <p>Your linked {ignored.length === 1 ? "rating is" : "ratings are"} too new to estimate from yet:</p>
      <ul className="mt-1 text-xs text-muted list-disc pl-5">
        {ignored.map((i) => (
          <li key={`${i.platform}:${i.timeClass}`}>{ignoredText(i)}</li>
        ))}
        {!ignored.length && <li>No rated games yet.</li>}
      </ul>
    </div>
  );
}
