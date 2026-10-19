/** Platform parsers and the import scope, on real captured responses. */
import { describe, expect, it } from "vitest";
import { Chess } from "chess.js";
import { DEFAULT_SCOPE, applyWindow, inScope } from "../filter";
import { sansFromPgn } from "../pgn";
import { chesscomGameId, chesscomRatings, monthsToFetch, parseChesscomGame } from "../sources/chesscom";
import { lichessProfile, parseLichessGame, splitNdjson } from "../sources/lichess";
import { isSkip, type NormalGame } from "../types";
import { CHESSCOM_USER, LICHESS_USER, chesscomGames, fixture, lichessGames } from "./helpers";

describe("Lichess", () => {
  const games = lichessGames().map((g) => parseLichessGame(g, LICHESS_USER));

  it("parses every fixture game as the player's own, colour and result from the players", () => {
    expect(games).toHaveLength(15);
    for (const [i, g] of games.entries()) {
      expect(isSkip(g)).toBe(false);
      const src = lichessGames()[i];
      const n = g as NormalGame;
      expect(n.color).toBe(src.players!.white!.user!.id === LICHESS_USER.toLowerCase() ? "white" : "black");
      expect(n.result).toBe(!src.winner ? "draw" : src.winner === n.color ? "win" : "loss");
      expect(n.sans.length).toBe(src.moves!.split(" ").length);
      expect(n.timeClass).toBe("blitz");
      expect(n.standard && n.rated).toBe(true);
    }
    const draws = games.filter((g) => !isSkip(g) && g.result === "draw");
    expect(draws).toHaveLength(1);
  });

  it("keeps the server analysis per ply, White's side, mates as mates", () => {
    const g = games[0] as NormalGame;
    expect(g.evals).not.toBeNull();
    expect(g.evals!.length).toBe(g.sans.length);
    const src = lichessGames()[0].analysis!;
    expect(g.evals![0]).toEqual("mate" in src[0]! ? { mate: src[0]!.mate } : { cp: src[0]!.eval });
  });

  it("is case-insensitive about the username and skips games the player isn't in", () => {
    expect(isSkip(parseLichessGame(lichessGames()[0], LICHESS_USER.toUpperCase()))).toBe(false);
    expect(parseLichessGame(lichessGames()[0], "someone_else")).toEqual({ skip: "not-player" });
  });

  it("profile: ratings for the four time classes with games; 404 body → null", () => {
    const p = lichessProfile(JSON.parse(fixture("lichess-user.json")))!;
    expect(p.username).toBe(LICHESS_USER);
    expect(p.ratings.blitz!.rating).toBeGreaterThan(2000);
    expect(lichessProfile(JSON.parse(fixture("lichess-user-404.json")))).toBeNull();
  });

  it("ndjson: lines split across chunks are reassembled", () => {
    const text = fixture("lichess-games.ndjson");
    let rest = "";
    const lines: string[] = [];
    for (let i = 0; i < text.length; i += 997) {
      const r = splitNdjson(rest, text.slice(i, i + 997));
      lines.push(...r.lines);
      rest = r.rest;
    }
    if (rest.trim()) lines.push(rest.trim());
    expect(lines).toHaveLength(15);
    expect(JSON.parse(lines[14]).id).toBe(lichessGames()[14].id);
  });
});

describe("Chess.com", () => {
  const src = chesscomGames();
  const games = src.map((g) => parseChesscomGame(g, CHESSCOM_USER));

  it("parses game ids, colours, results and the PGN ECO tag", () => {
    expect(chesscomGameId("https://www.chess.com/game/live/183193101523")).toBe("live/183193101523");
    expect(chesscomGameId("https://www.chess.com/game/daily/84604826")).toBe("daily/84604826");
    const g = games[0] as NormalGame;
    expect(g.gameId).toMatch(/^(live|daily)\/\d+$/);
    for (const [i, x] of games.entries()) {
      if (isSkip(x)) throw new Error(`game ${i} skipped: ${x.skip}`);
      const me = src[i].white!.username!.toLowerCase() === CHESSCOM_USER ? src[i].white! : src[i].black!;
      const opp = me === src[i].white ? src[i].black! : src[i].white!;
      expect(x.result).toBe(me.result === "win" ? "win" : opp.result === "win" ? "loss" : "draw");
      expect(x.eco === null || /^[A-E]\d\d$/.test(x.eco)).toBe(true);
    }
    expect(games.filter((x) => !isSkip(x) && x.result === "draw")).toHaveLength(2);
  });

  it("movetext tokens replay to the same moves as chess.js's PGN parser", () => {
    for (const g of src.filter((x) => x.rules === "chess").slice(0, 8)) {
      const c = new Chess();
      c.loadPgn(g.pgn!);
      expect(sansFromPgn(g.pgn!)).toEqual(c.history());
    }
  });

  it("scope: 960, daily, bullet (by default) and unrated games are skipped, with reasons", () => {
    const reasons = games.map((g) => (isSkip(g) ? g.skip : inScope(g, DEFAULT_SCOPE)?.skip ?? "ok"));
    const count = (r: string) => reasons.filter((x) => x === r).length;
    expect(count("variant")).toBe(1); // chess960 (daily)
    expect(count("unrated")).toBe(1); // the unrated rapid
    expect(count("time-class")).toBe(3); // 2 bullet + 1 daily
    expect(count("ok")).toBe(12);
    const withBullet = { ...DEFAULT_SCOPE, timeClasses: [...DEFAULT_SCOPE.timeClasses, "bullet" as const] };
    expect(games.filter((g) => !isSkip(g) && !inScope(g, withBullet))).toHaveLength(14);
  });

  it("window: newest first, after the window start, at most maxGames", () => {
    const ok = games.filter((g): g is NormalGame => !isSkip(g));
    const now = new Date("2026-10-19T12:00:00Z");
    const w = applyWindow(ok, { ...DEFAULT_SCOPE, maxGames: 5 }, null, now);
    expect(w).toHaveLength(5);
    expect(w.map((g) => g.playedAt)).toEqual([...w.map((g) => g.playedAt)].sort().reverse());
    // since cursor: only games after it
    const since = new Date(w[2].playedAt);
    expect(applyWindow(ok, DEFAULT_SCOPE, since, now).every((g) => Date.parse(g.playedAt) > since.getTime())).toBe(true);
  });

  it("ratings from /stats; daily is ignored", () => {
    const r = chesscomRatings(JSON.parse(fixture("chesscom-stats.json")));
    expect(Object.keys(r).sort()).toEqual(["blitz", "bullet", "rapid"]);
    expect(r.blitz!.rating).toBeGreaterThan(3000);
    expect(r.blitz!.games).toBeGreaterThan(0);
  });

  it("monthsToFetch: the window's months, newest first; a later cursor narrows it", () => {
    const archives: string[] = JSON.parse(fixture("chesscom-archives.json")).archives;
    const now = new Date("2026-10-19T12:00:00Z");
    expect(monthsToFetch(archives, null, now, 3).map((u) => u.slice(-7))).toEqual(["2026/10", "2026/09", "2026/08"]);
    expect(monthsToFetch(archives, new Date("2026-09-20T00:00:00Z"), now, 3).map((u) => u.slice(-7))).toEqual(["2026/10", "2026/09"]);
    expect(monthsToFetch([], null, now, 3)).toEqual([]);
  });
});
