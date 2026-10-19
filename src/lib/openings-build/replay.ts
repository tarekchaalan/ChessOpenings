/**
 * Prefix-shared replay cache. Rows are replayed with chess.js once per
 * distinct move prefix; the cache survives across builds in the dev watcher,
 * so an edit only replays the rows (and plies) that changed.
 */
import { Chess } from "chess.js";
import type { Ply } from "./types";

export const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
export const START_EPD = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -";

export const normSan = (san: string) => san.replace(/[+#?!]+$/, "");
export const epdOf = (fen: string) => fen.split(" ").slice(0, 4).join(" ");

interface CachedPly extends Ply {
  fen: string;
}

export type ReplayResult =
  | { ok: true; plies: Ply[] }
  | { ok: false; plies: Ply[]; plyIndex: number; token: string };

export class ReplayCache {
  /** key = normalised tokens joined by " " → ply reached by the last token */
  private plies = new Map<string, CachedPly>();
  /** key of an illegal prefix → true (so bad rows don't re-replay) */
  private illegal = new Set<string>();
  /** chess.js moves executed (for build stats) */
  moves = 0;

  get size(): number {
    return this.plies.size;
  }

  replay(tokens: string[]): ReplayResult {
    const out: Ply[] = [];
    let key = "";
    let chess: Chess | null = null;
    let fen = START_FEN;
    for (let i = 0; i < tokens.length; i++) {
      const tok = normSan(tokens[i]);
      key = i === 0 ? tok : key + " " + tok;
      const hit = this.plies.get(key);
      if (hit) {
        out.push(stripFen(hit));
        fen = hit.fen;
        chess = null;
        continue;
      }
      if (this.illegal.has(key)) return { ok: false, plies: out, plyIndex: i, token: tokens[i] };
      if (!chess) chess = new Chess(fen);
      let mv;
      try {
        mv = chess.move(tok);
        this.moves++;
      } catch {
        this.illegal.add(key);
        return { ok: false, plies: out, plyIndex: i, token: tokens[i] };
      }
      fen = chess.fen();
      const ply: CachedPly = {
        san: mv.san,
        norm: normSan(mv.san),
        from: mv.from,
        to: mv.to,
        epd: epdOf(fen),
        fen,
      };
      this.plies.set(key, ply);
      out.push(stripFen(ply));
    }
    return { ok: true, plies: out };
  }

  /** FEN after a replayed prefix (used by extension and stats joins). */
  fenAfter(tokens: string[]): string | null {
    if (!tokens.length) return START_FEN;
    return this.plies.get(tokens.map(normSan).join(" "))?.fen ?? null;
  }
}

function stripFen(p: CachedPly): Ply {
  return { san: p.san, norm: p.norm, from: p.from, to: p.to, epd: p.epd };
}
