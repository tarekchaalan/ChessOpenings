/** ADR 0006 write path (route logic) against an in-memory InsightsDb. */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDatasetV2 } from "@/lib/openings";
import type { RawDatasetV2 } from "@/lib/openings-build/dataset";
import { modelOf } from "@/lib/courses-client";
import { summarize } from "@/lib/insights/summarize";
import { parseLichessGame } from "@/lib/insights/sources/lichess";
import type { NormalGame, Platform, Summary } from "@/lib/insights/types";
import { checkSummary, fromRow, KEEP_GAMES, link, SYNC_CALLS_PER_HOUR, sync, toRow, unlink, type AccountRow, type GameRow, type InsightsDb } from "../insights";

const ds = parseDatasetV2(JSON.parse(readFileSync(join(__dirname, "../../../../public/data/openings.v2.json"), "utf8")) as RawDatasetV2, "t");
const model = modelOf(ds);
const fixtures = join(__dirname, "../../insights/__tests__/fixtures");
const lichess = readFileSync(join(fixtures, "lichess-games.ndjson"), "utf8")
  .trim()
  .split("\n")
  .map((l) => summarize(model, parseLichessGame(JSON.parse(l), "Zhigalko_Sergei") as NormalGame, "h")!);
const U = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-10-19T12:00:00Z");
const RATINGS = { blitz: { rating: 2800, games: 100, provisional: false } };

function fakeDb() {
  const accounts = new Map<string, AccountRow>();
  const games = new Map<string, GameRow>();
  const k = (u: string, p: Platform) => `${u}|${p}`;
  /** the database's now() */
  const clock = { t: NOW.getTime() };
  const db: InsightsDb = {
    async getAccount(u, p) {
      return accounts.get(k(u, p)) ?? null;
    },
    async putAccount(row, replace) {
      if (replace) await db.deleteAccount(row.user_id, row.platform);
      accounts.set(k(row.user_id, row.platform), { ...row });
    },
    async updateAccount(u, p, username, patch) {
      const a = accounts.get(k(u, p));
      if (a && a.username === username) accounts.set(k(u, p), { ...a, ...patch });
    },
    // insights_claim_sync (0007), same rules
    async claimSync(u, p, username, limit) {
      const a = accounts.get(k(u, p));
      if (!a || a.username.toLowerCase() !== username.toLowerCase()) return -1;
      const start = a.sync_window_start ? Date.parse(a.sync_window_start) : null;
      const expired = start === null || start <= clock.t - 3_600_000;
      if (!expired && a.sync_calls >= limit) return Math.max(1, Math.ceil((start! + 3_600_000 - clock.t) / 1000));
      accounts.set(k(u, p), { ...a, sync_window_start: expired ? new Date(clock.t).toISOString() : a.sync_window_start, sync_calls: expired ? 1 : a.sync_calls + 1 });
      return 0;
    },
    async deleteAccount(u, p) {
      accounts.delete(k(u, p));
      for (const [id, g] of games) if (g.user_id === u && g.platform === p) games.delete(id); // FK cascade
    },
    async upsertGames(rows) {
      for (const r of rows) games.set(`${r.user_id}|${r.platform}|${r.game_id}`, r);
    },
    async pruneGames(u, p, keep) {
      const mine = [...games.entries()].filter(([, g]) => g.user_id === u && g.platform === p).sort((a, b) => b[1].played_at.localeCompare(a[1].played_at));
      for (const [id] of mine.slice(keep)) games.delete(id);
      return Math.max(0, mine.length - keep);
    },
  };
  return { db, accounts, games, clock };
}

describe("checkSummary", () => {
  it("accepts every summary the client library produces from the fixtures", () => {
    for (const s of lichess) expect(checkSummary("lichess", s, NOW)).toBeNull();
  });

  it("rejects shapes the SQL checks would reject, and forged deviations", () => {
    const s = lichess.find((x) => x.deviatedBy !== "none")!;
    const cases: [Partial<Summary> | Record<string, unknown>, string][] = [
      [{ platform: "chesscom" }, "platform"],
      [{ gameId: "x/../y" }, "gameId"],
      [{ timeClass: "correspondence" }, "timeClass"],
      [{ playedAt: "2030-01-01T00:00:00Z" }, "playedAt"],
      [{ openingPlies: Array(39).fill("e4") }, "openingPlies"],
      [{ bookPly: s.openingPlies.length + 1 }, "bookPly"],
      [{ deviationEpd: null }, "deviation fields"],
      [{ evalBefore: 5, evalAfter: null }, "evals"],
      [{ playedSan: "Qh5" }, "playedSan"],
      [{ deviationEpd: "8/8/8/8/8/8/8/8 w - -" }, "deviationEpd"],
      [{ deviatedBy: s.deviatedBy === "me" ? "opponent" : "me" }, "deviatedBy"],
      [{ openingPlies: ["e4", "e4", ...s.openingPlies.slice(2)] }, "openingPlies (illegal)"],
      [{ openingPlies: ["e2e4", ...s.openingPlies.slice(1)] }, "openingPlies"],
      [{ playedAt: "-271821-04-20T00:00:00.000Z" }, "playedAt"],
      [{ playedAt: "Tue Mar 05 2024 10:00:00 GMT+0000" }, "playedAt"],
      [{ playedAt: "1999-12-31T00:00:00.000Z" }, "playedAt"],
      [{ openingName: "Sicilian\u0000" }, "openingName"],
      [{ openingName: "Sicilian \ud800" }, "openingName"],
    ];
    for (const [patch, why] of cases) expect(checkSummary("lichess", { ...s, ...patch }, NOW), why).toMatch(new RegExp(`^${why.replace(/[()]/g, "\\$&")}`));
  });

  it("a deviation right after the stored plies: playedSan must be legal, normalised SAN", () => {
    const s = lichess.find((x) => x.deviatedBy !== "none" && x.bookPly >= 2)!;
    const cut = { ...s, openingPlies: s.openingPlies.slice(0, s.bookPly) };
    expect(checkSummary("lichess", cut, NOW)).toBeNull();
    expect(checkSummary("lichess", { ...cut, playedSan: `${s.playedSan}??????` }, NOW)).toMatch(/^playedSan/);
    expect(checkSummary("lichess", { ...cut, playedSan: "Qh9" }, NOW)).toMatch(/^playedSan/);
  });

  it("rows round-trip", () => {
    for (const s of lichess) expect(fromRow(toRow(U, s))).toEqual(s);
  });
});

describe("link / sync / unlink", () => {
  it("sync needs a linked account; link then sync stores the games and moves the cursor", async () => {
    const { db, accounts, games } = fakeDb();
    expect((await sync(db, U, { platform: "lichess", username: "Zhigalko_Sergei", games: lichess }, NOW)).status).toBe(409);
    expect((await link(db, U, { platform: "lichess", username: "Zhigalko_Sergei", ratings: RATINGS })).status).toBe(200);
    const r = await sync(db, U, { platform: "lichess", username: "Zhigalko_Sergei", ratings: RATINGS, games: lichess }, NOW);
    expect(r.status).toBe(200);
    expect(games.size).toBe(15);
    const a = accounts.get(`${U}|lichess`)!;
    expect(a.last_synced_at).toBe(NOW.toISOString());
    expect(a.last_game_at).toBe([...lichess.map((g) => g.playedAt)].sort().pop());
  });

  it("re-sync never duplicates (same ids upsert in place)", async () => {
    const { db, games } = fakeDb();
    await link(db, U, { platform: "lichess", username: "Zhigalko_Sergei", ratings: RATINGS });
    await sync(db, U, { platform: "lichess", username: "Zhigalko_Sergei", games: lichess }, NOW);
    await sync(db, U, { platform: "lichess", username: "Zhigalko_Sergei", games: lichess.slice(0, 5) }, NOW);
    expect(games.size).toBe(15);
    expect((await sync(db, U, { platform: "lichess", username: "Zhigalko_Sergei", games: [lichess[0], lichess[0]] }, NOW)).status).toBe(400);
  });

  it("linking a different username replaces the old account's games; the same name keeps them", async () => {
    const { db, games } = fakeDb();
    await link(db, U, { platform: "lichess", username: "Zhigalko_Sergei", ratings: RATINGS });
    await sync(db, U, { platform: "lichess", username: "Zhigalko_Sergei", games: lichess }, NOW);
    expect((await link(db, U, { platform: "lichess", username: "zhigalko_sergei", ratings: {} })).body.replaced).toBe(false);
    expect(games.size).toBe(15);
    expect((await link(db, U, { platform: "lichess", username: "someone_else", ratings: {} })).body.replaced).toBe(true);
    expect(games.size).toBe(0);
  });

  it("unlink deletes that platform's games only", async () => {
    const { db, games, accounts } = fakeDb();
    await link(db, U, { platform: "lichess", username: "Zhigalko_Sergei", ratings: RATINGS });
    await link(db, U, { platform: "chesscom", username: "hikaru", ratings: {} });
    await sync(db, U, { platform: "lichess", username: "Zhigalko_Sergei", games: lichess }, NOW);
    expect((await unlink(db, U, { platform: "lichess" })).status).toBe(200);
    expect(games.size).toBe(0);
    expect(accounts.has(`${U}|chesscom`)).toBe(true);
  });

  it("rate limit: 30 syncs per platform per hour, then 429 with retryAfter; a new hour resets it", async () => {
    const { db, clock } = fakeDb();
    await link(db, U, { platform: "lichess", username: "Zhigalko_Sergei", ratings: RATINGS });
    for (let i = 0; i < SYNC_CALLS_PER_HOUR; i++) {
      clock.t = NOW.getTime() + i * 1000;
      expect((await sync(db, U, { platform: "lichess", username: "Zhigalko_Sergei", games: [] }, new Date(clock.t))).status).toBe(200);
    }
    clock.t = NOW.getTime() + 60_000;
    const r = await sync(db, U, { platform: "lichess", username: "Zhigalko_Sergei", games: [] }, new Date(clock.t));
    expect(r.status).toBe(429);
    expect(r.body.retryAfter).toBe(3540);
    // a throttled call is refused before any validation work
    expect((await sync(db, U, { platform: "lichess", username: "Zhigalko_Sergei", games: [{ junk: true }] }, new Date(clock.t))).status).toBe(429);
    // re-linking the same name keeps the window
    await link(db, U, { platform: "lichess", username: "zhigalko_sergei", ratings: RATINGS });
    expect((await sync(db, U, { platform: "lichess", username: "Zhigalko_Sergei", games: [] }, new Date(clock.t))).status).toBe(429);
    clock.t = NOW.getTime() + 3_601_000;
    expect((await sync(db, U, { platform: "lichess", username: "Zhigalko_Sergei", games: [] }, new Date(clock.t))).status).toBe(200);
  });

  it("a sync for a username that is no longer linked is refused (re-link mid-sync), and writes nothing", async () => {
    const { db, games, accounts } = fakeDb();
    await link(db, U, { platform: "lichess", username: "Zhigalko_Sergei", ratings: RATINGS });
    await link(db, U, { platform: "lichess", username: "someone_else", ratings: {} });
    const r = await sync(db, U, { platform: "lichess", username: "Zhigalko_Sergei", games: lichess }, NOW);
    expect(r.status).toBe(409);
    expect(games.size).toBe(0);
    expect(accounts.get(`${U}|lichess`)!.last_game_at).toBeNull();
  });

  it("rematch uploads keep last_synced_at (the stale check still imports)", async () => {
    const { db, accounts } = fakeDb();
    await link(db, U, { platform: "lichess", username: "Zhigalko_Sergei", ratings: RATINGS });
    await sync(db, U, { platform: "lichess", username: "Zhigalko_Sergei", games: lichess.slice(0, 2) }, NOW);
    const later = new Date(NOW.getTime() + 86_400_000);
    await sync(db, U, { platform: "lichess", username: "Zhigalko_Sergei", rematch: true, games: lichess.slice(0, 2) }, later);
    expect(accounts.get(`${U}|lichess`)!.last_synced_at).toBe(NOW.toISOString());
  });

  it("keeps the newest KEEP_GAMES per platform", async () => {
    const { db, games } = fakeDb();
    await link(db, U, { platform: "lichess", username: "Zhigalko_Sergei", ratings: RATINGS });
    const base = lichess[0];
    let t = Date.parse("2026-01-01T00:00:00Z");
    for (let batch = 0; batch < 6; batch++) {
      const rows = Array.from({ length: 200 }, (_, i) => ({ ...base, gameId: `g${String(batch * 200 + i).padStart(7, "0")}`, playedAt: new Date((t += 60_000)).toISOString() }));
      expect((await sync(db, U, { platform: "lichess", username: "Zhigalko_Sergei", games: rows }, new Date(t + 1000 + batch * 3_600_000))).status).toBe(200);
    }
    expect(games.size).toBe(KEEP_GAMES);
    expect([...games.values()].some((g) => g.game_id === "g0000000")).toBe(false);
  });

  it("bad input: platform, username, ratings, oversized batches", async () => {
    const { db } = fakeDb();
    expect((await link(db, U, { platform: "fics", username: "x1", ratings: {} })).status).toBe(400);
    expect((await link(db, U, { platform: "lichess", username: "bad name", ratings: {} })).status).toBe(400);
    expect((await link(db, U, { platform: "lichess", username: "ok_name", ratings: { blitz: { rating: "x" } } })).status).toBe(400);
    await link(db, U, { platform: "lichess", username: "ok_name", ratings: {} });
    expect((await sync(db, U, { platform: "lichess", username: "Zhigalko_Sergei", games: Array(201).fill(lichess[0]) }, NOW)).status).toBe(400);
    expect((await unlink(db, U, null)).status).toBe(400);
  });
});
