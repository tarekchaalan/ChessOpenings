/**
 * npm run corpus:build — position statistics from the pinned master corpus
 * (§4.6). Streams the lichess broadcast PGNs once and counts every
 * (position, move) up to `maxPly`, pruned to ≥ MIN_GAMES. The result is a
 * committed derived artifact, so `openings:build` can join stats onto any
 * line (including newly added ones) without touching the corpus again.
 *
 * Downloads missing months into data/cache/ (gitignored). Decompresses with
 * the zstd CLI when available, else the pure-JS `fzstd` decoder.
 */
import { Chess } from "chess.js";
import { createHash } from "node:crypto";
import { spawnSync, spawn } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { PassThrough, type Readable } from "node:stream";
import { gzipSync } from "node:zlib";
import { join } from "node:path";
import { Decompress } from "fzstd";
import { CACHE_DIR, ROOT, STATS_FILE, STATS_META_FILE, TSV_DIR, readTree, writeAtomic } from "./fsutil";
import { parseTsv, selectTsvFiles } from "../../src/lib/openings-build/tsv";
import { epdOf, normSan } from "../../src/lib/openings-build/replay";
import type { Issue, PositionStats } from "../../src/lib/openings-build/types";

const SOURCES = JSON.parse(readFileSync(join(ROOT, "scripts", "sources.json"), "utf8"));
const MIN_GAMES = Number(process.env.CORPUS_MIN_GAMES ?? 3);

async function download(url: string, dest: string): Promise<void> {
  if (existsSync(dest)) return;
  process.stdout.write(`  downloading ${url}\n`);
  const res = await fetch(url, { headers: { "User-Agent": "ChessOpeningsTrainer-corpus/2.0" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

const hasZstdCli = () => spawnSync("zstd", ["--version"], { stdio: "ignore" }).status === 0;

function decompress(file: string): Readable {
  if (hasZstdCli()) {
    return spawn("zstd", ["-dc", file], { stdio: ["ignore", "pipe", "inherit"] }).stdout;
  }
  const out = new PassThrough();
  const dec = new Decompress((chunk) => out.write(Buffer.from(chunk)));
  const src = createReadStream(file, { highWaterMark: 1 << 20 });
  src.on("data", (buf) => dec.push(new Uint8Array(buf as Buffer)));
  src.on("end", () => {
    dec.push(new Uint8Array(0), true);
    out.end();
  });
  src.on("error", (e) => out.destroy(e));
  return out;
}

/** Strip comments, variations, NAGs and move numbers from PGN movetext. */
function tokenizeMovetext(text: string, maxPlies: number): string[] {
  const sans: string[] = [];
  let depth = 0;
  let inComment = false;
  for (const tok of text.split(/\s+/)) {
    if (!tok) continue;
    if (inComment) { if (tok.includes("}")) inComment = false; continue; }
    if (tok.startsWith("{")) { if (!tok.includes("}")) inComment = true; continue; }
    if (tok.startsWith("(")) { depth += (tok.match(/\(/g) ?? []).length; continue; }
    if (tok.startsWith(")")) { depth -= (tok.match(/\)/g) ?? []).length; continue; }
    if (depth > 0) continue;
    if (/^\$\d+$/.test(tok)) continue;
    if (/^\d+\.+$/.test(tok)) continue;
    if (tok === "1-0" || tok === "0-1" || tok === "1/2-1/2" || tok === "*") break;
    const clean = tok.replace(/^\d+\.+/, "").replace(/[!?]+$/, "");
    if (!clean) continue;
    sans.push(clean);
    if (sans.length >= maxPlies) break;
  }
  return sans;
}

type Acc = { g: number; w: number; d: number; b: number; moves: Map<string, [number, number, number, number]> };

function deepestRowPlies(): number {
  const issues: Issue[] = [];
  let max = 0;
  for (const f of selectTsvFiles(readTree(TSV_DIR), issues)) {
    for (const r of parseTsv(f, issues)) max = Math.max(max, r.tokens.length);
  }
  return max;
}

async function main() {
  const t0 = Date.now();
  const deepest = deepestRowPlies();
  const maxPly = Math.max(30, deepest + 2);
  console.log(`corpus:build — maxPly ${maxPly} (deepest row ${deepest} plies), minGames ${MIN_GAMES}`);

  mkdirSync(CACHE_DIR, { recursive: true });
  const months: string[] = SOURCES.gamesCorpus.months;
  for (const m of months) {
    const f = `lichess_db_broadcast_${m}.pgn.zst`;
    await download(`https://database.lichess.org/broadcast/${f}`, join(CACHE_DIR, f));
  }

  const minElo: number = SOURCES.gamesCorpus.minElo;
  const acc = new Map<string, Acc>();
  const seen = new Set<string>();
  const counts = { seen: 0, included: 0, deduplicated: 0, illegal: 0 };
  // prefix cache: SAN prefix → FEN, so shared openings replay once
  const prefixFen = new Map<string, string>();

  const bump = (epd: string, rw: number, rd: number, rb: number): Acc => {
    let a = acc.get(epd);
    if (!a) { a = { g: 0, w: 0, d: 0, b: 0, moves: new Map() }; acc.set(epd, a); }
    a.g++; a.w += rw; a.d += rd; a.b += rb;
    return a;
  };

  for (const m of months) {
    const file = join(CACHE_DIR, `lichess_db_broadcast_${m}.pgn.zst`);
    process.stdout.write(`  ${m} …`);
    const before = counts.included;
    let tags: Record<string, string> = {};
    let moveText = "";
    let inMoves = false;

    const processGame = () => {
      counts.seen++;
      const result = tags.Result;
      if (result !== "1-0" && result !== "0-1" && result !== "1/2-1/2") return;
      const we = parseInt(tags.WhiteElo ?? "0", 10) || 0;
      const be = parseInt(tags.BlackElo ?? "0", 10) || 0;
      if (we < minElo || be < minElo) return;
      if (tags.FEN || (tags.SetUp && tags.SetUp !== "0")) return; // non-standard start
      const sans = tokenizeMovetext(moveText, maxPly);
      if (sans.length < 2) return;
      const key = `${tags.White}|${tags.Black}|${tags.Date}|${tags.Round}|${result}|${sans.slice(0, 16).join(" ")}`;
      const h = createHash("sha1").update(key).digest("base64");
      if (seen.has(h)) { counts.deduplicated++; return; }
      seen.add(h);
      counts.included++;
      const rw = result === "1-0" ? 1 : 0;
      const rd = result === "1/2-1/2" ? 1 : 0;
      const rb = result === "0-1" ? 1 : 0;

      let chess: Chess | null = null;
      let fen = new Chess().fen();
      let prefix = "";
      let epd = epdOf(fen);
      let node = bump(epd, rw, rd, rb);
      for (let i = 0; i < sans.length; i++) {
        const tok = normSan(sans[i]);
        prefix = i === 0 ? tok : prefix + " " + tok;
        let nextFen = prefixFen.get(prefix);
        let san = tok;
        if (nextFen === undefined || i >= 24) {
          if (!chess) chess = new Chess(fen);
          let mv;
          try { mv = chess.move(tok); } catch { counts.illegal++; return; }
          san = normSan(mv.san);
          nextFen = chess.fen();
          if (i < 24) prefixFen.set(prefix, nextFen);
        } else {
          chess = null;
        }
        const ms = node.moves.get(san) ?? [0, 0, 0, 0];
        ms[0]++; ms[1] += rw; ms[2] += rd; ms[3] += rb;
        node.moves.set(san, ms);
        fen = nextFen;
        epd = epdOf(fen);
        node = bump(epd, rw, rd, rb);
      }
    };

    const rl = createInterface({ input: decompress(file), crlfDelay: Infinity });
    for await (const line of rl) {
      if (line.startsWith("[")) {
        if (inMoves) { processGame(); tags = {}; moveText = ""; inMoves = false; }
        const mm = /^\[(\w+)\s+"(.*)"\]/.exec(line);
        if (mm) tags[mm[1]] = mm[2];
      } else if (line.trim()) {
        inMoves = true;
        moveText += " " + line;
      }
    }
    if (inMoves) processGame();
    process.stdout.write(` +${counts.included - before} games (positions so far ${acc.size})\n`);
  }

  // prune and serialise deterministically (sorted epds, moves by games desc then san)
  const positions: PositionStats["positions"] = {};
  let kept = 0;
  let keptMoves = 0;
  for (const epd of [...acc.keys()].sort()) {
    const a = acc.get(epd)!;
    if (a.g < MIN_GAMES) continue;
    const moves = [...a.moves.entries()]
      .filter(([, s]) => s[0] >= MIN_GAMES)
      .sort((x, y) => y[1][0] - x[1][0] || (x[0] < y[0] ? -1 : 1))
      .map(([san, s]) => [san, s[0], s[1], s[2], s[3]] as [string, number, number, number, number]);
    positions[epd] = [a.g, a.w, a.d, a.b, moves];
    kept++;
    keptMoves += moves.length;
  }
  const table: PositionStats = { format: "chess-openings-trainer/position-stats@1", maxPly, minGames: MIN_GAMES, positions };
  const json = JSON.stringify(table);
  const gz = gzipSync(json, { level: 9 });
  writeAtomic(STATS_FILE, gz);
  const meta = {
    format: table.format,
    source: SOURCES.gamesCorpus,
    maxPly,
    minGames: MIN_GAMES,
    counts: { gamesSeen: counts.seen, gamesIncluded: counts.included, gamesDeduplicated: counts.deduplicated, illegal: counts.illegal, positions: kept, moves: keptMoves },
    sha256: createHash("sha256").update(gz).digest("hex"),
    bytesGzip: gz.length,
    bytesJson: json.length,
  };
  writeAtomic(STATS_META_FILE, JSON.stringify(meta, null, 2) + "\n");
  console.log(`  ${kept} positions, ${keptMoves} moves → ${(gz.length / 1e6).toFixed(2)} MB gzip (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  if (gz.length > 3_000_000) console.warn(`  ! over the 3 MB budget — raise CORPUS_MIN_GAMES`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
