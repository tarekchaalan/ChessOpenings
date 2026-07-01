/**
 * Move-by-move explanations for Learn mode.
 *
 * Two layers:
 *   1. Curated annotations for the most-played openings (content/annotations).
 *   2. Heuristic explanations derived from the position with chess.js and from
 *      the corpus stats (popularity, name changes, tactical features).
 */
import { Chess, Move, Square } from "chess.js";
import type { Dataset, MoveStat, Opening } from "./openings";
import { nodeAt } from "./openings";
import { ANNOTATIONS } from "@/content/annotations";

const CENTER = new Set(["d4", "e4", "d5", "e5"]);
const EXTENDED_CENTER = new Set(["c3", "d3", "e3", "f3", "c4", "f4", "c5", "f5", "c6", "d6", "e6", "f6"]);

/**
 * Explain the move at `prefix.length` given the line so far.
 * `chessBefore` must be at the position before the move; `move` already validated.
 */
export function explainMove(
  ds: Dataset,
  prefix: string[],
  move: Move,
  chessAfter: Chess
): string {
  const curated = ANNOTATIONS[[...prefix, move.san].join(" ")];
  if (curated) return curated;

  const parts: string[] = [];
  const epdBefore = fenToEpd(move.before);
  const epdAfter = fenToEpd(move.after);
  const nodeBefore = nodeAt(ds, epdBefore);
  const nodeAfter = nodeAt(ds, epdAfter);

  // Naming: does this move define a new named opening/variation?
  const namedBefore = nodeBefore && nodeBefore.openingIdx !== -1 ? ds.openings[nodeBefore.openingIdx] : null;
  const namedAfter = nodeAfter && nodeAfter.openingIdx !== -1 ? ds.openings[nodeAfter.openingIdx] : null;
  if (namedAfter && namedAfter.name !== namedBefore?.name) {
    parts.push(`This is the defining move of the ${namedAfter.name} (${namedAfter.eco}).`);
  }

  parts.push(...tacticalFeatures(move, chessAfter));

  // Popularity from real games
  if (nodeBefore) {
    const stat = nodeBefore.moves.find((m) => m.san === move.san);
    if (stat && nodeBefore.games >= 10) {
      const pct = Math.round((stat.games / nodeBefore.games) * 100);
      if (pct >= 60) parts.push(`The main line — chosen in ${pct}% of master games here.`);
      else if (pct >= 25) parts.push(`A major alternative, played in ${pct}% of master games.`);
      else if (pct >= 8) parts.push(`A respected sideline (${pct}% of master games).`);
      else if (stat.games > 0) parts.push(`A rare guest in master play (${pct < 1 ? "<1" : pct}% of games).`);
    }
  }

  if (parts.length === 0) {
    parts.push(genericPurpose(move));
  }
  return parts.join(" ");
}

function tacticalFeatures(move: Move, after: Chess): string[] {
  const out: string[] = [];
  if (move.san === "O-O") out.push("Castles short, tucking the king to safety and connecting the rooks.");
  if (move.san === "O-O-O") out.push("Castles long — the king finds shelter on the queenside and the rook joins the fight immediately.");
  if (after.isCheckmate()) out.push("Checkmate!");
  else if (after.inCheck()) out.push("A check, forcing an immediate reply.");
  if (move.captured && !out.length) {
    out.push(move.promotion ? "Captures and promotes." : `Captures the ${pieceName(move.captured)} on ${move.to}.`);
  }
  if (move.piece === "p" && CENTER.has(move.to) && !move.captured) {
    out.push("Stakes a claim in the center.");
  }
  if (move.piece === "p" && isGambitOffer(move, after)) {
    out.push("Offers a pawn to seize the initiative — a gambit.");
  }
  if ((move.piece === "n" || move.piece === "b") && !move.captured) {
    if (isFianchetto(move)) out.push("Fianchettoes the bishop to bear down on the long diagonal.");
    else if (EXTENDED_CENTER.has(move.to) || CENTER.has(move.to)) out.push(`Develops the ${pieceName(move.piece)} toward the center.`);
  }
  if (createsPin(move, after)) out.push("Pins an enemy piece, restricting its defender's options.");
  return out;
}

function genericPurpose(move: Move): string {
  if (move.piece === "q") return "Brings the queen into active play.";
  if (move.piece === "r") return "Improves the rook, eyeing the open file.";
  if (move.piece === "k") return "A useful king move, sidestepping future tactics.";
  if (move.piece === "p") {
    const file = move.to[0];
    if (file === "a" || file === "h") return "Gains space on the edge and gives the king breathing room.";
    return "A useful pawn move, supporting the fight for key squares.";
  }
  return "A flexible developing move.";
}

function isFianchetto(move: Move): boolean {
  return move.piece === "b" && ["g2", "b2", "g7", "b7"].includes(move.to);
}

function isGambitOffer(move: Move, after: Chess): boolean {
  // a pushed pawn that can be captured by an enemy pawn and is not defended by a pawn
  const targetSq = move.to as Square;
  const attackers = after.attackers(targetSq, after.turn());
  const defenders = after.attackers(targetSq, after.turn() === "w" ? "b" : "w");
  const pawnAttacks = attackers.some((sq) => after.get(sq)?.type === "p");
  return pawnAttacks && defenders.length === 0 && CENTER.has(move.to) === false;
}

function createsPin(move: Move, after: Chess): boolean {
  if (move.piece !== "b" && move.piece !== "r" && move.piece !== "q") return false;
  // crude check: the moved piece attacks a knight/bishop that shields the king or queen
  const enemies = after.board().flat().filter((p) => p && p.color === after.turn());
  void enemies;
  return false; // conservative: rely on curated notes for pin language
}

function pieceName(p: string): string {
  return { p: "pawn", n: "knight", b: "bishop", r: "rook", q: "queen", k: "king" }[p] ?? "piece";
}

export function fenToEpd(fen: string): string {
  return fen.split(" ").slice(0, 4).join(" ");
}

/** One-line "why learn this" blurb for opening cards, derived from stats. */
export function openingBlurb(ds: Dataset, o: Opening): string {
  const node = ds.nodes[o.nodeIdx];
  const total = node.white + node.draws + node.black;
  if (total < 20) return `${o.eco} · a rare line — surprise value guaranteed.`;
  const whitePct = Math.round((node.white / total) * 100);
  const blackPct = Math.round((node.black / total) * 100);
  const side = whitePct > blackPct + 5 ? `White scores ${whitePct}%` : blackPct > whitePct + 5 ? `Black scores ${blackPct}%` : "balanced results";
  return `${o.eco} · ${total.toLocaleString()} master games · ${side}.`;
}

export function topTheoryMove(moves: MoveStat[]): MoveStat | null {
  const theory = moves.filter((m) => m.inTheory);
  return theory.length ? theory[0] : null;
}
