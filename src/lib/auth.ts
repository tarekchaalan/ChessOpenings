/**
 * Shared auth helpers (client and server): the username rule, a safe `next`
 * redirect, the email-link URLs, and one place that turns Supabase Auth
 * errors into messages a player can act on.
 */

export const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;
export const USERNAME_RULE = "3–20 characters: letters, numbers, underscores.";

/** Supabase allows one email per address per 60 s by default; the UI waits the same. */
export const EMAIL_COOLDOWN_S = 60;

/**
 * A same-origin path to continue to after sign-in, or "/". Rejects absolute
 * and protocol-relative URLs ("//evil.com", "/\\evil.com") and anything that
 * would make `${origin}${next}` point at another host ("@evil.com").
 */
export function safeNext(next: string | null | undefined, fallback = "/"): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return fallback;
  if (/[\u0000-\u001f\\]/.test(next)) return fallback;
  return next;
}

/** Where email links land: the callback exchanges or verifies, then continues to `next`. */
export function callbackUrl(origin: string, next = "/"): string {
  return `${origin}/auth/callback?next=${encodeURIComponent(safeNext(next))}`;
}

type AuthLikeError = { code?: string; status?: number; message?: string; name?: string } | null | undefined;

/** Error codes the callback forwards to /auth?error=… (ours and Supabase's). */
const CALLBACK_MESSAGES: Record<string, string> = {
  otp_expired: "That link has expired or was already used. Request a new one below.",
  access_denied: "That link has expired or was already used. Request a new one below.",
  flow_state_not_found: "That link was opened in a different browser than the one that requested it. Request a new link here, or use the code from the email.",
  pkce_code_verifier_not_found: "That link was opened in a different browser than the one that requested it. Request a new link here, or use the code from the email.",
  bad_code_verifier: "That link was opened in a different browser than the one that requested it. Request a new link here, or use the code from the email.",
  missing_code: "That sign-in link is incomplete. Request a new one below.",
  auth_callback_failed: "Sign-in failed. Please try again.",
  // Lichess / Chess.com sign-in (lib/server/oauth.ts)
  oauth_denied: "Sign-in was cancelled. Try again whenever you're ready.",
  oauth_state: "That sign-in expired or was started in another tab. Please try again.",
  oauth_failed: "We couldn't confirm that account. Please try again.",
  oauth_unavailable: "That sign-in option isn't set up on this deployment.",
  oauth_taken: "That account already signs in to a different account here. Sign in with it instead.",
  oauth_mismatch: "You signed in as a different account from the one linked here. Unlink it first, or switch accounts on that site and try again.",
  oauth_closed: "That account is closed.",
  oauth_signin_needed: "Your session ended before we could finish. Sign in, then try again.",
};

export function callbackErrorMessage(code: string | null): string | null {
  if (!code) return null;
  return CALLBACK_MESSAGES[code] ?? CALLBACK_MESSAGES.auth_callback_failed;
}

/** A player-facing message for a Supabase Auth (or PostgREST) error. */
export function authErrorMessage(err: unknown): string {
  const e = (err ?? {}) as AuthLikeError & object;
  const code = e?.code ?? "";
  const msg = e?.message ?? (typeof err === "string" ? err : "");
  switch (code) {
    case "invalid_credentials":
      return "Wrong email or password.";
    case "email_not_confirmed":
      return "Confirm your email first: open the link we sent you. You can resend it below.";
    case "user_already_exists":
    case "email_exists":
      return "An account with this email already exists. Sign in, or reset your password.";
    case "weak_password":
      return msg || "That password is too weak.";
    case "same_password":
      return "The new password must be different from the current one.";
    case "email_address_invalid":
      return "That email address isn't valid.";
    case "email_address_not_authorized":
      return "This deployment can't send email to that address yet (no email provider is set up). Contact the site owner.";
    case "over_email_send_rate_limit":
      return "Too many emails sent. Wait a minute, then try again.";
    case "over_request_rate_limit":
      return "Too many attempts. Wait a minute, then try again.";
    case "otp_expired":
      return "That code has expired or is wrong. Request a new one.";
    case "otp_disabled":
    case "signup_disabled":
      return "No account uses this email. Sign up first.";
    case "reauthentication_needed":
    case "reauthentication_not_valid":
      return "For security, sign out and back in, then change your password.";
    case "session_not_found":
    case "refresh_token_not_found":
    case "user_not_found":
      return "Your session has ended. Sign in again.";
    case "23505":
      return "That username is taken.";
    case "23514":
      return `Usernames are ${USERNAME_RULE.toLowerCase()}`;
  }
  if (e?.status === 429 || /rate limit|only request this after/i.test(msg)) return "Too many attempts. Wait a minute, then try again.";
  if (/signups not allowed for otp/i.test(msg)) return "No account uses this email. Sign up first.";
  if (/error sending .*email/i.test(msg)) return "We couldn't send the email. Please try again in a few minutes.";
  if (/failed to fetch|network/i.test(msg)) return "Couldn't reach the server. Check your connection and try again.";
  return msg || "Something went wrong. Please try again.";
}
