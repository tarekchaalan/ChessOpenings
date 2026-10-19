import type { Metadata } from "next";
import { Suspense } from "react";
import CatalogClient from "@/components/openings/CatalogClient";

export const metadata: Metadata = {
  title: "Openings",
  description: "Every opening in the theory book, as White or Black: search, filter and pick a course.",
};

export default function OpeningsPage() {
  return (
    <Suspense fallback={<div className="py-8 h-96 rounded-lg bg-surface-2 animate-pulse" />}>
      <CatalogClient />
    </Suspense>
  );
}
