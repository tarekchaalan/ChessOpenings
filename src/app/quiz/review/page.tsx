import type { Metadata } from "next";
import ReviewSession from "@/components/quiz/ReviewSession";

export const metadata: Metadata = {
  title: "Review",
  description: "Spaced-repetition review of the opening positions you've missed.",
};

export default function ReviewPage() {
  return <ReviewSession />;
}
