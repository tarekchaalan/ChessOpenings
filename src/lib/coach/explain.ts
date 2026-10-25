/**
 * Coach text (§4.11, ADR 0005): authored content always wins; otherwise a
 * sentence or two built only from verified facts and real master stats.
 * Phrasing varies deterministically (hash of position + move), so the same
 * position always reads the same. Every string is ≤ 240 characters.
 */
import { Chess, type Move, type Square } from "chess.js";
import { fnv1a } from "@/lib/openings-build/hash";
import type { Annotations, MoveNote } from "@/lib/openings-build/annotations";
import { moveFacts, newThreats, PIECE_NAME, withClocks, type MoveFacts, type Threat } from "./facts";

export const MAX_COACH_CHARS = 240;

const SQ = (s: string) => s;
/** A minor piece leaving its starting square (only that is "development"). */
const fromHome = (f: MoveFacts) => (f.piece === "n" ? ["b1", "g1", "b8", "g8"] : ["c1", "f1", "c8", "f8"]).includes(f.from);
const pick = <T,>(seed: string, options: T[]): T => options[fnv1a(seed) % options.length];
const sideName = (c: "w" | "b") => (c === "w" ? "White" : "Black");

export function clip(text: string, max = MAX_COACH_CHARS): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const stop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("; "));
  return (stop > max * 0.5 ? cut.slice(0, stop + 1) : cut.replace(/\s+\S*$/, "")) + "…";
}

export interface MoveStatsCtx {
  /** games reaching the position before the move */
  nodeGames: number;
  /** games with this move */
  moveGames: number;
  /** White score (0–1) before and after the move, null when < 30 games */
  scoreBefore: number | null;
  scoreAfter: number | null;
}

function factSentences(f: MoveFacts, seed: string, opts: { gambit: boolean }): string[] {
  const out: string[] = [];
  const piece = PIECE_NAME[f.piece];
  if (f.mate) return ["Checkmate."];
  if (f.castle) {
    out.push(
      f.castle === "short"
        ? pick(seed, ["Castles short: the king is safe and the rooks connect.", "Castles kingside, tucking the king away and connecting the rooks."])
        : pick(seed, ["Castles long: the king goes queenside and the rook joins the d-file at once.", "Castles queenside, bringing the rook straight to the centre."])
    );
  }
  if (f.capture) {
    const what = PIECE_NAME[f.capture.piece];
    out.push(f.capture.recapture ? `Recaptures on ${SQ(f.capture.square)}.` : `Captures the ${what} on ${SQ(f.capture.square)}.`);
  }
  if (f.check && !f.mate) out.push(pick(seed + "c", ["Check, so the reply is forced.", "A check: the opponent must deal with it first."]));
  for (const p of f.pins.slice(0, 1)) {
    out.push(
      p.absolute
        ? // only a pinned knight is frozen; other pieces may still move along the pin line
          `Pins the ${PIECE_NAME[p.pinnedPiece]} on ${p.pinned} to the king${p.pinnedPiece === "n" ? ": it can't move" : ""}.`
        : `Pins the ${PIECE_NAME[p.pinnedPiece]} on ${p.pinned} to the ${PIECE_NAME[p.behindPiece]} behind it.`
    );
  }
  if (f.fianchetto) out.push(pick(seed + "f", ["Fianchettoes the bishop onto the long diagonal.", "The bishop settles on the long diagonal: a fianchetto."]));
  if (f.pawnBreak && !f.capture) out.push(pick(seed + "p", ["Strikes at the centre, creating pawn tension.", "A pawn break: the pawns are now in contact."]));
  if (!f.capture && !f.castle && (f.piece === "n" || f.piece === "b") && !f.fianchetto && !f.pins.length) {
    out.push(
      fromHome(f)
        ? `Develops the ${piece}${f.developed >= 2 ? ` (${f.developed} minor pieces out)` : ""}.`
        : pick(seed + "r", [`Repositions the ${piece}.`, `The ${piece} finds a new square.`])
    );
  }
  if (f.materialVsStart <= -1) {
    const pawns = -f.materialVsStart;
    const amount = pawns === 1 ? "a pawn" : `${pawns} points of material`;
    out.push(opts.gambit ? `${sideName(f.color)} is ${amount} down: that's the gambit, paid for with time and open lines.` : `${sideName(f.color)} is ${amount} down for now.`);
  }
  return out;
}

function statsSentence(s: MoveStatsCtx | null, seed: string): string | null {
  if (!s || s.nodeGames < 10 || s.moveGames <= 0) return null;
  const pct = Math.round((s.moveGames / s.nodeGames) * 100);
  const share = pct < 1 ? "under 1%" : `${pct}%`;
  let text: string;
  if (pct >= 60) text = pick(seed + "s", [`The main move here: ${share} of master games.`, `Played in ${share} of master games: the main line.`]);
  else if (pct >= 20) text = `A major option: ${share} of master games.`;
  else text = `Played in ${share} of master games.`;
  if (s.scoreBefore !== null && s.scoreAfter !== null && Math.abs(s.scoreAfter - s.scoreBefore) >= 0.05) {
    text += ` White scores ${Math.round(s.scoreAfter * 100)}% after it (${Math.round(s.scoreBefore * 100)}% before).`;
  }
  return text;
}

export interface ExplainCtx {
  annotations: Annotations;
  /** hub/row/node names on the path, for the gambit rule */
  names: string[];
  stats: MoveStatsCtx | null;
  previous: Move | null;
  fallback?: string;
}

export function noteFor(a: Annotations, epd: string, san: string): MoveNote | undefined {
  return a.moves.get(`${epd}|${san.replace(/[+#]$/, "")}`);
}

/** The "why" of `san` played in `fenBefore`: authored, else verified facts + stats. */
export function whyText(fenBefore: string, san: string, ctx: ExplainCtx): { text: string; more?: string; authored: boolean } {
  const epd = withClocks(fenBefore).split(" ").slice(0, 4).join(" ");
  const authored = noteFor(ctx.annotations, epd, san)?.why;
  if (authored) {
    const short = clip(authored);
    return { text: short, ...(short !== authored ? { more: authored } : {}), authored: true };
  }
  const f = moveFacts(fenBefore, san, ctx.previous);
  const seed = epd + san;
  const gambit = ctx.names.some((n) => /gambit/i.test(n));
  const parts = f ? factSentences(f, seed, { gambit }) : [];
  const stat = statsSentence(ctx.stats, seed);
  const chosen = [...parts.slice(0, 2), ...(stat ? [stat] : [])];
  return { text: clip(chosen.join(" ") || (ctx.fallback ?? "A book move in this line.")), authored: false };
}

/** H1 idea: authored [%hint], else a fact-based idea that never names the destination. */
export function ideaText(fenBefore: string, san: string, a: Annotations, previous: Move | null = null): string {
  const epd = withClocks(fenBefore).split(" ").slice(0, 4).join(" ");
  const hint = noteFor(a, epd, san)?.hint;
  if (hint) return clip(hint);
  const f = moveFacts(fenBefore, san, previous);
  if (!f) return "Find the book move.";
  if (f.mate) return "There's a mate in one.";
  if (f.castle) return "Get your king to safety.";
  if (f.capture) {
    if (f.capture.recapture) return "Restore the material balance.";
    // "for the taking" only when the capturing piece can't be taken back
    const after = new Chess(withClocks(fenBefore));
    after.move(san);
    const defended = after.attackers(f.to as Square, after.turn()).length > 0;
    return defended ? `Trade: capture a ${PIECE_NAME[f.capture.piece]}.` : `Capture something: a ${PIECE_NAME[f.capture.piece]} is there for the taking.`;
  }
  if (f.check) return "Look for a check.";
  if (f.pins.length) return `Pin a piece with your ${PIECE_NAME[f.piece]}.`;
  if (f.fianchetto) return "Put a bishop on the long diagonal.";
  if (f.pawnBreak) return "Challenge the centre with a pawn.";
  if ((f.piece === "n" || f.piece === "b") && fromHome(f)) return `Develop a ${PIECE_NAME[f.piece]}.`;
  if (f.piece === "n" || f.piece === "b") return `Reposition a ${PIECE_NAME[f.piece]} that's already out.`;
  if (f.piece === "p" && /^[de][45]$/.test(f.to)) return "Claim the centre with a pawn.";
  if (f.piece === "p") return "A pawn move is the book move here.";
  return `Bring your ${PIECE_NAME[f.piece]} into play.`;
}

export function threatSentence(threats: Threat[], by: "w" | "b"): string | null {
  if (!threats.length) return null;
  const t = threats[0];
  const dots = by === "b" ? "…" : "";
  if (t.kind === "mate") return `${sideName(by)} threatens mate with ${dots}${t.san}.`;
  if (t.kind === "check") return `${sideName(by)} threatens ${dots}${t.san}.`;
  return `${sideName(by)} threatens ${dots}${t.san}, winning the ${PIECE_NAME[t.target]}.`;
}

/** Opponent message body: what was played, how often, why, and what it threatens. */
export function opponentText(fenBefore: string, san: string, ctx: ExplainCtx): { text: string; threats: Threat[]; more?: string } {
  const c = new Chess(withClocks(fenBefore));
  const color = c.turn();
  let fenAfter = fenBefore;
  try {
    c.move(san);
    fenAfter = c.fen();
  } catch {
    return { text: "", threats: [] };
  }
  const threats = newThreats(fenBefore, fenAfter);
  const why = whyText(fenBefore, san, ctx);
  const threat = threatSentence(threats, color);
  return { text: clip([why.text, threat].filter(Boolean).join(" ")), threats, ...(why.more ? { more: why.more } : {}) };
}
