import CourseClient from "@/components/openings/CourseClient";

export default async function CoursePage({
  params,
}: {
  params: Promise<{ hub: string; system: string; side: string }>;
}) {
  const { hub, system, side } = await params;
  return <CourseClient hub={hub} system={decodeURIComponent(system)} side={side === "black" ? "black" : "white"} />;
}
