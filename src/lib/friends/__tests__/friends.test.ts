/** Friends pure logic (ADR 0007): visibility, feed building, compare, challenge, course names. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseDatasetV2 } from "@/lib/openings";
import type { RawDatasetV2 } from "@/lib/openings-build/dataset";
import { catalogOf } from "@/lib/courses-client";
import { challengePlan, challengeUrl, platformProfileUrl } from "../challenge";
import { accuracy, compareCourses, compareRatings, primaryRating } from "../compare";
import { courseLink, courseName } from "../courses";
import { eventSentence, groupFeed } from "../feed";
import type { Audience, ChallengeTarget, FeedEvent, Level, LearningRow, LinkedInfo, Section } from "../types";
import { DEFAULT_PRIVACY, FRIENDS_PRESET, LEVELS, SECTIONS, VIEW_AS_AUDIENCE, reaches, visibleSections } from "../visibility";

const matrix = JSON.parse(readFileSync(join(__dirname, "visibility-matrix.json"), "utf8")) as {
  rows: { audience: Audience; level: Level; visible: boolean }[];
};

describe("visibility", () => {
  it("covers 6 audiences × 4 levels", () => {
    expect(matrix.rows).toHaveLength(24);
  });

  // 24 rows × 4 sections = the 96 cases the SQL test also runs
  for (const section of SECTIONS) {
    for (const r of matrix.rows) {
      it(`${section}: ${r.audience} ${r.visible ? "sees" : "doesn't see"} ${r.level}`, () => {
        const settings = { ...DEFAULT_PRIVACY, [section]: r.level } as Record<Section, Level>;
        expect(reaches(r.audience, r.level)).toBe(r.visible);
        expect(visibleSections(settings, r.audience).includes(section)).toBe(r.visible);
      });
    }
  }

  it("blocks win over everyone; the owner sees only_me", () => {
    expect(reaches("blocked", "everyone")).toBe(false);
    expect(reaches("owner", "only_me")).toBe(true);
  });

  it("defaults show nothing to anyone but the owner", () => {
    for (const a of ["friend", "follower", "stranger", "anonymous", "blocked"] as Audience[]) {
      expect(visibleSections(DEFAULT_PRIVACY, a)).toEqual([]);
    }
    expect(visibleSections(DEFAULT_PRIVACY, "owner")).toEqual(SECTIONS);
  });

  it("the preset shares learning, stats and activity with friends only", () => {
    const s = { ...DEFAULT_PRIVACY, ...FRIENDS_PRESET };
    expect(visibleSections(s, "friend")).toEqual(["learning", "stats", "activity"]);
    expect(visibleSections(s, "follower")).toEqual([]);
  });

  it("view-as maps to audiences", () => {
    expect(VIEW_AS_AUDIENCE).toEqual({ everyone: "stranger", follower: "follower", friend: "friend" });
    expect(LEVELS).toEqual(["everyone", "followers", "friends", "only_me"]);
  });
});

const ev = (id: number, username: string, at: string, rest: Omit<FeedEvent, "id" | "username" | "created_at" | "updated_at">) =>
  ({ id, username, created_at: at, updated_at: at, ...rest }) as FeedEvent;

describe("feed", () => {
  const name = (id: string) => (id === "italian-game/main@white" ? "the Italian" : id);

  it("writes the spec's sentences", () => {
    expect(eventSentence(ev(1, "Sam", "2026-10-19T10:00:00Z", { kind: "lines", payload: { course: "italian-game/main@white", count: 3 } }), name)).toBe(
      "Sam trained 3 new lines in the Italian"
    );
    expect(eventSentence(ev(2, "Sam", "2026-10-19T10:00:00Z", { kind: "lines", payload: { course: "italian-game/main@white", count: 1 } }), name)).toBe(
      "Sam trained 1 new line in the Italian"
    );
    expect(eventSentence(ev(3, "Sam", "2026-10-19T10:00:00Z", { kind: "streak", payload: { days: 14 } }), name)).toBe("Sam reached a 14-day streak");
    expect(
      eventSentence(ev(4, "Sam", "2026-10-19T10:00:00Z", { kind: "rating", payload: { platform: "lichess", time_class: "blitz", from: 1800, to: 1840 } }), name)
    ).toBe("Sam's Lichess blitz rating is up 40 this week (now 1840)");
    expect(
      eventSentence(ev(5, "Sam", "2026-10-19T10:00:00Z", { kind: "rating", payload: { platform: "chesscom", time_class: "rapid", from: 1500, to: 1475 } }), name)
    ).toBe("Sam's Chess.com rapid rating is down 25 this week (now 1475)");
  });

  it("groups consecutive items by player and UTC day, newest first", () => {
    const events: FeedEvent[] = [
      ev(1, "sam", "2026-10-19T09:00:00Z", { kind: "streak", payload: { days: 7 } }),
      ev(2, "sam", "2026-10-19T10:00:00Z", { kind: "lines", payload: { course: "a/b@white", count: 5 } }),
      ev(3, "ana", "2026-10-19T11:00:00Z", { kind: "course", payload: { course: "a/b@white" } }),
      ev(4, "sam", "2026-10-18T23:59:00Z", { kind: "lines", payload: { course: "a/b@white", count: 2 } }),
    ];
    const g = groupFeed(events);
    expect(g.map((x) => [x.username, x.day, x.items.map((i) => i.id)])).toEqual([
      ["ana", "2026-10-19", [3]],
      ["sam", "2026-10-19", [2, 1]],
      ["sam", "2026-10-18", [4]],
    ]);
  });

  it("drops small rating moves and duplicate ids", () => {
    const events: FeedEvent[] = [
      ev(1, "sam", "2026-10-19T09:00:00Z", { kind: "rating", payload: { platform: "lichess", time_class: "blitz", from: 1800, to: 1815 } }),
      ev(2, "sam", "2026-10-19T09:30:00Z", { kind: "streak", payload: { days: 30 } }),
      ev(2, "sam", "2026-10-19T09:30:00Z", { kind: "streak", payload: { days: 30 } }),
    ];
    expect(groupFeed(events).flatMap((x) => x.items.map((i) => i.id))).toEqual([2]);
  });
});

const row = (course_id: string, seen: number, correct: number, mastery: number, updated_at = "2026-10-19T00:00:00Z"): LearningRow => ({
  course_id,
  seen,
  correct,
  mastery,
  updated_at,
});

describe("compare", () => {
  it("keeps courses both learn, most recent first", () => {
    const me = [row("a/x@white", 10, 8, 0.5, "2026-10-10T00:00:00Z"), row("b/y@black", 4, 1, 0.1), row("c/z@white", 0, 0, 0)];
    const them = [row("b/y@black", 20, 15, 0.75, "2026-10-01T00:00:00Z"), row("a/x@white", 0, 0, 0, "2026-10-18T00:00:00Z")];
    expect(compareCourses(me, them)).toEqual([
      { course_id: "b/y@black", me: { mastery: 10, accuracy: 25, seen: 4 }, them: { mastery: 75, accuracy: 75, seen: 20 } },
      { course_id: "a/x@white", me: { mastery: 50, accuracy: 80, seen: 10 }, them: { mastery: 0, accuracy: null, seen: 0 } },
    ]);
  });

  it("compares nothing in a hidden section", () => {
    expect(compareCourses([row("a/x@white", 1, 1, 1)], null)).toEqual([]);
    expect(compareRatings([], null)).toEqual([]);
  });

  it("pairs ratings on the same platform and time class", () => {
    const me: LinkedInfo[] = [
      { platform: "lichess", username: "me1", verified: false, last_synced_at: null, ratings: { blitz: { rating: 1900, games: 10, provisional: false }, rapid: { rating: 2000, games: 2, provisional: false } } },
      { platform: "chesscom", username: "me2", verified: false, last_synced_at: null, ratings: { blitz: { rating: 1500, games: 1, provisional: false } } },
    ];
    const them: LinkedInfo[] = [
      { platform: "lichess", username: "t1", verified: false, last_synced_at: null, ratings: { blitz: { rating: 1850, games: 3, provisional: false }, bullet: { rating: 1700, games: 9, provisional: false } } },
    ];
    expect(compareRatings(me, them)).toEqual([{ platform: "lichess", time_class: "blitz", me: 1900, them: 1850, diff: 50 }]);
  });

  it("accuracy and the primary rating", () => {
    expect(accuracy(0, 0)).toBeNull();
    expect(accuracy(2, 3)).toBe(67);
    expect(primaryRating({ blitz: { rating: 1800, games: 5, provisional: false }, rapid: { rating: 1900, games: 50, provisional: false } })).toEqual({
      timeClass: "rapid",
      rating: 1900,
    });
    expect(primaryRating({})).toBeNull();
  });
});

const target = (platform: "lichess" | "chesscom", their: string): ChallengeTarget => ({
  platform,
  my_username: "me",
  my_ratings: {},
  their_username: their,
  their_ratings: {},
});

describe("challenge", () => {
  it("builds the verified links, encoded", () => {
    expect(challengeUrl("lichess", "Sam_99")).toBe("https://lichess.org/?user=Sam_99#friend");
    expect(challengeUrl("chesscom", "hikaru")).toBe("https://www.chess.com/play/hikaru");
    expect(challengeUrl("chesscom", "a/b?c#d")).toBe("https://www.chess.com/play/a%2Fb%3Fc%23d");
    expect(platformProfileUrl("lichess", "x y")).toBe("https://lichess.org/@/x%20y");
    expect(platformProfileUrl("chesscom", "hikaru")).toBe("https://www.chess.com/member/hikaru");
  });

  it("none hides the button, one goes straight there, two asks", () => {
    expect(challengePlan([])).toEqual({ kind: "none" });
    expect(challengePlan(null)).toEqual({ kind: "none" });
    const one = challengePlan([target("lichess", "sam")]);
    expect(one).toMatchObject({ kind: "direct", href: "https://lichess.org/?user=sam#friend", label: "Challenge on Lichess" });
    expect(challengePlan([target("chesscom", "s1"), target("lichess", "s2")])).toMatchObject({ kind: "choose" });
  });
});

describe("course names", () => {
  const raw = JSON.parse(readFileSync(join(__dirname, "../../../../public/data/openings.v2.json"), "utf8")) as RawDatasetV2;
  const ds = parseDatasetV2(raw, "test-hash");

  it("names a real course from the dataset and links to the catalog", () => {
    const cat = catalogOf(ds)!;
    const sys = cat.systems[0];
    const id = `${cat.hubs[sys.hub].slug}/${sys.slug}@${sys.side}`;
    expect(courseName(ds, id)).toContain(cat.hubs[sys.hub].title);
    expect(courseLink(id)).toBe(`/openings/${cat.hubs[sys.hub].slug}/${sys.slug}/${sys.side}`);
  });

  it("falls back to the slugs without a dataset", () => {
    expect(courseName(null, "italian-game/two-knights@black")).toBe("Italian Game: Two Knights");
    expect(courseName(null, "not a course")).toBe("not a course");
    expect(courseLink("bad")).toBeNull();
  });
});
