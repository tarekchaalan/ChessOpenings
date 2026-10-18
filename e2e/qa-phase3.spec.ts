/**
 * Phase 3 visual QA (not assertions): screenshots of the catalog, hub, course
 * and trainer states at 375 / 768 / 1280 px, light and dark, into
 * docs/qa/phase3/. Run with QA_SHOTS=1 npx playwright test e2e/qa-phase3.spec.ts
 */
import { test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./fixtures";

const OUT = join(ROOT, "docs", "qa", "phase3");
const WIDTHS = [375, 768, 1280] as const;
const HEIGHT: Record<number, number> = { 375: 812, 768: 1024, 1280: 900 };

test.skip(!process.env.QA_SHOTS, "set QA_SHOTS=1 to capture the Phase 3 screenshots");
test.setTimeout(600_000);

async function setTheme(page: Page, theme: "light" | "dark") {
  await page.evaluate((t) => {
    document.documentElement.classList.toggle("dark", t === "dark");
    document.documentElement.style.colorScheme = t;
  }, theme);
}

/** Every width and theme of the page as it is now. */
async function shoot(page: Page, name: string) {
  mkdirSync(OUT, { recursive: true });
  for (const w of WIDTHS) {
    await page.setViewportSize({ width: w, height: HEIGHT[w] });
    for (const theme of ["light", "dark"] as const) {
      await setTheme(page, theme);
      // show the selected message, else the newest (instantly, not mid smooth-scroll)
      await page.evaluate(() => {
        const sel = document.querySelector('[data-testid="coach-msg"].ring-2');
        if (sel) sel.scrollIntoView({ block: "center", behavior: "instant" });
        else document.querySelector('[data-testid="end-actions"], [data-testid="coach-msg"]:last-of-type')?.scrollIntoView({ block: "end", behavior: "instant" });
      });
      await page.waitForTimeout(350);
      await page.screenshot({ path: join(OUT, `${name}-${w}-${theme}.jpg`), type: "jpeg", quality: 72 });
    }
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await setTheme(page, "light");
}

const phase = (page: Page, ph: string) =>
  page.waitForFunction((p) => (document.querySelector('[data-testid="trainer"]') as HTMLElement | null)?.dataset.phase === p, ph, { timeout: 60_000 });

async function learnUntil(page: Page, until: number) {
  for (;;) {
    await page.waitForFunction(() => ["await", "end"].includes((document.querySelector('[data-testid="trainer"]') as HTMLElement | null)?.dataset.phase ?? ""), null, { timeout: 60_000 });
    const d = await page.getByTestId("trainer").evaluate((e) => ({ ...(e as HTMLElement).dataset }));
    if (d.phase === "end" || Number(d.ply) >= until) return;
    const t = await page.locator('[data-kind="turn"] [data-testid="coach-title"]').last().innerText();
    await page.getByTestId("san-input").fill(/Play \d+(?:\.|…)(\S+?)\.$/.exec(t)![1]);
    await page.getByTestId("san-input").press("Enter");
    await page.waitForFunction((p0) => Number((document.querySelector('[data-testid="trainer"]') as HTMLElement | null)?.dataset.ply ?? -1) > p0, Number(d.ply));
  }
}

test("Phase 3 screenshots", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  // the v1 catalog stays until Phase 4 replaces it with /openings
  await page.goto("/learn");
  await page.waitForTimeout(3000);
  await shoot(page, "catalog");

  await page.goto("/openings/ruy-lopez?stay=1");
  await page.getByTestId("hub-title").waitFor();
  await shoot(page, "hub");

  await page.goto("/openings/ruy-lopez/closed/white");
  await page.getByTestId("course-title").waitFor();
  await shoot(page, "course");

  await page.goto("/train/ruy-lopez/closed/white?mode=learn&line=ln_c4e43ggaphii");
  await phase(page, "await");
  await shoot(page, "trainer-learn");

  await learnUntil(page, 6);
  await page.getByTestId("san-input").fill("Kf1");
  await page.getByTestId("san-input").press("Enter");
  await phase(page, "wrong");
  await shoot(page, "trainer-wrong-move");
  await page.getByTestId("action-try").click();
  await phase(page, "await");

  // the branch card, scrubbed to so its alternative arrows show
  await page.locator('[data-kind="branch"]').first().getByRole("button").first().click();
  await shoot(page, "trainer-branch-card");
  await page.getByTestId("back-to-live").click();

  await learnUntil(page, Infinity);
  await phase(page, "end");
  await shoot(page, "trainer-end-card");
});
