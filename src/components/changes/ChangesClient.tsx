"use client";
/** Changelog of opening-data builds (public/data/openings.changelog.json). */
import { useEffect, useState } from "react";
import { Minus, Pencil, Plus } from "lucide-react";
import { loadDataset, subscribeDataset } from "@/lib/dataset-live";
import { summarizeEntry, type Changelog, type ChangelogEntry } from "@/lib/openings-build/diff";

const LIST_LIMIT = 40;

export default function ChangesClient() {
  const [log, setLog] = useState<Changelog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    loadDataset().catch(() => {}); // starts live updates on this page too
    return subscribeDataset(() => setTick((t) => t + 1));
  }, []);
  useEffect(() => {
    let alive = true;
    fetch("/data/openings.changelog.json", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((l: Changelog) => alive && setLog(l))
      .catch((e) => alive && setError(String(e)));
    return () => {
      alive = false;
    };
  }, [tick]);

  return (
    <div className="py-8 max-w-3xl">
      <h1 className="text-2xl font-semibold tracking-tight">Opening data changes</h1>
      <p className="text-muted text-sm mt-1">
        Every build of <code className="font-mono text-xs">public/data/all-openings/</code> is compared with the previous
        one, so you can see which lines were added, removed or renamed.
      </p>
      {error && <p className="mt-6 text-sm text-danger">Couldn’t load the changelog ({error}).</p>}
      {!log && !error && <div className="mt-6 h-40 rounded-lg bg-surface-2 animate-pulse" />}
      {log && log.entries.length === 0 && <p className="mt-6 text-sm text-muted">No changes recorded yet.</p>}
      <ol className="mt-6 space-y-6">
        {log?.entries.map((e, i) => <Entry key={`${e.toHash}-${i}`} e={e} />)}
      </ol>
    </div>
  );
}

function Entry({ e }: { e: ChangelogEntry }) {
  const when = new Date(e.builtAt);
  return (
    <li className="rounded-lg border border-edge bg-surface p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="font-medium">{summarizeEntry(e)}</div>
        <time className="text-xs text-muted" dateTime={e.builtAt}>
          {when.toLocaleString()}
          {e.fromHash ? "" : " · vs. previous data version"}
        </time>
      </div>
      <Section icon={<Plus size={13} />} label="Added" rows={e.added.map((r) => ({ key: r.rowId, text: r.name, eco: r.eco }))} />
      <Section icon={<Minus size={13} />} label="Removed" rows={e.removed.map((r) => ({ key: r.rowId, text: r.name, eco: r.eco }))} />
      <Section
        icon={<Pencil size={13} />}
        label="Renamed"
        rows={e.renamed.map((r) => ({ key: r.rowId, text: `${r.from} → ${r.to}`, eco: r.eco }))}
      />
    </li>
  );
}

function Section({ icon, label, rows }: { icon: React.ReactNode; label: string; rows: { key: string; text: string; eco: string | null }[] }) {
  const [all, setAll] = useState(false);
  if (!rows.length) return null;
  const shown = all ? rows : rows.slice(0, LIST_LIMIT);
  return (
    <details className="mt-3" open={rows.length <= 10}>
      <summary className="cursor-pointer text-sm text-muted inline-flex items-center gap-1.5">
        {icon} {label} ({rows.length})
      </summary>
      <ul className="mt-2 grid gap-1 text-sm">
        {shown.map((r) => (
          <li key={r.key} className="flex gap-2">
            <span className="font-mono text-xs text-muted w-8 shrink-0">{r.eco ?? "—"}</span>
            <span>{r.text}</span>
          </li>
        ))}
      </ul>
      {rows.length > LIST_LIMIT && !all && (
        <button onClick={() => setAll(true)} className="mt-2 text-xs text-accent hover:underline">
          Show all {rows.length}
        </button>
      )}
    </details>
  );
}
