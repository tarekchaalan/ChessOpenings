"use client";
/** Email + OAuth sign-in. Guests keep local progress; accounts add sync + leaderboard. */
import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Crown, Loader2, Mail } from "lucide-react";
import { getSupabase, supabaseConfigured } from "@/lib/supabase/client";

type Mode = "signin" | "signup" | "magic";

export default function AuthClient() {
  const router = useRouter();
  const params = useSearchParams();
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "error" | "ok"; text: string } | null>(
    params.get("error") ? { kind: "error", text: "Sign-in failed — please try again." } : null
  );

  if (!supabaseConfigured()) {
    return (
      <div className="max-w-md mx-auto py-20 text-center">
        <Crown className="mx-auto text-accent mb-3" size={28} />
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
  const callbackUrl = () => `${window.location.origin}/auth/callback`;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      if (mode === "magic") {
        const { error } = await sb.auth.signInWithOtp({
          email,
          options: { emailRedirectTo: callbackUrl() },
        });
        if (error) throw error;
        setMsg({ kind: "ok", text: "Check your email for the sign-in link." });
      } else if (mode === "signup") {
        const { error } = await sb.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: callbackUrl() },
        });
        if (error) throw error;
        setMsg({ kind: "ok", text: "Account created — check your email to confirm, then sign in." });
      } else {
        const { error } = await sb.auth.signInWithPassword({ email, password });
        if (error) throw error;
        router.push("/");
      }
    } catch (err) {
      setMsg({ kind: "error", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  const oauth = async (provider: "google" | "github") => {
    setBusy(true);
    const { error } = await sb.auth.signInWithOAuth({
      provider,
      options: { redirectTo: callbackUrl() },
    });
    if (error) {
      setMsg({ kind: "error", text: error.message });
      setBusy(false);
    }
  };

  const tab = (m: Mode, label: string) => (
    <button
      key={m}
      onClick={() => {
        setMode(m);
        setMsg(null);
      }}
      className={`flex-1 h-9 text-sm rounded-md transition-colors ${
        mode === m ? "bg-surface font-medium shadow-sm" : "text-muted hover:text-foreground"
      }`}
    >
      {label}
    </button>
  );

  return (
    <div className="max-w-sm mx-auto py-16">
      <div className="text-center mb-8">
        <span className="inline-grid w-12 h-12 place-items-center rounded-xl bg-accent text-accent-fg mb-3">
          <Crown size={24} strokeWidth={2.5} />
        </span>
        <h1 className="text-xl font-semibold tracking-tight">Welcome back</h1>
        <p className="text-sm text-muted mt-1">
          Sync progress across devices and join the leaderboard.
        </p>
      </div>

      <div className="flex gap-1 rounded-lg bg-surface-2 p-1 mb-5">
        {tab("signin", "Sign in")}
        {tab("signup", "Sign up")}
        {tab("magic", "Magic link")}
      </div>

      <form onSubmit={submit} className="space-y-3">
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          className="w-full h-10 px-3 rounded-lg border border-edge bg-surface text-sm outline-none focus:border-accent transition-colors"
        />
        {mode !== "magic" && (
          <input
            type="password"
            required
            minLength={6}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="password"
            className="w-full h-10 px-3 rounded-lg border border-edge bg-surface text-sm outline-none focus:border-accent transition-colors"
          />
        )}
        <button
          type="submit"
          disabled={busy}
          className="w-full h-10 rounded-lg bg-accent text-accent-fg text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-50 flex items-center justify-center gap-2"
        >
          {busy ? <Loader2 size={15} className="animate-spin" /> : <Mail size={15} />}
          {mode === "signin" ? "Sign in" : mode === "signup" ? "Create account" : "Send magic link"}
        </button>
      </form>

      {msg && (
        <p
          className={`text-sm mt-3 text-center ${
            msg.kind === "error" ? "text-danger" : "text-accent"
          }`}
        >
          {msg.text}
        </p>
      )}

      <div className="flex items-center gap-3 my-6">
        <div className="h-px flex-1 bg-[var(--border)]" />
        <span className="text-xs text-muted">or continue with</span>
        <div className="h-px flex-1 bg-[var(--border)]" />
      </div>

      <div className="grid grid-cols-2 gap-2">
        <button
          onClick={() => oauth("google")}
          disabled={busy}
          className="h-10 rounded-lg border border-edge bg-surface text-sm hover:bg-surface-2 transition-colors disabled:opacity-50"
        >
          Google
        </button>
        <button
          onClick={() => oauth("github")}
          disabled={busy}
          className="h-10 rounded-lg border border-edge bg-surface text-sm hover:bg-surface-2 transition-colors disabled:opacity-50"
        >
          GitHub
        </button>
      </div>

      <p className="text-xs text-muted text-center mt-6">
        Guest progress stays in this browser and is not merged into your account.
      </p>
    </div>
  );
}
