"use client";
/**
 * Stockfish on demand (Phase 6, stretch 2): Stockfish 19 lite, single-threaded
 * WASM (GPL-3.0, like chessground), in a Web Worker created on first use only.
 * The files are copied from node_modules/stockfish to /engine/ at build time
 * (scripts/engine/copy-engine.ts). One search at a time: a new request stops
 * the running one. When the worker can't start, `engineAvailable()` turns false
 * and callers hide the eval bar / keep the engine-free mistake text.
 */
import { parseBestmove, parseInfo, rememberInfo, type Info } from "./uci";

export { rememberInfo };

const URL_JS = "/engine/stockfish-19-lite-single.js";

export interface Analysis extends Info {
  bestmove: string | null;
  /** Best line per MultiPV rank, ordered from best to worst. */
  lines: Info[];
}

let worker: Worker | null = null;
let failed = false;
let ready: Promise<void> | null = null;
/** the running search; superseded searches resolve with what they had */
let current: { resolve: (a: Analysis | null) => void; lines: Map<number, Info>; stopped: boolean } | null = null;
let chain: Promise<unknown> = Promise.resolve();

export function engineAvailable(): boolean {
  return !failed && typeof window !== "undefined" && typeof Worker !== "undefined" && typeof WebAssembly !== "undefined";
}

function start(): Promise<void> {
  if (ready) return ready;
  ready = new Promise<void>((resolve, reject) => {
    try {
      worker = new Worker(URL_JS);
    } catch (e) {
      failed = true;
      reject(e);
      return;
    }
    const timeout = setTimeout(() => {
      failed = true;
      reject(new Error("engine didn't start"));
    }, 20_000);
    worker.onerror = (e) => {
      failed = true;
      clearTimeout(timeout);
      current?.resolve(null);
      current = null;
      reject(e);
    };
    worker.onmessage = (ev: MessageEvent<string>) => {
      const line = String(ev.data);
      if (line === "readyok") {
        clearTimeout(timeout);
        resolve();
        return;
      }
      const info = parseInfo(line);
      if (info && current) {
        rememberInfo(current.lines, info);
        return;
      }
      const best = parseBestmove(line);
      if (best !== undefined && current) {
        const c = current;
        current = null;
        const lines = [...c.lines.values()].sort((a, b) => a.multipv - b.multipv);
        const main = lines[0];
        c.resolve(
          main
            ? { ...main, bestmove: best, lines }
            : best === null
              ? null
              : { depth: 0, score: { cp: 0 }, pv: [best], multipv: 1, bestmove: best, lines: [] }
        );
      }
    };
    worker.postMessage("uci");
    worker.postMessage("setoption name Hash value 16");
    worker.postMessage("isready");
  });
  return ready;
}

/**
 * Analyse a position (FEN). Scores are from the side to move's point of view.
 * Resolves null when the engine is unavailable or the position has no moves.
 */
export function analyse(fen: string, opts: { movetimeMs?: number; depth?: number; multipv?: number } = {}): Promise<Analysis | null> {
  if (!engineAvailable()) return Promise.resolve(null);
  // a newer request stops the running search (its caller gets what it had)
  if (current && !current.stopped) {
    current.stopped = true;
    worker?.postMessage("stop");
  }
  const run = chain.then(async () => {
    try {
      await start();
    } catch {
      return null;
    }
    return new Promise<Analysis | null>((resolve) => {
      const multipv = Math.max(1, Math.floor(opts.multipv ?? 1));
      current = { resolve, lines: new Map(), stopped: false };
      worker!.postMessage(`setoption name MultiPV value ${multipv}`);
      worker!.postMessage(`position fen ${fen}`);
      worker!.postMessage(opts.depth ? `go depth ${opts.depth}` : `go movetime ${opts.movetimeMs ?? 700}`);
    });
  });
  chain = run.catch(() => null);
  return run;
}

/** Stop and drop the worker (tests, memory). */
export function shutdownEngine(): void {
  worker?.terminate();
  worker = null;
  ready = null;
  current = null;
}
