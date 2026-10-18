import { Suspense } from "react";
import TrainerClient from "@/components/trainer/TrainerClient";

export default async function TrainPage({ params }: { params: Promise<{ hub: string; system: string; side: string }> }) {
  const { hub, system, side } = await params;
  return (
    <Suspense fallback={<div className="py-8 h-[70vh] rounded-lg bg-surface-2 animate-pulse" />}>
      <TrainerClient hub={hub} system={decodeURIComponent(system)} side={side === "black" ? "black" : "white"} />
    </Suspense>
  );
}
