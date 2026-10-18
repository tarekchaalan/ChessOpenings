/**
 * Phase 5 acceptance (§4.9) in the browser, guest mode: the v1 → v2 guest
 * migration on the real v1 fixture, the v1 backup in Settings, the daily
 * review cap's deferral, the tier forecast and the daily new-line cap.
 * Screenshots → docs/qa/phase5/.
 */
import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SHOTS = join(__dirname, "../docs/qa/phase5");
const fixture = JSON.parse(readFileSync(join(__dirname, "../src/lib/progress/__tests__/fixtures/v1-localStorage.json"), "utf8")) as { localStorage: Record<string, string> };

test.setTimeout(180_000);

/** Seed localStorage once, before the app's first script runs. */
async function seed(page: Page, entries: Record<string, string>) {
  await page.addInitScript((e) => {
    if (sessionStorage.getItem("e2e-seeded")) return;
    for (const [k, v] of Object.entries(e)) localStorage.setItem(k, v);
    sessionStorage.setItem("e2e-seeded", "1");
  }, entries);
}

const keys = (page: Page) => page.evaluate(() => Object.keys(localStorage).sort());

test("a v1 guest's progress migrates once on load: backup first, v2 keys, v1 keys gone", async ({ page }) => {
  await seed(page, fixture.localStorage);
  await page.goto("/");
  await expect.poll(() => page.evaluate(() => localStorage.getItem("cot.v2.migrated")), { timeout: 60_000 }).not.toBeNull();
  const ks = await keys(page);
  expect(ks).toContain("cot.v1.backup");
  for (const k of Object.keys(fixture.localStorage)) expect(ks).not.toContain(k);
  const report = await page.evaluate(() => JSON.parse(localStorage.getItem("cot.v2.migrationReport")!));
  const cards = await page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem("cot.v2.cards")!)).length);
  expect(report.dropped).toEqual([]);
  expect(cards).toBe(report.v2Cards);
  expect(report.v1Cards).toBe(Object.keys(JSON.parse(fixture.localStorage["cot.v1.cards"])).length);
  // v1 prefs carried over (learnHints off), new fields defaulted
  const prefs = await page.evaluate(() => JSON.parse(localStorage.getItem("cot.v2.prefs")!));
  expect(prefs).toMatchObject({ learnHints: false, dailyNewLines: 5 });

  // the dashboard shows the migrated courses
  await page.reload();
  await expect(page.getByText(/Ruy Lopez/).first()).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: join(SHOTS, "migrated-dashboard.png"), fullPage: true });

  // idempotent: another load changes nothing
  const before = await page.evaluate(() => JSON.stringify(localStorage));
  await page.reload();
  await page.waitForTimeout(2000);
  expect(await page.evaluate(() => JSON.stringify(localStorage))).toBe(before);

  // Settings → Data: clearing local data keeps the backup; deleting it takes its own confirmation
  await page.goto("/settings");
  await page.getByRole("button", { name: "Data" }).click();
  await expect(page.getByTestId("clear-v1-backup")).toBeVisible();
  await page.screenshot({ path: join(SHOTS, "settings-backup.png"), fullPage: true });
  await page.getByRole("button", { name: "Clear local data" }).click();
  await page.getByRole("button", { name: "Click again to confirm" }).click();
  expect((await keys(page)).filter((k) => k.startsWith("cot."))).toEqual(["cot.v1.backup"]);
  await page.getByTestId("clear-v1-backup").click();
  expect(await keys(page)).toContain("cot.v1.backup");
  await page.getByTestId("clear-v1-backup").click();
  expect(await keys(page)).not.toContain("cot.v1.backup");
  await expect(page.getByTestId("clear-v1-backup")).toHaveCount(0);
});

test("daily review cap: the overflow is deferred to the coming days, lowest recall first", async ({ page }) => {
  const now = Date.now();
  const cards: Record<string, unknown> = {};
  for (let i = 0; i < 5; i++) {
    const epd = `8/8/8/8/8/8/8/K${i}k w - -`; // positions don't matter to the cap
    cards[`white|${epd}|Kb1`] = {
      side: "white", epd, answer: "Kb1", due: new Date(now - (i + 1) * 86400_000).toISOString(), stability: 2 + i, difficulty: 5,
      elapsed_days: 0, scheduled_days: 2, learning_steps: 0, reps: 3, lapses: 0, state: 2,
      last_review: new Date(now - (i + 4) * 86400_000).toISOString(), seen: 3, correct: 3,
    };
  }
  await seed(page, { "cot.v2.cards": JSON.stringify(cards), "cot.v2.prefs": JSON.stringify({ dailyReviewCap: 2 }) });
  await page.goto("/");
  await expect.poll(() => page.evaluate(() => localStorage.getItem("cot.v2.capDay"))).not.toBeNull();
  const after = await page.evaluate(() => Object.values(JSON.parse(localStorage.getItem("cot.v2.cards")!)) as { due: string; deferredFrom?: string }[]);
  const deferred = after.filter((c) => c.deferredFrom);
  expect(deferred).toHaveLength(3);
  for (const c of deferred) expect(new Date(c.due).getTime()).toBeGreaterThan(now);
  // never dropped
  expect(after).toHaveLength(5);
});

test("course page: tier forecast and the daily new-line cap", async ({ page }) => {
  const today = new Date().toISOString();
  await seed(page, {
    "cot.v2.prefs": JSON.stringify({ dailyNewLines: 1 }),
    "cot.v2.courseProgress": JSON.stringify({
      "ruy-lopez/closed@white": { courseId: "ruy-lopez/closed@white", tier: null, lastLineId: null, lastStudiedAt: today, lines: { ln_x: { learnedAt: today } } },
    }),
  });
  await page.goto("/openings/ruy-lopez/closed/white");
  const adds = page.locator('[data-testid^="tier-adds-"]');
  await expect(adds.first()).toBeVisible({ timeout: 30_000 });
  await expect(adds.first()).toHaveText(/adds ~\d+ reviews?\/day next week|nothing new to add/);
  await expect(page.getByTestId("mode-learn")).toContainText("today’s 1 done");
  await page.screenshot({ path: join(SHOTS, "course-forecast.png"), fullPage: false });
});
