import type { Metadata } from "next";
import LeaderboardClient from "@/components/leaderboard/LeaderboardClient";

export const metadata: Metadata = {
  title: "Leaderboard",
  description: "Global and weekly rankings by quiz rating.",
};

export default function LeaderboardPage() {
  return <LeaderboardClient />;
}
