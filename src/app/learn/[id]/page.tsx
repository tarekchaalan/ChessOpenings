import LearnClient from "@/components/learn/LearnClient";

export default async function LearnOpeningPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <LearnClient openingId={Number(id)} />;
}
