"use client";
/**
 * Challenge a friend on Lichess or Chess.com (spec §2.7). Only platforms both
 * players linked and the friend lets the viewer see (challenge_targets in
 * 0008); none hides the button, one links straight there, two open a dialog.
 */
import { useEffect, useRef, useState } from "react";
import { ExternalLink, Swords, X } from "lucide-react";
import { challengePlan, challengeUrl, platformProfileUrl } from "@/lib/friends/challenge";
import { primaryRating } from "@/lib/friends/compare";
import type { ChallengeTarget, Ratings } from "@/lib/friends/types";
import { PLATFORM_NAME } from "@/lib/insights/types";

const ratingText = (r: Ratings) => {
  const p = primaryRating(r);
  return p ? `${p.timeClass} ${p.rating}` : "unrated";
};

export default function ChallengeButton({ targets, size = "md" }: { targets: ChallengeTarget[] | null | undefined; size?: "sm" | "md" }) {
  const plan = challengePlan(targets);
  const [open, setOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const h = size === "sm" ? "h-8 px-2.5 text-xs" : "h-9 px-3.5 text-sm";
  const cls = `inline-flex items-center gap-1.5 rounded-md border border-edge bg-surface hover:bg-surface-2 font-medium ${h}`;

  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  if (plan.kind === "none") return null;
  if (plan.kind === "direct") {
    return (
      <a href={plan.href} target="_blank" rel="noopener noreferrer" className={cls} data-testid="challenge-link">
        <Swords size={14} /> {plan.label}
        <span className="sr-only"> (opens in a new tab)</span>
      </a>
    );
  }

  return (
    <>
      <button type="button" className={cls} onClick={() => setOpen(true)} aria-haspopup="dialog" data-testid="challenge-button">
        <Swords size={14} /> Challenge
      </button>
      <dialog
        ref={dialog}
        onClose={() => setOpen(false)}
        aria-labelledby="challenge-title"
        className="m-auto w-[min(26rem,calc(100vw-2rem))] rounded-xl border border-edge bg-surface text-foreground p-5 shadow-xl backdrop:bg-black/50"
      >
        <div className="flex items-start justify-between gap-3 mb-3">
          <h2 id="challenge-title" className="font-semibold">
            Challenge on Chess.com or Lichess?
          </h2>
          <button type="button" onClick={() => setOpen(false)} aria-label="Close" className="w-8 h-8 grid place-items-center rounded-md text-muted hover:bg-surface-2">
            <X size={16} />
          </button>
        </div>
        <ul className="space-y-2">
          {plan.targets.map((t: ChallengeTarget) => (
            <li key={t.platform} className="rounded-lg border border-edge p-3">
              <a
                href={challengeUrl(t.platform, t.their_username)}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => setOpen(false)}
                className="flex items-center justify-between gap-3 font-medium text-accent hover:underline"
                data-testid={`challenge-${t.platform}`}
              >
                {PLATFORM_NAME[t.platform]}
                <ExternalLink size={14} aria-hidden />
                <span className="sr-only"> (opens in a new tab)</span>
              </a>
              <p className="text-xs text-muted mt-1">
                You: {t.my_username} ({ratingText(t.my_ratings)}) · Them: {t.their_username} ({ratingText(t.their_ratings)})
              </p>
              <p className="text-xs text-muted mt-1">
                Link not working?{" "}
                <a href={platformProfileUrl(t.platform, t.their_username)} target="_blank" rel="noopener noreferrer" className="underline">
                  Open their profile
                </a>{" "}
                and challenge from there.
              </p>
            </li>
          ))}
        </ul>
        <p className="text-xs text-muted mt-3">Usernames are as linked in each player&apos;s settings and aren&apos;t verified.</p>
      </dialog>
    </>
  );
}
