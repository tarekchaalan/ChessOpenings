/**
 * One-off: migrate the 74 v1 notes in src/content/annotations.ts (keyed by
 * move-order strings) into public/data/annotations/curated.pgn, one tiny
 * game per note. Every key must replay legally, or the script fails.
 * Re-running is idempotent (the PGN is regenerated from the TS file).
 */
import { Chess } from "chess.js";
import { writeAtomic, ANNOTATIONS_DIR } from "./fsutil";
import { join } from "node:path";
import { ANNOTATIONS } from "../../src/content/annotations";

/**
 * v1 keys that never resolved (the v1 lookup silently missed them).
 * "e4 e6 d5" is illegal (no pawn can reach d5); its text — "White takes the
 * full center on offer" — describes 2.d4, so it is migrated there.
 */
const CORRECTIONS: Record<string, string> = { "e4 e6 d5": "e4 e6 d4" };

const games: string[] = [];
let n = 0;
for (const [rawLine, note] of Object.entries(ANNOTATIONS)) {
  const line = CORRECTIONS[rawLine] ?? rawLine;
  if (line !== rawLine) console.log(`  corrected v1 key "${rawLine}" → "${line}"`);
  const sans = line.split(" ");
  const chess = new Chess();
  const parts: string[] = [];
  sans.forEach((san, i) => {
    const mv = chess.move(san); // throws on an illegal key: the migration must not lose notes silently
    if (i % 2 === 0) parts.push(`${i / 2 + 1}. ${mv.san}`);
    else parts.push(i === 0 ? `1... ${mv.san}` : mv.san);
  });
  const text = note.replace(/[{}]/g, "");
  games.push(`[Event "Curated note ${++n}"]\n[Annotator "chess-openings-trainer v1"]\n\n${parts.join(" ")} { ${text} } *\n`);
}
const header =
  "% Curated coach notes migrated from src/content/annotations.ts (v1).\n" +
  "% Keyed by position + move when parsed, so transpositions share them.\n\n";
writeAtomic(join(ANNOTATIONS_DIR, "curated.pgn"), header + games.join("\n"));
console.log(`migrated ${n} notes → public/data/annotations/curated.pgn`);
