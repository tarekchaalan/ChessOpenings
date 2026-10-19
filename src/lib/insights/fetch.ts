/**
 * Browser fetching from Lichess and Chess.com (ADR 0006 Decision 1). Both send
 * `access-control-allow-origin: *`; `Accept` is a safelisted header, so no
 * preflight. One request at a time per platform; on 429, wait 60 s and retry
 * once, then report. `fetch` and `sleep` are injectable for tests.
 */
import { applyWindow, inScope, windowStart, type ImportScope } from "./filter";
import { chesscomRatings, monthsToFetch, parseChesscomGame, type ChesscomGame } from "./sources/chesscom";
import { lichessProfile, parseLichessGame, splitNdjson, type LichessGame } from "./sources/lichess";
import { isSkip, PLATFORM_NAME, type NormalGame, type Platform, type Ratings, type Skip } from "./types";

export type FetchErrorKind = "not-found" | "rate-limited" | "network" | "bad-response" | "busy";

export class InsightsFetchError extends Error {
  constructor(
    readonly kind: FetchErrorKind,
    readonly platform: Platform,
    message: string
  ) {
    super(message);
  }
}

export interface FetchDeps {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
}
const defaultDeps = (): FetchDeps => ({ fetch: (...a) => fetch(...a), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) });

export const RETRY_AFTER_MS = 60_000;
const LICHESS = "https://lichess.org";
const CHESSCOM = "https://api.chess.com/pub";
const USERNAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{1,29}$/;

export const validUsername = (u: string) => USERNAME_RE.test(u.trim());

// one request at a time per platform, in this tab: each public call (a
// lookup, a whole import including the Lichess stream) runs alone
const chains: Record<Platform, Promise<unknown>> = { lichess: Promise.resolve(), chesscom: Promise.resolve() };
function serial<T>(platform: Platform, run: () => Promise<T>): Promise<T> {
  const next = chains[platform].then(run, run);
  chains[platform] = next.catch(() => undefined);
  return next;
}

/** GET with the platform's error mapping; one automatic retry after a 429. */
async function get(platform: Platform, url: string, deps: FetchDeps, init: RequestInit = {}, signal?: AbortSignal): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await deps.fetch(url, { ...init, signal });
    } catch (e) {
      if ((e as Error)?.name === "AbortError") throw e;
      throw new InsightsFetchError("network", platform, `Couldn't reach ${platform === "lichess" ? "lichess.org" : "chess.com"}. Check your connection and try again.`);
    }
    if (res.status === 429) {
      if (attempt === 0) {
        await deps.sleep(RETRY_AFTER_MS);
        continue;
      }
      throw new InsightsFetchError("rate-limited", platform, `${PLATFORM_NAME[platform]} asked us to slow down. Try again in a minute.`);
    }
    if (res.status === 404) throw new InsightsFetchError("not-found", platform, `No ${PLATFORM_NAME[platform]} player with that username.`);
    if (!res.ok) throw new InsightsFetchError("bad-response", platform, `${PLATFORM_NAME[platform]} answered ${res.status}. Try again later.`);
    return res;
  }
}

async function json<T>(platform: Platform, res: Response): Promise<T> {
  try {
    return (await res.json()) as T;
  } catch {
    throw new InsightsFetchError("bad-response", platform, `${PLATFORM_NAME[platform]} sent a response we couldn't read.`);
  }
}

export interface Profile {
  platform: Platform;
  /** as the platform spells it */
  username: string;
  ratings: Ratings;
}

/** Check that the user exists; their display name and current ratings. */
export function lookupProfile(platform: Platform, username: string, deps: FetchDeps = defaultDeps()): Promise<Profile> {
  return serial(platform, () => lookup(platform, username, deps));
}

async function lookup(platform: Platform, username: string, deps: FetchDeps): Promise<Profile> {
  const u = username.trim();
  if (!validUsername(u)) throw new InsightsFetchError("not-found", platform, "That isn't a valid username.");
  if (platform === "lichess") {
    const p = lichessProfile(await json(platform, await get(platform, `${LICHESS}/api/user/${encodeURIComponent(u)}`, deps)));
    if (!p) throw new InsightsFetchError("not-found", platform, "That Lichess account is closed or unavailable.");
    return { platform, ...p };
  }
  const player = await json<{ username?: string }>(platform, await get(platform, `${CHESSCOM}/player/${encodeURIComponent(u.toLowerCase())}`, deps));
  const stats = await json<Record<string, unknown>>(platform, await get(platform, `${CHESSCOM}/player/${encodeURIComponent(u.toLowerCase())}/stats`, deps));
  // Chess.com's player endpoint returns the name in lower case; keep what the player typed when it matches
  const name = player.username && player.username.toLowerCase() === u.toLowerCase() ? u : player.username ?? u;
  return { platform, username: name, ratings: chesscomRatings(stats) };
}

export interface FetchProgress {
  /** games read so far (before filtering) */
  read: number;
  /** games kept (in scope) */
  kept: number;
  /** 0..1 when the total is known, else null */
  fraction: number | null;
  label: string;
}

export interface FetchResult {
  games: NormalGame[];
  skipped: Partial<Record<Skip["skip"], number>>;
}

export interface FetchOptions {
  username: string;
  scope: ImportScope;
  /** newest game already imported (incremental cursor) */
  since: Date | null;
  now?: Date;
  signal?: AbortSignal;
  onProgress?: (p: FetchProgress) => void;
}

export function fetchGames(platform: Platform, o: FetchOptions, deps: FetchDeps = defaultDeps()): Promise<FetchResult> {
  return serial(platform, () => (platform === "lichess" ? fetchLichess(o, deps) : fetchChesscom(o, deps)));
}

function collect(skipped: FetchResult["skipped"], scope: ImportScope, g: NormalGame | Skip, out: NormalGame[]) {
  const why = isSkip(g) ? g : inScope(g, scope);
  if (why) skipped[why.skip] = (skipped[why.skip] ?? 0) + 1;
  else out.push(g as NormalGame);
}

async function fetchLichess(o: FetchOptions, deps: FetchDeps): Promise<FetchResult> {
  const now = o.now ?? new Date();
  const from = windowStart(o.scope, o.since, now);
  const q = new URLSearchParams({
    since: String(from.getTime() + 1),
    max: String(o.scope.maxGames),
    rated: "true",
    perfType: o.scope.timeClasses.join(","),
    opening: "true",
    evals: "true",
    moves: "true",
    clocks: "false",
  });
  const res = await get("lichess", `${LICHESS}/api/games/user/${encodeURIComponent(o.username)}?${q}`, deps, { headers: { Accept: "application/x-ndjson" } }, o.signal);
  const games: NormalGame[] = [];
  const skipped: FetchResult["skipped"] = {};
  let read = 0;
  const onLine = (line: string) => {
    let g: LichessGame;
    try {
      g = JSON.parse(line);
    } catch {
      skipped.unreadable = (skipped.unreadable ?? 0) + 1;
      return;
    }
    read++;
    collect(skipped, o.scope, parseLichessGame(g, o.username), games);
    o.onProgress?.({ read, kept: games.length, fraction: Math.min(1, read / o.scope.maxGames), label: `${read} games read` });
  };
  // stream the ndjson; Lichess sends about 20 games a second
  if (res.body && typeof res.body.getReader === "function") {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let rest = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const r = splitNdjson(rest, dec.decode(value, { stream: true }));
      rest = r.rest;
      r.lines.forEach(onLine);
    }
    if (rest.trim()) onLine(rest.trim());
  } else {
    (await res.text()).split("\n").map((l) => l.trim()).filter(Boolean).forEach(onLine);
  }
  return { games: applyWindow(games, o.scope, o.since, now), skipped };
}

async function fetchChesscom(o: FetchOptions, deps: FetchDeps): Promise<FetchResult> {
  const now = o.now ?? new Date();
  const user = encodeURIComponent(o.username.toLowerCase());
  const { archives } = await json<{ archives?: string[] }>("chesscom", await get("chesscom", `${CHESSCOM}/player/${user}/games/archives`, deps, {}, o.signal));
  const months = monthsToFetch(archives ?? [], windowStart(o.scope, o.since, now), now, o.scope.months + 1);
  const games: NormalGame[] = [];
  const skipped: FetchResult["skipped"] = {};
  let read = 0;
  for (const [i, url] of months.entries()) {
    o.onProgress?.({ read, kept: games.length, fraction: i / Math.max(1, months.length), label: `Month ${i + 1} of ${months.length}` });
    if (!url.startsWith(`${CHESSCOM}/`)) continue; // only follow the API's own archive URLs
    const month = await json<{ games?: ChesscomGame[] }>("chesscom", await get("chesscom", url, deps, {}, o.signal));
    for (const g of month.games ?? []) {
      read++;
      collect(skipped, o.scope, parseChesscomGame(g, o.username), games);
    }
    // newest month first: stop once the window is full of newer games
    if (applyWindow(games, o.scope, o.since, now).length >= o.scope.maxGames) break;
  }
  o.onProgress?.({ read, kept: games.length, fraction: 1, label: `${months.length} months read` });
  return { games: applyWindow(games, o.scope, o.since, now), skipped };
}
