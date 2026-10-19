/**
 * Copies the Stockfish 19 lite single-threaded build (GPL-3.0) from
 * node_modules/stockfish into public/engine/ (gitignored), with its licence.
 * Runs before dev and build; the browser loads it only on demand.
 */
import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "../..");
const SRC = join(ROOT, "node_modules/stockfish");
const OUT = join(ROOT, "public/engine");
const FILES: [string, string][] = [
  ["bin/stockfish-19-lite-single.js", "stockfish-19-lite-single.js"],
  ["bin/stockfish-19-lite-single.wasm", "stockfish-19-lite-single.wasm"],
  ["Copying.txt", "COPYING.txt"],
];

if (!existsSync(SRC)) {
  console.warn("copy-engine: node_modules/stockfish missing; the engine features stay hidden");
  process.exit(0);
}
mkdirSync(OUT, { recursive: true });
for (const [from, to] of FILES) {
  const src = join(SRC, from);
  const dst = join(OUT, to);
  if (existsSync(dst) && statSync(dst).size === statSync(src).size && statSync(dst).mtimeMs >= statSync(src).mtimeMs) continue;
  copyFileSync(src, dst);
}
console.log("copy-engine: public/engine ready (Stockfish 19 lite single-threaded, GPL-3.0)");
