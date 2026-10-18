"use client";
/** Settings: Account (username, email, sign out), Preferences (theme, hints), Data. */
import { useEffect, useState } from "react";
import Link from "next/link";
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
  User as UserIcon,
} from "lucide-react";
import { useAuth } from "@/lib/supabase/AuthProvider";
import { getSupabase } from "@/lib/supabase/client";
import { clearLocalData, setPref, usePrefs } from "@/lib/prefs";
import PasswordRequirements from "@/components/auth/PasswordRequirements";
import { passwordValid, PASSWORD_POLICY_TEXT } from "@/lib/password";

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

      {tab === "account" && <AccountTab />}
      {tab === "preferences" && <PreferencesTab />}
      {tab === "data" && <DataTab />}
    </div>
  );
}

// ── Account ────────────────────────────────────────────────────────────────
function AccountTab() {
  const { user, username, configured, signOut, refreshProfile } = useAuth();
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

  const save = async () => {
    if (!/^[A-Za-z0-9_]{3,20}$/.test(name)) {
      setMsg({ kind: "error", text: "3–20 characters: letters, numbers, underscores." });
      return;
    }
    setSaving(true);
    setMsg(null);
    const { error } = await getSupabase()!
      .from("profiles")
      .update({ username: name, updated_at: new Date().toISOString() })
      .eq("id", user.id);
    setSaving(false);
    if (error) {
      setMsg({
        kind: "error",
        text: error.code === "23505" ? "That username is taken." : error.message,
      });
    } else {
      await refreshProfile();
      setMsg({ kind: "ok", text: "Username updated." });
    }
  };

  return (
    <div className="space-y-4">
      <Card title="Username">
        <p className="text-sm text-muted mb-3">
          Shown on the leaderboard and across the site.
        </p>
        <div className="flex gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={20}
            className="flex-1 h-10 px-3 rounded-lg border border-edge bg-surface text-sm outline-none focus:border-accent transition-colors"
            placeholder="username"
          />
          <button
            onClick={save}
            disabled={saving || name === username}
            className="px-4 h-10 rounded-lg bg-accent text-accent-fg text-sm font-medium hover:opacity-90 disabled:opacity-50 flex items-center gap-2"
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
            Save
          </button>
        </div>
        {msg && (
          <p className={`text-sm mt-2 ${msg.kind === "error" ? "text-danger" : "text-accent"}`}>
            {msg.text}
          </p>
        )}
      </Card>

      <Card title="Email">
        <p className="text-sm">{user.email}</p>
        <p className="text-xs text-muted mt-1">Used for sign-in only — never shown publicly.</p>
      </Card>

      <ChangePasswordCard />

      <Card title="Session">
        <button
          onClick={() => signOut()}
          className="inline-flex items-center gap-2 px-4 h-10 rounded-lg border border-edge bg-surface text-sm hover:bg-surface-2 transition-colors"
        >
          <LogOut size={15} /> Sign out
        </button>
      </Card>
    </div>
  );
}

function ChangePasswordCard() {
  const [current, setCurrent] = useState("");
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
      setMsg({ kind: "error", text: error.message });
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
          <p className={`text-sm ${msg.kind === "error" ? "text-danger" : "text-accent"}`}>
            {msg.text}
          </p>
        )}
      </form>
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
          <Range label="New lines per day" hint="Saved now; the daily plan that uses it is coming soon." value={prefs.dailyNewLines} min={1} max={30} step={1} format={String} onChange={(v) => setPref("dailyNewLines", v)} />
          <Range
            label="Reviews per day"
            hint="Coming soon with the daily plan: when more are due, the rest wait for the next day, lowest recall first. Nothing is dropped."
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
interface DatasetMeta {
  version: string;
  counts: { openings: number; positions: number; theoryMoves: number; corpusGamesIncluded: number };
  builtWith?: { gamesCorpus?: { months?: string[] } | null };
  sha256: string;
}

function DataTab() {
  const { user } = useAuth();
  const [meta, setMeta] = useState<DatasetMeta | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [cleared, setCleared] = useState(false);

  useEffect(() => {
    fetch("/data/openings.meta.json")
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
          <dl className="text-sm grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5">
            <dt className="text-muted">Version</dt>
            <dd className="font-mono">{meta.version}</dd>
            <dt className="text-muted">Named openings</dt>
            <dd>{meta.counts.openings.toLocaleString()}</dd>
            <dt className="text-muted">Positions</dt>
            <dd>{meta.counts.positions.toLocaleString()}</dd>
            <dt className="text-muted">Games behind the stats</dt>
            <dd>{meta.counts.corpusGamesIncluded.toLocaleString()} professional games</dd>
            {meta.builtWith?.gamesCorpus?.months && (
              <>
                <dt className="text-muted">Corpus window</dt>
                <dd>
                  {meta.builtWith.gamesCorpus.months[0]} →{" "}
                  {meta.builtWith.gamesCorpus.months.at(-1)}
                </dd>
              </>
            )}
            <dt className="text-muted">Checksum</dt>
            <dd className="font-mono text-xs pt-0.5">{meta.sha256.slice(0, 16)}…</dd>
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
    </div>
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
