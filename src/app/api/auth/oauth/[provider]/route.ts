/**
 * GET /api/auth/oauth/{lichess,chesscom}?intent=signin|link&next=/path — starts
 * "Sign in with …" (ADR 0009): a PKCE verifier and state go into an httpOnly
 * cookie for the callback, and the browser goes to the provider's consent
 * page. `link` (verify the platform for the signed-in player) needs a session.
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { safeNext } from "@/lib/auth";
import { isOAuthProvider, type OAuthIntent } from "@/lib/oauth/providers";
import { authorizeUrl, encodeFlow, failUrl, FLOW_COOKIE, FLOW_COOKIE_PATH, FLOW_MAX_AGE_S, pkce, providerConfig, randomState, redirectUri, withParams } from "@/lib/server/oauth";
import { adminClient, cookieClient } from "@/lib/server/oauth-db";

export async function GET(request: Request, { params }: { params: Promise<{ provider: string }> }): Promise<Response> {
  const { provider } = await params;
  if (!isOAuthProvider(provider)) return Response.json({ message: "unknown provider" }, { status: 404 });
  const { searchParams, origin, host } = new URL(request.url);
  const intent: OAuthIntent = searchParams.get("intent") === "link" ? "link" : "signin";
  const next = safeNext(searchParams.get("next"), intent === "link" ? "/settings" : "/");

  const cfg = providerConfig(provider, process.env, host);
  const store = await cookies();
  const sb = cookieClient(store);
  if (!cfg || !sb || !adminClient()) return NextResponse.redirect(failUrl(origin, provider, intent, next, "oauth_unavailable"));

  if (intent === "link") {
    const { data } = await sb.auth.getUser();
    if (!data.user) return NextResponse.redirect(withParams(origin, "/auth", { next }));
  }

  const { verifier, challenge } = pkce();
  const state = randomState();
  store.set(FLOW_COOKIE, encodeFlow({ p: provider, s: state, v: verifier, i: intent, n: next }), {
    httpOnly: true,
    secure: origin.startsWith("https:"),
    // the callback is a top-level GET navigation from the provider: Lax cookies go with it
    sameSite: "lax",
    path: FLOW_COOKIE_PATH,
    maxAge: FLOW_MAX_AGE_S,
  });
  return NextResponse.redirect(authorizeUrl(cfg, { state, challenge, redirectUri: redirectUri(origin, provider) }));
}
