"use client";
/**
 * The one-step "what friends see" choice (ADR 0007, defaults A): every section
 * starts at Only me; this offers the friends preset once, on a first follow
 * and on /friends, until it's answered either way.
 */
import { useState } from "react";
import Link from "next/link";
import { Loader2, ShieldCheck } from "lucide-react";
import { errorText, friendsApi } from "@/lib/friends/api";
import { FRIENDS_PRESET } from "@/lib/friends/visibility";
import type { PrivacySettings } from "@/lib/friends/types";

export default function PresetCard({ onDone }: { onDone: (s: PrivacySettings) => void }) {
  const [busy, setBusy] = useState<"share" | "keep" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const answer = async (share: boolean) => {
    setBusy(share ? "share" : "keep");
    setError(null);
    try {
      onDone(await friendsApi.setPrivacy({ ...(share ? FRIENDS_PRESET : {}), preset_answered: true }));
    } catch (e) {
      setError(errorText(e));
      setBusy(null);
    }
  };

  return (
    <section aria-labelledby="preset-title" className="rounded-lg border border-accent/40 bg-accent-soft p-4" data-testid="preset-card">
      <h2 id="preset-title" className="font-semibold flex items-center gap-2">
        <ShieldCheck size={16} className="text-accent" /> What should your friends see?
      </h2>
      <p className="text-sm mt-1">
        Right now nobody but you sees your training. Friends are people you follow who follow you back.
      </p>
      <div className="flex flex-wrap gap-2 mt-3">
        <button
          type="button"
          onClick={() => answer(true)}
          disabled={busy !== null}
          className="inline-flex items-center gap-1.5 h-9 px-3.5 rounded-md bg-accent text-accent-fg text-sm font-medium hover:opacity-90 disabled:opacity-60"
        >
          {busy === "share" && <Loader2 size={14} className="animate-spin motion-reduce:animate-none" />}
          Let friends see what I&apos;m learning, my stats and activity
        </button>
        <button
          type="button"
          onClick={() => answer(false)}
          disabled={busy !== null}
          className="inline-flex items-center gap-1.5 h-9 px-3.5 rounded-md border border-edge bg-surface text-sm hover:bg-surface-2 disabled:opacity-60"
        >
          {busy === "keep" && <Loader2 size={14} className="animate-spin motion-reduce:animate-none" />}
          Keep everything private
        </button>
      </div>
      <p className="text-xs mt-2">
        Linked accounts stay private either way. Fine-tune any time in{" "}
        <Link href="/settings?tab=privacy" className="underline">
          Settings → Privacy
        </Link>
        .
      </p>
      {error && (
        <p role="alert" className="text-sm text-danger-ink mt-2">
          {error}
        </p>
      )}
    </section>
  );
}
