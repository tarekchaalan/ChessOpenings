"use client";
/** Settings: Account (username, email, sign out), Preferences (theme, hints), Data. */
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useTheme } from "next-themes";
import {
  Check,
  Database,
  Loader2,
  LogOut,
  Monitor,
  Moon,
  Settings as SettingsIcon,
  Sun,
  Trash2,
  TriangleAlert,
  User as UserIcon,
} from "lucide-react";
import { useAuth } from "@/lib/supabase/AuthProvider";
import { useHydrated } from "@/lib/hooks";
import { getSupabase } from "@/lib/supabase/client";
import { clearLocalData, clearV1Backup, setPref, usePrefs, v1BackupSize } from "@/lib/prefs";
import PasswordRequirements from "@/components/auth/PasswordRequirements";
import { passwordValid, PASSWORD_POLICY_TEXT } from "@/lib/password";
import { authErrorMessage, callbackUrl, USERNAME_RE, USERNAME_RULE } from "@/lib/auth";
import LinkedAccounts from "@/components/insights/LinkedAccounts";
import { useInsights } from "@/lib/insights/client";

type Tab = "account" | "preferences" | "data";

const TABS: { id: Tab; label: string; icon: React.ReactNode }[] = [
  { id: "account", label: "Account", icon: <UserIcon size={15} /> },
  { id: "preferences", label: "Preferences", icon: <SettingsIcon size={15} /> },
  { id: "data", label: "Data", icon: <Database size={15} /> },
];

export default function SettingsClient() {
  const [tab, setTab] = useState<Tab>("account");

  return (
    <div className="max-w-2xl mx-auto py-8">
      <h1 className="text-2xl font-semibold tracking-tight mb-6">Settings</h1>

      <div className="flex gap-1 rounded-lg bg-surface-2 p-1 mb-6 max-w-md">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`flex-1 h-9 text-sm rounded-md flex items-center justify-center gap-1.5 transition-colors ${
              tab === t.id ? "bg-surface font-medium shadow-sm" : "text-muted hover:text-foreground"
            }`}
          >
            {t.icon}
            {t.label}
          </button>
        ))}
      </div>

      {tab === "account" && (
        <div className="space-y-4">
          <AccountTab />
          <ChessAccountsCard />
        </div>
      )}
      {tab === "preferences" && <PreferencesTab />}
      {tab === "data" && <DataTab />}
    </div>
  );
}

// ── Account ────────────────────────────────────────────────────────────────
function AccountTab() {
  const { user, username, configured, signOut, refreshProfile } = useAuth();
  const params = useSearchParams();
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  useEffect(() => {
    if (username) setName(username);
  }, [username]);

  if (!configured) {
    return (
      <Card title="Account">
        <p className="text-sm text-muted">
          This deployment runs without Supabase, so there are no accounts — progress is stored in
          this browser. See the README to enable accounts and the leaderboard.
        </p>
      </Card>
    );
  }
  if (!user) {
    return (
      <Card title="Account">
        <p className="text-sm text-muted mb-4">
          You&apos;re training as a guest. Sign in to pick a username, sync progress across devices,
          and join the leaderboard.
        </p>
        <Link
          href="/auth"
          className="inline-flex items-center px-4 h-10 rounded-lg bg-accent text-accent-fg text-sm font-medium hover:opacity-90"
        >
          Sign in
        </Link>
      </Card>
    );
  }

  const trimmed = name.trim();
  const save = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (saving) return;
    if (!USERNAME_RE.test(trimmed)) {
      setMsg({ kind: "error", text: USERNAME_RULE });
      return;
    }
    setSaving(true);
    setMsg(null);
    const sb = getSupabase()!;
    const update = () =>
      sb.from("profiles").update({ username: trimmed, updated_at: new Date().toISOString() }).eq("id", user.id).select("username").maybeSingle();
    let { data, error } = await update();
    if (!error && !data) {
      // no row was updated: the profile is missing, so create it and try once more
      const ensured = await sb.rpc("ensure_profile");
      if (!ensured.error) ({ data, error } = await update());
    }
    setSaving(false);
    if (error) {
      setMsg({ kind: "error", text: authErrorMessage(error) });
    } else if (!data) {
      setMsg({ kind: "error", text: "Couldn't save your username. Sign out and back in, then try again." });
    } else {
      await refreshProfile();
      setName(data.username);
      setMsg({ kind: "ok", text: "Username saved." });
    }
  };

  return (
    <div className="space-y-4">
      <Card title="Username">
        <p className="text-sm text-muted mb-3">
          Shown on the leaderboard and across the site.
        </p>
        <form onSubmit={save} className="flex gap-2">
          <label htmlFor="settings-username" className="sr-only">Username</label>
          <input
            id="settings-username"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={20}
            autoComplete="username"
            autoCapitalize="off"
            spellCheck={false}
            className="flex-1 h-10 px-3 rounded-lg border border-edge bg-surface text-sm outline-none focus:border-accent transition-colors"
            placeholder={username ? "username" : "loading…"}
          />
          <button
            type="submit"
            disabled={saving || !trimmed || trimmed === username}
            className="px-4 h-10 rounded-lg bg-accent text-accent-fg text-sm font-medium hover:opacity-90 disabled:opacity-50 flex items-center gap-2"
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
            Save
          </button>
        </form>
        {msg && (
          <p role={msg.kind === "error" ? "alert" : "status"} className={`text-sm mt-2 ${msg.kind === "error" ? "text-danger" : "text-accent"}`}>
            {msg.text}
          </p>
        )}
      </Card>

      <EmailCard email={user.email ?? ""} pending={user.new_email ?? null} changed={params.get("email") === "changed"} />

      <ChangePasswordCard email={user.email ?? ""} />

      <Card title="Session">
        <button
          onClick={() => signOut()}
          className="inline-flex items-center gap-2 px-4 h-10 rounded-lg border border-edge bg-surface text-sm hover:bg-surface-2 transition-colors"
        >
          <LogOut size={15} /> Sign out
        </button>
      </Card>

      <DeleteAccountCard confirmWord={username ?? user.email ?? ""} />
    </div>
  );
}

function EmailCard({ email, pending, changed }: { email: string; pending: string | null; changed: boolean }) {
  const [editing, setEditing] = useState(false);
  const [next, setNext] = useState("");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(changed ? { kind: "ok", text: "Email confirmed." } : null);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const to = next.trim();
    if (saving || !to) return;
    if (to.toLowerCase() === email.toLowerCase()) {
      setMsg({ kind: "error", text: "That's already your email." });
      return;
    }
    setSaving(true);
    setMsg(null);
    const { error } = await getSupabase()!.auth.updateUser({ email: to }, { emailRedirectTo: callbackUrl(window.location.origin, "/settings?email=changed") });
    setSaving(false);
    if (error) {
      setMsg({ kind: "error", text: authErrorMessage(error) });
    } else {
      setEditing(false);
      setNext("");
      setMsg({ kind: "ok", text: `Confirm the change from the emails we sent to ${email} and ${to}. Until then, sign in with ${email}.` });
    }
  };

  return (
    <Card title="Email">
      <p className="text-sm">{email}</p>
      {pending && <p className="text-xs text-muted mt-1">Waiting for confirmation: {pending}</p>}
      <p className="text-xs text-muted mt-1">Used for sign-in only — never shown publicly.</p>
      {editing ? (
        <form onSubmit={save} className="mt-3 flex gap-2 max-w-sm">
          <label htmlFor="settings-email" className="sr-only">New email</label>
          <input
            id="settings-email"
            type="email"
            required
            autoComplete="email"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            placeholder="new email"
            className="flex-1 h-10 px-3 rounded-lg border border-edge bg-surface text-sm outline-none focus:border-accent transition-colors"
          />
          <button type="submit" disabled={saving || !next.trim()} className="px-4 h-10 rounded-lg bg-accent text-accent-fg text-sm font-medium hover:opacity-90 disabled:opacity-50 flex items-center gap-2">
            {saving && <Loader2 size={14} className="animate-spin" />}
            Change
          </button>
          <button type="button" onClick={() => setEditing(false)} className="px-3 h-10 rounded-lg text-sm text-muted hover:text-foreground">
            Cancel
          </button>
        </form>
      ) : (
        <button onClick={() => setEditing(true)} className="mt-3 text-sm text-accent underline underline-offset-2">
          Change email
        </button>
      )}
      {msg && (
        <p role={msg.kind === "error" ? "alert" : "status"} className={`text-sm mt-2 ${msg.kind === "error" ? "text-danger" : "text-accent"}`}>
          {msg.text}
        </p>
      )}
    </Card>
  );
}

function DeleteAccountCard({ confirmWord }: { confirmWord: string }) {
  const router = useRouter();
  const { signOut } = useAuth();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [alsoLocal, setAlsoLocal] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const matches = typed.trim().toLowerCase() === confirmWord.toLowerCase() && confirmWord !== "";

  const remove = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || !matches) return;
    setBusy(true);
    setError(null);
    try {
      const sb = getSupabase()!;
      // a fresh token: the delete must not fail on an access token that just expired
      const { data } = await sb.auth.refreshSession();
      const token = data.session?.access_token ?? (await sb.auth.getSession()).data.session?.access_token;
      if (!token) throw new Error("Your session has ended. Sign in again, then delete the account.");
      const res = await fetch("/api/account", {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: typed.trim() }),
      });
      if (!res.ok && res.status !== 204) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        throw new Error(
          res.status === 503
            ? "Account deletion isn't available on this deployment. Contact the site owner."
            : res.status === 400
              ? "The confirmation doesn't match."
              : body?.message ?? "Could not delete the account. Please try again."
        );
      }
      if (alsoLocal) clearLocalData();
      await signOut();
      router.replace("/?account=deleted");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <section className="rounded-lg border border-danger/40 bg-surface p-5" data-testid="delete-account">
      <h2 className="text-xs uppercase tracking-wider text-danger mb-3">Delete account</h2>
      <p className="text-sm text-muted">
        Permanently deletes your account, username, rating, review schedule and leaderboard history. This can&apos;t be undone.
      </p>
      {!open ? (
        <button
          onClick={() => setOpen(true)}
          className="mt-3 inline-flex items-center gap-2 px-4 h-10 rounded-lg border border-edge bg-surface text-sm text-danger hover:border-danger transition-colors"
        >
          <Trash2 size={15} /> Delete my account…
        </button>
      ) : (
        <form onSubmit={remove} className="mt-4 space-y-3 max-w-sm">
          <label htmlFor="delete-confirm" className="block text-sm">
            Type <span className="font-mono font-medium">{confirmWord}</span> to confirm
          </label>
          <input
            id="delete-confirm"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            className="w-full h-10 px-3 rounded-lg border border-edge bg-surface text-sm outline-none focus:border-danger transition-colors"
            data-testid="delete-confirm"
          />
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input type="checkbox" checked={alsoLocal} onChange={(e) => setAlsoLocal(e.target.checked)} className="accent-[var(--accent)]" />
            Also clear progress saved in this browser
          </label>
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={!matches || busy}
              className="inline-flex items-center gap-2 px-4 h-10 rounded-lg bg-danger text-white text-sm font-medium hover:opacity-90 disabled:opacity-50"
              data-testid="delete-submit"
            >
              {busy ? <Loader2 size={14} className="animate-spin" /> : <TriangleAlert size={14} />}
              Delete forever
            </button>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setTyped("");
                setError(null);
              }}
              className="px-4 h-10 rounded-lg text-sm text-muted hover:text-foreground"
            >
              Cancel
            </button>
          </div>
          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}
        </form>
      )}
    </section>
  );
}

function ChangePasswordCard({ email }: { email: string }) {
  const [current, setCurrent] = useState("");
  const [resetSent, setResetSent] = useState(false);
  const [next, setNext] = useState("");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!passwordValid(next)) {
      setMsg({ kind: "error", text: PASSWORD_POLICY_TEXT });
      return;
    }
    setSaving(true);
    setMsg(null);
    // the project requires the current password for password updates
    const { error } = await getSupabase()!.auth.updateUser({
      password: next,
      current_password: current,
    });
    setSaving(false);
    if (error) {
      setMsg({ kind: "error", text: error.code === "invalid_credentials" || /current password/i.test(error.message) ? "Your current password is wrong." : authErrorMessage(error) });
    } else {
      setCurrent("");
      setNext("");
      setMsg({ kind: "ok", text: "Password updated." });
    }
  };

  return (
    <Card title="Password">
      <form onSubmit={save} className="space-y-2 max-w-sm">
        <input
          type="password"
          required
          autoComplete="current-password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          placeholder="current password"
          className="w-full h-10 px-3 rounded-lg border border-edge bg-surface text-sm outline-none focus:border-accent transition-colors"
        />
        <input
          type="password"
          required
          minLength={8}
          autoComplete="new-password"
          value={next}
          onChange={(e) => setNext(e.target.value)}
          placeholder="new password"
          className="w-full h-10 px-3 rounded-lg border border-edge bg-surface text-sm outline-none focus:border-accent transition-colors"
        />
        <PasswordRequirements password={next} />
        <button
          type="submit"
          disabled={saving || !current || !next}
          className="px-4 h-10 rounded-lg bg-accent text-accent-fg text-sm font-medium hover:opacity-90 disabled:opacity-50 flex items-center gap-2"
        >
          {saving ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
          Update password
        </button>
        {msg && (
          <p role={msg.kind === "error" ? "alert" : "status"} className={`text-sm ${msg.kind === "error" ? "text-danger" : "text-accent"}`}>
            {msg.text}
          </p>
        )}
      </form>
      <p className="text-xs text-muted mt-3">
        Don&apos;t know your current password (e.g. you sign in by email link)?{" "}
        <button
          type="button"
          disabled={resetSent}
          onClick={async () => {
            setMsg(null);
            const { error } = await getSupabase()!.auth.resetPasswordForEmail(email, { redirectTo: callbackUrl(window.location.origin, "/auth/reset") });
            if (error) setMsg({ kind: "error", text: authErrorMessage(error) });
            else {
              setResetSent(true);
              setMsg({ kind: "ok", text: `We emailed a link to ${email} to set a new password.` });
            }
          }}
          className="underline underline-offset-2 hover:text-foreground disabled:opacity-60 disabled:no-underline"
        >
          Email me a reset link
        </button>
      </p>
    </Card>
  );
}

// ── Preferences ────────────────────────────────────────────────────────────
function PreferencesTab() {
  const { theme, setTheme } = useTheme();
  const prefs = usePrefs();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  return (
    <div className="space-y-4">
      <Card title="Theme">
        <div className="grid grid-cols-3 gap-2 max-w-sm">
          {(
            [
              { id: "light", label: "Light", icon: <Sun size={15} /> },
              { id: "dark", label: "Dark", icon: <Moon size={15} /> },
              { id: "system", label: "System", icon: <Monitor size={15} /> },
            ] as const
          ).map((t) => (
            <button
              key={t.id}
              onClick={() => setTheme(t.id)}
              className={`h-10 rounded-lg border text-sm flex items-center justify-center gap-1.5 transition-colors ${
                mounted && theme === t.id
                  ? "border-accent bg-accent-soft text-accent font-medium"
                  : "border-edge bg-surface text-muted hover:text-foreground"
              }`}
            >
              {t.icon}
              {t.label}
            </button>
          ))}
        </div>
      </Card>

      <Card title="Sound">
        <Toggle
          label="Board sounds"
          description="Move, capture, castle, check and promotion sounds on every board."
          checked={prefs.sound}
          onChange={(v) => setPref("sound", v)}
        />
      </Card>

      <Card title="Training">
        <div className="space-y-5">
          <Toggle
            label="Hint arrows in Learn"
            description="The green arrow on the move to play while learning a line. Recall and Review never show it."
            checked={prefs.learnHints}
            onChange={(v) => setPref("learnHints", v)}
          />
          <Toggle
            label="Skip known moves"
            description="Learn fast-forwards the moves you already know, so each new line starts where it gets new."
            checked={prefs.skipKnown}
            onChange={(v) => setPref("skipKnown", v)}
          />
          <Range
            label="Opponent reply delay"
            value={prefs.replyDelayMs}
            min={0}
            max={1500}
            step={100}
            format={(v) => (v === 0 ? "instant" : `${(v / 1000).toFixed(1)} s`)}
            onChange={(v) => setPref("replyDelayMs", v)}
          />
          <Range label="New lines per day" hint="Learn suggests up to this many new lines a day; you can always learn more." value={prefs.dailyNewLines} min={1} max={30} step={1} format={String} onChange={(v) => setPref("dailyNewLines", v)} />
          <Range
            label="Reviews per day"
            hint="When more are due, the rest wait for the next day(s), lowest recall first. Nothing is dropped."
            value={prefs.dailyReviewCap}
            min={20}
            max={500}
            step={10}
            format={String}
            onChange={(v) => setPref("dailyReviewCap", v)}
          />
          <Range
            label="Target retention"
            hint="How likely you should be to remember a move when it comes up. Higher means more reviews."
            value={Math.round(prefs.targetRetention * 100)}
            min={80}
            max={97}
            step={1}
            format={(v) => `${v}%`}
            onChange={(v) => setPref("targetRetention", v / 100)}
          />
        </div>
      </Card>

      <Card title="Board">
        <div className="grid grid-cols-4 gap-2 max-w-sm" role="radiogroup" aria-label="Board theme">
          {(["brown", "blue", "green", "gray"] as const).map((t) => (
            <button
              key={t}
              role="radio"
              aria-checked={prefs.boardTheme === t}
              onClick={() => setPref("boardTheme", t)}
              className={`rounded-lg border p-1.5 text-xs capitalize ${prefs.boardTheme === t ? "border-accent bg-accent-soft font-medium" : "border-edge bg-surface text-muted"}`}
            >
              <span className={`board-swatch board-theme-${t} block w-full aspect-square rounded mb-1`} aria-hidden />
              {t}
            </button>
          ))}
        </div>
        <div className="mt-5 grid grid-cols-3 gap-2 max-w-sm" role="radiogroup" aria-label="Motion">
          {(
            [
              { id: "system", label: "Motion: system" },
              { id: "reduce", label: "Reduce" },
              { id: "full", label: "Full" },
            ] as const
          ).map((m) => (
            <button
              key={m.id}
              role="radio"
              aria-checked={prefs.motion === m.id}
              onClick={() => setPref("motion", m.id)}
              className={`h-10 rounded-lg border text-sm ${prefs.motion === m.id ? "border-accent bg-accent-soft text-accent font-medium" : "border-edge bg-surface text-muted hover:text-foreground"}`}
            >
              {m.label}
            </button>
          ))}
        </div>
      </Card>
    </div>
  );
}

function Range({
  label,
  hint,
  value,
  min,
  max,
  step,
  format,
  onChange,
}: {
  label: string;
  hint?: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
  onChange: (v: number) => void;
}) {
  const id = `range-${label.replace(/\W+/g, "-").toLowerCase()}`;
  return (
    <div>
      <div className="flex items-baseline justify-between gap-4">
        <label htmlFor={id} className="text-sm font-medium">{label}</label>
        <span className="text-sm text-muted tabular-nums">{format(value)}</span>
      </div>
      {hint && <p className="text-xs text-muted mt-0.5">{hint}</p>}
      <input id={id} type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} className="w-full mt-2 accent-[var(--accent)]" />
    </div>
  );
}

function Toggle({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="w-full flex items-start gap-4 text-left"
    >
      <span
        className={`mt-0.5 w-10 h-6 rounded-full p-0.5 shrink-0 transition-colors ${
          checked ? "bg-accent" : "bg-surface-2 border border-edge"
        }`}
      >
        <span
          className={`block w-5 h-5 rounded-full bg-white shadow transition-transform ${
            checked ? "translate-x-4" : ""
          }`}
        />
      </span>
      <span>
        <span className="block text-sm font-medium">{label}</span>
        <span className="block text-xs text-muted mt-0.5">{description}</span>
      </span>
    </button>
  );
}

// ── Data ───────────────────────────────────────────────────────────────────
/** openings.v2.meta.json (the fields shown here) */
interface DatasetMeta {
  outputHash: string;
  counts: { rows: number; positions: number; theoryMoves: number; statsCoveredPositions: number };
  coverage: { hubs: number; courses: number; lines: number };
}

function DataTab() {
  const { user } = useAuth();
  const [meta, setMeta] = useState<DatasetMeta | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [cleared, setCleared] = useState(false);
  // the v1 backup the migration kept (ADR 0003): removed only on its own confirmation
  const hydrated = useHydrated();
  const [backupGone, setBackupGone] = useState(false);
  const backup = hydrated && !backupGone ? v1BackupSize() : 0;
  const [confirmBackup, setConfirmBackup] = useState(false);

  useEffect(() => {
    fetch("/data/openings.v2.meta.json")
      .then((r) => (r.ok ? r.json() : null))
      .then(setMeta)
      .catch(() => setMeta(null));
  }, []);

  const wipe = () => {
    if (!confirming) {
      setConfirming(true);
      setTimeout(() => setConfirming(false), 4000);
      return;
    }
    clearLocalData();
    setConfirming(false);
    setCleared(true);
  };

  return (
    <div className="space-y-4">
      <Card title="Opening dataset">
        {meta ? (
          <dl className="text-sm grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5" data-testid="dataset-meta">
            <dt className="text-muted">Named openings</dt>
            <dd>{meta.counts.rows.toLocaleString()}</dd>
            <dt className="text-muted">Openings · courses · lines</dt>
            <dd>
              {meta.coverage.hubs.toLocaleString()} · {meta.coverage.courses.toLocaleString()} · {meta.coverage.lines.toLocaleString()}
            </dd>
            <dt className="text-muted">Positions</dt>
            <dd>{meta.counts.positions.toLocaleString()}</dd>
            <dt className="text-muted">Theory moves</dt>
            <dd>{meta.counts.theoryMoves.toLocaleString()}</dd>
            <dt className="text-muted">Positions with master stats</dt>
            <dd>{meta.counts.statsCoveredPositions.toLocaleString()}</dd>
            <dt className="text-muted">Build</dt>
            <dd className="font-mono text-xs pt-0.5">{meta.outputHash.slice(0, 16)}…</dd>
          </dl>
        ) : (
          <p className="text-sm text-muted">Dataset metadata unavailable.</p>
        )}
      </Card>

      <Card title="Local practice data">
        <p className="text-sm text-muted mb-3">
          Guest progress, review schedule, and preferences stored in this browser.
          {user && " Your account progress lives on the server and is not affected."}
        </p>
        {cleared ? (
          <p className="text-sm text-accent">Local data cleared.</p>
        ) : (
          <button
            onClick={wipe}
            className={`inline-flex items-center gap-2 px-4 h-10 rounded-lg border text-sm transition-colors ${
              confirming
                ? "border-danger bg-danger text-white"
                : "border-edge bg-surface text-danger hover:border-danger"
            }`}
          >
            <Trash2 size={15} />
            {confirming ? "Click again to confirm" : "Clear local data"}
          </button>
        )}
      </Card>

      {backup > 0 && (
        <Card title="Backup from the previous version">
          <p className="text-sm text-muted mb-3">
            Your progress from the previous trainer was converted to the new one. A copy of the original ({Math.max(1, Math.round(backup / 1024))} KB) is kept in
            this browser in case anything needs recovering. Clearing local data doesn&apos;t remove it.
          </p>
          <button
            data-testid="clear-v1-backup"
            onClick={() => {
              if (!confirmBackup) {
                setConfirmBackup(true);
                setTimeout(() => setConfirmBackup(false), 4000);
                return;
              }
              clearV1Backup();
              setBackupGone(true);
            }}
            className={`inline-flex items-center gap-2 px-4 h-10 rounded-lg border text-sm transition-colors ${
              confirmBackup ? "border-danger bg-danger text-white" : "border-edge bg-surface text-danger hover:border-danger"
            }`}
          >
            <Trash2 size={15} />
            {confirmBackup ? "Click again to delete the backup for good" : "Delete the backup"}
          </button>
        </Card>
      )}
    </div>
  );
}

/** Linked Chess.com / Lichess accounts (ADR 0006), the same panel as on /insights. */
function ChessAccountsCard() {
  const { user, loading } = useAuth();
  const ins = useInsights(user?.id ?? null, loading);
  return (
    <Card title="Chess.com and Lichess">
      <p className="text-sm text-muted mb-3">
        Link your accounts to see where your openings leave book and what to learn next on{" "}
        <Link href="/insights" className="text-accent underline">
          Insights
        </Link>
        .
      </p>
      {ins.loaded ? <LinkedAccounts accounts={ins.data.accounts} status={ins.status} signedIn={!!user && !ins.serverless} showStatus /> : <div className="h-24 rounded bg-surface-2 animate-pulse" />}
    </Card>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-edge bg-surface p-5">
      <h2 className="text-xs uppercase tracking-wider text-muted mb-3">{title}</h2>
      {children}
    </section>
  );
}
