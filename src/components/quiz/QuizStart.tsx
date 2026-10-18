"use client";
/** Side + playlist-size selection, then launches the session. */
import { useMemo, useState } from "react";
import Link from "next/link";
import { ListMusic, Swords } from "lucide-react";
import QuizSession from "./QuizSession";
import { useLegacyDataset } from "@/lib/hooks";
import { defaultSide, familyOf } from "@/lib/openings";
import { distinctBranchCount } from "@/lib/quiz/playlist";

export default function QuizStart({ openingId }: { openingId: number }) {
  const { ds } = useLegacyDataset();
  const [side, setSide] = useState<"white" | "black" | null>(null);
  const [playlistSize, setPlaylistSize] = useState<number | null>(null);

  const branchCount = useMemo(() => {
    if (!ds || !ds.openings[openingId]) return 0;
    return distinctBranchCount(familyOf(ds, openingId));
  }, [ds, openingId]);

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

  const sizeOptions = [10, 15, 20].filter((n) => n < branchCount);
  const effectiveSize = playlistSize ?? (sizeOptions.length ? sizeOptions[0] : branchCount);

  if (side) {
    return (
      <QuizSession
        config={{ mode: "opening", openingId, side, playlistSize: effectiveSize }}
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
        {family.lines.length} named line{family.lines.length === 1 ? "" : "s"} in this family. Your
        playlist rotates through the most-played variations — the opponent walks each one and you
        supply the book moves.
      </p>

      {sizeOptions.length > 0 && (
        <>
          <div className="text-xs uppercase tracking-wider text-muted mb-3 flex items-center justify-center gap-1.5">
            <ListMusic size={13} /> Variations in the playlist
          </div>
          <div className="flex justify-center gap-2 mb-8">
            {[...sizeOptions, branchCount].map((n, i) => {
              const isAll = i === sizeOptions.length;
              const active = effectiveSize === n;
              return (
                <button
                  key={`${n}-${isAll}`}
                  onClick={() => setPlaylistSize(n)}
                  className={`px-4 h-9 rounded-lg border text-sm transition-colors ${
                    active
                      ? "border-accent bg-accent-soft text-accent font-medium"
                      : "border-edge bg-surface text-muted hover:text-foreground hover:border-accent"
                  }`}
                >
                  {isAll ? `All ${n}` : `Top ${n}`}
                </button>
              );
            })}
          </div>
        </>
      )}

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
        {branchCount <= 1
          ? "12 positions per session · answer fast for bigger rating gains"
          : `Drilling ${effectiveSize} variation${effectiveSize === 1 ? "" : "s"} · 12 positions per session · answer fast for bigger rating gains`}
      </p>
    </div>
  );
}
