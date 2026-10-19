/**
 * The board's arrow vocabulary (§3.2 D, ADR 0005), defined in one place.
 * Brushes differ by opacity, width and dash as well as hue, so they stay
 * distinguishable for colour-blind users.
 *
 *   play     solid green, wide     — the expected move (Learn, first pass)
 *   plan     translucent green, thin, numbered 1-2-3 — next learner moves
 *   threat   red + tinted target square(s)
 *   alt      blue                   — alternatives at branch cards
 *   authored yellow                 — from PGN [%cal]/[%csl]
 *   ext      dashed green           — master practice beyond named theory
 */
import type { DrawBrushes, DrawShape } from "chessground/draw";
import type { Key } from "chessground/types";

/** Unique stroke colours let CSS target them (dashes for `ext`, see globals.css). */
export const BRUSHES: DrawBrushes = {
  green: { key: "g", color: "#15781B", opacity: 1, lineWidth: 10 },
  red: { key: "r", color: "#882020", opacity: 1, lineWidth: 10 },
  blue: { key: "b", color: "#003088", opacity: 1, lineWidth: 10 },
  yellow: { key: "y", color: "#e68f00", opacity: 1, lineWidth: 10 },
  play: { key: "cpl", color: "#15781B", opacity: 0.9, lineWidth: 10 },
  plan: { key: "cpn", color: "#2a9d3c", opacity: 0.45, lineWidth: 6 },
  threat: { key: "cth", color: "#b3261e", opacity: 0.85, lineWidth: 9 },
  alt: { key: "cal", color: "#1f5fbf", opacity: 0.6, lineWidth: 7 },
  authored: { key: "cau", color: "#d99a00", opacity: 0.75, lineWidth: 8 },
  ext: { key: "cex", color: "#157a1c", opacity: 0.7, lineWidth: 8 },
  hint: { key: "chi", color: "#15781B", opacity: 0.35, lineWidth: 0 },
};

export type Arrow = { from: string; to?: string; kind: keyof typeof KIND_BRUSH; label?: string };

const KIND_BRUSH = {
  play: "play",
  plan: "plan",
  threat: "threat",
  alt: "alt",
  authored: "authored",
  ext: "ext",
  green: "green",
  red: "red",
  blue: "blue",
  yellow: "yellow",
} as const;

export function arrowShapes(arrows: Arrow[]): DrawShape[] {
  return arrows.map((a) => ({
    orig: a.from as Key,
    ...(a.to ? { dest: a.to as Key } : {}),
    brush: KIND_BRUSH[a.kind],
    ...(a.label ? { label: { text: a.label, fill: BRUSHES.plan.color } } : {}),
  }));
}

/**
 * ✓ / ✕ badge in the top-right corner of a square (chessground customSvg:
 * the square is 0–100 on both axes). The circle stays inside the square,
 * since the board clips anything past its edge on the h-file and 8th rank,
 * and each glyph's bounding box is centred on the circle (80, 20).
 */
export function badgeShape(square: string, kind: "ok" | "bad"): DrawShape {
  const fill = kind === "ok" ? "#15781B" : "#b3261e";
  const glyph =
    kind === "ok"
      ? '<path d="M72 20.5 l5.5 5.5 l10.5 -11" stroke="#fff" stroke-width="4.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>'
      : '<path d="M73.5 13.5 l13 13 M86.5 13.5 l-13 13" stroke="#fff" stroke-width="4.5" fill="none" stroke-linecap="round"/>';
  return {
    orig: square as Key,
    customSvg: {
      html: `<g class="cg-badge cg-badge-${kind}"><circle cx="80" cy="20" r="16.5" fill="${fill}" stroke="#fff" stroke-width="2.5"/>${glyph}</g>`,
    },
  };
}

/** Square tints (chessground highlight.custom) by purpose. */
export type Tint = "threat" | "wrong" | "hint" | "authored-green" | "authored-red" | "authored-yellow" | "authored-blue";
export const tintClass = (t: Tint) => `sq-${t}`;
