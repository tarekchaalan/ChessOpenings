/**
 * Brand mark: a pawn whose first moves branch into a variation tree —
 * the opening explorer in one glyph. Renders in currentColor.
 */
export default function Logo({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <svg
      viewBox="0 0 64 64"
      width={size}
      height={size}
      className={className}
      aria-hidden="true"
      fill="none"
    >
      {/* variation tree */}
      <path d="M32 28.5 V13.5" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
      <path
        d="M32 28.5 Q31.5 20.5 21 17.5"
        stroke="currentColor"
        strokeWidth="4"
        strokeLinecap="round"
      />
      <path
        d="M32 28.5 Q32.5 20.5 43 17.5"
        stroke="currentColor"
        strokeWidth="4"
        strokeLinecap="round"
      />
      <circle cx="32" cy="12.5" r="3.6" fill="currentColor" />
      <circle cx="19.5" cy="17" r="3.6" fill="currentColor" />
      <circle cx="44.5" cy="17" r="3.6" fill="currentColor" />
      {/* pawn */}
      <circle cx="32" cy="34.5" r="5.4" fill="currentColor" />
      <path
        d="M26.4 51 C26.4 44.6 28.6 41.4 32 40 C35.4 41.4 37.6 44.6 37.6 51 Z"
        fill="currentColor"
      />
      <rect x="22" y="51" width="20" height="5.5" rx="2.4" fill="currentColor" />
    </svg>
  );
}
