import QuizStart from "@/components/quiz/QuizStart";

export default async function QuizOpeningPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <QuizStart openingId={Number(id)} />;
}
