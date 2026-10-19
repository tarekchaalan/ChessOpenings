/**
 * Server side of Account Insights (ADR 0006 § Write path): validation and the
 * three actions behind POST /api/insights/{link,sync,unlink}. Pure apart from
 * the injected `InsightsDb`, so it is unit-tested without Supabase.
 *
 * The server never sees games, only summaries. It checks every field against
 * the same rules as the SQL checks and replays the stored plies with chess.js,
 * so the deviation fields agree with the moves. It does not re-run book
 * matching (`dataset_hash` records which dataset did); a forged summary only
 * ever misleads the player who sent it.
 */
import { Chess } from "chess.js";
import { epdOf } from "@/lib/openings-build/replay";
import { normSan } from "@/lib/openings-build/model";
import { PLATFORMS, TIME_CLASSES, type Platform, type Ratings, type Summary, type TimeClass } from "@/lib/insights/types";
import type { Result } from "./train";

export const MAX_GAMES_PER_SYNC = 200;
export const KEEP_GAMES = 1000;
export const SYNC_CALLS_PER_HOUR = 30;
/** the column caps in 0006 */
export const MAX_PLIES = 38;

const USERNAME = /^[A-Za-z0-9][A-Za-z0-9_-]{1,29}$/;
const GAME_ID: Record<Platform, RegExp> = { lichess: /^[A-Za-z0-9]{8}$/, chesscom: /^(live|daily)\/\d{1,20}$/ };
const SAN = /^[A-Za-z0-9+#=-]{2,8}$/;
const ECO = /^[A-E]\d{2}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MIN_DATE = Date.parse("2000-01-01T00:00:00.000Z");
/** NUL (Postgres text rejects it) and lone surrogates */
const BAD_TEXT = /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

export interface AccountRow {
  user_id: string;
  platform: Platform;
  username: string;
  verified: boolean;
  ratings: Ratings;
  linked_at?: string;
  last_synced_at: string | null;
  last_game_at: string | null;
  sync_window_start: string | null;
  sync_calls: number;
}

export interface GameRow {
  user_id: string;
  platform: Platform;
  game_id: string;
  color: "white" | "black";
  time_class: TimeClass;
  played_at: string;
  result: "win" | "draw" | "loss";
  my_rating: number | null;
  opp_rating: number | null;
  eco: string | null;
  opening_name: string | null;
  opening_plies: string[];
  book_ply: number;
  deviated_by: "me" | "opponent" | "none";
  deviation_epd: string | null;
  played_san: string | null;
  book_sans: string[] | null;
  eval_before: number | null;
  eval_after: number | null;
  dataset_hash: string;
}

export interface InsightsDb {
  getAccount(userId: string, platform: Platform): Promise<AccountRow | null>;
  /** insert or replace the account row (a new username replaces the old row, cascading its games) */
  putAccount(row: AccountRow, replace: boolean): Promise<void>;
  /** update the row only while it is still linked to `username` (case-insensitive) */
  updateAccount(userId: string, platform: Platform, username: string, patch: Partial<AccountRow>): Promise<void>;
  /**
   * Atomically take one of `limit` sync slots per hour for this username
   * (insights_claim_sync, migration 0007): 0 = claimed, > 0 = seconds to wait,
   * -1 = not linked to that username.
   */
  claimSync(userId: string, platform: Platform, username: string, limit: number): Promise<number>;
  deleteAccount(userId: string, platform: Platform): Promise<void>;
  upsertGames(rows: GameRow[]): Promise<void>;
  /** delete all but the newest `keep` games; returns how many were removed */
  pruneGames(userId: string, platform: Platform, keep: number): Promise<number>;
}

const bad = (message: string): Result => ({ status: 400, body: { message } });
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const isInt = (x: unknown, lo: number, hi: number): x is number => typeof x === "number" && Number.isInteger(x) && x >= lo && x <= hi;
const optInt = (x: unknown, lo: number, hi: number) => x === null || x === undefined || isInt(x, lo, hi);

export function validRatings(x: unknown): x is Ratings {
  if (!isObj(x)) return false;
  for (const [k, v] of Object.entries(x)) {
    if (!TIME_CLASSES.includes(k as TimeClass) || !isObj(v)) return false;
    if (!isInt(v.rating, 0, 4000) || !isInt(v.games, 0, 10_000_000) || typeof v.provisional !== "boolean") return false;
  }
  return true;
}

/** null when valid, else why not. */
export function checkSummary(platform: Platform, s: unknown, now: Date): string | null {
  if (!isObj(s)) return "not an object";
  if (s.platform !== platform) return "platform";
  if (typeof s.gameId !== "string" || !GAME_ID[platform].test(s.gameId)) return "gameId";
  if (s.color !== "white" && s.color !== "black") return "color";
  if (!TIME_CLASSES.includes(s.timeClass as TimeClass)) return "timeClass";
  // canonical ISO only (what the client sends), from 2000 to tomorrow: always valid timestamptz input
  if (typeof s.playedAt !== "string" || !ISO.test(s.playedAt) || Number.isNaN(Date.parse(s.playedAt))) return "playedAt";
  if (new Date(s.playedAt).toISOString() !== s.playedAt || Date.parse(s.playedAt) < MIN_DATE || Date.parse(s.playedAt) > now.getTime() + 86_400_000) return "playedAt";
  if (s.result !== "win" && s.result !== "draw" && s.result !== "loss") return "result";
  if (!optInt(s.myRating, 0, 4000) || !optInt(s.oppRating, 0, 4000)) return "ratings";
  if (!(s.eco === null || (typeof s.eco === "string" && ECO.test(s.eco)))) return "eco";
  if (!(s.openingName === null || (typeof s.openingName === "string" && s.openingName.length <= 200 && !BAD_TEXT.test(s.openingName)))) return "openingName";
  if (typeof s.datasetHash !== "string" || !s.datasetHash || s.datasetHash.length > 80) return "datasetHash";
  const plies = s.openingPlies;
  if (!Array.isArray(plies) || plies.length < 1 || plies.length > MAX_PLIES || !plies.every((p) => typeof p === "string" && SAN.test(p))) return "openingPlies";
  if (!isInt(s.bookPly, 0, MAX_PLIES) || s.bookPly > plies.length) return "bookPly";
  if (s.deviatedBy !== "me" && s.deviatedBy !== "opponent" && s.deviatedBy !== "none") return "deviatedBy";
  const dev = s.deviatedBy !== "none";
  if (dev !== (typeof s.deviationEpd === "string") || dev !== (typeof s.playedSan === "string")) return "deviation fields";
  if (dev && (!SAN.test(s.playedSan as string) || (s.deviationEpd as string).length > 100)) return "playedSan";
  if (!dev && (s.deviationEpd !== null || s.playedSan !== null)) return "deviation fields";
  if (!(s.bookSans === null || (Array.isArray(s.bookSans) && s.bookSans.length <= 40 && s.bookSans.every((b) => typeof b === "string" && SAN.test(b))))) return "bookSans";
  if (!optInt(s.evalBefore, -10_000, 10_000) || !optInt(s.evalAfter, -10_000, 10_000)) return "evals";
  if ((s.evalBefore === null) !== (s.evalAfter === null)) return "evals";
  // the moves must be legal, and the deviation must sit at ply bookPly
  const chess = new Chess();
  for (const [i, p] of (plies as string[]).entries()) {
    if (dev && i === s.bookPly) {
      if (epdOf(chess.fen()) !== s.deviationEpd) return "deviationEpd";
      if (normSan(p) !== s.playedSan) return "playedSan";
    }
    try {
      if (normSan(chess.move(p).san) !== p) return "openingPlies (not normalised SAN)";
    } catch {
      return "openingPlies (illegal)";
    }
  }
  if (dev && s.bookPly === plies.length) {
    if (epdOf(chess.fen()) !== s.deviationEpd) return "deviationEpd";
    try {
      // must be the normalised SAN chess.js produces (not "g1f3", "Ng1-f3", "Nf3!?")
      if (normSan(chess.move(s.playedSan as string).san) !== s.playedSan) return "playedSan";
    } catch {
      return "playedSan (illegal)";
    }
  }
  if (dev) {
    const mover = (s.deviationEpd as string).split(" ")[1] === "w" ? "white" : "black";
    if ((s.deviatedBy === "me") !== (mover === s.color)) return "deviatedBy";
  }
  return null;
}

export function toRow(userId: string, s: Summary): GameRow {
  return {
    user_id: userId,
    platform: s.platform,
    game_id: s.gameId,
    color: s.color,
    time_class: s.timeClass,
    played_at: s.playedAt,
    result: s.result,
    my_rating: s.myRating,
    opp_rating: s.oppRating,
    eco: s.eco,
    opening_name: s.openingName,
    opening_plies: s.openingPlies,
    book_ply: s.bookPly,
    deviated_by: s.deviatedBy,
    deviation_epd: s.deviationEpd,
    played_san: s.playedSan,
    book_sans: s.bookSans,
    eval_before: s.evalBefore,
    eval_after: s.evalAfter,
    dataset_hash: s.datasetHash,
  };
}

export function fromRow(r: GameRow): Summary {
  return {
    platform: r.platform,
    gameId: r.game_id,
    color: r.color,
    timeClass: r.time_class,
    playedAt: new Date(r.played_at).toISOString(),
    result: r.result,
    myRating: r.my_rating,
    oppRating: r.opp_rating,
    eco: r.eco,
    openingName: r.opening_name,
    openingPlies: r.opening_plies,
    bookPly: r.book_ply,
    deviatedBy: r.deviated_by,
    deviationEpd: r.deviation_epd,
    playedSan: r.played_san,
    bookSans: r.book_sans,
    evalBefore: r.eval_before,
    evalAfter: r.eval_after,
    datasetHash: r.dataset_hash,
  };
}

const platformOf = (b: Record<string, unknown>): Platform | null => (PLATFORMS.includes(b.platform as Platform) ? (b.platform as Platform) : null);

/** POST /api/insights/link {platform, username, ratings} */
export async function link(db: InsightsDb, userId: string, body: unknown): Promise<Result> {
  if (!isObj(body)) return bad("invalid body");
  const platform = platformOf(body);
  if (!platform) return bad("platform");
  if (typeof body.username !== "string" || !USERNAME.test(body.username)) return bad("username");
  if (!validRatings(body.ratings)) return bad("ratings");
  const old = await db.getAccount(userId, platform);
  const same = old && old.username.toLowerCase() === body.username.toLowerCase();
  if (same) {
    // re-linking the same account: keep its cursor and counters as they are now
    await db.updateAccount(userId, platform, old.username, { username: body.username, ratings: body.ratings });
    return { status: 200, body: { ok: true, replaced: false } };
  }
  const row: AccountRow = {
    user_id: userId,
    platform,
    username: body.username,
    verified: false,
    ratings: body.ratings,
    last_synced_at: null,
    last_game_at: null,
    // the rate-limit window carries over to the new name
    sync_window_start: old?.sync_window_start ?? null,
    sync_calls: old?.sync_calls ?? 0,
  };
  // a different username is a different account: its old games go (FK cascade)
  await db.putAccount(row, !!old);
  return { status: 200, body: { ok: true, replaced: !!old } };
}

/**
 * POST /api/insights/sync {platform, username, ratings?, games: Summary[], rematch?}
 * `username` must be the linked one (a re-link mid-sync fails with 409 instead
 * of mixing accounts). `rematch: true` stores re-matched rows without counting
 * as a sync (last_synced_at stays, so the stale check still imports).
 */
export async function sync(db: InsightsDb, userId: string, body: unknown, now = new Date()): Promise<Result> {
  if (!isObj(body)) return bad("invalid body");
  const platform = platformOf(body);
  if (!platform) return bad("platform");
  if (typeof body.username !== "string" || !USERNAME.test(body.username)) return bad("username");
  if (!Array.isArray(body.games) || body.games.length > MAX_GAMES_PER_SYNC) return bad(`games: an array of at most ${MAX_GAMES_PER_SYNC}`);
  // the rate limit comes before the (chess.js) validation, so a throttled caller costs one query
  const wait = await db.claimSync(userId, platform, body.username, SYNC_CALLS_PER_HOUR);
  if (wait < 0) return { status: 409, body: { message: "This account isn't linked (any more). Reload and try again." } };
  if (wait > 0) return { status: 429, body: { message: "Too many syncs this hour. Try again later.", retryAfter: wait } };
  if (body.ratings !== undefined && !validRatings(body.ratings)) return bad("ratings");
  for (const [i, g] of body.games.entries()) {
    const why = checkSummary(platform, g, now);
    if (why) return bad(`games[${i}]: ${why}`);
  }
  const games = body.games as Summary[];
  if (new Set(games.map((g) => g.gameId)).size !== games.length) return bad("duplicate gameId");
  const acct = await db.getAccount(userId, platform);
  if (!acct || acct.username.toLowerCase() !== body.username.toLowerCase()) return { status: 409, body: { message: "This account isn't linked (any more). Reload and try again." } };
  if (games.length) await db.upsertGames(games.map((g) => toRow(userId, g)));
  const times = [acct.last_game_at, ...games.map((g) => g.playedAt)].filter((x): x is string => !!x).map((x) => Date.parse(x));
  const newest = times.length ? new Date(Math.max(...times)).toISOString() : null;
  await db.updateAccount(userId, platform, acct.username, {
    ...(body.rematch === true ? {} : { last_synced_at: now.toISOString() }),
    last_game_at: newest,
    ...(body.ratings ? { ratings: body.ratings as Ratings } : {}),
  });
  const pruned = await db.pruneGames(userId, platform, KEEP_GAMES);
  return { status: 200, body: { ok: true, stored: games.length, pruned, lastGameAt: newest } };
}

/** POST /api/insights/unlink {platform}: deletes the account row; its games cascade. */
export async function unlink(db: InsightsDb, userId: string, body: unknown): Promise<Result> {
  if (!isObj(body)) return bad("invalid body");
  const platform = platformOf(body);
  if (!platform) return bad("platform");
  await db.deleteAccount(userId, platform);
  return { status: 200, body: { ok: true } };
}
