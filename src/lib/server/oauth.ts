/**
 * Server side of "Sign in with Lichess / Chess.com" (ADR 0009): provider
 * config, PKCE and the flow cookie, the code exchange, reading the identity,
 * and what a sign-in or a link does to the accounts. Pure apart from the
 * injected `OAuthDb` and `fetch`, so it is unit-tested without Supabase or the
 * providers. The routes are /api/auth/oauth/[provider] and …/callback.
 *
 * Identities are keyed by the provider's stable user id (oauth_identities,
 * migration 0010). A first sign-in creates an app account with a placeholder
 * email; a signed-in player can attach an identity instead ("link"), which also
 * marks their linked account verified. No provider tokens are kept.
 */
import { createHash, randomBytes } from "node:crypto";
import { lichessProfile, type LichessUser } from "@/lib/insights/sources/lichess";
import type { Ratings } from "@/lib/insights/types";
import { USERNAME_RE } from "@/lib/auth";
import { isOAuthProvider, PLACEHOLDER_EMAIL_DOMAIN, type OAuthIntent, type OAuthProvider } from "@/lib/oauth/providers";
import type { AccountRow, InsightsDb } from "./insights";

/** the error codes the routes put on /auth?error=… or ?oauth_error=… (messages in lib/auth.ts) */
export type OAuthErrorCode = "oauth_denied" | "oauth_state" | "oauth_failed" | "oauth_unavailable" | "oauth_taken" | "oauth_mismatch" | "oauth_closed" | "oauth_signin_needed";

export class OAuthError extends Error {
  constructor(
    readonly code: OAuthErrorCode,
    detail?: string
  ) {
    super(detail ?? code);
  }
}

// ── provider config ─────────────────────────────────────────────────────────

export interface ProviderConfig {
  provider: OAuthProvider;
  authorizeUrl: string;
  tokenUrl: string;
  clientId: string;
  /** confidential clients only (Chess.com may issue one); sent as client_secret_post */
  clientSecret?: string;
  scope: string;
  /** Lichess: where /api/account and token revocation live */
  apiBase?: string;
  /** Chess.com: the expected `iss` of the ID token, when configured */
  issuer?: string;
}

type Env = Record<string, string | undefined>;

/**
 * null when the provider isn't configured. Lichess needs nothing: the client id
 * is only shown on its consent screen, so it defaults to this site's host.
 * Chess.com's endpoints come from the credentials it issues on approval.
 */
export function providerConfig(p: OAuthProvider, env: Env, host: string): ProviderConfig | null {
  if (p === "lichess") {
    const base = (env.LICHESS_HOST || "https://lichess.org").replace(/\/+$/, "");
    return { provider: p, authorizeUrl: `${base}/oauth`, tokenUrl: `${base}/api/token`, apiBase: base, clientId: env.LICHESS_CLIENT_ID || host, scope: "" };
  }
  const clientId = env.NEXT_PUBLIC_CHESSCOM_CLIENT_ID;
  if (!clientId || !env.CHESSCOM_AUTHORIZE_URL || !env.CHESSCOM_TOKEN_URL) return null;
  return {
    provider: p,
    authorizeUrl: env.CHESSCOM_AUTHORIZE_URL,
    tokenUrl: env.CHESSCOM_TOKEN_URL,
    clientId,
    clientSecret: env.CHESSCOM_CLIENT_SECRET || undefined,
    scope: env.CHESSCOM_SCOPE || "openid profile",
    issuer: env.CHESSCOM_ISSUER || undefined,
  };
}

export const redirectUri = (origin: string, p: OAuthProvider) => `${origin}/api/auth/oauth/${p}/callback`;

/** `path` (a safeNext path) on `origin` with `params` added to its query. */
export function withParams(origin: string, path: string, params: Record<string, string>): string {
  const u = new URL(path, origin);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}

/** Where a failed flow lands: a sign-in back on /auth with the reason; a link back where it started, which shows it. */
export function failUrl(origin: string, p: OAuthProvider, intent: OAuthIntent, next: string, code: OAuthErrorCode): string {
  return intent === "signin" ? withParams(origin, "/auth", { error: code, next }) : withParams(origin, next, { oauth: p, oauth_error: code });
}

// ── PKCE, state and the flow cookie ─────────────────────────────────────────

export function pkce(): { verifier: string; challenge: string } {
  // 43 characters of base64url, the shortest verifier RFC 7636 allows
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

export const randomState = () => randomBytes(24).toString("base64url");

export function authorizeUrl(cfg: ProviderConfig, o: { state: string; challenge: string; redirectUri: string }): string {
  const u = new URL(cfg.authorizeUrl);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", cfg.clientId);
  u.searchParams.set("redirect_uri", o.redirectUri);
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("code_challenge", o.challenge);
  u.searchParams.set("state", o.state);
  if (cfg.scope) u.searchParams.set("scope", cfg.scope);
  return u.toString();
}

/** What the start route remembers for the callback, in an httpOnly cookie scoped to /api/auth/oauth. */
export interface Flow {
  p: OAuthProvider;
  /** state */
  s: string;
  /** PKCE verifier */
  v: string;
  i: OAuthIntent;
  /** where to continue (already through safeNext) */
  n: string;
}

export const FLOW_COOKIE = "oauth_flow";
export const FLOW_COOKIE_PATH = "/api/auth/oauth";
export const FLOW_MAX_AGE_S = 600;

export const encodeFlow = (f: Flow) => Buffer.from(JSON.stringify(f)).toString("base64url");

export function decodeFlow(raw: string | undefined): Flow | null {
  if (!raw || raw.length > 1024) return null;
  try {
    const f = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Partial<Flow>;
    const str = (x: unknown): x is string => typeof x === "string" && x.length > 0 && x.length <= 300;
    if (!isOAuthProvider(f.p) || !str(f.s) || !str(f.v) || (f.i !== "signin" && f.i !== "link") || !str(f.n) || !f.n.startsWith("/")) return null;
    return { p: f.p, s: f.s, v: f.v, i: f.i, n: f.n };
  } catch {
    return null;
  }
}

// ── code exchange and identity ──────────────────────────────────────────────

export interface Identity {
  provider: OAuthProvider;
  providerUserId: string;
  username: string;
  /** Lichess sends ratings with the account; Chess.com's come with the first sync */
  ratings?: Ratings;
}

interface TokenResponse {
  access_token: string;
  id_token?: string;
}

type Fetch = typeof fetch;

const PROVIDER_USER_ID = /^[A-Za-z0-9_.:-]{1,64}$/;
/** the linked_accounts / oauth_identities username rule */
const PLATFORM_USERNAME = /^[A-Za-z0-9][A-Za-z0-9_-]{1,29}$/;

export async function exchangeCode(cfg: ProviderConfig, code: string, verifier: string, redirect: string, fetchFn: Fetch): Promise<TokenResponse> {
  const body = new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: redirect, client_id: cfg.clientId });
  if (cfg.clientSecret) body.set("client_secret", cfg.clientSecret);
  const res = await fetchFn(cfg.tokenUrl, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body });
  const json = (await res.json().catch(() => null)) as Partial<TokenResponse> | null;
  if (!res.ok || typeof json?.access_token !== "string") throw new OAuthError("oauth_failed", `${cfg.provider} token endpoint answered ${res.status}`);
  return { access_token: json.access_token, id_token: typeof json.id_token === "string" ? json.id_token : undefined };
}

/** Reads the Lichess account behind the token, then revokes the token: nothing here needs it again. */
async function lichessIdentity(cfg: ProviderConfig, token: string, fetchFn: Fetch): Promise<Identity> {
  const auth = { Authorization: `Bearer ${token}` };
  try {
    const res = await fetchFn(`${cfg.apiBase}/api/account`, { headers: { ...auth, Accept: "application/json" } });
    if (!res.ok) throw new OAuthError("oauth_failed", `lichess /api/account answered ${res.status}`);
    const u = (await res.json()) as LichessUser;
    if (u?.disabled) throw new OAuthError("oauth_closed");
    const profile = lichessProfile(u);
    if (!profile || typeof u.id !== "string" || !PROVIDER_USER_ID.test(u.id) || !PLATFORM_USERNAME.test(profile.username)) {
      throw new OAuthError("oauth_failed", "unexpected lichess account");
    }
    return { provider: "lichess", providerUserId: u.id, username: profile.username, ratings: profile.ratings };
  } finally {
    await fetchFn(`${cfg.apiBase}/api/token`, { method: "DELETE", headers: auth }).catch(() => undefined);
  }
}

function jwtClaims(jwt: string): Record<string, unknown> | null {
  const part = jwt.split(".")[1];
  if (!part) return null;
  try {
    const c = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as unknown;
    return typeof c === "object" && c !== null && !Array.isArray(c) ? (c as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * The Chess.com identity from the ID token. Its signature isn't checked: the
 * token came straight from the token endpoint over TLS in exchange for our
 * code and verifier (OpenID Connect Core § 3.1.3.7), so audience, expiry and
 * (when configured) issuer are what's left to check.
 *
 * Which claim carries the username is to be confirmed against Chess.com's docs
 * once the app is approved; `preferred_username`, then `username`, are tried.
 */
export function chesscomIdentity(cfg: ProviderConfig, tokens: TokenResponse, now: Date): Identity {
  const c = tokens.id_token ? jwtClaims(tokens.id_token) : null;
  if (!c) throw new OAuthError("oauth_failed", "no chess.com id token");
  const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
  if (!aud.includes(cfg.clientId)) throw new OAuthError("oauth_failed", "id token audience");
  if (typeof c.exp !== "number" || c.exp * 1000 < now.getTime()) throw new OAuthError("oauth_failed", "id token expired");
  if (cfg.issuer && c.iss !== cfg.issuer) throw new OAuthError("oauth_failed", "id token issuer");
  if (typeof c.sub !== "string" || !PROVIDER_USER_ID.test(c.sub)) throw new OAuthError("oauth_failed", "id token subject");
  const username = [c.preferred_username, c.username].find((x): x is string => typeof x === "string" && PLATFORM_USERNAME.test(x));
  if (!username) throw new OAuthError("oauth_failed", "id token has no username");
  return { provider: "chesscom", providerUserId: c.sub, username };
}

export async function fetchIdentity(cfg: ProviderConfig, code: string, verifier: string, redirect: string, fetchFn: Fetch, now: Date): Promise<Identity> {
  const tokens = await exchangeCode(cfg, code, verifier, redirect, fetchFn);
  return cfg.provider === "lichess" ? lichessIdentity(cfg, tokens.access_token, fetchFn) : chesscomIdentity(cfg, tokens, now);
}

// ── accounts ────────────────────────────────────────────────────────────────

export interface IdentityRow {
  provider: OAuthProvider;
  provider_user_id: string;
  user_id: string;
  username: string;
}

export interface OAuthDb extends Pick<InsightsDb, "getAccount" | "putAccount" | "updateAccount"> {
  findIdentity(provider: OAuthProvider, providerUserId: string): Promise<IdentityRow | null>;
  /**
   * Attach the identity to row.user_id, replacing that user's previous identity
   * for the provider. Throws OAuthError("oauth_taken") if another user holds it.
   */
  putIdentity(row: IdentityRow): Promise<void>;
  /** refresh username / last_used_at on sign-in */
  touchIdentity(provider: OAuthProvider, providerUserId: string, username: string): Promise<void>;
  /** the auth user with this email, created (confirmed, with `username` as the requested name) if missing; returns its id */
  ensureUser(email: string, username: string | undefined): Promise<string>;
}

/**
 * The placeholder address of an account created by an OAuth sign-in: derived
 * from the provider's user id, so a retried or concurrent first sign-in finds
 * the same auth user. Ids that aren't already lowercase-safe are hashed
 * (Supabase lowercases emails, and "AbC" must not meet "abc").
 */
export function placeholderEmail(i: Pick<Identity, "provider" | "providerUserId">): string {
  const id = /^[a-z0-9_-]{1,40}$/.test(i.providerUserId) ? i.providerUserId : createHash("sha256").update(i.providerUserId).digest("hex").slice(0, 32);
  return `${i.provider}.${id}@${PLACEHOLDER_EMAIL_DOMAIN}`;
}

/** The provider's name as an app username when it fits the rule (the sign-up trigger adds a suffix if it's taken). */
export function suggestUsername(name: string): string | undefined {
  const s = name.replace(/-/g, "_").slice(0, 20);
  return USERNAME_RE.test(s) ? s : undefined;
}

const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Marks the player's linked account for this platform verified, creating it when `create` and there is none. */
async function markVerified(db: OAuthDb, userId: string, i: Identity, create: boolean): Promise<void> {
  const linked = await db.getAccount(userId, i.provider);
  if (linked && sameName(linked.username, i.username)) {
    await db.updateAccount(userId, i.provider, linked.username, { username: i.username, verified: true, ...(i.ratings ? { ratings: i.ratings } : {}) });
  } else if (!linked && create) {
    const row: AccountRow = {
      user_id: userId,
      platform: i.provider,
      username: i.username,
      verified: true,
      ratings: i.ratings ?? {},
      last_synced_at: null,
      last_game_at: null,
      sync_window_start: null,
      sync_calls: 0,
    };
    await db.putAccount(row, false);
  }
}

/**
 * Sign in with the identity: its app account, or a new one (placeholder email,
 * the provider's name as the requested username, the platform linked and
 * verified). Returns the auth user id to start a session for.
 */
export async function signIn(db: OAuthDb, i: Identity): Promise<{ userId: string; created: boolean }> {
  const found = await db.findIdentity(i.provider, i.providerUserId);
  if (found) {
    await db.touchIdentity(i.provider, i.providerUserId, i.username);
    // an already-linked account under the same name gets the proof (and fresh ratings); an unlinked one stays unlinked
    await markVerified(db, found.user_id, i, false);
    return { userId: found.user_id, created: false };
  }
  const userId = await db.ensureUser(placeholderEmail(i), suggestUsername(i.username));
  await db.putIdentity({ provider: i.provider, provider_user_id: i.providerUserId, user_id: userId, username: i.username });
  await markVerified(db, userId, i, true);
  return { userId, created: true };
}

/**
 * Attach the identity to the signed-in player (Settings / Insights "Verify"):
 * it then signs in to this account, and the linked account is verified (or
 * linked, when none is). Refuses an identity another account holds, and one
 * whose name differs from the username already linked (that would silently
 * replace the linked account and delete its games).
 */
export async function linkIdentity(db: OAuthDb, userId: string, i: Identity): Promise<void> {
  const owner = await db.findIdentity(i.provider, i.providerUserId);
  if (owner && owner.user_id !== userId) throw new OAuthError("oauth_taken");
  const linked = await db.getAccount(userId, i.provider);
  if (linked && !sameName(linked.username, i.username)) throw new OAuthError("oauth_mismatch");
  await db.putIdentity({ provider: i.provider, provider_user_id: i.providerUserId, user_id: userId, username: i.username });
  await markVerified(db, userId, i, true);
}
