/**
 * "Sign in with Lichess / Chess.com" (ADR 0009), the parts the browser needs:
 * which providers to offer and where their buttons go. The flow itself runs in
 * /api/auth/oauth/[provider] (start) and …/callback (lib/server/oauth.ts).
 *
 * Lichess OAuth needs no registration (any client id, PKCE). Chess.com issues
 * a client id only after approving an application, so its buttons appear once
 * NEXT_PUBLIC_CHESSCOM_CLIENT_ID is set (the server also needs its endpoints).
 */
import { safeNext } from "@/lib/auth";
import { PLATFORMS, type Platform } from "@/lib/insights/types";

export type OAuthProvider = Platform;
/** signin: sign in (or sign up) with the provider; link: verify it for the signed-in player */
export type OAuthIntent = "signin" | "link";

export const isOAuthProvider = (x: unknown): x is OAuthProvider => PLATFORMS.includes(x as OAuthProvider);

/**
 * Accounts created by an OAuth sign-in get a placeholder address on a reserved
 * domain (RFC 2606): nothing is ever sent to it, and Settings hides the email
 * and password cards for it.
 */
export const PLACEHOLDER_EMAIL_DOMAIN = "oauth.invalid";
export const isPlaceholderEmail = (email: string | null | undefined) => !!email && email.toLowerCase().endsWith(`@${PLACEHOLDER_EMAIL_DOMAIN}`);

export function oauthEnabled(p: OAuthProvider): boolean {
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) return false;
  return p === "lichess" || Boolean(process.env.NEXT_PUBLIC_CHESSCOM_CLIENT_ID);
}

export function oauthStartUrl(p: OAuthProvider, intent: OAuthIntent, next = "/"): string {
  return `/api/auth/oauth/${p}?intent=${intent}&next=${encodeURIComponent(safeNext(next))}`;
}
