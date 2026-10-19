/**
 * Phase 4 visual QA (not assertions): screenshots of the catalog, hub, course
 * views, dashboard and Explore at 375 / 768 / 1280 px, light and dark, into
 * docs/qa/phase4/. Run with QA_SHOTS=1 npx playwright test e2e/qa-phase4.spec.ts
 */
import { test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./fixtures";

const OUT = join(ROOT, "docs", "qa", "phase4");
const WIDTHS = [375, 768, 1280] as const;
const HEIGHT: Record<number, number> = { 375: 812, 768: 1024, 1280: 900 };

test.skip(!process.env.QA_SHOTS, "set QA_SHOTS=1 to capture the Phase 4 screenshots");
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

test("Phase 4 screenshots", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/openings");
  await page.getByTestId("hub-card").first().waitFor();
  await shoot(page, "catalog-white");
  await page.goto("/openings?side=black");
  await page.getByTestId("hub-card").first().waitFor();
  await shoot(page, "catalog-black");
  await page.goto("/openings?q=najdorf");
  await page.getByTestId("search-hit").first().waitFor();
  await shoot(page, "catalog-search");
  await page.goto("/openings/sicilian-defense?stay=1");
  await page.getByTestId("hub-title").waitFor();
  await shoot(page, "hub");
  await page.goto("/openings/ruy-lopez/closed/white");
  await page.getByTestId("course-title").waitFor();
  await shoot(page, "course-chapters");
  await page.getByTestId("view-tree").click();
  await shoot(page, "course-tree");
  await page.getByTestId("view-explorer").click();
  await page.getByTestId("course-explorer").waitFor();
  await shoot(page, "course-explorer");
  await page.goto("/");
  await page.getByTestId("dashboard").waitFor();
  await shoot(page, "dashboard");
  await page.goto("/explore?line=e4,e5,Nf3,Nc6,Bb5,a6");
  await page.getByTestId("train-links").waitFor();
  await shoot(page, "explore");
});
