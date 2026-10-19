/**
 * Course ids ("hub/system@side") to names and catalog links. The server only
 * stores ids; names come from the dataset when it's loaded, else from the slugs.
 */
import { courseHref, findSystem, hubSummary, parseCourseId } from "@/lib/courses-client";
import type { Dataset } from "@/lib/openings";

const titleCase = (slug: string) => slug.split("-").filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");

export function courseName(ds: Dataset | null, id: string): string {
  const c = parseCourseId(id);
  if (!c) return id;
  if (ds) {
    const hub = hubSummary(ds, c.hub);
    const sys = findSystem(ds, c.hub, c.system, c.side);
    if (hub && sys) {
      const s = sys.name;
      // system names usually repeat the hub's ("Sicilian Defense: Old Sicilian")
      return !s || s === hub.title ? hub.title : s.startsWith(hub.title) ? s : `${hub.title}: ${s}`;
    }
  }
  const hub = titleCase(c.hub);
  return c.system === "main" || c.system === c.hub ? hub : `${hub}: ${titleCase(c.system)}`;
}

/** "Learn this too": the same course in the catalog. */
export function courseLink(id: string): string | null {
  const c = parseCourseId(id);
  return c ? courseHref(c.hub, c.system, c.side) : null;
}

export function courseSide(id: string): "white" | "black" | null {
  return parseCourseId(id)?.side ?? null;
}
