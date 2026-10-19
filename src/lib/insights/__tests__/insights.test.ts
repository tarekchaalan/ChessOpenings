/** Aggregation, deep links, rating bands and recommendation scoring. */
import { describe, expect, it } from "vitest";
import { catalogOf, modelOf } from "@/lib/courses-client";
import { analyse, byOpening, repeatDeviations, summary, type Analysed } from "../aggregate";
import { bandOf, playerBand } from "../bands";
import { CATALOG_LINK, trainLink } from "../links";
import { fillRecs, fixRecs, growRecs, recommend, styleProfile } from "../recommend";
import { DEFAULT_SCOPE, inScope } from "../filter";
import { parseChesscomGame } from "../sources/chesscom";
import { parseLichessGame } from "../sources/lichess";
import { summarize } from "../summarize";
import { isSkip, type NormalGame, type Result, type Side, type Summary } from "../types";
import { BAND_LEVELS, MIN_GAMES } from "../weights";
import { CHESSCOM_USER, LICHESS_USER, chesscomGames, ds, lichessGames } from "./helpers";

const model = modelOf(ds);

const fixtureSummaries = (): Summary[] => {
  const li = lichessGames().map((g) => parseLichessGame(g, LICHESS_USER));
  const cc = chesscomGames().map((g) => parseChesscomGame(g, CHESSCOM_USER));
  return [...li, ...cc]
    .filter((g): g is NormalGame => !isSkip(g) && !inScope(g, DEFAULT_SCOPE))
    .map((g) => summarize(model, g, "h"))
    .filter((s): s is Summary => !!s);
};

let seq = 0;
/** a synthetic game summary from moves (through the real matcher) */
const mk = (sans: string[], color: Side, result: Result = "win", extra: Partial<NormalGame> = {}): Summary =>
  summarize(
    model,
    {
      platform: "lichess",
      gameId: `t${seq++}`,
      color,
      timeClass: "blitz",
      rated: true,
      standard: true,
      playedAt: new Date(Date.UTC(2026, 9, 1, 0, seq)).toISOString(),
      result,
      myRating: 1500,
      oppRating: 1500,
      eco: null,
      openingName: null,
      sans,
      evals: null,
      ...extra,
    },
    "h"
  )!;
const times = <T,>(k: number, f: (i: number) => T) => Array.from({ length: k }, (_, i) => f(i));

describe("analyse + byOpening on the fixtures", () => {
  const games = analyse(ds, fixtureSummaries());

  it("names every game with the dataset's family and keeps its book path", () => {
    expect(games).toHaveLength(15 + 12);
    for (const g of games) {
      expect(g.path).toHaveLength(g.bookPly + 1);
      expect(g.family.length).toBeGreaterThan(0);
    }
  });

  it("rows add up to the games, W+D+L per row, score in [0, 1]", () => {
    const rows = byOpening(ds, games);
    expect(rows.reduce((a, r) => a + r.games, 0)).toBe(games.length);
    for (const r of rows) {
      expect(r.w + r.d + r.l).toBe(r.games);
      expect(r.byMe.games + r.byOpp.games + r.inBook).toBe(r.games);
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(1);
      expect(r.enough).toBe(r.games >= MIN_GAMES);
    }
    // most played first
    expect(rows.map((r) => r.games)).toEqual([...rows.map((r) => r.games)].sort((a, b) => b - a));
  });

  it("every finding links somewhere trainable; report how many needed the fallback", () => {
    const links = games.map((g) => trainLink(ds, g.path, g.color));
    for (const l of links) {
      expect(l.train).toMatch(/^\/(train\/[^/]+\/[^/]+\/(white|black)\?mode=learn&li=\d+|openings)/);
      expect(l.course).toMatch(/^\/openings/);
    }
    const exact = links.filter((l) => l.exact).length;
    const catalog = links.filter((l) => l === CATALOG_LINK).length;
    // recorded in the Phase 1 report: exact at the exit position / an earlier position / catalog only
    console.info(`[insights] deep links on fixtures: ${exact} exact, ${links.length - exact - catalog} earlier position, ${catalog} catalog`);
    expect(catalog).toBe(0);
  });

  it("a link opens Learn at the position on the course line", () => {
    const g = games.find((x) => x.bookPly >= 4)!;
    const l = trainLink(ds, g.path, g.color);
    expect(l.train).toMatch(/&start=\d+$/);
  });

  it("summary counts per platform and time class, date range ordered", () => {
    const s = summary(games);
    expect(s.games).toBe(games.length);
    expect(s.perPlatform.lichess!.blitz).toBe(15);
    expect(s.from! <= s.to!).toBe(true);
    expect(s.byColor.white.games + s.byColor.black.games).toBe(games.length);
  });
});

describe("repeatDeviations", () => {
  it("groups my own repeated non-book moves at one position, at least twice", () => {
    const games = analyse(ds, [
      mk(["e4", "e5", "Nf3", "h6", "Nc3"], "black", "loss"),
      mk(["e4", "e5", "Nf3", "h6", "d4"], "black", "draw"),
      mk(["e4", "e5", "Nf3", "h6"], "black", "win"),
      mk(["e4", "e5", "Nf3", "a6"], "black", "loss"), // once only
      mk(["e4", "e5", "Nf3", "h6"], "white", "win"), // the opponent's move
    ]);
    const groups = repeatDeviations(ds, games);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ playedSan: "h6", games: 3, w: 1, d: 1, l: 1, score: 0.5, color: "black" });
    expect(groups[0].plies).toEqual(["e4", "e5", "Nf3"]);
    expect(groups[0].bookSans[0]).toBe("Nc6");
    expect(groups[0].link.train).toMatch(/^\/train\//);
    expect([groups[0].evalBefore, groups[0].evalAfter]).toEqual([null, null]);
  });
});

describe("bands", () => {
  it("bands each platform on its own scale", () => {
    expect([1000, 1300, 1599, 1600, 1900, 2200, 2900].map((r) => bandOf("lichess", r))).toEqual([1, 2, 2, 3, 4, 5, 5]);
    expect([500, 800, 1199, 1200, 1600, 2000].map((r) => bandOf("chesscom", r))).toEqual([1, 2, 2, 3, 4, 5]);
    // 1500 means different things on each platform
    expect(bandOf("lichess", 1500)).not.toBe(bandOf("chesscom", 1500));
  });

  it("uses the platform/time class with the most games; provisional is one band lower", () => {
    const games = [...times(3, () => mk(["e4"], "white")), mk(["d4"], "white", "win", { platform: "chesscom", timeClass: "rapid" })];
    const b = playerBand(games, { lichess: { blitz: { rating: 1700, games: 50, provisional: false } }, chesscom: { rapid: { rating: 1700, games: 5, provisional: false } } })!;
    expect(b).toMatchObject({ platform: "lichess", timeClass: "blitz", band: 3, name: "Club" });
    const p = playerBand(games, { lichess: { blitz: { rating: 1700, games: 3, provisional: true } } })!;
    expect(p.band).toBe(2);
    expect(playerBand(games, {})).toBeNull();
  });
});

describe("recommendations", () => {
  it("Fix: leaving book early in most games of an opening", () => {
    // as Black after 1.e4 e5 2.Nf3, 6 games of 2...h6 (deviation at ply 4 < EARLY_PLY)
    const games = analyse(ds, times(6, (i) => mk(["e4", "e5", "Nf3", "h6"], "black", i < 3 ? "loss" : "win")));
    const recs = fixRecs(byOpening(ds, games));
    expect(recs).toHaveLength(1);
    expect(recs[0].reason).toBe("You leave the King's Knight Opening by move 5 in 100% of games as Black (6 of 6).");
    expect(recs[0].link.train).toMatch(/^\/train\//);
  });

  it("Fix: a low score without early exits; nothing below MIN_GAMES", () => {
    const deep = ["e4", "c5", "Nf3", "d6", "d4", "cxd4", "Nxd4", "Nf6", "Nc3", "a6"];
    const games = analyse(ds, times(MIN_GAMES, () => mk(deep, "white", "loss")));
    const recs = fixRecs(byOpening(ds, games));
    expect(recs[0].reason).toMatch(/^You score 0% with the Sicilian Defense as White \(0 won, 0 drawn, 5 lost\)\.$/);
    expect(fixRecs(byOpening(ds, games.slice(0, MIN_GAMES - 1)))).toEqual([]);
  });

  it("Fill: no consistent answer to 1.d4 as Black", () => {
    const replies = ["Nf6", "d5", "e6", "f5", "g6", "c5", "d6", "Nf6", "d5", "e6", "b6"];
    const games = analyse(ds, replies.map((r) => mk(["d4", r], "black")));
    const recs = fillRecs(ds, games, null);
    expect(recs).toHaveLength(1);
    expect(recs[0].reason).toBe("No consistent answer to 1.d4 as Black: 11 games, 8 different replies.");
    const hub = catalogOf(ds)!.hubs.find((h) => h.slug === recs[0].hub)!;
    expect(hub).toMatchObject({ side: "black", against: "d4", placement: "top" });
    // a consistent repertoire isn't flagged
    expect(fillRecs(ds, analyse(ds, times(12, () => mk(["d4", "d5"], "black"))), null)).toEqual([]);
  });

  it("Grow: common hubs at the band's levels, not already played, ranked by style", () => {
    // a White player who always plays the Italian (tagged solid)
    const italian = ["e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5"];
    const games = analyse(ds, times(MIN_GAMES + 1, () => mk(italian, "white")));
    const style = styleProfile(ds, games, "white");
    expect(style.known).toBe(true);
    expect(style.shares.solid).toBe(1);
    const band = playerBand(games, { lichess: { blitz: { rating: 1700, games: 100, provisional: false } } })!;
    const recs = growRecs(ds, games, band).filter((r) => r.color === "white");
    expect(recs.length).toBeGreaterThan(0);
    const hubs = catalogOf(ds)!.hubs;
    for (const r of recs) {
      const h = hubs.find((x) => x.slug === r.hub)!;
      expect(BAND_LEVELS[band.band]).toContain(h.level);
      expect(h.slug).not.toBe("italian-game");
      expect(r.reason).toMatch(/^Common at your level \(Lichess blitz 1700\)/);
    }
    // the top pick shares the player's style and says so
    expect(recs[0].reason).toMatch(/close to how you play: 100% of your games as White are in solid openings\.$/);
  });

  it("Grow without enough games: no style claim", () => {
    const games = analyse(ds, [mk(["e4", "e5"], "white")]);
    for (const r of growRecs(ds, games, null)) expect(r.reason).not.toMatch(/how you play/);
  });

  it("recommend: at most 4 per kind, no course twice, deterministic", () => {
    const games: Analysed[] = analyse(ds, fixtureSummaries());
    const rows = byOpening(ds, games);
    const a = recommend(ds, games, rows, null);
    expect(recommend(ds, games, rows, null)).toEqual(a);
    expect(new Set(a.map((r) => r.link.course)).size).toBe(a.length);
    for (const k of ["fix", "fill", "grow"] as const) expect(a.filter((r) => r.kind === k).length).toBeLessThanOrEqual(4);
  });
});
