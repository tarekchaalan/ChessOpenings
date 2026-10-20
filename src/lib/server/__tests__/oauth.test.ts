/** ADR 0009: Lichess / Chess.com OAuth (flow pieces, identity, sign-in and link) against fakes. */
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { callbackErrorMessage } from "@/lib/auth";
import { isPlaceholderEmail } from "@/lib/oauth/providers";
import type { Platform } from "@/lib/insights/types";
import type { AccountRow } from "../insights";
import {
  authorizeUrl,
  chesscomIdentity,
  decodeFlow,
  encodeFlow,
  failUrl,
  fetchIdentity,
  linkIdentity,
  OAuthError,
  pkce,
  placeholderEmail,
  providerConfig,
  signIn,
  suggestUsername,
  type Identity,
  type IdentityRow,
  type OAuthDb,
  type OAuthErrorCode,
  type ProviderConfig,
} from "../oauth";

const NOW = new Date("2026-10-20T12:00:00Z");
const U = "11111111-1111-4111-8111-111111111111";
const V = "22222222-2222-4222-8222-222222222222";
const lichessUser = JSON.parse(readFileSync(join(__dirname, "../../insights/__tests__/fixtures/lichess-user.json"), "utf8")) as { id: string; username: string };
const LICHESS = providerConfig("lichess", {}, "chess.example")!;
const CHESSCOM_ENV = { NEXT_PUBLIC_CHESSCOM_CLIENT_ID: "cid", CHESSCOM_AUTHORIZE_URL: "https://oauth.chess.example/authorize", CHESSCOM_TOKEN_URL: "https://oauth.chess.example/token" };
const CHESSCOM = providerConfig("chesscom", CHESSCOM_ENV, "chess.example")!;

function fakeDb() {
  const identities = new Map<string, IdentityRow>();
  const accounts = new Map<string, AccountRow>();
  const users = new Map<string, { id: string; username?: string }>();
  const touched: string[] = [];
  const ik = (p: Platform, id: string) => `${p}|${id}`;
  const ak = (u: string, p: Platform) => `${u}|${p}`;
  const db: OAuthDb = {
    async getAccount(u, p) {
      return accounts.get(ak(u, p)) ?? null;
    },
    async putAccount(row, replace) {
      if (replace) accounts.delete(ak(row.user_id, row.platform));
      accounts.set(ak(row.user_id, row.platform), { ...row });
    },
    async updateAccount(u, p, username, patch) {
      const a = accounts.get(ak(u, p));
      if (a && a.username === username) accounts.set(ak(u, p), { ...a, ...patch });
    },
    async findIdentity(p, id) {
      return identities.get(ik(p, id)) ?? null;
    },
    // the two unique keys of 0010
    async putIdentity(row) {
      for (const [key, r] of identities) if (r.user_id === row.user_id && r.provider === row.provider && r.provider_user_id !== row.provider_user_id) identities.delete(key);
      const owner = identities.get(ik(row.provider, row.provider_user_id));
      if (owner && owner.user_id !== row.user_id) throw new OAuthError("oauth_taken");
      identities.set(ik(row.provider, row.provider_user_id), { ...row });
    },
    async touchIdentity(p, id, username) {
      touched.push(id);
      const r = identities.get(ik(p, id));
      if (r) identities.set(ik(p, id), { ...r, username });
    },
    async ensureUser(email, username) {
      if (!users.has(email)) users.set(email, { id: `user-${users.size + 1}`, username });
      return users.get(email)!.id;
    },
  };
  return { db, identities, accounts, users, touched };
}

const lichessId = (o: Partial<Identity> = {}): Identity => ({ provider: "lichess", providerUserId: "zhigalko_sergei", username: "Zhigalko_Sergei", ratings: { blitz: { rating: 2800, games: 100, provisional: false } }, ...o });

function linkedRow(user: string, username: string, verified = false): AccountRow {
  return { user_id: user, platform: "lichess", username, verified, ratings: {}, last_synced_at: null, last_game_at: null, sync_window_start: null, sync_calls: 0 };
}

/** A fake Lichess: the token endpoint, /api/account and revocation, recording every call. */
function fakeLichess(account: unknown, opts: { tokenStatus?: number; accountStatus?: number } = {}) {
  const calls: { url: string; method: string; body?: string; auth?: string }[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({ url, method: init?.method ?? "GET", body: init?.body ? String(init.body) : undefined, auth: headers.get("authorization") ?? undefined });
    if (url.endsWith("/api/token") && init?.method === "POST") {
      return Response.json(opts.tokenStatus ? { error: "invalid_grant" } : { token_type: "Bearer", access_token: "lio_secret", expires_in: 31536000 }, { status: opts.tokenStatus ?? 200 });
    }
    if (url.endsWith("/api/token") && init?.method === "DELETE") return new Response(null, { status: 204 });
    if (url.endsWith("/api/account")) return Response.json(account, { status: opts.accountStatus ?? 200 });
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  return { fetchFn, calls };
}

const jwt = (claims: Record<string, unknown>) => `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;

describe("provider config", () => {
  it("Lichess works with no configuration: lichess.org endpoints, this host as client id, identity only", () => {
    expect(LICHESS).toEqual({ provider: "lichess", authorizeUrl: "https://lichess.org/oauth", tokenUrl: "https://lichess.org/api/token", apiBase: "https://lichess.org", clientId: "chess.example", scope: "" });
    expect(providerConfig("lichess", { LICHESS_CLIENT_ID: "my-app", LICHESS_HOST: "http://localhost:8080/" }, "h")).toMatchObject({ clientId: "my-app", tokenUrl: "http://localhost:8080/api/token" });
  });

  it("Chess.com is off until its client id and endpoints are set", () => {
    expect(providerConfig("chesscom", {}, "h")).toBeNull();
    expect(providerConfig("chesscom", { NEXT_PUBLIC_CHESSCOM_CLIENT_ID: "cid" }, "h")).toBeNull();
    expect(CHESSCOM).toMatchObject({ clientId: "cid", scope: "openid profile", clientSecret: undefined });
  });
});

describe("PKCE, state and the flow cookie", () => {
  it("the challenge is the S256 of the verifier, and both are fresh each time", () => {
    const a = pkce();
    expect(a.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.challenge).toBe(createHash("sha256").update(a.verifier).digest("base64url"));
    expect(pkce().verifier).not.toBe(a.verifier);
  });

  it("the authorize URL carries the PKCE challenge and state, and no scope for Lichess", () => {
    const u = new URL(authorizeUrl(LICHESS, { state: "st", challenge: "ch", redirectUri: "https://chess.example/api/auth/oauth/lichess/callback" }));
    expect(u.origin + u.pathname).toBe("https://lichess.org/oauth");
    expect(Object.fromEntries(u.searchParams)).toEqual({
      response_type: "code",
      client_id: "chess.example",
      redirect_uri: "https://chess.example/api/auth/oauth/lichess/callback",
      code_challenge_method: "S256",
      code_challenge: "ch",
      state: "st",
    });
    expect(new URL(authorizeUrl(CHESSCOM, { state: "s", challenge: "c", redirectUri: "r" })).searchParams.get("scope")).toBe("openid profile");
  });

  it("the flow cookie round-trips and anything malformed reads as no flow", () => {
    const f = { p: "lichess", s: "state", v: "verifier", i: "link", n: "/insights" } as const;
    expect(decodeFlow(encodeFlow(f))).toEqual(f);
    const enc = (x: unknown) => Buffer.from(JSON.stringify(x)).toString("base64url");
    for (const bad of [undefined, "", "not base64 json", enc({ ...f, p: "fide" }), enc({ ...f, i: "admin" }), enc({ ...f, n: "https://evil.example" }), enc({ ...f, s: "" }), enc([f])]) {
      expect(decodeFlow(bad)).toBeNull();
    }
  });

  it("a failed sign-in goes back to /auth with the reason; a failed link goes back where it started", () => {
    expect(failUrl("https://c.example", "lichess", "signin", "/train", "oauth_denied")).toBe("https://c.example/auth?error=oauth_denied&next=%2Ftrain");
    expect(failUrl("https://c.example", "lichess", "link", "/settings?tab=account", "oauth_taken")).toBe("https://c.example/settings?tab=account&oauth=lichess&oauth_error=oauth_taken");
  });

  it("every error code has a message of its own", () => {
    const codes: OAuthErrorCode[] = ["oauth_denied", "oauth_state", "oauth_failed", "oauth_unavailable", "oauth_taken", "oauth_mismatch", "oauth_closed", "oauth_signin_needed"];
    const generic = callbackErrorMessage("auth_callback_failed");
    for (const c of codes) expect(callbackErrorMessage(c)).not.toBe(generic);
  });
});

describe("identity", () => {
  it("Lichess: exchanges the code with the verifier, reads the account, then revokes the token", async () => {
    const { fetchFn, calls } = fakeLichess(lichessUser);
    const id = await fetchIdentity(LICHESS, "the-code", "the-verifier", "https://chess.example/cb", fetchFn, NOW);
    expect(id).toMatchObject({ provider: "lichess", providerUserId: lichessUser.id, username: lichessUser.username });
    expect(id.ratings).toBeTypeOf("object");
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(["POST https://lichess.org/api/token", "GET https://lichess.org/api/account", "DELETE https://lichess.org/api/token"]);
    expect(Object.fromEntries(new URLSearchParams(calls[0].body))).toEqual({
      grant_type: "authorization_code",
      code: "the-code",
      code_verifier: "the-verifier",
      redirect_uri: "https://chess.example/cb",
      client_id: "chess.example",
    });
    expect(calls[1].auth).toBe("Bearer lio_secret");
    expect(calls[2].auth).toBe("Bearer lio_secret");
  });

  it("Lichess: a refused code, a failed account read or a closed account fail, and the token is still revoked", async () => {
    await expect(fetchIdentity(LICHESS, "c", "v", "r", fakeLichess(lichessUser, { tokenStatus: 400 }).fetchFn, NOW)).rejects.toMatchObject({ code: "oauth_failed" });
    const failed = fakeLichess({}, { accountStatus: 500 });
    await expect(fetchIdentity(LICHESS, "c", "v", "r", failed.fetchFn, NOW)).rejects.toMatchObject({ code: "oauth_failed" });
    expect(failed.calls.at(-1)?.method).toBe("DELETE");
    await expect(fetchIdentity(LICHESS, "c", "v", "r", fakeLichess({ ...lichessUser, disabled: true }).fetchFn, NOW)).rejects.toMatchObject({ code: "oauth_closed" });
    await expect(fetchIdentity(LICHESS, "c", "v", "r", fakeLichess({ id: "x y", username: "x y" }).fetchFn, NOW)).rejects.toMatchObject({ code: "oauth_failed" });
  });

  it("Chess.com: the ID token must be for us, unexpired, from the configured issuer, and name the player", () => {
    const ok = { aud: "cid", exp: NOW.getTime() / 1000 + 60, sub: "12345678", preferred_username: "Hikaru", iss: "https://oauth.chess.example" };
    expect(chesscomIdentity(CHESSCOM, { access_token: "a", id_token: jwt(ok) }, NOW)).toEqual({ provider: "chesscom", providerUserId: "12345678", username: "Hikaru" });
    expect(chesscomIdentity(CHESSCOM, { access_token: "a", id_token: jwt({ ...ok, aud: ["other", "cid"], preferred_username: undefined, username: "hikaru" }) }, NOW).username).toBe("hikaru");
    const fails = (claims: Record<string, unknown>, cfg: ProviderConfig = CHESSCOM) => expect(() => chesscomIdentity(cfg, { access_token: "a", id_token: jwt(claims) }, NOW)).toThrow(OAuthError);
    fails({ ...ok, aud: "someone-else" });
    fails({ ...ok, exp: NOW.getTime() / 1000 - 1 });
    fails({ ...ok, sub: "" });
    fails({ ...ok, preferred_username: "not a name" });
    fails(ok, { ...CHESSCOM, issuer: "https://elsewhere.example" });
    expect(() => chesscomIdentity(CHESSCOM, { access_token: "a" }, NOW)).toThrow(OAuthError);
  });
});

describe("accounts", () => {
  it("placeholder emails are stable per provider id, never collide on case, and are recognised", () => {
    expect(placeholderEmail({ provider: "lichess", providerUserId: "zhigalko_sergei" })).toBe("lichess.zhigalko_sergei@oauth.invalid");
    const a = placeholderEmail({ provider: "chesscom", providerUserId: "AbC" });
    expect(a).toMatch(/^chesscom\.[0-9a-f]{32}@oauth\.invalid$/);
    expect(a).not.toBe(placeholderEmail({ provider: "chesscom", providerUserId: "abc" }));
    expect(isPlaceholderEmail(a)).toBe(true);
    expect(isPlaceholderEmail("me@example.com")).toBe(false);
  });

  it("the provider's name becomes the requested username when it fits the rule", () => {
    expect(suggestUsername("Zhigalko_Sergei")).toBe("Zhigalko_Sergei");
    expect(suggestUsername("dr-nykterstein")).toBe("dr_nykterstein");
    expect(suggestUsername("a_very_long_lichess_name_29ch")).toBe("a_very_long_lichess_");
    expect(suggestUsername("ab")).toBeUndefined();
  });

  it("a first sign-in creates the account with the name, the identity and a verified linked account; the next one finds it", async () => {
    const { db, identities, accounts, users, touched } = fakeDb();
    const first = await signIn(db, lichessId());
    expect(first.created).toBe(true);
    expect([...users.entries()]).toEqual([["lichess.zhigalko_sergei@oauth.invalid", { id: first.userId, username: "Zhigalko_Sergei" }]]);
    expect(identities.get("lichess|zhigalko_sergei")?.user_id).toBe(first.userId);
    expect(accounts.get(`${first.userId}|lichess`)).toMatchObject({ username: "Zhigalko_Sergei", verified: true, ratings: { blitz: { rating: 2800 } } });

    const again = await signIn(db, lichessId({ username: "zhigalko_SERGEI" }));
    expect(again).toEqual({ userId: first.userId, created: false });
    expect(touched).toEqual(["zhigalko_sergei"]);
    expect(identities.get("lichess|zhigalko_sergei")?.username).toBe("zhigalko_SERGEI");
    expect(users.size).toBe(1);
  });

  it("signing in verifies a same-name linked account but never re-links one the player unlinked", async () => {
    const { db, identities, accounts } = fakeDb();
    identities.set("lichess|zhigalko_sergei", { provider: "lichess", provider_user_id: "zhigalko_sergei", user_id: U, username: "Zhigalko_Sergei" });
    accounts.set(`${U}|lichess`, linkedRow(U, "zhigalko_sergei"));
    await signIn(db, lichessId());
    expect(accounts.get(`${U}|lichess`)).toMatchObject({ username: "Zhigalko_Sergei", verified: true });
    accounts.clear();
    await signIn(db, lichessId());
    expect(accounts.size).toBe(0);
  });

  it("a retried first sign-in reuses the user it already created", async () => {
    const { db, users } = fakeDb();
    // the first attempt created the user, then stopped before writing the identity
    const orphan = await db.ensureUser(placeholderEmail(lichessId()), "Zhigalko_Sergei");
    expect((await signIn(db, lichessId())).userId).toBe(orphan);
    expect(users.size).toBe(1);
  });

  it("linking verifies the player's account, links it when none is, and replaces their previous identity", async () => {
    const { db, identities, accounts } = fakeDb();
    accounts.set(`${U}|lichess`, linkedRow(U, "ZHIGALKO_SERGEI"));
    await linkIdentity(db, U, lichessId());
    expect(accounts.get(`${U}|lichess`)).toMatchObject({ username: "Zhigalko_Sergei", verified: true });
    expect(identities.get("lichess|zhigalko_sergei")?.user_id).toBe(U);

    await linkIdentity(db, V, lichessId({ providerUserId: "other", username: "Other" }));
    expect(accounts.get(`${V}|lichess`)).toMatchObject({ username: "Other", verified: true });
    accounts.delete(`${V}|lichess`);
    await linkIdentity(db, V, lichessId({ providerUserId: "other2", username: "Other2" }));
    expect([...identities.values()].filter((r) => r.user_id === V).map((r) => r.provider_user_id)).toEqual(["other2"]);
  });

  it("linking refuses an identity another account holds, and a different name from the one linked", async () => {
    const { db, accounts, identities } = fakeDb();
    identities.set("lichess|zhigalko_sergei", { provider: "lichess", provider_user_id: "zhigalko_sergei", user_id: V, username: "Zhigalko_Sergei" });
    await expect(linkIdentity(db, U, lichessId())).rejects.toMatchObject({ code: "oauth_taken" });
    identities.clear();
    accounts.set(`${U}|lichess`, linkedRow(U, "someone_else"));
    await expect(linkIdentity(db, U, lichessId())).rejects.toMatchObject({ code: "oauth_mismatch" });
    expect(accounts.get(`${U}|lichess`)).toMatchObject({ username: "someone_else", verified: false });
    expect(identities.size).toBe(0);
  });
});
