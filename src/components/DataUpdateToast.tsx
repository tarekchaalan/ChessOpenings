"use client";
/**
 * "Openings updated · +2 lines · 1 renamed · Ruy Lopez" — shown when the
 * live dataset swaps to a new build (dev watcher or a new deploy).
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { RefreshCw, X } from "lucide-react";
import type { DatasetUpdate } from "@/lib/dataset-live";

const VISIBLE_MS = 8000;

export default function DataUpdateToast() {
  const [update, setUpdate] = useState<DatasetUpdate | null>(null);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onUpdate = (e: Event) => {
      setUpdate((e as CustomEvent<DatasetUpdate>).detail);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => setUpdate(null), VISIBLE_MS);
    };
    window.addEventListener("cot:dataset-updated", onUpdate);
    return () => {
      window.removeEventListener("cot:dataset-updated", onUpdate);
      if (timer) clearTimeout(timer);
    };
  }, []);
  return (
    <div aria-live="polite" className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 w-[min(92vw,460px)]">
      {update && (
        <div
          role="status"
          data-testid="data-update-toast"
          className="flex items-start gap-3 rounded-lg border border-edge bg-surface shadow-lg px-4 py-3 text-sm motion-safe:animate-[toast-in_180ms_ease-out]"
        >
          <RefreshCw size={16} className="text-accent mt-0.5 shrink-0" aria-hidden />
          <div className="min-w-0 flex-1">
            <div className="font-medium">Openings updated</div>
            <div className="text-muted truncate" title={update.summary}>{update.summary}</div>
          </div>
          <Link href="/changes" className="text-accent font-medium hover:underline shrink-0">
            See changes
          </Link>
          <button aria-label="Dismiss" onClick={() => setUpdate(null)} className="text-muted hover:text-foreground shrink-0">
            <X size={15} />
          </button>
        </div>
      )}
    </div>
  );
}
