/**
 * Live acceptance check for Account Insights (ADR 0006 "Done when"): imports
 * real Lichess and Chess.com accounts through the same library the browser
 * uses, validates every summary with the server's checks, then re-syncs from
 * the cursor to show that only new games come back. Makes real requests,
 * serially; not part of `npm test`.
 *
 *   npx tsx scripts/insights/live-check.ts [lichessUser] [chesscomUser]
 *
 * Report: docs/qa/insights/live-import.md
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseDatasetV2 } from "../../src/lib/openings";
import type { RawDatasetV2 } from "../../src/lib/openings-build/dataset";
import { modelOf } from "../../src/lib/courses-client";
import { maxBookPly } from "../../src/lib/insights/book";
import { fetchGames, lookupProfile, type FetchDeps } from "../../src/lib/insights/fetch";
import { DEFAULT_SCOPE } from "../../src/lib/insights/filter";
import { summarize } from "../../src/lib/insights/summarize";
import { analyse, byOpening, repeatDeviations } from "../../src/lib/insights/aggregate";
import { recommend } from "../../src/lib/insights/recommend";
import { playerBand } from "../../src/lib/insights/bands";
import { checkSummary } from "../../src/lib/server/insights";
import type { Platform, Summary } from "../../src/lib/insights/types";

const ROOT = join(__dirname, "../..");
const meta = JSON.parse(readFileSync(join(ROOT, "public/data/openings.v2.meta.json"), "utf8")) as { outputHash: string };
const ds = parseDatasetV2(JSON.parse(readFileSync(join(ROOT, "public/data/openings.v2.json"), "utf8")) as RawDatasetV2, meta.outputHash);
const model = modelOf(ds);
const n = maxBookPly(model);
const UA = "ChessOpeningsTrainer/0.1 (+https://github.com/tarekchaalan/chessopenings)";
// Node can set a User-Agent (browsers can't); everything else is the browser code path
const deps: FetchDeps = {
  fetch: (url, init) => fetch(url, { ...init, headers: { ...(init?.headers as Record<string, string>), "User-Agent": UA } }),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

async function check(platform: Platform, username: string): Promise<string[]> {
  const out: string[] = [`## ${platform === "lichess" ? "Lichess" : "Chess.com"}: ${username}`, ""];
  const t0 = Date.now();
  const profile = await lookupProfile(platform, username, deps);
  const first = await fetchGames(platform, { username: profile.username, scope: DEFAULT_SCOPE, since: null }, deps);
  const ms = Date.now() - t0;
  const summaries = first.games.map((g) => summarize(model, g, ds.outputHash!, n)).filter((s): s is Summary => !!s);
  const invalid = summaries.map((s) => checkSummary(platform, s, new Date())).filter(Boolean);
  const newest = summaries.map((s) => s.playedAt).sort().pop() ?? null;
  const second = await fetchGames(platform, { username: profile.username, scope: DEFAULT_SCOPE, since: newest ? new Date(newest) : null }, deps);
  const known = new Set(summaries.map((s) => s.gameId));
  const games = analyse(ds, summaries);
  const rows = byOpening(ds, games);
  const repeats = repeatDeviations(ds, games);
  const recs = recommend(ds, games, rows, playerBand(summaries, { [platform]: profile.ratings }));
  const links = [...rows.map((r) => r.link), ...repeats.map((r) => r.link), ...recs.map((r) => r.link)];
  out.push(
    `- Profile: ${profile.username}; ratings ${JSON.stringify(profile.ratings)}`,
    `- First import: ${first.games.length} games in scope (${summaries.length} summarised) in ${(ms / 1000).toFixed(1)} s; skipped ${JSON.stringify(first.skipped)}`,
    `- Server validation (checkSummary): ${summaries.length - invalid.length}/${summaries.length} valid${invalid.length ? `; failures: ${[...new Set(invalid)].join(", ")}` : ""}`,
    `- Re-sync from the cursor (${newest ?? "none"}): ${second.games.length} games returned, ${second.games.filter((g) => !known.has(g.gameId)).length} new, ${second.games.filter((g) => known.has(g.gameId)).length} already imported`,
    `- Deviations: by me ${summaries.filter((s) => s.deviatedBy === "me").length}, by the opponent ${summaries.filter((s) => s.deviatedBy === "opponent").length}, still in book ${summaries.filter((s) => s.deviatedBy === "none").length}; with a Lichess evaluation ${summaries.filter((s) => s.evalAfter !== null).length}`,
    `- Openings: ${rows.length} (${rows.filter((r) => r.enough).length} with ${5}+ games); repeat deviations: ${repeats.length}; recommendations: ${recs.map((r) => r.kind).join(", ") || "none"}`,
    `- Links: ${links.length}, all trainable or a course: ${links.every((l) => /^\/(train|openings)/.test(l.train))}`,
    ""
  );
  if (invalid.length) process.exitCode = 1;
  return out;
}

async function main() {
  const [li = "Zhigalko_Sergei", cc = "hikaru"] = process.argv.slice(2);
  const lines = [
    "# Account Insights: live import check",
    "",
    `Run ${new Date().toISOString()} with \`scripts/insights/live-check.ts\`, dataset ${ds.outputHash}, n = ${n} plies. Scope: rated standard rapid/blitz/classical, last 3 months, up to 200 games.`,
    "",
  ];
  for (const [p, u] of [["lichess", li], ["chesscom", cc]] as const) {
    try {
      lines.push(...(await check(p, u)));
    } catch (e) {
      lines.push(`## ${p}: ${u}`, "", `- FAILED: ${(e as Error).message}`, "");
      process.exitCode = 1;
    }
  }
  writeFileSync(join(ROOT, "docs/qa/insights/live-import.md"), lines.join("\n"));
  console.log(lines.join("\n"));
}

void main();
