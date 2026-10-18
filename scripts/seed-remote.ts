/**
 * Pushes the v2 REFERENCE tables (dataset_version, theory_edges incl. is_ext,
 * theory_lines) to a hosted Supabase project without psql — the same rows as
 * supabase/seed.sql (ADR 0004). It never touches user tables or the one-time
 * legacy staging tables.
 *
 * REMOTE WRITE: run only with the project owner's approval, and only after
 * migrations/0004_v2_schema.sql is applied there.
 *
 *   NEXT_PUBLIC_SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npm run seed:remote -- --confirm
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDatasetV2 } from "../src/lib/openings";
import { buildSeedV2 } from "../src/lib/server/seed-v2";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
  process.exit(1);
}
if (!process.argv.includes("--confirm")) {
  console.error(`This writes to ${url}. Re-run with --confirm once the owner has approved it.`);
  process.exit(1);
}
const sb = createClient(url, key, { auth: { persistSession: false } });

async function main() {
  const meta = JSON.parse(readFileSync(join(ROOT, "public/data/openings.v2.meta.json"), "utf8"));
  const raw = JSON.parse(readFileSync(join(ROOT, "public/data/openings.v2.json"), "utf8"));
  const legacy = JSON.parse(readFileSync(join(ROOT, "public/data/legacy-map.v1.json"), "utf8"));
  const seed = buildSeedV2(parseDatasetV2(raw, meta.outputHash), legacy, { hash: meta.outputHash });
  console.log(`Seeding v2 reference data ${meta.outputHash.slice(0, 12)}: ${seed.edges.length} edges, ${seed.lines.length} lines…`);

  // clear table by table (no cascade); the version row goes first so clients
  // fall back to local grading while edges are being replaced
  for (const [table, col] of [["dataset_version", "hash"], ["theory_edges", "san"], ["theory_lines", "id"]] as const) {
    const del = await sb.from(table).delete().neq(col, "");
    if (del.error) throw new Error(`${table}: ${del.error.message}`);
  }
  const BATCH = 1000;
  for (const [table, rows] of [["theory_edges", seed.edges], ["theory_lines", seed.lines]] as const) {
    for (let i = 0; i < rows.length; i += BATCH) {
      const { error } = await sb.from(table).insert(rows.slice(i, i + BATCH) as never[]);
      if (error) throw new Error(`${table} @${i}: ${error.message}`);
      process.stdout.write(`\r  ${table} ${Math.min(i + BATCH, rows.length)}/${rows.length}`);
    }
    console.log();
  }
  const v = await sb.from("dataset_version").insert({ hash: meta.outputHash });
  if (v.error) throw new Error(`dataset_version: ${v.error.message}`);
  console.log("Done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
