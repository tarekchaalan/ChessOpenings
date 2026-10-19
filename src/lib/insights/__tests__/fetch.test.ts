/** Browser importers against mocked platform responses (the captured fixtures); no live calls. */
import { describe, expect, it } from "vitest";
import { fetchGames, InsightsFetchError, lookupProfile, RETRY_AFTER_MS, type FetchDeps } from "../fetch";
import { DEFAULT_SCOPE } from "../filter";
import { EMPTY, GUEST_CAP, mergeGames, readLocal, releaseLock, takeLock, withoutPlatform, writeLocal } from "../local";
import type { Summary } from "../types";
import { fixture } from "./helpers";

const NOW = new Date("2026-10-19T12:00:00Z");
type Route = (url: string, init?: RequestInit) => Response | Promise<Response>;

function mock(route: Route) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const slept: number[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const deps: FetchDeps = {
    fetch: (async (u: RequestInfo | URL, init?: RequestInit) => {
      const url = String(u);
      calls.push({ url, init });
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        await new Promise((r) => setTimeout(r, 1));
        return await route(url, init);
      } finally {
        inFlight--;
      }
    }) as typeof fetch,
    sleep: async (ms) => void slept.push(ms),
  };
  return { deps, calls, slept, maxInFlight: () => maxInFlight };
}

const ok = (body: string, type = "application/json") => new Response(body, { status: 200, headers: { "content-type": type } });
/** a streamed body in small chunks, like a real ndjson export */
const stream = (text: string, size = 700) =>
  new Response(
    new ReadableStream({
      start(c) {
        for (let i = 0; i < text.length; i += size) c.enqueue(new TextEncoder().encode(text.slice(i, i + size)));
        c.close();
      },
    }),
    { status: 200, headers: { "content-type": "application/x-ndjson" } }
  );

describe("Lichess import", () => {
  it("streams ndjson with the documented query, keeps the window, reports progress", async () => {
    const m = mock(() => stream(fixture("lichess-games.ndjson")));
    const progress: number[] = [];
    const res = await fetchGames("lichess", { username: "Zhigalko_Sergei", scope: DEFAULT_SCOPE, since: null, now: NOW, onProgress: (p) => progress.push(p.read) }, m.deps);
    expect(m.calls).toHaveLength(1);
    const url = new URL(m.calls[0].url);
    expect(url.pathname).toBe("/api/games/user/Zhigalko_Sergei");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ max: "200", rated: "true", perfType: "rapid,blitz,classical", opening: "true", evals: "true", moves: "true" });
    expect((m.calls[0].init?.headers as Record<string, string>).Accept).toBe("application/x-ndjson");
    expect(res.games.length).toBe(15);
    expect(progress[progress.length - 1]).toBe(15);
  });

  it("incremental: `since` is the newest imported game + 1 ms", async () => {
    const m = mock(() => stream(""));
    const since = new Date("2026-10-10T00:00:00Z");
    await fetchGames("lichess", { username: "u1", scope: DEFAULT_SCOPE, since, now: NOW }, m.deps);
    expect(new URL(m.calls[0].url).searchParams.get("since")).toBe(String(since.getTime() + 1));
  });

  it("404 → not-found; 429 waits 60 s and retries once, then rate-limited; network → network", async () => {
    await expect(lookupProfile("lichess", "nobody_zz9", mock(() => new Response(fixture("lichess-user-404.json"), { status: 404 })).deps)).rejects.toMatchObject({ kind: "not-found" });
    let n = 0;
    const once = mock(() => (n++ === 0 ? new Response("", { status: 429 }) : ok(fixture("lichess-user.json"))));
    expect((await lookupProfile("lichess", "Zhigalko_Sergei", once.deps)).username).toBe("Zhigalko_Sergei");
    expect(once.slept).toEqual([RETRY_AFTER_MS]);
    const twice = mock(() => new Response("", { status: 429 }));
    const err = await lookupProfile("lichess", "Zhigalko_Sergei", twice.deps).catch((e) => e);
    expect(err).toBeInstanceOf(InsightsFetchError);
    expect(err.kind).toBe("rate-limited");
    expect(twice.calls).toHaveLength(2);
    const down = mock(() => Promise.reject(new TypeError("Failed to fetch")));
    await expect(lookupProfile("lichess", "Zhigalko_Sergei", down.deps)).rejects.toMatchObject({ kind: "network" });
  });

  it("Cancel during the 429 back-off rejects at once with an AbortError", async () => {
    const m = mock(() => new Response("", { status: 429 }));
    // a sleep that never ends on its own
    m.deps.sleep = () => new Promise(() => {});
    const ctrl = new AbortController();
    const p = fetchGames("lichess", { username: "u1", scope: DEFAULT_SCOPE, since: null, now: NOW, signal: ctrl.signal }, m.deps);
    setTimeout(() => ctrl.abort(), 20);
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
  });

  it("an invalid username never reaches the network", async () => {
    const m = mock(() => ok("{}"));
    await expect(lookupProfile("lichess", "bad name!", m.deps)).rejects.toMatchObject({ kind: "not-found" });
    expect(m.calls).toHaveLength(0);
  });
});

describe("Chess.com import", () => {
  const month = fixture("chesscom-month.json");
  const route: Route = (url) => {
    if (url.endsWith("/games/archives")) return ok(fixture("chesscom-archives.json"));
    if (/\/games\/\d{4}\/\d{2}$/.test(url)) return ok(url.endsWith("2026/09") ? month : '{"games":[]}');
    if (url.endsWith("/stats")) return ok(fixture("chesscom-stats.json"));
    if (url.endsWith("/player/hikaru")) return ok(fixture("chesscom-player.json"));
    return new Response(fixture("chesscom-404.json"), { status: 404 });
  };

  it("archives, then the window's months newest first, one request at a time", async () => {
    const m = mock(route);
    const res = await fetchGames("chesscom", { username: "Hikaru", scope: DEFAULT_SCOPE, since: null, now: NOW }, m.deps);
    expect(m.calls.map((c) => c.url.replace("https://api.chess.com/pub/player/hikaru", ""))).toEqual(["/games/archives", "/games/2026/10", "/games/2026/09", "/games/2026/08", "/games/2026/07"]);
    expect(m.maxInFlight()).toBe(1);
    // 2026-09 rated blitz/rapid standard games in the fixture; older ones fall outside the window
    expect(res.games.every((g) => g.playedAt >= "2026-07-19")).toBe(true);
    expect(res.games.length).toBeGreaterThan(0);
    expect(res.skipped["time-class"]).toBeGreaterThan(0);
  });

  it("lookup: profile + stats; unknown user → not-found", async () => {
    const m = mock(route);
    const p = await lookupProfile("chesscom", "Hikaru", m.deps);
    expect(p.username).toBe("Hikaru");
    expect(p.ratings.blitz!.rating).toBeGreaterThan(3000);
    await expect(lookupProfile("chesscom", "nobody_zz9", mock(route).deps)).rejects.toMatchObject({ kind: "not-found" });
  });

  it("two imports on one platform never overlap", async () => {
    const m = mock(route);
    await Promise.all([
      fetchGames("chesscom", { username: "hikaru", scope: DEFAULT_SCOPE, since: null, now: NOW }, m.deps),
      lookupProfile("chesscom", "hikaru", m.deps),
    ]);
    expect(m.maxInFlight()).toBe(1);
  });
});

describe("guest store", () => {
  const s = (id: string, at: string, platform: "lichess" | "chesscom" = "lichess") => ({ platform, gameId: id, playedAt: at }) as Summary;

  it("merge: incoming replaces by id, newest first, capped per platform", () => {
    const a = [s("a", "2026-01-01"), s("b", "2026-01-02")];
    const merged = mergeGames(a, [{ ...s("a", "2026-01-01"), result: "win" } as Summary, s("c", "2026-01-03")], 10);
    expect(merged.map((x) => x.gameId)).toEqual(["c", "b", "a"]);
    expect(merged.find((x) => x.gameId === "a")!.result).toBe("win");
    const many = Array.from({ length: GUEST_CAP + 5 }, (_, i) => s(`g${i}`, new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString()));
    const capped = mergeGames([], [...many, s("x", "2025-01-01", "chesscom")], GUEST_CAP);
    expect(capped.filter((x) => x.platform === "lichess")).toHaveLength(GUEST_CAP);
    expect(capped.some((x) => x.gameId === "x")).toBe(true);
  });

  it("read/write survive broken storage; unlink drops a platform", () => {
    const mem = new Map<string, string>();
    const st = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) };
    const data = { accounts: { lichess: { platform: "lichess", username: "u1" } }, games: [s("a", "2026-01-01"), s("b", "2026-01-01", "chesscom")] } as never;
    writeLocal(st, data);
    expect(readLocal(st)).toEqual(data);
    expect(withoutPlatform(readLocal(st), "lichess").games.map((g) => g.gameId)).toEqual(["b"]);
    writeLocal(st, EMPTY);
    expect(mem.size).toBe(0);
    mem.set("cot.v2.insights", "{not json");
    expect(readLocal(st)).toEqual(EMPTY);
    const throwing = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); }, removeItem: () => { throw new Error("denied"); } };
    expect(readLocal(throwing)).toEqual(EMPTY);
    expect(() => writeLocal(throwing, data)).not.toThrow();
  });

  it("cross-tab lock: held by one tab until released or stale", () => {
    const mem = new Map<string, string>();
    const st = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) };
    expect(takeLock(st, "lichess", "tab1", 0)).toBe(true);
    expect(takeLock(st, "lichess", "tab2", 1000)).toBe(false);
    expect(takeLock(st, "chesscom", "tab2", 1000)).toBe(true);
    expect(takeLock(st, "lichess", "tab2", 4 * 60_000)).toBe(true); // stale
    releaseLock(st, "lichess", "tab1"); // not the owner any more: no-op
    expect(takeLock(st, "lichess", "tab3", 4 * 60_000 + 1)).toBe(false);
    releaseLock(st, "lichess", "tab2");
    expect(takeLock(st, "lichess", "tab3", 4 * 60_000 + 2)).toBe(true);
  });
});
