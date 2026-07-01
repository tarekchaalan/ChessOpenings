import { Chess } from "chess.js";
import { START_EPD } from "./openings";

export const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

export interface PlayedMove {
  san: string;
  from: string;
  to: string;
  fenAfter: string;
  epdAfter: string;
}

export interface LineState {
  sans: string[];
  moves: PlayedMove[];
  /** EPDs from the start position: epds[0] = start, epds[i] = after i plies */
  epds: string[];
  fen: string;
  epd: string;
  turn: "white" | "black";
  lastMove: [string, string] | null;
}

/** Replays a SAN line from the start; invalid tails are dropped. */
export function replayLine(sans: string[]): LineState {
  const chess = new Chess();
  const moves: PlayedMove[] = [];
  const epds: string[] = [START_EPD];
  for (const san of sans) {
    let mv;
    try {
      mv = chess.move(san);
    } catch {
      break;
    }
    const fenAfter = chess.fen();
    const epdAfter = fenAfter.split(" ").slice(0, 4).join(" ");
    moves.push({ san: mv.san, from: mv.from, to: mv.to, fenAfter, epdAfter });
    epds.push(epdAfter);
  }
  const last = moves[moves.length - 1];
  return {
    sans: moves.map((m) => m.san),
    moves,
    epds,
    fen: last?.fenAfter ?? START_FEN,
    epd: last?.epdAfter ?? START_EPD,
    turn: chess.turn() === "w" ? "white" : "black",
    lastMove: last ? [last.from, last.to] : null,
  };
}

/** Applies one SAN to a line state; returns null if illegal. */
export function pushSan(line: LineState, san: string): LineState | null {
  const chess = new Chess(line.fen);
  try {
    chess.move(san);
  } catch {
    return null;
  }
  return replayLine([...line.sans, san]);
}
