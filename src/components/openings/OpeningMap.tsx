"use client";
/**
 * Opening Map (§3.2 A, Phase 6 stretch): an icicle of named theory from the
 * focused position, 8 plies deep. Width = share of master games, colour = ECO
 * volume. Click a cell to zoom into it; double-click to open its opening's
 * hub. The List view is the accessible version of the same tree.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useDataset } from "@/lib/hooks";
import { formatMoves, hubHref, modelOf } from "@/lib/courses-client";
import { ECO_VOLUMES, hubsOfRow } from "@/lib/catalog-client";
import { layoutIcicle, nodeAtPath, theoryChildren, type MapCell } from "@/lib/opening-map";
import type { Dataset } from "@/lib/openings";
import type { Model } from "@/lib/openings-build/model";

const DEPTH = 8;
const W = 1000;
const ROW_H = 40;
const pct = (x: number) => (x >= 0.1 ? `${Math.round(x * 100)}%` : x >= 0.001 ? `${(x * 100).toFixed(1)}%` : "<0.1%");

export default function OpeningMap() {
  const { ds, error } = useDataset();
  if (error) return <p className="py-20 text-center text-muted">Couldn’t load the opening data ({error}).</p>;
  if (!ds) return <div className="py-8 h-[60vh] rounded-lg bg-surface-2 animate-pulse" />;
  return <MapView ds={ds} />;
}

function MapView({ ds }: { ds: Dataset }) {
  const model = modelOf(ds);
  const params = useSearchParams();
  const router = useRouter();
  const urlPath = (params.get("at") ?? "").split(",").filter(Boolean);
  const [focus, setFocusState] = useState<string[]>(nodeAtPath(model, urlPath) ? urlPath : []);
  const [view, setView] = useState<"map" | "list">(params.get("view") === "list" ? "list" : "map");
  // the URL keeps the zoom and the view (shareable, survives reload)
  const syncUrl = (p: string[], v: "map" | "list") => {
    const q = new URLSearchParams();
    if (p.length) q.set("at", p.join(","));
    if (v === "list") q.set("view", "list");
    window.history.replaceState(null, "", `/openings/map${q.size ? `?${q}` : ""}`);
  };
  const setFocus = (p: string[]) => {
    setFocusState(p);
    syncUrl(p, view);
  };
  const changeView = (v: "map" | "list") => {
    setView(v);
    syncUrl(focus, v);
  };
  const layout = useMemo(() => layoutIcicle(model, focus, DEPTH), [model, focus]);
  const hubOf = (row: number) => (row >= 0 ? (hubsOfRow(ds).get(row)?.[0] ?? null) : null);
  const name = (row: number) => (row >= 0 ? model.rows[row].name : "Starting position");

  // single click zooms, double click opens the hub: wait out the double click
  const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (clickTimer.current) clearTimeout(clickTimer.current);
  }, []);
  const onCell = (c: MapCell, double: boolean) => {
    if (clickTimer.current) clearTimeout(clickTimer.current);
    if (double) {
      const hub = hubOf(c.row);
      if (hub) router.push(hubHref(hub.slug));
      return;
    }
    clickTimer.current = setTimeout(() => setFocus(c.path), 220);
  };

  if (!layout) return null;
  const rows = DEPTH + 1;
  return (
    <div className="py-8">
      <nav aria-label="Breadcrumb" className="text-sm text-muted mb-2">
        <Link href="/openings" className="hover:text-foreground">Openings</Link> › <span className="text-foreground">Map</span>
      </nav>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Opening map</h1>
          <p className="text-sm text-muted mt-1">
            Named theory, {DEPTH} plies deep. Width = share of master games; colour = ECO volume. Click to zoom in; double-click to open the opening.
          </p>
        </div>
        <div className="flex gap-1 rounded-lg bg-surface-2 p-1" role="tablist" aria-label="Map view">
          {(["map", "list"] as const).map((v) => (
            <button
              key={v}
              role="tab"
              aria-selected={view === v}
              onClick={() => changeView(v)}
              className={`px-3 h-8 text-sm rounded-md ${view === v ? "bg-surface font-medium shadow-sm" : "text-muted hover:text-foreground"}`}
            >
              {v === "map" ? "Map" : "List"}
            </button>
          ))}
        </div>
      </div>

      {/* where we are: each step zooms back out */}
      <ol className="mt-4 flex flex-wrap items-center gap-1 text-sm" aria-label="Zoom path" data-testid="map-crumbs">
        <li>
          <button onClick={() => setFocus([])} className="px-2 min-h-[32px] rounded hover:bg-surface-2 font-medium" disabled={!focus.length}>
            Start
          </button>
        </li>
        {focus.map((san, i) => (
          <li key={i} className="flex items-center gap-1">
            <span className="text-muted" aria-hidden>›</span>
            <button onClick={() => setFocus(focus.slice(0, i + 1))} className="px-1.5 min-h-[32px] rounded hover:bg-surface-2 font-mono" disabled={i === focus.length - 1}>
              {formatMoves([san], i)}
            </button>
          </li>
        ))}
        <li className="ml-2 text-muted">
          {name(layout.root.row)}
          {layout.root.row >= 0 && model.rows[layout.root.row].eco ? ` · ${model.rows[layout.root.row].eco}` : ""}
        </li>
      </ol>

      {view === "map" ? (
        <>
          <div className="mt-3 rounded-xl border border-edge bg-surface overflow-hidden">
            <svg
              viewBox={`0 0 ${W} ${rows * ROW_H}`}
              className="w-full h-auto block select-none"
              role="img"
              aria-label={`Opening map from ${name(layout.root.row)}. The List view has the same tree as a navigable list.`}
              data-testid="opening-map"
            >
              {layout.cells.map((c) => {
                const x = c.x0 * W;
                const w = (c.x1 - c.x0) * W;
                const y = c.depth * ROW_H;
                const label = c.depth === 0 ? name(c.row) : formatMoves([c.path[c.path.length - 1]], c.path.length - 1);
                return (
                  <g
                    key={c.path.join(" ")}
                    className="map-cell cursor-pointer"
                    data-volume={c.volume ?? "none"}
                    data-path={c.path.join(",")}
                    onClick={() => onCell(c, false)}
                    onDoubleClick={() => onCell(c, true)}
                  >
                    <title>{`${c.path.length ? formatMoves(c.path) : "Start"} — ${name(c.row)}${c.row >= 0 && model.rows[c.row].eco ? ` (${model.rows[c.row].eco})` : ""} · ${c.games.toLocaleString("en-US")} master games (${pct(c.share)})`}</title>
                    <rect x={x + 0.5} y={y + 0.5} width={Math.max(0, w - 1)} height={ROW_H - 1} rx={3} />
                    {w > 34 && (
                      <text x={x + 6} y={y + 17} className="map-san" pointerEvents="none">
                        {label.length * 7 > w - 10 ? label.slice(0, Math.max(1, Math.floor((w - 10) / 7))) : label}
                      </text>
                    )}
                    {w > 90 && c.depth > 0 && (
                      <text x={x + 6} y={y + 32} className="map-name" pointerEvents="none">
                        {fit(name(c.row), w - 12)}
                      </text>
                    )}
                  </g>
                );
              })}
            </svg>
          </div>
          <ul className="mt-3 flex flex-wrap gap-3 text-xs text-muted" aria-label="ECO volumes">
            {ECO_VOLUMES.map(([l, n]) => (
              <li key={l} className="flex items-center gap-1.5">
                <span className="map-swatch" data-volume={l} aria-hidden /> {l} · {n}
              </li>
            ))}
            <li className="flex items-center gap-1.5">
              <span className="map-swatch" data-volume="none" aria-hidden /> not yet named
            </li>
          </ul>
        </>
      ) : (
        <TreeList model={model} ds={ds} focus={focus} onZoom={setFocus} />
      )}
    </div>
  );
}

/** Truncate to roughly `px` of 11 px text. */
function fit(s: string, px: number): string {
  const n = Math.floor(px / 6);
  return s.length > n ? `${s.slice(0, Math.max(1, n - 1))}…` : s;
}

/** The accessible version: the same tree as nested, expandable lists. */
function TreeList({ model, ds, focus, onZoom }: { model: Model; ds: Dataset; focus: string[]; onZoom: (p: string[]) => void }) {
  const root = nodeAtPath(model, focus)!;
  return (
    <div className="mt-3 rounded-xl border border-edge bg-surface p-3" data-testid="map-list">
      <TreeLevel model={model} ds={ds} node={root.node} path={focus} depth={0} row={root.row} onZoom={onZoom} open />
    </div>
  );
}

function TreeLevel({ model, ds, node, path, depth, row, onZoom, open }: { model: Model; ds: Dataset; node: number; path: string[]; depth: number; row: number; onZoom: (p: string[]) => void; open?: boolean }) {
  const games = model.nodes[node].games;
  const kids = theoryChildren(model, node);
  if (!open || !kids.length) return null;
  return (
    <ul className={depth ? "pl-4 border-l border-edge ml-2" : ""}>
      {kids.map((c) => (
        <TreeItem key={c.san} model={model} ds={ds} c={c} path={[...path, c.san]} depth={depth} parentGames={games} parentRow={row} onZoom={onZoom} />
      ))}
    </ul>
  );
}

function TreeItem({
  model,
  ds,
  c,
  path,
  depth,
  parentGames,
  parentRow,
  onZoom,
}: {
  model: Model;
  ds: Dataset;
  c: { san: string; to: number; games: number };
  path: string[];
  depth: number;
  parentGames: number;
  parentRow: number;
  onZoom: (p: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const row = model.nodes[c.to].nameRow !== -1 ? model.nodes[c.to].nameRow : parentRow;
  const hub = row >= 0 ? (hubsOfRow(ds).get(row)?.[0] ?? null) : null;
  const hasKids = theoryChildren(model, c.to).length > 0 && depth < DEPTH - 1;
  const share = parentGames > 0 ? c.games / parentGames : 0;
  return (
    <li className="py-0.5">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {hasKids ? (
          <button onClick={() => setOpen(!open)} aria-expanded={open} className="font-mono min-h-[32px] px-1 rounded hover:bg-surface-2">
            {open ? "▾" : "▸"} {formatMoves([c.san], path.length - 1)}
          </button>
        ) : (
          <span className="font-mono px-1 pl-4">{formatMoves([c.san], path.length - 1)}</span>
        )}
        <span>{row >= 0 ? model.rows[row].name : "—"}</span>
        <span className="text-muted text-xs">{pct(share)} of master games here</span>
        <button onClick={() => onZoom(path)} className="text-xs text-accent hover:underline min-h-[32px]">
          Zoom map here
        </button>
        {hub && (
          <Link href={hubHref(hub.slug)} className="text-xs text-accent hover:underline">
            Open {hub.title}
          </Link>
        )}
      </div>
      {open && <TreeLevel model={model} ds={ds} node={c.to} path={path} depth={depth + 1} row={row} onZoom={onZoom} open />}
    </li>
  );
}
