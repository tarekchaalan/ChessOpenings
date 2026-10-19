/**
 * Visibility resolution (ADR 0007, decision 2). The database decides what
 * anyone can read (friends_reaches in 0008_friends.sql); this mirror only
 * drives the Settings copy and the "view as" labels. Both are tested against
 * the same fixture, __tests__/visibility-matrix.json, so they can't drift.
 */
import type { Audience, Level, PrivacySettings, Section, ViewAs } from "./types";

export const LEVELS: Level[] = ["everyone", "followers", "friends", "only_me"];
export const SECTIONS: Section[] = ["linked", "learning", "stats", "activity"];

export const LEVEL_LABEL: Record<Level, string> = {
  everyone: "Everyone",
  followers: "Followers",
  friends: "Friends (mutual)",
  only_me: "Only me",
};

export const SECTION_LABEL: Record<Section, string> = {
  linked: "Linked accounts",
  learning: "Openings I'm learning",
  stats: "Training stats",
  activity: "Activity in the feed",
};

export const SECTION_HELP: Record<Section, string> = {
  linked: "Lichess and Chess.com usernames, ratings and the openings you play. Also decides who can challenge you.",
  learning: "Courses in progress, with answers and mastery.",
  stats: "Day streak, lines trained and graded moves this week.",
  activity: "Feed items about you. Each item also needs the section it's about.",
};

/** Every section starts at Only me (ADR 0007, defaults A). */
export const DEFAULT_PRIVACY: PrivacySettings = {
  linked: "only_me",
  learning: "only_me",
  stats: "only_me",
  activity: "only_me",
  approve_followers: false,
  preset_answered: false,
};

/** The one-click preset offered on a first follow: friends see learning, stats and activity. */
export const FRIENDS_PRESET: Partial<PrivacySettings> = { learning: "friends", stats: "friends", activity: "friends" };

const REACH: Record<Audience, readonly Level[]> = {
  owner: LEVELS,
  friend: ["everyone", "followers", "friends"],
  follower: ["everyone", "followers"],
  stranger: ["everyone"],
  anonymous: ["everyone"],
  blocked: [],
};

export function reaches(audience: Audience, level: Level): boolean {
  return REACH[audience].includes(level);
}

/** The audience a "view as" preview stands for. */
export const VIEW_AS_AUDIENCE: Record<ViewAs, Audience> = { everyone: "stranger", follower: "follower", friend: "friend" };

/** Sections an audience would see under these settings. */
export function visibleSections(settings: Pick<PrivacySettings, Section>, audience: Audience): Section[] {
  return SECTIONS.filter((s) => reaches(audience, settings[s]));
}

/** Who can see a section, in words (Settings → Privacy). */
export function whoCanSee(level: Level): string {
  switch (level) {
    case "everyone":
      return "Anyone with your profile link, signed in or not.";
    case "followers":
      return "Everyone who follows you (friends included).";
    case "friends":
      return "Only people you follow who also follow you.";
    case "only_me":
      return "Nobody but you.";
  }
}
