"use client";
/** Side selection + session launcher for one opening. */
import { useState } from "react";
import Link from "next/link";
import { Swords } from "lucide-react";
import QuizSession from "./QuizSession";
import { useDataset } from "@/lib/hooks";
import { defaultSide, familyOf } from "@/lib/openings";

export default function QuizStart({ openingId }: { openingId: number }) {
  const { ds } = useDataset();
  const [side, setSide] = useState<"white" | "black" | null>(null);

  if (!ds) {
    return (
      <div className="py-16 max-w-md mx-auto animate-pulse space-y-4">
        <div className="h-8 rounded bg-surface-2" />
        <div className="h-32 rounded-lg bg-surface-2" />
      </div>
    );
  }
  const opening = ds.openings[openingId];
  if (!opening) {
    return (
      <div className="py-20 text-center text-muted">
        Opening not found.{" "}
        <Link href="/quiz" className="text-accent underline">
          Back to quiz home
        </Link>
      </div>
    );
  }

  if (side) {
    return (
      <QuizSession
        config={{ mode: "opening", openingId, side }}
        title={`${opening.name} (${opening.eco})`}
      />
    );
  }

  const suggested = defaultSide(opening);
  const family = familyOf(ds, openingId);

  return (
    <div className="py-16 max-w-md mx-auto text-center">
      <Swords className="mx-auto text-accent mb-3" size={30} />
      <h1 className="text-2xl font-semibold tracking-tight mb-1">{opening.name}</h1>
      <p className="text-sm text-muted mb-1 font-mono">{opening.eco}</p>
      <p className="text-sm text-muted mb-8">
        {family.lines.length} named line{family.lines.length === 1 ? "" : "s"} in this family. The
        opponent plays weighted master theory — every run is different.
      </p>

      <div className="text-xs uppercase tracking-wider text-muted mb-3">Play as</div>
      <div className="grid grid-cols-2 gap-3 mb-4">
        {(["white", "black"] as const).map((s) => (
          <button
            key={s}
            onClick={() => setSide(s)}
            className={`h-24 rounded-xl border-2 transition-colors flex flex-col items-center justify-center gap-2 ${
              suggested === s
                ? "border-accent bg-accent-soft hover:opacity-90"
                : "border-edge bg-surface hover:border-accent"
            }`}
          >
            <span
              className={`w-8 h-8 rounded-full border ${
                s === "white" ? "bg-white border-neutral-300" : "bg-neutral-900 border-neutral-700"
              }`}
            />
            <span className="text-sm font-medium capitalize">
              {s}
              {suggested === s && <span className="text-accent"> · suggested</span>}
            </span>
          </button>
        ))}
      </div>
      <p className="text-xs text-muted">
        12 positions per session · answer fast for bigger rating gains
      </p>
    </div>
  );
}
