"use client";
/**
 * Friends calls (ADR 0007). Every one is an RPC on 0008_friends.sql that reads
 * the caller from the JWT; nothing here can name a viewer or touch a table.
 */
import { useCallback, useEffect, useState } from "react";
import { getSupabase } from "@/lib/supabase/client";
import type {
  BoardRow,
  CompareData,
  FeedEvent,
  FollowerRow,
  FollowingRow,
  NotificationRow,
  PrivacySettings,
  Profile,
  RequestRow,
  SearchResult,
  ViewAs,
} from "./types";

export class FriendsError extends Error {
  constructor(
    message: string,
    readonly code: "rate_limited" | "not_found" | "signed_out" | "unavailable" | "other",
    readonly retryAfter: number | null = null
  ) {
    super(message);
  }
}

interface PgError {
  message: string;
  details?: string | null;
  code?: string;
}

function toError(e: PgError): FriendsError {
  if (e.message === "rate_limited") {
    const s = Number(e.details);
    const wait = Number.isFinite(s) && s > 0 ? s : 60;
    return new FriendsError(`Slow down: try again in ${wait} s.`, "rate_limited", wait);
  }
  if (e.message === "no such player" || e.message === "no such request") return new FriendsError("That player isn't available.", "not_found");
  if (e.code === "42501" || e.message === "not signed in") return new FriendsError("Sign in to do that.", "signed_out");
  return new FriendsError(e.message || "Something went wrong.", "other");
}

async function rpc<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const sb = getSupabase();
  if (!sb) throw new FriendsError("Friends need accounts, which this deployment doesn't have.", "unavailable");
  const { data, error } = await sb.rpc(fn, args);
  if (error) throw toError(error as PgError);
  return data as T;
}

export const friendsApi = {
  profile: (username: string, viewAs?: ViewAs) => rpc<Profile | null>("get_profile", { p_username: username, p_view_as: viewAs ?? null }),
  search: (prefix: string) => rpc<SearchResult[]>("search_profiles", { p_prefix: prefix }),
  following: () => rpc<FollowingRow[]>("my_follows", { p_kind: "following" }),
  followers: () => rpc<FollowerRow[]>("my_follows", { p_kind: "followers" }),
  requests: () => rpc<RequestRow[]>("my_follows", { p_kind: "requests" }),
  feed: (before?: string) => rpc<FeedEvent[]>("get_feed", { p_before: before ?? null, p_limit: 30 }),
  compare: (username: string) => rpc<CompareData | null>("compare_with", { p_username: username }),
  board: () => rpc<BoardRow[]>("friends_leaderboard"),
  privacy: () => rpc<PrivacySettings>("get_privacy"),
  setPrivacy: (s: Partial<PrivacySettings>) => rpc<PrivacySettings>("set_privacy", { p_settings: s }),
  blocks: () => rpc<{ username: string; since: string }[]>("my_blocks"),
  notificationCount: () => rpc<number>("notification_count"),
  notifications: () => rpc<NotificationRow[]>("my_notifications"),
  markRead: () => rpc<number>("mark_notifications_read").then((n) => (announceNotifications(), n)),
  follow: (u: string) => rpc<{ status: "active" | "pending" }>("follow", { p_username: u }),
  unfollow: (u: string) => rpc<unknown>("unfollow", { p_username: u }),
  accept: (u: string) => rpc<unknown>("accept_follower", { p_username: u }).then(announceNotifications),
  decline: (u: string) => rpc<unknown>("decline_follower", { p_username: u }).then(announceNotifications),
  removeFollower: (u: string) => rpc<unknown>("remove_follower", { p_username: u }),
  block: (u: string) => rpc<unknown>("block", { p_username: u }),
  unblock: (u: string) => rpc<unknown>("unblock", { p_username: u }),
};

const NOTIFY = "cot:friends-notifications";
/** Tell the nav badge to refetch (after reading or handling notifications). */
export function announceNotifications(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(NOTIFY));
}

/** The Friends nav badge: unread count, refetched on focus, every 60 s while visible, and on announce. */
export function useNotificationCount(enabled: boolean): number {
  const [n, setN] = useState(0);
  const load = useCallback(() => {
    if (!enabled || document.visibilityState === "hidden") return;
    friendsApi.notificationCount().then(setN, () => {});
  }, [enabled]);
  useEffect(() => {
    if (!enabled) return;
    load();
    const id = window.setInterval(load, 60_000);
    window.addEventListener("focus", load);
    window.addEventListener(NOTIFY, load);
    document.addEventListener("visibilitychange", load);
    return () => {
      window.clearInterval(id);
      window.removeEventListener("focus", load);
      window.removeEventListener(NOTIFY, load);
      document.removeEventListener("visibilitychange", load);
    };
  }, [enabled, load]);
  return enabled ? n : 0;
}

export const errorText = (e: unknown) => (e instanceof FriendsError ? e.message : e instanceof Error ? e.message : "Something went wrong.");
