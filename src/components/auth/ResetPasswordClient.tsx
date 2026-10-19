"use client";
/**
 * Where a password-reset email lands (via /auth/callback, which has already
 * signed the player in with the recovery link). Without that session the
 * link was expired or already used, so offer a new one.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Check, Loader2 } from "lucide-react";
import PasswordRequirements from "@/components/auth/PasswordRequirements";
import { passwordValid, PASSWORD_POLICY_TEXT } from "@/lib/password";
import { authErrorMessage } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase/client";
import { useAuth } from "@/lib/supabase/AuthProvider";

export default function ResetPasswordClient() {
  const router = useRouter();
  const { user, loading, configured } = useAuth();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  if (!configured) return null;
  if (loading) {
    return (
      <div className="py-24 grid place-items-center text-muted">
        <Loader2 className="animate-spin" size={20} />
      </div>
    );
  }
  if (!user && !done) {
    return (
      <div className="max-w-sm mx-auto py-16 text-center">
        <h1 className="text-xl font-semibold tracking-tight">This reset link has expired</h1>
        <p className="text-sm text-muted mt-2">Reset links work once and expire after an hour. Request a new one and use the latest email.</p>
        <Link href="/auth" className="inline-flex items-center mt-6 px-4 h-10 rounded-lg bg-accent text-accent-fg text-sm font-medium hover:opacity-90">
          Request a new link
        </Link>
      </div>
    );
  }

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (!passwordValid(password)) return setError(PASSWORD_POLICY_TEXT);
    if (password !== confirm) return setError("The two passwords don't match.");
    setBusy(true);
    setError(null);
    const { error: err } = await getSupabase()!.auth.updateUser({ password });
    setBusy(false);
    if (err) return setError(authErrorMessage(err));
    setDone(true);
    setTimeout(() => {
      router.replace("/");
      router.refresh();
    }, 1500);
  };

  return (
    <div className="max-w-sm mx-auto py-16">
      <h1 className="text-xl font-semibold tracking-tight text-center">Choose a new password</h1>
      <p className="text-sm text-muted mt-1 text-center">for {user?.email}</p>
      {done ? (
        <p role="status" className="mt-6 text-sm text-accent text-center flex items-center justify-center gap-1.5">
          <Check size={15} /> Password updated. Taking you back…
        </p>
      ) : (
        <form onSubmit={save} className="mt-6 space-y-3">
          <label htmlFor="reset-password" className="sr-only">New password</label>
          <input
            id="reset-password"
            type="password"
            required
            minLength={8}
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="new password"
            className="w-full h-10 px-3 rounded-lg border border-edge bg-surface text-sm outline-none focus:border-accent transition-colors"
          />
          <label htmlFor="reset-confirm" className="sr-only">Repeat the new password</label>
          <input
            id="reset-confirm"
            type="password"
            required
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder="repeat the new password"
            className="w-full h-10 px-3 rounded-lg border border-edge bg-surface text-sm outline-none focus:border-accent transition-colors"
          />
          <PasswordRequirements password={password} />
          <button
            type="submit"
            disabled={busy || !password || !confirm}
            className="w-full h-10 rounded-lg bg-accent text-accent-fg text-sm font-medium hover:opacity-90 disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {busy && <Loader2 size={15} className="animate-spin" />}
            Save password
          </button>
          {error && (
            <p role="alert" className="text-sm text-danger text-center">
              {error}
            </p>
          )}
        </form>
      )}
    </div>
  );
}
