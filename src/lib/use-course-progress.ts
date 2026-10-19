"use client";
/** Progress for a course the learner has started (only started courses are derived). */
import { useHydrated } from "./hooks";
import { findSystem, loadCourse, modelOf, parseCourseId } from "./courses-client";
import { courseProgressInfo } from "./catalog-client";
import { allCards, allCourseProgress, overridesFor, useProgressVersion } from "./progress/store";
import { tierLines } from "./trainer/plan";
import type { Dataset } from "./openings";

export function useStartedCourse(ds: Dataset, courseId: string | null) {
  useProgressVersion();
  const hydrated = useHydrated();
  if (!hydrated || !courseId || !allCourseProgress()[courseId]) return null;
  const p = parseCourseId(courseId);
  const system = p && findSystem(ds, p.hub, p.system, p.side);
  if (!system) return null;
  const course = loadCourse(ds, system, overridesFor(courseId));
  if (!course) return null;
  return courseProgressInfo(modelOf(ds), course, tierLines(course, "complete"), allCards());
}
