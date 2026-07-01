"use client";
/** Combobox for finding openings by name or ECO code (e.g. "najdorf", "B90"). */
import { useEffect, useRef, useState } from "react";
import { Search } from "lucide-react";
import { Dataset, Opening, searchOpenings } from "@/lib/openings";

export default function OpeningSearch({
  ds,
  onPick,
  placeholder = "Search openings — try “najdorf” or “B90”",
  autoFocus = false,
}: {
  ds: Dataset;
  onPick: (o: Opening) => void;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Opening[]>([]);
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!q.trim()) {
      setResults([]);
      return;
    }
    setResults(searchOpenings(ds, q, 12));
    setSel(0);
  }, [q, ds]);

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  const pick = (o: Opening) => {
    onPick(o);
    setQ("");
    setOpen(false);
  };

  return (
    <div ref={boxRef} className="relative">
      <div className="flex items-center gap-2 rounded-lg border border-edge bg-surface px-3 h-10 focus-within:border-accent transition-colors">
        <Search size={15} className="text-muted shrink-0" />
        <input
          value={q}
          autoFocus={autoFocus}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setSel((s) => Math.min(s + 1, results.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setSel((s) => Math.max(s - 1, 0));
            } else if (e.key === "Enter" && results[sel]) {
              e.preventDefault();
              pick(results[sel]);
            } else if (e.key === "Escape") {
              setOpen(false);
              (e.target as HTMLInputElement).blur();
            }
            e.stopPropagation();
          }}
          placeholder={placeholder}
          className="w-full bg-transparent outline-none text-sm placeholder:text-muted"
          aria-label="Search openings"
        />
      </div>
      {open && results.length > 0 && (
        <ul className="absolute z-30 mt-1 w-full max-h-80 overflow-y-auto panel-scroll rounded-lg border border-edge bg-surface shadow-lg">
          {results.map((o, i) => (
            <li key={o.id}>
              <button
                onMouseEnter={() => setSel(i)}
                onClick={() => pick(o)}
                className={`w-full text-left px-3 py-2 flex items-baseline gap-2 ${
                  i === sel ? "bg-accent-soft" : ""
                }`}
              >
                <span className="font-mono text-xs text-accent w-8 shrink-0">{o.eco}</span>
                <span className="text-sm truncate">{o.name}</span>
                <span className="ml-auto text-xs text-muted font-mono shrink-0">
                  {o.popularity > 0 ? `${o.popularity.toLocaleString()}` : ""}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
