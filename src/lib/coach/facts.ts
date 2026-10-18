/**
 * Coach facts (§4.11, ADR 0005): deterministic, and only what code has
 * verified on the position. Every function here has unit tests on real
 * positions, including negative cases.
 */
import { Chess, type Color, type Move, type PieceSymbol, type Square } from "chess.js";

export const VALUE: Record<PieceSymbol, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 100 };
export const PIECE_NAME: Record<PieceSymbol, string> = { p: "pawn", n: "knight", b: "bishop", r: "rook", q: "queen", k: "king" };

const FILES = "abcdefgh";
const sq = (f: number, r: number): Square => `${FILES[f]}${r + 1}` as Square;
const fileOf = (s: string) => FILES.indexOf(s[0]);
const rankOf = (s: string) => Number(s[1]) - 1;
const other = (c: Color): Color => (c === "w" ? "b" : "w");

export const withClocks = (fenOrEpd: string) => (fenOrEpd.split(" ").length < 6 ? `${fenOrEpd} 0 1` : fenOrEpd);

/** A copy of the position with the other side to move (en passant cleared). */
export function flipTurn(fen: string): Chess | null {
  const p = withClocks(fen).split(" ");
  p[1] = p[1] === "w" ? "b" : "w";
  p[3] = "-";
  try {
    return new Chess(p.join(" "));
  } catch {
    return null;
  }
}

// ───────────────────────────── threats ─────────────────────────────────────

export interface Threat {
  kind: "mate" | "capture" | "check";
  from: string;
  to: string;
  san: string;
  /** the attacked piece for captures, the king for checks/mates */
  target: PieceSymbol;
  /** squares to tint: the target, plus the king for check threats */
  tint: string[];
}

/** Threats `by` would have if it were to move in `fen` (its legal moves only). */
function threatsFor(fen: string, by: Color): Threat[] {
  const c = new Chess(withClocks(fen));
  const chess = c.turn() === by ? c : flipTurn(fen);
  if (!chess) return [];
  const victim = other(by);
  const out: Threat[] = [];
  let kingSq = "";
  for (const row of chess.board()) for (const p of row) if (p && p.type === "k" && p.color === victim) kingSq = p.square;
  for (const mv of chess.moves({ verbose: true }) as Move[]) {
    if (mv.san.endsWith("#")) {
      out.push({ kind: "mate", from: mv.from, to: mv.to, san: mv.san, target: "k", tint: [mv.to, kingSq] });
      continue;
    }
    if (mv.captured && mv.captured !== "k") {
      const defenders = chess.attackers(mv.to as Square, victim);
      const undefended = defenders.length === 0;
      const upTrade = VALUE[mv.piece] < VALUE[mv.captured];
      if (undefended || upTrade) {
        out.push({ kind: "capture", from: mv.from, to: mv.to, san: mv.san, target: mv.captured, tint: [mv.to] });
      }
    }
    if (mv.san.endsWith("+") && seriousCheck(chess, mv)) {
      out.push({ kind: "check", from: mv.from, to: mv.to, san: mv.san, target: "k", tint: [mv.to, kingSq] });
    }
  }
  return out;
}

/**
 * A check worth calling a threat (not every legal check is): by a queen or
 * rook, or one that also attacks an undefended or higher-value piece (a
 * forking check), or one that can't be blocked or captured (king must move).
 */
function seriousCheck(chess: Chess, mv: Move): boolean {
  const c = new Chess(chess.fen());
  c.move(mv.san);
  const victim = c.turn();
  // a check that just loses the checker isn't a threat (3…Bc5 "threatens" …Bxf2+ Kxf2)
  const takers = (c.moves({ verbose: true }) as Move[]).filter((m) => m.to === mv.to && m.captured);
  if (takers.length) {
    const defended = c.attackers(mv.to as Square, mv.color).length > 0;
    if (!defended || takers.some((m) => VALUE[m.piece] < VALUE[mv.piece])) return false;
  }
  if (mv.piece === "q" || mv.piece === "r") return true;
  // forking check: from its new square the checker also hits a loose or bigger piece
  const flipped = flipTurn(c.fen());
  if (flipped) {
    for (const reply of flipped.moves({ square: mv.to as Square, verbose: true }) as Move[]) {
      if (!reply.captured || reply.captured === "k") continue;
      if (VALUE[reply.captured] > VALUE[mv.piece] || flipped.attackers(reply.to as Square, victim).length === 0) return true;
    }
  }
  // only king moves answer it
  return (c.moves({ verbose: true }) as Move[]).every((m) => m.piece === "k");
}

const RANK: Record<Threat["kind"], number> = { mate: 0, capture: 1, check: 2 };

/**
 * Threats the opponent's last move *created* (ADR 0005): with the learner to
 * move and not in check, the opponent's would-be moves after its move,
 * minus those it already had before it. At most `max`, mate > capture > check.
 */
export function newThreats(fenBefore: string, fenAfter: string, max = 2): Threat[] {
  const after = new Chess(withClocks(fenAfter));
  if (after.inCheck() || after.isGameOver()) return [];
  const by = other(after.turn());
  const key = (t: Threat) => `${t.kind}|${t.kind === "capture" ? t.to : t.from + t.to}`;
  const before = new Set(threatsFor(fenBefore, by).map(key));
  return threatsFor(fenAfter, by)
    .filter((t) => !before.has(key(t)))
    .sort((a, b) => RANK[a.kind] - RANK[b.kind] || VALUE[b.target] - VALUE[a.target] || (a.san < b.san ? -1 : 1))
    .slice(0, max);
}

// ───────────────────────────── pins ────────────────────────────────────────

export interface Pin {
  pinner: string;
  pinned: string;
  pinnedPiece: PieceSymbol;
  behind: string;
  behindPiece: PieceSymbol;
  absolute: boolean;
}

const DIAG = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
const ORTHO = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/** Pins created by the piece on `from` (B/R/Q): ray scans toward the enemy K or Q (or R behind a minor). */
export function pinsBy(fen: string, from: string): Pin[] {
  const chess = new Chess(withClocks(fen));
  const piece = chess.get(from as Square);
  if (!piece || !["b", "r", "q"].includes(piece.type)) return [];
  const dirs = piece.type === "b" ? DIAG : piece.type === "r" ? ORTHO : [...DIAG, ...ORTHO];
  const out: Pin[] = [];
  for (const [df, dr] of dirs) {
    let f = fileOf(from) + df;
    let r = rankOf(from) + dr;
    let first: { sq: string; type: PieceSymbol; color: Color } | null = null;
    while (f >= 0 && f < 8 && r >= 0 && r < 8) {
      const p = chess.get(sq(f, r));
      if (p) {
        if (!first) {
          if (p.color === piece.color) break;
          first = { sq: sq(f, r), type: p.type, color: p.color };
        } else {
          if (p.color !== first.color) break;
          const absolute = p.type === "k";
          if ((absolute || VALUE[p.type] > VALUE[first.type]) && first.type !== "k") {
            out.push({ pinner: from, pinned: first.sq, pinnedPiece: first.type, behind: sq(f, r), behindPiece: p.type, absolute });
          }
          break;
        }
      }
      f += df;
      r += dr;
    }
  }
  return out;
}

// ───────────────────────────── other facts ─────────────────────────────────

/** Material balance (P1 N3 B3 R5 Q9) for white minus black. */
export function materialBalance(fen: string): number {
  let bal = 0;
  for (const row of new Chess(withClocks(fen)).board()) for (const p of row) if (p && p.type !== "k") bal += (p.color === "w" ? 1 : -1) * VALUE[p.type];
  return bal;
}

const HOME_MINORS: Record<Color, string[]> = { w: ["b1", "c1", "f1", "g1"], b: ["b8", "c8", "f8", "g8"] };

/** Minor pieces of `color` that have left their starting squares. */
export function developedMinors(fen: string, color: Color): number {
  const chess = new Chess(withClocks(fen));
  let home = 0;
  for (const s of HOME_MINORS[color]) {
    const p = chess.get(s as Square);
    if (p && p.color === color && (p.type === "n" || p.type === "b")) home++;
  }
  // captured minors aren't "developed": count what's on the board
  let minors = 0;
  for (const row of chess.board()) for (const p of row) if (p && p.color === color && (p.type === "n" || p.type === "b")) minors++;
  return Math.max(0, minors - home);
}

/** A fianchetto: the bishop lands on b2/g2/b7/g7 with the knight pawn one step forward. */
export function isFianchetto(move: Move, fenAfter: string): boolean {
  if (move.piece !== "b") return false;
  const spots: Record<string, string> = { g2: "g3", b2: "b3", g7: "g6", b7: "b6" };
  const pawnSq = spots[move.to];
  if (!pawnSq) return false;
  const p = new Chess(withClocks(fenAfter)).get(pawnSq as Square);
  return !!p && p.type === "p" && p.color === move.color;
}

/** A pawn move that creates pawn-against-pawn contact on the c–f files. */
export function isPawnBreak(move: Move, fenAfter: string): boolean {
  if (move.piece !== "p") return false;
  const f = fileOf(move.to);
  if (f < 2 || f > 5) return false;
  const chess = new Chess(withClocks(fenAfter));
  const r = rankOf(move.to);
  const dir = move.color === "w" ? 1 : -1;
  for (const df of [-1, 1]) {
    const tf = f + df;
    if (tf < 0 || tf > 7) continue;
    // our pawn attacks an enemy pawn, or an enemy pawn attacks ours
    for (const tr of [r + dir, r - dir]) {
      if (tr < 0 || tr > 7) continue;
      const p = chess.get(sq(tf, tr));
      if (p && p.type === "p" && p.color !== move.color) return true;
    }
  }
  return false;
}

/** The previous move captured on the square this move captures on. */
export function isRecapture(move: Move, previous: Move | null): boolean {
  return !!move.captured && !!previous?.captured && previous.to === move.to;
}

export interface MoveFacts {
  san: string;
  color: Color;
  piece: PieceSymbol;
  from: string;
  to: string;
  capture: { piece: PieceSymbol; square: string; recapture: boolean } | null;
  check: boolean;
  mate: boolean;
  castle: "short" | "long" | null;
  pins: Pin[];
  fianchetto: boolean;
  pawnBreak: boolean;
  /** minors developed by the mover after the move */
  developed: number;
  /** material for the mover vs the start position, after the move (pawn units) */
  materialVsStart: number;
}

/** Facts about `san` played in `fenBefore` (null if illegal). */
export function moveFacts(fenBefore: string, san: string, previous: Move | null = null): MoveFacts | null {
  const chess = new Chess(withClocks(fenBefore));
  let move: Move;
  try {
    move = chess.move(san);
  } catch {
    return null;
  }
  const after = chess.fen();
  const sign = move.color === "w" ? 1 : -1;
  return {
    san: move.san,
    color: move.color,
    piece: move.piece,
    from: move.from,
    to: move.to,
    capture: move.captured ? { piece: move.captured, square: move.to, recapture: isRecapture(move, previous) } : null,
    check: chess.inCheck(),
    mate: chess.isCheckmate(),
    castle: move.san.startsWith("O-O-O") ? "long" : move.san.startsWith("O-O") ? "short" : null,
    pins: pinsBy(after, move.to),
    fianchetto: isFianchetto(move, after),
    pawnBreak: isPawnBreak(move, after),
    developed: developedMinors(after, move.color),
    materialVsStart: sign * materialBalance(after),
  };
}
