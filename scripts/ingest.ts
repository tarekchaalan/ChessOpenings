/**
 * Chess Openings Trainer — data ingest pipeline.
 *
 * Reproducible build of the opening variation graph:
 *   1. Downloads the lichess-org/chess-openings ECO database (pinned commit).
 *   2. Downloads N months of the lichess broadcast database (pinned months) —
 *      real professional over-the-board games.
 *   3. Replays every named line with chess.js into a position graph keyed by
 *      EPD (FEN minus move clocks).
 *   4. Streams the game corpus through the graph, accumulating per-position and
 *      per-move popularity + win rates while games remain "in book".
 *   5. Emits:
 *        public/data/openings.v1.json   — compact runtime dataset
 *        public/data/openings.meta.json — version, source pins, counts, sha256
 *        supabase/seed.v1.sql           — v1 theory tables (the dry run's v1 baseline;
 *                                         the live seed is v2: supabase/seed/, scripts/supabase/gen-seed-v2.ts)
 *
 * Usage:  npm run ingest            (downloads into data/cache if missing)
 *         npm run ingest -- --skip-corpus   (graph only, no frequency stats)
 */
import { Chess } from "chess.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import type { Readable } from "node:stream";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CACHE = join(ROOT, "data", "cache");
const OUT_DATA = join(ROOT, "public", "data");
const OUT_SUPABASE = join(ROOT, "supabase");
const SOURCES = JSON.parse(readFileSync(join(ROOT, "scripts", "sources.json"), "utf8"));
const SKIP_CORPUS = process.argv.includes("--skip-corpus");

const START_EPD = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface Opening {
  eco: string;
  name: string;
  sans: string[];   // the defining line from the start position
  nodeIdx: number;  // index of the final position's node
}
interface Edge {
  san: string;           // display SAN (with +/# suffixes)
  to: number;            // destination node index, -1 = off-book (stats only)
  games: number; w: number; d: number; b: number;
}
interface Node {
  epd: string;
  openingIdx: number;    // opening defined by exactly this position, else -1
  games: number; w: number; d: number; b: number;
  edges: Map<string, Edge>;  // keyed by normalized SAN
  extras: Map<string, { san: string; games: number; w: number; d: number; b: number }>;
}

// ---------------------------------------------------------------------------
// Download helpers (cache-first, pinned sources)
// ---------------------------------------------------------------------------
async function download(url: string, dest: string): Promise<void> {
  if (existsSync(dest)) return;
  process.stdout.write(`  downloading ${url}\n`);
  const res = await fetch(url, { headers: { "User-Agent": "ChessOpeningsTrainer-ingest/1.0" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(dest, buf);
}

async function fetchSources(): Promise<void> {
  mkdirSync(CACHE, { recursive: true });
  const { repo, commit, files } = SOURCES.chessOpenings;
  for (const f of files) {
    await download(`https://raw.githubusercontent.com/${repo}/${commit}/${f}`, join(CACHE, f));
  }
  if (SKIP_CORPUS) return;
  for (const m of SOURCES.gamesCorpus.months) {
    const f = `lichess_db_broadcast_${m}.pgn.zst`;
    await download(`https://database.lichess.org/broadcast/${f}`, join(CACHE, f));
  }
}

// ---------------------------------------------------------------------------
// Step 1: build the variation graph from the ECO database
// ---------------------------------------------------------------------------
const normSan = (san: string) => san.replace(/[+#?!]+$/, "");
const epdOf = (chess: Chess) => chess.fen().split(" ").slice(0, 4).join(" ");

function parsePgnLine(pgn: string): string[] {
  // TSV pgn column: "1. e4 e5 2. Nf3 Nc6 ..." — strip move numbers.
  return pgn.split(/\s+/).filter((t) => t && !/^\d+\.+$/.test(t));
}

function buildGraph(): { nodes: Node[]; byEpd: Map<string, number>; openings: Opening[] } {
  const nodes: Node[] = [];
  const byEpd = new Map<string, number>();
  const openings: Opening[] = [];

  const getNode = (epd: string): number => {
    let idx = byEpd.get(epd);
    if (idx === undefined) {
      idx = nodes.length;
      byEpd.set(epd, idx);
      nodes.push({ epd, openingIdx: -1, games: 0, w: 0, d: 0, b: 0, edges: new Map(), extras: new Map() });
    }
    return idx;
  };
  getNode(START_EPD);

  let collisions = 0;
  for (const file of SOURCES.chessOpenings.files) {
    const tsv = readFileSync(join(CACHE, file), "utf8");
    for (const line of tsv.split("\n")) {
      if (!line.trim() || line.startsWith("eco\t")) continue;
      const [eco, name, pgn] = line.split("\t");
      if (!eco || !name || !pgn) continue;
      const sans = parsePgnLine(pgn);
      const chess = new Chess();
      let cur = 0;
      let ok = true;
      for (const san of sans) {
        let mv;
        try {
          mv = chess.move(san);
        } catch {
          ok = false;
          break;
        }
        const toEpd = epdOf(chess);
        const to = getNode(toEpd);
        const key = normSan(mv.san);
        if (!nodes[cur].edges.has(key)) {
          nodes[cur].edges.set(key, { san: mv.san, to, games: 0, w: 0, d: 0, b: 0 });
        }
        cur = to;
      }
      if (!ok) {
        console.warn(`  ! illegal line skipped: ${eco} ${name}`);
        continue;
      }
      if (nodes[cur].openingIdx !== -1) {
        collisions++;
        continue; // keep the first name for a transposed duplicate final position
      }
      const idx = openings.length;
      openings.push({ eco, name, sans, nodeIdx: cur });
      nodes[cur].openingIdx = idx;
    }
  }
  if (collisions) console.log(`  ${collisions} duplicate final positions kept first name`);
  return { nodes, byEpd, openings };
}

// ---------------------------------------------------------------------------
// Step 2: stream the games corpus through the graph
// ---------------------------------------------------------------------------
interface CorpusStats { games: number; included: number; deduped: number; }

async function streamCorpus(nodes: Node[], stats: CorpusStats): Promise<void> {
  const minElo: number = SOURCES.gamesCorpus.minElo;
  const seen = new Set<string>();

  for (const m of SOURCES.gamesCorpus.months) {
    const file = join(CACHE, `lichess_db_broadcast_${m}.pgn.zst`);
    process.stdout.write(`  corpus ${m} ...`);
    const before = stats.included;

    let tags: Record<string, string> = {};
    let inMoves = false;
    let moveText = "";

    const processGame = () => {
      stats.games++;
      const result = tags.Result;
      if (result !== "1-0" && result !== "0-1" && result !== "1/2-1/2") return;
      const we = parseInt(tags.WhiteElo ?? "0", 10) || 0;
      const be = parseInt(tags.BlackElo ?? "0", 10) || 0;
      if (we < minElo || be < minElo) return;
      const sans = tokenizeMovetext(moveText, 40); // first 40 plies is plenty for openings
      if (sans.length < 2) return;
      const key = `${tags.White}|${tags.Black}|${tags.Date}|${tags.Round}|${result}|${sans.slice(0, 16).join(" ")}`;
      const h = createHash("sha1").update(key).digest("base64");
      if (seen.has(h)) { stats.deduped++; return; }
      seen.add(h);
      stats.included++;

      const rw = result === "1-0" ? 1 : 0;
      const rd = result === "1/2-1/2" ? 1 : 0;
      const rb = result === "0-1" ? 1 : 0;
      let cur = 0;
      nodes[0].games++; nodes[0].w += rw; nodes[0].d += rd; nodes[0].b += rb;
      for (const rawSan of sans) {
        const key = normSan(rawSan);
        const node = nodes[cur];
        const edge = node.edges.get(key);
        if (edge) {
          edge.games++; edge.w += rw; edge.d += rd; edge.b += rb;
          cur = edge.to;
          const child = nodes[cur];
          child.games++; child.w += rw; child.d += rd; child.b += rb;
        } else {
          // off-book move: record for explorer display, then the game leaves theory
          let ex = node.extras.get(key);
          if (!ex) { ex = { san: rawSan, games: 0, w: 0, d: 0, b: 0 }; node.extras.set(key, ex); }
          ex.games++; ex.w += rw; ex.d += rd; ex.b += rb;
          break;
        }
      }
    };

    const rl = createInterface({ input: zstdStream(file), crlfDelay: Infinity });
    for await (const line of rl) {
      if (line.startsWith("[")) {
        if (inMoves) { processGame(); tags = {}; moveText = ""; inMoves = false; }
        const m = /^\[(\w+)\s+"(.*)"\]/.exec(line);
        if (m) tags[m[1]] = m[2];
      } else if (line.trim()) {
        inMoves = true;
        moveText += " " + line;
      }
    }
    if (inMoves) processGame();
    process.stdout.write(` total included so far: ${stats.included} (+${stats.included - before})\n`);
  }
}

/**
 * Decompress via the zstd CLI: the lichess dumps are multi-frame archives
 * with a leading skippable frame, which node:zlib's zstd cannot stream.
 */
function zstdStream(file: string): Readable {
  const child = spawn("zstd", ["-dc", file], { stdio: ["ignore", "pipe", "inherit"] });
  child.on("error", (e) => {
    console.error(`zstd CLI is required to read the games corpus (${e.message}).`);
    console.error("Install it (macOS: brew install zstd, Debian: apt install zstd) and re-run.");
    process.exit(1);
  });
  return child.stdout;
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
    // handle "12.e4" glued tokens
    const clean = tok.replace(/^\d+\.+/, "");
    if (!clean) continue;
    sans.push(clean);
    if (sans.length >= maxPlies) break;
  }
  return sans;
}

// ---------------------------------------------------------------------------
// Step 3: emit runtime dataset + supabase seed
// ---------------------------------------------------------------------------
function emit(nodes: Node[], openings: Opening[], stats: CorpusStats): void {
  mkdirSync(OUT_DATA, { recursive: true });
  mkdirSync(OUT_SUPABASE, { recursive: true });

  const MAX_EXTRAS = 6;
  const MIN_EXTRA_GAMES = 3;

  const outNodes = nodes.map((n) => {
    const edges: (string | number)[][] = [];
    for (const e of n.edges.values()) edges.push([e.san, e.to, e.games, e.w, e.d, e.b]);
    edges.sort((a, b) => (b[2] as number) - (a[2] as number));
    const extras = [...n.extras.values()]
      .filter((x) => x.games >= MIN_EXTRA_GAMES)
      .sort((a, b) => b.games - a.games)
      .slice(0, MAX_EXTRAS)
      .map((x) => [x.san, -1, x.games, x.w, x.d, x.b]);
    return [n.epd, n.openingIdx, n.games, n.w, n.d, n.b, [...edges, ...extras]];
  });
  const outOpenings = openings.map((o) => [o.eco, o.name, o.sans.join(" "), o.nodeIdx]);

  const dataset = {
    format: "chess-openings-trainer/graph@1",
    version: SOURCES.datasetVersion,
    startEpd: START_EPD,
    openings: outOpenings,
    nodes: outNodes,
  };
  const json = JSON.stringify(dataset);
  const file = join(OUT_DATA, `openings.v1.json`);
  writeFileSync(file, json);

  const meta = {
    version: SOURCES.datasetVersion,
    builtWith: { chessOpenings: SOURCES.chessOpenings, gamesCorpus: SKIP_CORPUS ? null : SOURCES.gamesCorpus },
    counts: {
      openings: openings.length,
      positions: nodes.length,
      theoryMoves: nodes.reduce((s, n) => s + n.edges.size, 0),
      corpusGamesSeen: stats.games,
      corpusGamesIncluded: stats.included,
      corpusGamesDeduplicated: stats.deduped,
    },
    sha256: createHash("sha256").update(json).digest("hex"),
    bytes: json.length,
  };
  writeFileSync(join(OUT_DATA, "openings.meta.json"), JSON.stringify(meta, null, 2) + "\n");

  emitSeedSql(nodes, openings);

  console.log(`\nDataset v${SOURCES.datasetVersion}`);
  console.log(`  openings:      ${meta.counts.openings}`);
  console.log(`  positions:     ${meta.counts.positions}`);
  console.log(`  theory moves:  ${meta.counts.theoryMoves}`);
  console.log(`  corpus games:  ${stats.included} included / ${stats.games} seen (${stats.deduped} duplicates)`);
  console.log(`  ${file} (${(json.length / 1e6).toFixed(1)} MB, sha256 ${meta.sha256.slice(0, 12)}…)`);
}

const sqlStr = (s: string) => `'${s.replace(/'/g, "''")}'`;

function emitSeedSql(nodes: Node[], openings: Opening[]): void {
  const lines: string[] = [
    "-- Generated by scripts/ingest.ts — DO NOT EDIT.",
    `-- Dataset version ${SOURCES.datasetVersion}, chess-openings @ ${SOURCES.chessOpenings.commit.slice(0, 10)}`,
    "begin;",
    "truncate table public.theory_openings, public.theory_edges restart identity cascade;",
  ];

  const openingRows = openings.map((o, i) =>
    `(${i}, ${sqlStr(o.eco)}, ${sqlStr(o.name)}, ${sqlStr("{" + o.sans.map((s) => '"' + s.replace(/"/g, '\\"') + '"').join(",") + "}")}::text[], ${sqlStr(nodes[o.nodeIdx].epd)}, ${nodes[o.nodeIdx].games})`
  );
  for (let i = 0; i < openingRows.length; i += 500) {
    lines.push(`insert into public.theory_openings (id, eco, name, line_san, final_epd, popularity) values\n${openingRows.slice(i, i + 500).join(",\n")};`);
  }

  const edgeRows: string[] = [];
  nodes.forEach((n) => {
    for (const e of n.edges.values()) {
      edgeRows.push(`(${sqlStr(n.epd)}, ${sqlStr(e.san)}, ${sqlStr(nodes[e.to].epd)}, ${e.games}, ${e.w}, ${e.d}, ${e.b})`);
    }
  });
  for (let i = 0; i < edgeRows.length; i += 1000) {
    lines.push(`insert into public.theory_edges (from_epd, san, to_epd, games, white_wins, draws, black_wins) values\n${edgeRows.slice(i, i + 1000).join(",\n")};`);
  }
  lines.push("commit;", "analyze public.theory_openings, public.theory_edges;");
  writeFileSync(join(OUT_SUPABASE, "seed.v1.sql"), lines.join("\n") + "\n");
  console.log(`  supabase/seed.v1.sql (${openings.length} openings, ${edgeRows.length} theory edges)`);
}

// ---------------------------------------------------------------------------
async function main() {
  console.log("Chess Openings Trainer — ingest");
  console.log("1/3 fetching pinned sources");
  await fetchSources();
  console.log("2/3 building variation graph");
  const { nodes, openings } = buildGraph();
  console.log(`  ${openings.length} named openings → ${nodes.length} positions`);
  const stats: CorpusStats = { games: 0, included: 0, deduped: 0 };
  if (!SKIP_CORPUS) {
    console.log("3/3 streaming games corpus");
    await streamCorpus(nodes, stats);
  } else {
    console.log("3/3 skipped corpus (--skip-corpus)");
  }
  emit(nodes, openings, stats);
}

main().catch((e) => { console.error(e); process.exit(1); });
