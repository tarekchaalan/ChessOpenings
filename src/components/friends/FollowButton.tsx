"use client";
/**
 * Follow / Request / Requested / Following. A second click undoes (unfollow,
 * or cancel the request). Guests get a sign-in link instead.
 */
import { useState } from "react";
import Link from "next/link";
import { Check, Clock, Loader2, UserPlus } from "lucide-react";
import { errorText, friendsApi } from "@/lib/friends/api";
import { useAuth } from "@/lib/supabase/AuthProvider";

export interface FollowState {
  following: boolean;
  requested: boolean;
}

export default function FollowButton({
  username,
  state,
  approve = false,
  onChange,
  onFollowed,
  size = "md",
}: {
  username: string;
  state: FollowState;
  /** the other player approves followers: a follow becomes a request */
  approve?: boolean;
  onChange?: (s: FollowState) => void;
  /** after a new follow or request (the preset card listens) */
  onFollowed?: () => void;
  size?: "sm" | "md";
}) {
  const { user, configured } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const h = size === "sm" ? "h-8 px-2.5 text-xs" : "h-9 px-3.5 text-sm";

  if (!configured) return null;
  if (!user) {
    return (
      <Link href="/auth" className={`inline-flex items-center gap-1.5 rounded-md border border-edge hover:bg-surface-2 ${h}`}>
        <UserPlus size={14} /> Sign in to follow
      </Link>
    );
  }

  const act = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (state.following || state.requested) {
        await friendsApi.unfollow(username);
        onChange?.({ following: false, requested: false });
      } else {
        const r = await friendsApi.follow(username);
        onChange?.({ following: r.status === "active", requested: r.status === "pending" });
        onFollowed?.();
      }
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const on = state.following || state.requested;
  const label = state.following ? "Following" : state.requested ? "Requested" : approve ? "Request to follow" : "Follow";
  // the accessible name starts with the visible label (WCAG 2.5.3), then says what a click does
  const more = state.following ? `${username}, select to unfollow` : state.requested ? `${username}, select to cancel the request` : username;

  return (
    <span className="inline-flex flex-col items-start gap-1">
      <button
        type="button"
        onClick={act}
        disabled={busy}
        aria-pressed={on}
        title={on ? (state.following ? "Unfollow" : "Cancel request") : undefined}
        data-testid="follow-button"
        className={`inline-flex items-center gap-1.5 rounded-md font-medium transition-colors disabled:opacity-60 ${h} ${
          on ? "border border-edge bg-surface hover:bg-surface-2" : "bg-accent text-accent-fg hover:opacity-90"
        }`}
      >
        {busy ? <Loader2 size={14} className="animate-spin motion-reduce:animate-none" /> : state.following ? <Check size={14} /> : state.requested ? <Clock size={14} /> : <UserPlus size={14} />}
        {label}
        <span className="sr-only"> {more}</span>
      </button>
      {error && (
        <span role="alert" className="text-xs text-danger-ink">
          {error}
        </span>
      )}
    </span>
  );
}
