import { NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import type { EmailOtpType } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { safeNext } from "@/lib/auth";

const OTP_TYPES = new Set<EmailOtpType>(["signup", "invite", "magiclink", "recovery", "email_change", "email"]);

/** Where each kind of email link continues when it carries no `next`. */
const DEFAULT_NEXT: Partial<Record<EmailOtpType, string>> = { recovery: "/auth/reset", email_change: "/settings?email=changed" };

/**
 * Email-link callback (sign-up confirmation, magic link, password reset,
 * email change). Two link shapes:
 *  - `?token_hash=…&type=…` (our email templates): verified server-side, so it
 *    works in any browser, e.g. a phone's mail app;
 *  - `?code=…` (Supabase's default templates, PKCE): needs the code verifier
 *    cookie, so only the browser that asked for the email can finish it.
 * Errors Supabase puts on the URL (expired or reused links) are passed on to
 * /auth so the page can say what happened.
 */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;
  const fail = (reason: string) => NextResponse.redirect(`${origin}/auth?error=${encodeURIComponent(reason)}`);

  const upstream = searchParams.get("error_code") ?? searchParams.get("error");
  if (upstream) return fail(upstream);

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return fail("auth_callback_failed");

  const cookieStore = await cookies();
  const supabase = createServerClient(url, key, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (list) => list.forEach(({ name, value, options }) => cookieStore.set(name, value, options)),
    },
  });

  let kind: EmailOtpType | null = null;
  if (tokenHash && type && OTP_TYPES.has(type)) {
    const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type });
    if (error) return fail(error.code ?? "otp_expired");
    kind = type;
  } else if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) return fail(error.code ?? "auth_callback_failed");
  } else {
    return fail("missing_code");
  }

  const next = safeNext(searchParams.get("next"), (kind && DEFAULT_NEXT[kind]) ?? "/");
  // a reset link always ends on the new-password form, whatever `next` says
  return NextResponse.redirect(`${origin}${kind === "recovery" ? "/auth/reset" : next}`);
}
