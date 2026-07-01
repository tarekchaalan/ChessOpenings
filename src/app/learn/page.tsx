import type { Metadata } from "next";
import LearnCatalog from "@/components/learn/LearnCatalog";

export const metadata: Metadata = {
  title: "Learn",
  description: "Guided walkthroughs of every chess opening — mainlines, sidelines, and the ideas behind each move.",
};

export default function LearnPage() {
  return <LearnCatalog />;
}
