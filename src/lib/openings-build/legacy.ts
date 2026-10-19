/**
 * v1 → v2 legacy map (§4.3). v1 identity was the row's index in the
 * committed openings.v1.json; this maps every index to its content
 * identity so URLs, guest progress and server rows can be migrated.
 */
import { rowIdFor } from "./hash";
import { START_EPD, type ReplayCache } from "./replay";
import type { BaselineRow } from "./diff";

/** v1 dataset opening tuple: [eco, name, sans (space-joined), nodeIdx] */
export type V1Opening = [string, string, string, number];

export interface LegacyEntry {
  /** v2 row with the same move sequence, null if the row was removed */
  rowId: string | null;
  finalEpd: string;
  sans: string[];
  bestCourseId: string | null;
  bestLineId: string | null;
}

export interface LegacyMap {
  format: "chess-openings-trainer/legacy-map@1";
  /** index = v1 openingId */
  entries: LegacyEntry[];
}

export interface V1Replayed {
  baseline: BaselineRow[];
  replayed: { norms: string[]; sans: string[]; finalEpd: string; epds: string[] }[];
}

export function replayV1(v1: V1Opening[], cache: ReplayCache): V1Replayed {
  const baseline: BaselineRow[] = [];
  const replayed: V1Replayed["replayed"] = [];
  for (const o of v1) {
    const res = cache.replay(o[2].split(" "));
    const norms = res.plies.map((p) => p.norm);
    replayed.push({
      norms,
      sans: res.plies.map((p) => p.san),
      finalEpd: res.plies.length ? res.plies[res.plies.length - 1].epd : START_EPD,
      epds: [START_EPD, ...res.plies.map((p) => p.epd)],
    });
    baseline.push({ rowId: rowIdFor(norms), name: o[1], eco: o[0] || null });
  }
  return { baseline, replayed };
}

export function buildLegacyMap(
  v1: V1Replayed,
  currentRowIds: Set<string>,
  resolve: (r: V1Replayed["replayed"][number]) => { courseId: string | null; lineId: string | null } = () => ({
    courseId: null,
    lineId: null,
  })
): LegacyMap {
  return {
    format: "chess-openings-trainer/legacy-map@1",
    entries: v1.replayed.map((r, i) => {
      const rowId = v1.baseline[i].rowId;
      const best = resolve(r);
      return {
        rowId: currentRowIds.has(rowId) ? rowId : null,
        finalEpd: r.finalEpd,
        sans: r.sans,
        bestCourseId: best.courseId,
        bestLineId: best.lineId,
      };
    }),
  };
}
