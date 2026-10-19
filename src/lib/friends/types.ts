/**
 * Friends types (ADR 0007): the shapes the SQL functions in 0008_friends.sql
 * return, as the browser receives them.
 */
import type { Platform, Ratings, TimeClass } from "@/lib/insights/types";

export type { Platform, Ratings, TimeClass };

export type Level = "everyone" | "followers" | "friends" | "only_me";
export type Section = "linked" | "learning" | "stats" | "activity";
export type Audience = "owner" | "friend" | "follower" | "stranger" | "anonymous" | "blocked";
/** the owner's "view as" preview */
export type ViewAs = "everyone" | "follower" | "friend";

export interface PrivacySettings {
  linked: Level;
  learning: Level;
  stats: Level;
  activity: Level;
  approve_followers: boolean;
  preset_answered: boolean;
}

export interface LinkedInfo {
  platform: Platform;
  username: string;
  verified: boolean;
  ratings: Ratings;
  last_synced_at: string | null;
}

export interface PlayedOpening {
  color: "white" | "black";
  name: string;
  games: number;
  wins: number;
  draws: number;
  losses: number;
}

export interface LearningRow {
  course_id: string;
  /** server-graded answers in the course */
  seen: number;
  correct: number;
  /** 0..1, reported by the owner's browser (display only) */
  mastery: number;
  updated_at: string;
}

export interface ProfileStats {
  streak: number;
  lines_trained: number;
  moves_this_week: number;
  attempts: number;
  correct: number;
}

export interface ChallengeTarget {
  platform: Platform;
  my_username: string;
  my_ratings: Ratings;
  their_username: string;
  their_ratings: Ratings;
}

export interface Relationship {
  self: boolean;
  following: boolean;
  requested: boolean;
  follows_you: boolean;
  friends: boolean;
  approve_followers: boolean;
}

export interface Profile {
  username: string;
  rating: number;
  attempts: number;
  correct: number;
  followers: number;
  following: number;
  preview: boolean;
  /** null for anonymous visitors and previews */
  relationship: Relationship | null;
  some_private: boolean;
  /** null = hidden from this viewer */
  linked: LinkedInfo[] | null;
  played: PlayedOpening[] | null;
  learning: LearningRow[] | null;
  stats: ProfileStats | null;
  challenge: ChallengeTarget[];
}

export interface SearchResult {
  username: string;
  following: boolean;
  requested: boolean;
  follows_you: boolean;
}

export interface FollowingRow {
  username: string;
  status: "active" | "pending";
  since: string;
  friends: boolean;
  challenge: ChallengeTarget[];
}

export interface FollowerRow {
  username: string;
  since: string;
  following: boolean;
  requested: boolean;
}

export interface RequestRow {
  username: string;
  since: string;
}

export type FeedEvent =
  | { id: number; username: string; kind: "lines"; payload: { course: string; count: number }; created_at: string; updated_at: string }
  | { id: number; username: string; kind: "streak"; payload: { days: number }; created_at: string; updated_at: string }
  | { id: number; username: string; kind: "rating"; payload: { platform: Platform; time_class: TimeClass; from: number; to: number }; created_at: string; updated_at: string }
  | { id: number; username: string; kind: "course"; payload: { course: string }; created_at: string; updated_at: string };

export interface CompareData {
  me: { username: string; learning: LearningRow[]; linked: LinkedInfo[] };
  them: { username: string; learning: LearningRow[] | null; linked: LinkedInfo[] | null };
}

export interface BoardRow {
  rank: number;
  username: string;
  rating: number;
  attempts: number;
  correct: number;
}

export interface NotificationRow {
  username: string;
  kind: "new_follower" | "follow_request" | "request_accepted";
  created_at: string;
  read: boolean;
}
