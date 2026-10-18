/**
 * The learner's book moves in the given courses, as (epd, answer) — what the
 * one-time server remap re-keys migrated cards to (ADR 0004). Loaded on
 * demand by lib/train-sync (course derivation is heavy).
 */
import type { Dataset } from "@/lib/openings";
import { findSystem, modelOf, parseCourseId } from "@/lib/courses-client";
import { courseFor } from "@/lib/trainer/client";
import { learnerMoves } from "@/lib/trainer/plan";

export function bookMovesOf(ds: Dataset, courseIds: string[]): { epd: string; answer: string }[] {
  const out = new Map<string, string>();
  const model = modelOf(ds);
  for (const id of courseIds) {
    const p = parseCourseId(id);
    const s = p ? findSystem(ds, p.hub, p.system, p.side) : null;
    if (!s) continue;
    const course = courseFor(ds, s);
    for (const l of course.lines) for (const m of learnerMoves(model, course.side, l)) if (!out.has(m.epd)) out.set(m.epd, m.answer);
  }
  return [...out].map(([epd, answer]) => ({ epd, answer }));
}
