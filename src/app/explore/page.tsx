import { Suspense } from "react";
import type { Metadata } from "next";
import ExplorerClient from "@/components/explorer/ExplorerClient";

export const metadata: Metadata = {
  title: "Explore",
  description: "Browse every named chess opening with real master-game statistics.",
};

export default function ExplorePage() {
  return (
    <Suspense>
      <ExplorerClient />
    </Suspense>
  );
}
