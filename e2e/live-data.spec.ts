/**
 * Phase 1 acceptance — live data in dev (§5 Phase 1): while `npm run dev`
 * runs, TSV edits reach the open page within 3 s with no reload.
 */
import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA, ROOT, TSV_DIR } from "./fixtures";

const LIVE_MS = 3000;
const E_TSV = join(TSV_DIR, "e.tsv");
const NEW_PGN = "1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O 9. h3 Kh8";
const LINE = "e4,e5,Nf3,Nc6,Bb5,a6,Ba4,Nf6,O-O,Be7,Re1,b5,Bb3,d6,c3,O-O,h3,Kh8";

const meta = () => JSON.parse(readFileSync(join(DATA, "openings.v2.meta.json"), "utf8"));
const runCheck = () => {
  try {
    execFileSync("npx", ["tsx", "scripts/openings/check.ts"], { cwd: ROOT, stdio: "pipe" });
    return { code: 0, out: "" };
  } catch (e) {
    const err = e as { status: number; stderr: Buffer; stdout: Buffer };
    return { code: err.status, out: err.stderr.toString() + err.stdout.toString() };
  }
};

test.describe.configure({ mode: "serial" });

test("appending, renaming and breaking rows updates Explore live", async ({ page }) => {
  const original = readFileSync(E_TSV, "utf8");
  try {
    await page.goto(`/explore?line=${LINE}`);
    await expect(page.getByTestId("opening-name")).toBeVisible();
    await expect(page.getByTestId("opening-name")).not.toHaveText("E2E Test Line");

    // 1. append a legal row → named at its position + changelog toast, no reload
    // a full reload would wipe this marker; client-side URL syncs don't
    await page.evaluate(() => ((window as unknown as { __e2eMarker: number }).__e2eMarker = 42));
    const t0 = Date.now();
    appendFileSync(E_TSV, `C92\tE2E Test Line\t${NEW_PGN}\n`);
    await expect(page.getByTestId("opening-name")).toHaveText("E2E Test Line", { timeout: LIVE_MS });
    await expect(page.getByTestId("data-update-toast")).toContainText("+1 line", { timeout: LIVE_MS });
    console.log(`append → visible in ${Date.now() - t0} ms`);

    // 2. rename → name updates; changelog marks it renamed
    const t1 = Date.now();
    writeFileSync(E_TSV, original + `C92\tE2E Renamed Line\t${NEW_PGN}\n`);
    await expect(page.getByTestId("opening-name")).toHaveText("E2E Renamed Line", { timeout: LIVE_MS });
    await expect(page.getByTestId("data-update-toast")).toContainText("1 renamed", { timeout: LIVE_MS });
    console.log(`rename → visible in ${Date.now() - t1} ms`);
    const log = JSON.parse(readFileSync(join(DATA, "openings.changelog.json"), "utf8"));
    expect(log.entries[0].renamed).toEqual([expect.objectContaining({ from: "E2E Test Line", to: "E2E Renamed Line" })]);

    // 3. illegal row → last good data kept; check exits 1 with file:line
    const goodHash = meta().outputHash;
    appendFileSync(E_TSV, `C20\tBroken Row\t1. e4 e5 2. Bxf9\n`);
    await page.waitForTimeout(2000);
    expect(meta().outputHash).toBe(goodHash);
    await expect(page.getByTestId("opening-name")).toHaveText("E2E Renamed Line");
    const check = runCheck();
    expect(check.code).toBe(1);
    expect(check.out).toMatch(/all-openings\/e\.tsv:\d+ — illegal move "Bxf9" at ply 3/);
    expect(await page.evaluate(() => (window as unknown as { __e2eMarker?: number }).__e2eMarker)).toBe(42); // never reloaded
  } finally {
    writeFileSync(E_TSV, original);
  }
});

test("a new f.tsv works and non-TSV files are ignored with a warning", async ({ page }) => {
  const F_TSV = join(TSV_DIR, "f.tsv");
  const NOTES = join(TSV_DIR, "notes.txt");
  try {
    await page.goto(`/explore?line=a3,a6,h3,h6`);
    writeFileSync(NOTES, "not data\n");
    writeFileSync(F_TSV, "eco\tname\tpgn\nA00\tE2E F File Line\t1. a3 a6 2. h3 h6\n");
    await expect(page.getByTestId("opening-name")).toHaveText("E2E F File Line", { timeout: LIVE_MS });
    expect(meta().issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ level: "warning", message: "ignored non-TSV file all-openings/notes.txt" })])
    );
  } finally {
    rmSync(F_TSV, { force: true });
    rmSync(NOTES, { force: true });
  }
});
