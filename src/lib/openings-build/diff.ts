/**
 * Changelog between two builds, keyed by rowId: a row with the same id and a
 * new name is a rename (§4.3). Per-hub / per-course deltas are attached by
 * the build once the catalog exists (Phase 2).
 */

export interface BaselineRow {
  rowId: string;
  name: string;
  eco: string | null;
}

export interface ChangeRow {
  rowId: string;
  name: string;
  eco: string | null;
}

export interface ChangelogEntry {
  fromHash: string | null;
  toHash: string;
  builtAt: string;
  added: ChangeRow[];
  removed: ChangeRow[];
  renamed: { rowId: string; from: string; to: string; eco: string | null }[];
  /** hub slug → line delta (Phase 2) */
  hubs: Record<string, { title: string; added: number; removed: number }>;
  /** course id → line delta (Phase 2) */
  courses: Record<string, { added: string[]; removed: string[] }>;
}

export interface Changelog {
  format: "chess-openings-trainer/changelog@1";
  entries: ChangelogEntry[];
}

export const CHANGELOG_KEEP = 20;

export function diffRows(prev: BaselineRow[], next: BaselineRow[]) {
  const before = new Map(prev.map((r) => [r.rowId, r]));
  const after = new Map(next.map((r) => [r.rowId, r]));
  const added: ChangeRow[] = [];
  const removed: ChangeRow[] = [];
  const renamed: ChangelogEntry["renamed"] = [];
  for (const r of next) {
    const p = before.get(r.rowId);
    if (!p) added.push({ rowId: r.rowId, name: r.name, eco: r.eco });
    else if (p.name !== r.name) renamed.push({ rowId: r.rowId, from: p.name, to: r.name, eco: r.eco });
  }
  for (const r of prev) {
    if (!after.has(r.rowId)) removed.push({ rowId: r.rowId, name: r.name, eco: r.eco });
  }
  return { added, removed, renamed };
}

/** Short human summary for toasts: "+2 lines · 1 renamed · Ruy Lopez, Sicilian". */
export function summarizeEntry(e: ChangelogEntry, maxHubs = 3): string {
  const parts: string[] = [];
  const hubLines = Object.values(e.hubs).reduce((s, h) => s + h.added, 0);
  const added = hubLines || e.added.length;
  if (added) parts.push(`+${added} line${added === 1 ? "" : "s"}`);
  if (e.removed.length) parts.push(`−${e.removed.length} removed`);
  if (e.renamed.length) parts.push(`${e.renamed.length} renamed`);
  const hubs = Object.entries(e.hubs)
    .filter(([, h]) => h.added || h.removed)
    .sort((a, b) => b[1].added + b[1].removed - (a[1].added + a[1].removed))
    .map(([, h]) => h.title);
  if (hubs.length) parts.push(hubs.slice(0, maxHubs).join(", ") + (hubs.length > maxHubs ? "…" : ""));
  return parts.join(" · ") || "No changes";
}
