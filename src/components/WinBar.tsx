"use client";
import { winRateBar } from "@/lib/openings";

export default function WinBar({
  white,
  draws,
  black,
  className = "h-4",
  showLabels = true,
}: {
  white: number;
  draws: number;
  black: number;
  className?: string;
  showLabels?: boolean;
}) {
  const bar = winRateBar(white, draws, black);
  const label = (pct: number) => (showLabels && pct >= 12 ? `${Math.round(pct)}%` : "");
  return (
    <div className={className} title={`White ${Math.round(bar.white)}% · Draw ${Math.round(bar.draws)}% · Black ${Math.round(bar.black)}%`}>
      <div className="winbar">
        <div className="w" style={{ width: `${bar.white}%` }}>{label(bar.white)}</div>
        <div className="d" style={{ width: `${bar.draws}%` }}>{label(bar.draws)}</div>
        <div className="b" style={{ width: `${bar.black}%` }}>{label(bar.black)}</div>
      </div>
    </div>
  );
}
