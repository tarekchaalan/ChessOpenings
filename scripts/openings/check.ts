/**
 * npm run openings:check — exit 1 if the committed artifacts are stale
 * (inputHash differs) or if the current data has errors.
 */
import { computeInputHash } from "../../src/lib/openings-build/build";
import { formatIssue } from "../../src/lib/openings-build/build";
import { loadStats, nodeSha256, readInputs, readMeta, runBuild } from "./artifacts";

const meta = readMeta();
const inputs = readInputs();
const hash = computeInputHash([...inputs.tsvFiles, ...(inputs.annotationFiles ?? [])], loadStats()?.sha ?? null, nodeSha256);
let failed = false;
if (!meta) {
  console.error("openings:check — no openings.v2.meta.json; run npm run openings:build");
  failed = true;
} else if (meta.inputHash !== hash) {
  console.error(`openings:check — artifacts are stale (meta ${meta.inputHash.slice(0, 12)} ≠ inputs ${hash.slice(0, 12)}); run npm run openings:build`);
  failed = true;
}
const out = runBuild({ previous: null });
const errors = out.issues.filter((i) => i.level === "error");
if (errors.length) {
  console.error(`openings:check — ${errors.length} data error(s):`);
  for (const e of errors) console.error("  " + formatIssue(e));
  failed = true;
}
if (!failed) console.log(`openings:check — ok (${out.counts.rows} rows, inputs ${hash.slice(0, 12)})`);
process.exit(failed ? 1 : 0);
