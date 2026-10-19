/**
 * Course memo for the dev watcher (§4.8 "incremental rebuild < 1 s"). A
 * course depends only on its hub's DAG, the extension region below the DAG's
 * leaves, the names and stats of those positions, and its system choices.
 * We fingerprint exactly that in EPD terms (node indices shift whenever rows
 * are inserted), reuse the cached course on a hit, and remap its node
 * indices to the new model by EPD.
 */
import { deriveCourse, type Course, type SystemDef } from "./courses";
import type { Hub } from "./hubs";
import type { Model } from "./model";
import { T } from "./tunables";

interface Entry {
  course: Course;
  model: Model;
  used: boolean;
}

export class CourseMemo {
  private map = new Map<string, Entry>();
  hits = 0;
  misses = 0;
  private sigs = new Map<Hub, string>();

  constructor(private hasher: (s: string) => string) {}

  /** Start a build: forget per-build hub signatures, mark entries unused. */
  begin(): void {
    this.sigs.clear();
    this.hits = 0;
    this.misses = 0;
    for (const e of this.map.values()) e.used = false;
  }

  /** Drop entries no course used this build (bounded memory). */
  end(): void {
    for (const [k, e] of this.map) if (!e.used) this.map.delete(k);
  }

  derive(model: Model, hub: Hub, system: SystemDef): Course {
    let sig = this.sigs.get(hub);
    if (sig === undefined) {
      sig = this.hasher(hubSignature(model, hub));
      this.sigs.set(hub, sig);
    }
    const choices = system.choices.map(([n, san]) => `${model.nodes[n].epd}>${san}`).join(";");
    const key = `${hub.slug}|${system.side}|${system.slug}|${system.name}|${system.parent ?? ""}|${model.nodes[system.signatureNode].epd}|${choices}|${sig}`;
    const hit = this.map.get(key);
    if (hit) {
      const course = hit.model === model ? { ...hit.course, system } : remapCourse(hit.course, hit.model, model, system);
      if (course) {
        hit.used = true;
        this.hits++;
        if (hit.model !== model) this.map.set(key, { course, model, used: true });
        return course;
      }
    }
    this.misses++;
    const course = deriveCourse(model, hub, system);
    this.map.set(key, { course, model, used: true });
    return course;
  }
}

/** Everything deriveCourse reads for this hub, in index-free terms. */
export function hubSignature(model: Model, hub: Hub): string {
  const parts: string[] = [hub.slug, hub.title, String(model.maxPly), hub.sigmaNorms.join(" ")];
  const nameOf = (n: number) => (model.nodes[n].nameRow === -1 ? "" : model.rows[model.nodes[n].nameRow].name);
  const nodeSig = (n: number) => {
    const nd = model.nodes[n];
    return `${nd.epd}|${nameOf(n)}|${nd.games}`;
  };
  const dagNodes = [...hub.dag.keys()].sort((a, b) => (model.nodes[a].epd < model.nodes[b].epd ? -1 : 1));
  const leaves = new Set<number>();
  for (const n of dagNodes) {
    const moves = hub.dag.get(n)!;
    parts.push(
      nodeSig(n) +
        "#" +
        (hub.rowsThrough.get(n) ?? 0) +
        "#" +
        moves
          .map((m) => {
            if (!hub.dag.get(m.to)?.length) leaves.add(m.to);
            const first = m.rows[0] === undefined ? "" : model.rows[m.rows[0]].rowId;
            return `${m.norm}:${m.san}:${m.games}:${model.nodes[m.to].epd}:${hub.rowsThrough.get(m.to) ?? 0}:${first}:${nameOf(m.to)}`;
          })
          .join(",")
    );
  }
  // the extension region below every leaf (bounded by the same limits)
  const seen = new Set<number>();
  const stack: [number, number][] = [...leaves].map((n) => [n, 0]);
  while (stack.length) {
    const [n, d] = stack.pop()!;
    if (seen.has(n) || d > T.EXT_MAX_PLIES) continue;
    seen.add(n);
    const nd = model.nodes[n];
    const ext = nd.moves.filter((m) => m.ext && m.to >= 0);
    parts.push(`E${nodeSig(n)}#${ext.map((m) => `${m.norm}:${m.san}:${m.games}:${model.nodes[m.to].epd}`).join(",")}`);
    for (const m of ext) if (!hub.dag.get(m.to)?.length) stack.push([m.to, d + 1]);
  }
  parts.sort();
  // rows realised per position
  parts.push(
    hub.rows
      .map((r) => `${model.rows[r].rowId}@${model.nodes[model.rows[r].path[model.rows[r].path.length - 1]].epd}`)
      .sort()
      .join(",")
  );
  return parts.join("\n");
}

function remapCourse(c: Course, from: Model, to: Model, system: SystemDef): Course | null {
  const map = (n: number): number => {
    const i = to.byEpd.get(from.nodes[n].epd);
    if (i === undefined) throw new Error("missing");
    return i;
  };
  try {
    return {
      ...c,
      system,
      lines: c.lines.map((l) => ({ ...l, nodes: l.nodes.map(map) })),
      folded: c.folded.map((f) => ({ ...f, nodes: f.nodes.map(map) })),
      bookMoves: new Map([...c.bookMoves].map(([n, s]) => [map(n), s])),
      alternatives: new Map([...c.alternatives].map(([n, s]) => [map(n), s])),
      systemNodes: new Set([...c.systemNodes].map(map)),
    };
  } catch {
    return null;
  }
}
