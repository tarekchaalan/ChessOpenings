import type { Metadata } from "next";
import QuizHome from "@/components/quiz/QuizHome";

export const metadata: Metadata = {
  title: "Quiz",
  description: "Drill openings against real theory — the app plays the opponent, you find the book move.",
};

export default function QuizPage() {
  return <QuizHome />;
}
