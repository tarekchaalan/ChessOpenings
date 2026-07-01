/**
 * Pushes the theory tables to a hosted Supabase project without psql.
 *
 * Usage:
 *   NEXT_PUBLIC_SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npm run seed:remote
 *
 * Reads public/data/openings.v1.json (run `npm run ingest` first) and
 * replaces the contents of theory_openings + theory_edges in batches.
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
  process.exit(1);
}
const sb = createClient(url, key, { auth: { persistSession: false } });

interface RawDataset {
  version: string;
  openings: [string, string, string, number][];
  nodes: [string, number, number, number, number, number, (string | number)[][]][];
}

async function main() {
  const raw: RawDataset = JSON.parse(
    readFileSync(join(ROOT, "public", "data", "openings.v1.json"), "utf8")
  );
  console.log(`Seeding dataset v${raw.version}: ${raw.openings.length} openings…`);

  const openings = raw.openings.map((o, id) => ({
    id,
    eco: o[0],
    name: o[1],
    line_san: o[2].split(" "),
    final_epd: raw.nodes[o[3]][0],
    popularity: raw.nodes[o[3]][2],
  }));

  const edges: {
    from_epd: string;
    san: string;
    to_epd: string;
    games: number;
    white_wins: number;
    draws: number;
    black_wins: number;
  }[] = [];
  for (const n of raw.nodes) {
    for (const e of n[6]) {
      const to = e[1] as number;
      if (to < 0) continue; // stats-only off-book moves are client-side only
      edges.push({
        from_epd: n[0],
        san: e[0] as string,
        to_epd: raw.nodes[to][0],
        games: e[2] as number,
        white_wins: e[3] as number,
        draws: e[4] as number,
        black_wins: e[5] as number,
      });
    }
  }

  console.log(`  clearing existing theory tables…`);
  // theory_edges has no FK to openings, but clear it first anyway
  let del = await sb.from("theory_edges").delete().neq("san", "");
  if (del.error) throw new Error(del.error.message);
  del = await sb.from("theory_openings").delete().gte("id", 0);
  if (del.error) throw new Error(del.error.message);

  const BATCH = 1000;
  for (let i = 0; i < openings.length; i += BATCH) {
    const { error } = await sb.from("theory_openings").insert(openings.slice(i, i + BATCH));
    if (error) throw new Error(`theory_openings @${i}: ${error.message}`);
    process.stdout.write(`\r  openings ${Math.min(i + BATCH, openings.length)}/${openings.length}`);
  }
  console.log();
  for (let i = 0; i < edges.length; i += BATCH) {
    const { error } = await sb.from("theory_edges").insert(edges.slice(i, i + BATCH));
    if (error) throw new Error(`theory_edges @${i}: ${error.message}`);
    process.stdout.write(`\r  edges ${Math.min(i + BATCH, edges.length)}/${edges.length}`);
  }
  console.log("\nDone.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
