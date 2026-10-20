/**
 * GET /api/auth/oauth/{lichess,chesscom}/callback?code=…&state=… — finishes
 * "Sign in with …" (ADR 0009). Checks the state against the flow cookie,
 * exchanges the code (PKCE) and reads the identity, then:
 *  - signin: finds or creates the app account and starts a session on this
 *    browser (a one-time magic-link token, verified here, no email sent);
 *  - link: attaches the identity to the signed-in player and verifies their
 *    linked account.
 * It lives under /api/ so the proxy's email-link rescue leaves `?code=` alone.
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { isOAuthProvider } from "@/lib/oauth/providers";
import { decodeFlow, failUrl, fetchIdentity, FLOW_COOKIE, FLOW_COOKIE_PATH, linkIdentity, OAuthError, providerConfig, redirectUri, signIn, withParams } from "@/lib/server/oauth";
import { adminClient, cookieClient, sessionTokenHash, supabaseOAuthDb } from "@/lib/server/oauth-db";

export async function GET(request: Request, { params }: { params: Promise<{ provider: string }> }): Promise<Response> {
  const { provider } = await params;
  if (!isOAuthProvider(provider)) return Response.json({ message: "unknown provider" }, { status: 404 });
  const { searchParams, origin, host } = new URL(request.url);
  const store = await cookies();
  const flow = decodeFlow(store.get(FLOW_COOKIE)?.value);
  // single use, whatever happens next
  store.delete({ name: FLOW_COOKIE, path: FLOW_COOKIE_PATH });

  const intent = flow?.i ?? "signin";
  const next = flow?.n ?? "/";
  const fail = (code: OAuthError["code"]) => NextResponse.redirect(failUrl(origin, provider, intent, next, code));

  if (!flow || flow.p !== provider) return fail("oauth_state");
  const upstream = searchParams.get("error");
  if (upstream) return fail(upstream === "access_denied" ? "oauth_denied" : "oauth_failed");
  const code = searchParams.get("code");
  if (!code || searchParams.get("state") !== flow.s) return fail("oauth_state");

  const cfg = providerConfig(provider, process.env, host);
  const admin = adminClient();
  const sb = cookieClient(store);
  if (!cfg || !admin || !sb) return fail("oauth_unavailable");

  try {
    const identity = await fetchIdentity(cfg, code, flow.v, redirectUri(origin, provider), fetch, new Date());
    const db = supabaseOAuthDb(admin);
    if (intent === "link") {
      const { data } = await sb.auth.getUser();
      if (!data.user) return fail("oauth_signin_needed");
      await linkIdentity(db, data.user.id, identity);
      return NextResponse.redirect(withParams(origin, next, { oauth: provider, verified: "1" }));
    }
    const { userId } = await signIn(db, identity);
    const { error } = await sb.auth.verifyOtp({ type: "magiclink", token_hash: await sessionTokenHash(admin, userId) });
    if (error) throw new Error(`verifyOtp: ${error.message}`);
    return NextResponse.redirect(`${origin}${next}`);
  } catch (e) {
    if (e instanceof OAuthError && e.code !== "oauth_failed") return fail(e.code);
    console.error(`[api/auth/oauth/${provider}]`, e);
    return fail("oauth_failed");
  }
}
