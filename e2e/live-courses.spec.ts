/**
 * Phase 2 acceptance — live data end to end: appending a legal Ruy Lopez row
 * makes the new line appear in the right course and chapter, with a
 * "+1 new line" badge on the hub, within 3 s and without a reload.
 */
import { expect, test } from "@playwright/test";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA, TSV_DIR } from "./fixtures";

// the acceptance budget is 3 s; E2E_LIVE_MS only loosens it to check behaviour on a slow machine
const envMs = Number(process.env.E2E_LIVE_MS);
const LIVE_MS = Number.isFinite(envMs) && envMs > 0 ? envMs : 3000;
const C_TSV = join(TSV_DIR, "c.tsv");
const ROW = "C92\tRuy Lopez: Closed, E2E Test Line\t1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O 9. h3 Kh8\n";

test("a new Ruy Lopez row appears in its course and chapter, and badges the hub", async ({ browser }) => {
  const original = readFileSync(C_TSV, "utf8");
  const ctx = await browser.newContext();
  const course = await ctx.newPage();
  const hub = await ctx.newPage();
  try {
    await course.goto("/openings/ruy-lopez/closed/white");
    const morphy = course.getByTestId("chapter").filter({ has: course.getByTestId("chapter-name").filter({ hasText: "Morphy Defense (3…a6)" }) });
    await expect(morphy).toBeVisible();
    await expect(morphy.getByTestId("line-name").filter({ hasText: "E2E Test Line" })).toHaveCount(0);
    await hub.goto("/openings/ruy-lopez?stay=1");
    await expect(hub.getByTestId("hub-title")).toHaveText("Ruy Lopez");
    // the current build may already badge this hub (e.g. the baseline entry): the changelog
    // on disk says so deterministically; wait for that badge, then dismiss it
    const badge = hub.getByTestId("new-lines-badge");
    const latest = JSON.parse(readFileSync(join(DATA, "openings.changelog.json"), "utf8")).entries[0];
    if ((latest?.hubs?.["ruy-lopez"]?.added ?? 0) > 0) {
      await expect(badge).toBeVisible();
      await badge.getByRole("button", { name: "Dismiss" }).click();
    }
    await expect(badge).toHaveCount(0);
    await course.evaluate(() => ((window as unknown as { __m: number }).__m = 7));

    const t0 = Date.now();
    appendFileSync(C_TSV, ROW);
    await expect(morphy.getByTestId("line-name").filter({ hasText: "E2E Test Line" })).toHaveCount(1, { timeout: LIVE_MS });
    console.log(`append → line in course in ${Date.now() - t0} ms`);
    // both checks are timed from the append, not from each other
    await expect(badge).toHaveText(/\+1 new line$/, { timeout: Math.max(1, LIVE_MS - (Date.now() - t0)) });
    console.log(`append → hub badge in ${Date.now() - t0} ms`);
    expect(await course.evaluate(() => (window as unknown as { __m?: number }).__m)).toBe(7); // no reload
  } finally {
    writeFileSync(C_TSV, original);
    await ctx.close();
  }
});
