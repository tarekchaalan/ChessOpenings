"use client";
/**
 * v1 URLs (/learn/[id], /quiz/[id]) → the v2 trainer via the legacy map
 * (§4.3): the v1 id is an index into the map, whose entry names the best
 * course and line for that row. Client-side, so it works in every deploy
 * (the map is a static file). Unknown ids land on the catalog.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { parseCourseId } from "@/lib/courses-client";
import type { LegacyMap } from "@/lib/openings-build/legacy";

export function legacyTarget(map: LegacyMap, id: number, kind: "learn" | "quiz"): string {
  const e = Number.isInteger(id) && id >= 0 ? map.entries[id] : undefined;
  const c = e?.bestCourseId ? parseCourseId(e.bestCourseId) : null;
  if (!e || !c) return e?.sans.length ? `/explore?line=${e.sans.join(",")}` : "/openings";
  const mode = kind === "learn" ? "learn" : "recall";
  return `/train/${c.hub}/${c.system}/${c.side}?mode=${mode}${e.bestLineId ? `&line=${e.bestLineId}` : ""}`;
}

export default function LegacyRedirect({ id, kind }: { id: number; kind: "learn" | "quiz" }) {
  const router = useRouter();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    fetch("/data/legacy-map.v1.json")
      .then((r) => (r.ok ? (r.json() as Promise<LegacyMap>) : Promise.reject(new Error(String(r.status)))))
      .then((map) => alive && router.replace(legacyTarget(map, id, kind)))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [id, kind, router]);
  return (
    <p className="py-20 text-center text-sm text-muted" data-testid="legacy-redirect">
      {failed ? (
        <>
          This old link couldn’t be resolved. <Link href="/openings" className="text-accent underline">Browse openings</Link>
        </>
      ) : (
        "This opening moved to the new trainer — taking you there…"
      )}
    </p>
  );
}
