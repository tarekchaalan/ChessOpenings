import type { Metadata } from "next";
import InsightsClient from "@/components/insights/InsightsClient";

export const metadata: Metadata = {
  title: "Insights",
  description: "Link Chess.com or Lichess: where your openings leave book, how they score, and what to learn next.",
};

export default function InsightsPage() {
  return <InsightsClient />;
}
