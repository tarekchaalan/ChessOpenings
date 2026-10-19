/**
 * npm run openings:bench — measures the dev watcher's incremental rebuild:
 * a cold build, then N rebuilds after appending a legal row (in memory only,
 * no files are touched), reusing the replay and extension caches.
 */
import { readInputs, loadStats, loadV1, nodeSha256, readPrevious } from "./artifacts";
import { buildOpenings } from "../../src/lib/openings-build/build";
import { ReplayCache } from "../../src/lib/openings-build/replay";
import { ExtCache } from "../../src/lib/openings-build/extension";
import { HUBS } from "../../src/content/hubs";
import { CourseMemo } from "../../src/lib/openings-build/memo";

const cache = new ReplayCache();
const extCache = new ExtCache();
const courseMemo = new CourseMemo(nodeSha256);
const stats = loadStats();
const inputs = readInputs();
const run = (extra: string) => {
  const tsvFiles = inputs.tsvFiles.map((f) => (f.path.endsWith("c.tsv") ? { ...f, text: f.text + extra } : f));
  const t0 = performance.now();
  const out = buildOpenings({
    tsvFiles,
    annotationFiles: inputs.annotationFiles,
    stats: stats?.stats ?? null,
    statsSha: stats?.sha ?? null,
    v1Openings: loadV1(),
    previous: readPrevious(),
    cache,
    extCache,
    courseMemo,
    skipLegacy: true,
    hubDefs: HUBS,
    hasher: nodeSha256,
  });
  return { ms: Math.round(performance.now() - t0), reused: `${courseMemo.hits}/${courseMemo.hits + courseMemo.misses}`, t: out.timingsMs, hash: out.outputHash.slice(0, 12) };
};
console.log("cold", run(""));
const moves = ["Kh8", "Rb8", "Qe8", "a5", "Bd7"];
for (const m of moves) {
  console.log(`+row …9.h3 ${m}`, run(`C92\tRuy Lopez: Closed, Bench ${m}\t1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O 9. h3 ${m}\n`));
}
