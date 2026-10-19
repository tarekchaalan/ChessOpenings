"use client";
/**
 * Email sign-in: password, magic link (or its one-time code), sign-up and
 * password reset. Guests keep local progress; accounts add sync + leaderboard.
 */
import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Check, Loader2, Mail, X } from "lucide-react";
import Logo from "@/components/Logo";
import PasswordRequirements from "@/components/auth/PasswordRequirements";
import { passwordValid, PASSWORD_POLICY_TEXT } from "@/lib/password";
import { authErrorMessage, callbackErrorMessage, callbackUrl, EMAIL_COOLDOWN_S, safeNext, USERNAME_RE, USERNAME_RULE } from "@/lib/auth";
import { getSupabase, supabaseConfigured } from "@/lib/supabase/client";
import { useAuth } from "@/lib/supabase/AuthProvider";

type Mode = "signin" | "signup" | "magic" | "forgot";
type Msg = { kind: "error" | "ok"; text: string } | null;
/** what the last email was, so "Resend" sends the same kind again */
type Sent = { kind: "signup" | "magic" | "forgot"; email: string } | null;

const TITLES: Record<Mode, { h: string; p: string }> = {
  signin: { h: "Welcome back", p: "Sync progress across devices and join the leaderboard." },
  signup: { h: "Create an account", p: "Sync progress across devices and join the leaderboard." },
  magic: { h: "Sign in by email", p: "We'll email you a sign-in link and a one-time code." },
  forgot: { h: "Reset your password", p: "We'll email you a link to choose a new password." },
};

const inputCls = "w-full h-10 px-3 rounded-lg border border-edge bg-surface text-sm outline-none focus:border-accent transition-colors";

export default function AuthClient() {
  const router = useRouter();
  const params = useSearchParams();
  const next = safeNext(params.get("next"));
  const { user, username: currentName, loading, signOut } = useAuth();
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [username, setUsername] = useState("");
  // the last availability answer, for the name it was asked about
  const [nameCheck, setNameCheck] = useState<{ name: string; free: boolean } | null>(null);
  const nameFree = mode === "signup" && nameCheck?.name.toLowerCase() === username.trim().toLowerCase() ? nameCheck.free : null;
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(() => {
    const text = callbackErrorMessage(params.get("error"));
    return text ? { kind: "error", text } : null;
  });
  const [sent, setSent] = useState<Sent>(null);
  const [unconfirmed, setUnconfirmed] = useState(false);
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  // live availability while typing a username (debounced; silent if the check isn't deployed)
  useEffect(() => {
    const client = getSupabase();
    const name = username.trim();
    if (!client || mode !== "signup" || !USERNAME_RE.test(name)) return;
    let alive = true;
    const t = setTimeout(async () => {
      const { data, error } = await client.rpc("username_available", { p_name: name });
      if (alive && !error) setNameCheck({ name, free: Boolean(data) });
    }, 350);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [mode, username]);

  if (!supabaseConfigured()) {
    return (
      <div className="max-w-md mx-auto py-20 text-center">
        <Logo className="mx-auto mb-3" size={40} />
        <h1 className="text-xl font-semibold mb-2">Accounts not configured</h1>
        <p className="text-sm text-muted mb-6">
          This deployment is running without Supabase. Your progress is saved in this browser.
          To enable accounts and the leaderboard, set{" "}
          <code className="font-mono text-xs">NEXT_PUBLIC_SUPABASE_URL</code> and{" "}
          <code className="font-mono text-xs">NEXT_PUBLIC_SUPABASE_ANON_KEY</code> — see the README.
        </p>
        <Link href="/" className="text-accent underline text-sm">
          Back to training
        </Link>
      </div>
    );
  }

  const sb = getSupabase()!;
  const cleanEmail = email.trim();
  const finish = () => {
    router.replace(next);
    router.refresh();
  };

  if (!loading && user && !sent) {
    return (
      <div className="max-w-sm mx-auto py-16 text-center" data-testid="auth-signed-in">
        <h1 className="text-xl font-semibold tracking-tight">You&apos;re signed in</h1>
        <p className="text-sm text-muted mt-1">
          as <span className="text-foreground font-medium">{currentName ?? user.email}</span>
        </p>
        <div className="flex justify-center gap-2 mt-6">
          <Link href={next} className="inline-flex items-center px-4 h-10 rounded-lg bg-accent text-accent-fg text-sm font-medium hover:opacity-90">
            Continue
          </Link>
          <button onClick={() => signOut()} className="px-4 h-10 rounded-lg border border-edge bg-surface text-sm hover:bg-surface-2">
            Use another account
          </button>
        </div>
      </div>
    );
  }

  const switchMode = (m: Mode) => {
    setMode(m);
    setMsg(null);
    setSent(null);
    setUnconfirmed(false);
    setCode("");
  };

  /** Sends (or re-sends) the email for `kind`; returns false on error (message already shown). */
  const sendEmail = async (kind: NonNullable<Sent>["kind"], to: string): Promise<boolean> => {
    if (kind === "magic") {
      // sign-in only: new players sign up so they choose their username
      const { error } = await sb.auth.signInWithOtp({ email: to, options: { emailRedirectTo: callbackUrl(window.location.origin, next), shouldCreateUser: false } });
      if (error) throw error;
    } else if (kind === "forgot") {
      const { error } = await sb.auth.resetPasswordForEmail(to, { redirectTo: callbackUrl(window.location.origin, "/auth/reset") });
      if (error) throw error;
    } else {
      const { error } = await sb.auth.resend({ type: "signup", email: to, options: { emailRedirectTo: callbackUrl(window.location.origin, next) } });
      if (error) throw error;
    }
    setSent({ kind, email: to });
    setCooldown(EMAIL_COOLDOWN_S);
    return true;
  };

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
    } catch (err) {
      const e = err as { code?: string };
      if (e?.code === "email_not_confirmed") setUnconfirmed(true);
      setMsg({ kind: "error", text: authErrorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    void run(async () => {
      if (mode === "signin") {
        setUnconfirmed(false);
        const { error } = await sb.auth.signInWithPassword({ email: cleanEmail, password });
        if (error) throw error;
        finish();
      } else if (mode === "magic") {
        await sendEmail("magic", cleanEmail);
        setMsg({ kind: "ok", text: `Check ${cleanEmail} for a sign-in link, or enter the code from the email below.` });
      } else if (mode === "forgot") {
        await sendEmail("forgot", cleanEmail);
        // the same answer whether or not the account exists
        setMsg({ kind: "ok", text: `If an account uses ${cleanEmail}, a reset link is on its way.` });
      } else {
        const name = username.trim();
        if (!USERNAME_RE.test(name)) throw new Error(`Usernames are ${USERNAME_RULE.toLowerCase()}`);
        if (!passwordValid(password)) throw new Error(PASSWORD_POLICY_TEXT);
        const avail = await sb.rpc("username_available", { p_name: name });
        if (!avail.error && avail.data === false) {
          setNameCheck({ name, free: false });
          throw new Error("That username is taken. Pick another one.");
        }
        const { data, error } = await sb.auth.signUp({
          email: cleanEmail,
          password,
          options: { emailRedirectTo: callbackUrl(window.location.origin, next), data: { username: name } },
        });
        if (error) throw error;
        if (data.session) {
          // email confirmation is off: signed in already
          finish();
          return;
        }
        if (data.user && data.user.identities?.length === 0) {
          // Supabase hides existing accounts behind a fake success
          throw Object.assign(new Error(), { code: "user_already_exists" });
        }
        setSent({ kind: "signup", email: cleanEmail });
        setCooldown(EMAIL_COOLDOWN_S);
        setMsg({ kind: "ok", text: `Almost there: open the confirmation link we sent to ${cleanEmail}.` });
      }
    });
  };

  const resend = () =>
    run(async () => {
      const kind = sent?.kind ?? "signup";
      const to = sent?.email ?? cleanEmail;
      await sendEmail(kind, to);
      setUnconfirmed(false);
      setMsg({ kind: "ok", text: `Sent again to ${to}.` });
    });

  const verifyCode = (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || !sent) return;
    void run(async () => {
      const { error } = await sb.auth.verifyOtp({ email: sent.email, token: code.trim(), type: "email" });
      if (error) throw error;
      finish();
    });
  };

  const tab = (m: Mode, label: string) => (
    <button
      key={m}
      type="button"
      role="tab"
      aria-selected={mode === m}
      onClick={() => switchMode(m)}
      className={`flex-1 h-9 text-sm rounded-md transition-colors ${mode === m ? "bg-surface font-medium shadow-sm" : "text-muted hover:text-foreground"}`}
      data-testid={`auth-tab-${m}`}
    >
      {label}
    </button>
  );

  const canResend = sent || unconfirmed;
  return (
    <div className="max-w-sm mx-auto py-16">
      <div className="text-center mb-8">
        <Logo size={48} className="mx-auto mb-3" />
        <h1 className="text-xl font-semibold tracking-tight">{TITLES[mode].h}</h1>
        <p className="text-sm text-muted mt-1">{TITLES[mode].p}</p>
      </div>

      <div className="flex gap-1 rounded-lg bg-surface-2 p-1 mb-5" role="tablist" aria-label="Sign-in method">
        {tab("signin", "Sign in")}
        {tab("signup", "Sign up")}
        {tab("magic", "Email link")}
      </div>

      <form onSubmit={submit} className="space-y-3">
        {mode === "signup" && (
          <div>
            <label htmlFor="auth-username" className="sr-only">Username</label>
            <div className="relative">
              <input
                id="auth-username"
                type="text"
                required
                minLength={3}
                maxLength={20}
                pattern="[A-Za-z0-9_]{3,20}"
                title={USERNAME_RULE}
                autoComplete="username"
                autoCapitalize="off"
                spellCheck={false}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="username (shown on the leaderboard)"
                className={`${inputCls} pr-9`}
                aria-describedby="auth-username-hint"
              />
              {nameFree !== null && (
                <span className={`absolute right-3 top-1/2 -translate-y-1/2 ${nameFree ? "text-accent" : "text-danger"}`} aria-hidden>
                  {nameFree ? <Check size={15} /> : <X size={15} />}
                </span>
              )}
            </div>
            <p id="auth-username-hint" className={`text-xs mt-1 ${nameFree === false ? "text-danger" : "text-muted"}`} aria-live="polite">
              {nameFree === false ? "That username is taken." : nameFree ? "Available." : USERNAME_RULE}
            </p>
          </div>
        )}
        <div>
          <label htmlFor="auth-email" className="sr-only">Email</label>
          <input
            id="auth-email"
            type="email"
            required
            autoComplete="email"
            inputMode="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            className={inputCls}
          />
        </div>
        {(mode === "signin" || mode === "signup") && (
          <div>
            <label htmlFor="auth-password" className="sr-only">Password</label>
            <input
              id="auth-password"
              type="password"
              required
              minLength={mode === "signup" ? 8 : undefined}
              autoComplete={mode === "signup" ? "new-password" : "current-password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="password"
              className={inputCls}
            />
          </div>
        )}
        {mode === "signup" && <PasswordRequirements password={password} />}
        <button
          type="submit"
          disabled={busy || ((mode === "magic" || mode === "forgot") && cooldown > 0 && sent?.email === cleanEmail) || (mode === "signup" && nameFree === false)}
          className="w-full h-10 rounded-lg bg-accent text-accent-fg text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-50 flex items-center justify-center gap-2"
          data-testid="auth-submit"
        >
          {busy ? <Loader2 size={15} className="animate-spin" /> : <Mail size={15} />}
          {mode === "signin" ? "Sign in" : mode === "signup" ? "Create account" : mode === "magic" ? "Email me a link" : "Send reset link"}
        </button>
        {mode === "signin" && (
          <p className="text-xs text-center">
            <button type="button" onClick={() => switchMode("forgot")} className="text-muted hover:text-foreground underline underline-offset-2">
              Forgot your password?
            </button>
          </p>
        )}
        {mode === "forgot" && (
          <p className="text-xs text-center">
            <button type="button" onClick={() => switchMode("signin")} className="text-muted hover:text-foreground underline underline-offset-2">
              Back to sign in
            </button>
          </p>
        )}
      </form>

      {msg && (
        <p role={msg.kind === "error" ? "alert" : "status"} className={`text-sm mt-3 text-center ${msg.kind === "error" ? "text-danger" : "text-accent"}`} data-testid="auth-msg">
          {msg.text}
        </p>
      )}

      {sent?.kind === "magic" && (
        <form onSubmit={verifyCode} className="mt-4 flex gap-2">
          <label htmlFor="auth-code" className="sr-only">One-time code</label>
          <input
            id="auth-code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6,10}"
            required
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            placeholder="code from the email"
            className={`${inputCls} font-mono tracking-widest`}
          />
          <button type="submit" disabled={busy || code.length < 6} className="px-4 h-10 rounded-lg border border-edge bg-surface text-sm hover:bg-surface-2 disabled:opacity-50">
            Verify
          </button>
        </form>
      )}

      {canResend && (
        <p className="text-xs text-muted text-center mt-3">
          Didn&apos;t get it? Check your spam folder, or{" "}
          <button type="button" onClick={resend} disabled={busy || cooldown > 0 || !(sent?.email ?? cleanEmail)} className="underline underline-offset-2 hover:text-foreground disabled:no-underline disabled:opacity-60" data-testid="auth-resend">
            {cooldown > 0 ? `resend in ${cooldown}s` : "send it again"}
          </button>
          .
        </p>
      )}

      <p className="text-xs text-muted text-center mt-6">Guest progress stays in this browser and is not merged into your account.</p>
    </div>
  );
}
