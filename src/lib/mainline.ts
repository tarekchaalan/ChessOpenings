/**
 * Mainline construction for Learn mode: from a line prefix, repeatedly follow
 * the most popular named-theory continuation within the family until the
 * named lines run out. This yields "the" mainline a coach would show first.
 */
import { Chess } from "chess.js";
import { Dataset, Family, familyNextMoves, START_EPD } from "./openings";
import { fenToEpd } from "./explain";

export function greedyMainline(ds: Dataset, family: Family, fromPrefix: string[]): string[] {
  const chess = new Chess();
  for (const san of fromPrefix) chess.move(san);
  let epd = fromPrefix.length ? fenToEpd(chess.fen()) : START_EPD;
  const sans = [...fromPrefix];

  for (;;) {
    const next = familyNextMoves(ds, family, sans, epd);
    if (!next.length) break;
    const best = next[0];
    try {
      chess.move(best.san);
    } catch {
      break;
    }
    sans.push(best.san);
    epd = fenToEpd(chess.fen());
    if (sans.length > 40) break; // safety bound
  }
  return sans;
}
