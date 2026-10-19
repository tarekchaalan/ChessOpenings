/**
 * npm run openings:build — one-shot build of every opening artifact.
 *   --allow-errors   write artifacts and exit 0 even if rows were skipped (predev)
 *   --force          rebuild even when inputHash matches the committed meta
 */
import { existsSync } from "node:fs";
import { OUT, readMeta, runBuild, writeArtifacts, printReport } from "./artifacts";
import { computeInputHash } from "../../src/lib/openings-build/build";
import { codeHash, loadStats, nodeSha256, readInputs } from "./artifacts";

const allowErrors = process.argv.includes("--allow-errors");
const force = process.argv.includes("--force");

const t0 = Date.now();
const meta = readMeta();
if (!force && meta && existsSync(OUT.dataset)) {
  const inputs = readInputs();
  const hash = computeInputHash([...inputs.tsvFiles, ...(inputs.annotationFiles ?? [])], loadStats()?.sha ?? null, nodeSha256, codeHash());
  if (hash === meta.inputHash) {
    const errors = meta.counts.errors;
    console.log(`openings:build — up to date (${hash.slice(0, 12)}), ${errors} error(s), ${Date.now() - t0} ms`);
    // the shortcut must not hide data errors recorded by an --allow-errors build (predev)
    process.exit(errors > 0 && !allowErrors ? 1 : 0);
  }
}
const out = runBuild();
const meta2 = writeArtifacts(out);
printReport(out, "openings:build", Date.now() - t0, true);
console.log(
  `  openings.v2.json ${(meta2.bytes / 1e6).toFixed(2)} MB (${(meta2.gzipBytes / 1e3).toFixed(0)} KB gzip) · output ${meta2.outputHash.slice(0, 12)}` +
    (out.changelogEntry
      ? ` · changelog +${out.changelogEntry.added.length} / −${out.changelogEntry.removed.length} / ${out.changelogEntry.renamed.length} renamed`
      : "")
);
if (!out.ok && !allowErrors) process.exit(1);
