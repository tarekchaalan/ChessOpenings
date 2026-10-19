import type { Metadata } from "next";
import { Suspense } from "react";
import OpeningMap from "@/components/openings/OpeningMap";

export const metadata: Metadata = {
  title: "Opening map",
  description: "The named-theory tree as a zoomable map: width is how often masters play it, colour is the ECO volume.",
};

export default function OpeningMapPage() {
  return (
    <Suspense fallback={<div className="py-8 h-[60vh] rounded-lg bg-surface-2 animate-pulse" />}>
      <OpeningMap />
    </Suspense>
  );
}
