import { useId } from "react";

/**
 * Brand mark, from the Chess Analysis iOS app icon: the cburnett knight as one
 * forest-green silhouette with a light-green rim, on a charcoal tile. The
 * knight is a few shades lighter than the app icon's so it reads against the
 * tile at small sizes. src/app/icon.svg is the same drawing (favicon), and
 * scripts/brand/render-logo.mjs renders the PNGs from it.
 */
export const KNIGHT_PATHS = [
  "M22 10C32.5 11 38.5 18 38 39L15 39C15 30 25 32.5 23 18",
  "M24 18C24.38 20.91 18.45 25.37 16 27C13 29 13.18 31.34 11 31C9.958 30.06 12.41 27.96 11 28C10 28 11.19 29.23 10 30C9 30 5.997 31 6 26C6 24 12 14 12 14C12 14 13.89 12.1 14 10.5C13.27 9.506 13.5 8.5 13.5 7.5C14.5 6.5 16.5 10 16.5 10L18.5 10C18.5 10 19.28 8.008 21 7C22 7 22 10 22 10",
];

export default function Logo({ size = 24, className }: { size?: number; className?: string }) {
  // gradient ids must be unique per instance (several logos can share a page)
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  return (
    <svg viewBox="0 0 64 64" width={size} height={size} className={className} aria-hidden="true">
      <defs>
        <linearGradient id={`${id}-tile`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#323333" />
          <stop offset="1" stopColor="#131314" />
        </linearGradient>
        <linearGradient id={`${id}-knight`} gradientUnits="userSpaceOnUse" x1="38" y1="7" x2="11" y2="39">
          <stop offset="0" stopColor="#3a7a2b" />
          <stop offset="0.55" stopColor="#1e4d14" />
          <stop offset="1" stopColor="#14350d" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="14" fill={`url(#${id}-tile)`} />
      {/* stroke both paths, then fill over them: only the silhouette's outer rim stays visible */}
      <g transform="translate(7.1 5.2) scale(1.1)" strokeLinejoin="round" strokeLinecap="round">
        {KNIGHT_PATHS.map((d) => (
          <path key={`rim${d.length}`} d={d} fill="none" stroke="#8cc474" strokeWidth="2.2" />
        ))}
        {KNIGHT_PATHS.map((d) => (
          <path key={`fill${d.length}`} d={d} fill={`url(#${id}-knight)`} />
        ))}
      </g>
    </svg>
  );
}
