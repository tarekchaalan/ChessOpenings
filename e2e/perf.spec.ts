/**
 * §3 performance budgets, measured in Chromium (Phase 6). No CPU throttling:
 * this machine is the "laptop". Results → docs/qa/phase6/perf.json (+ the
 * report quotes them).
 *   dataset gzipped ≤ 700 KB · parse ≤ 150 ms · move → feedback ≤ 50 ms ·
 *   catalog renders its cards without jank
 */
import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { join } from "node:path";
import { parseDatasetV2 } from "../src/lib/openings";
import { findSystem, loadCourse } from "../src/lib/courses-client";

const OUT = join(__dirname, "../docs/qa/phase6");
const results: Record<string, unknown> = {};
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const round = (x: number) => Math.round(x * 10) / 10;
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))];

test.setTimeout(240_000);
// tracing snapshots the DOM on every action (113 boards × 32 pieces): that, not the app, is what janks
test.use({ trace: "off" });
test.describe.configure({ mode: "serial" });
// budgets are for production React; under `next dev` they measure dev overhead (and starve the live specs)
test.skip(!process.env.E2E_PROD, "perf budgets run against a production build: E2E_PROD=1 npx playwright test e2e/perf.spec.ts");

test.afterAll(() => {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "perf.json"), JSON.stringify({ measuredAt: new Date().toISOString(), ...results }, null, 2) + "\n");
});

test("dataset: gzipped size", () => {
  const buf = readFileSync(join(__dirname, "../public/data/openings.v2.json"));
  const gz = gzipSync(buf, { level: 9 }).length;
  results.dataset = { bytes: buf.length, gzipBytes: gz, budgetGzipBytes: 700 * 1024 };
  expect(gz).toBeLessThanOrEqual(700 * 1024);
});

async function parseMs(page: Page): Promise<number> {
  await page.goto("/openings");
  await page.waitForFunction(() => performance.getEntriesByName("cot:dataset-parse").length > 0, null, { timeout: 60_000 });
  return page.evaluate(() => performance.getEntriesByName("cot:dataset-parse")[0].duration);
}

test("dataset: parse time (JSON + decode, after download)", async ({ page }) => {
  const runs: number[] = [];
  for (let i = 0; i < 9; i++) runs.push(await parseMs(page));
  results.parse = { runsMs: runs.map(round), medianMs: round(median(runs)), p90Ms: round(pct(runs, 0.9)), budgetMs: 150 };
  expect(median(runs)).toBeLessThanOrEqual(150);
});

const ds = parseDatasetV2(JSON.parse(readFileSync(join(__dirname, "../public/data/openings.v2.json"), "utf8")), "perf");
const ruy = loadCourse(ds, findSystem(ds, "ruy-lopez", "closed", "white")!)!;

test("trainer: user move → feedback", async ({ page }) => {
  await page.goto("/train/ruy-lopez/closed/white?mode=learn");
  const samples: number[] = [];
  // the line in Learn, then again in Recall (the learner's moves only; opponent replies aren't user moves)
  for (let i = 0; i < 40 && samples.length < 16; i++) {
    await page.waitForFunction(() => ["await", "end"].includes((document.querySelector('[data-testid="trainer"]') as HTMLElement | null)?.dataset.phase ?? ""), null, { timeout: 60_000 });
    if ((await page.getByTestId("trainer").getAttribute("data-phase")) === "end") {
      const again = page.getByTestId("end-recall");
      if (!(await again.count())) break;
      await again.click();
      continue;
    }
    // the line's book move at the live ply (the URL names the line)
    const lineId = new URL(page.url()).searchParams.get("line");
    const line = lineId ? ruy.lines.find((l) => l.id === lineId) : ruy.lines[0];
    const san = line?.sans[Number(await page.getByTestId("trainer").getAttribute("data-ply"))];
    if (!san) break;
    await page.evaluate(() => performance.clearMeasures("cot:move-feedback"));
    await page.getByTestId("san-input").fill(san);
    await page.getByTestId("san-input").press("Enter");
    await page.waitForFunction(() => performance.getEntriesByName("cot:move-feedback").length > 0, null, { timeout: 10_000 });
    samples.push(await page.evaluate(() => performance.getEntriesByName("cot:move-feedback")[0].duration));
  }
  results.moveFeedback = { samplesMs: samples.map(round), medianMs: round(median(samples)), p90Ms: round(pct(samples, 0.9)), maxMs: round(Math.max(...samples)), budgetMs: 50 };
  expect(samples.length).toBeGreaterThan(3);
  expect(median(samples)).toBeLessThanOrEqual(50);
});

test("catalog: renders all its hub cards without jank (scrolling)", async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { __long: number[] };
    w.__long = [];
    new PerformanceObserver((l) => l.getEntries().forEach((e) => w.__long.push(e.duration))).observe({ type: "longtask", buffered: true });
  });
  await page.goto("/openings");
  const cards = page.locator('[data-testid="hub-card"]');
  await expect(cards.first()).toBeVisible({ timeout: 60_000 });
  // every hub card on the page: open the collapsed sections too
  for (const id of ["their-openings", "offbeat"]) {
    const c = page.getByTestId(id);
    await c.locator("button, summary").first().click();
  }
  await page.waitForTimeout(1500);
  const count = await cards.count();
  const longOnLoad = await page.evaluate(() => (window as unknown as { __long: number[] }).__long.slice());
  // scroll the whole page, recording frame gaps
  await page.evaluate(() => {
    const w = window as unknown as { __gaps: number[]; __stop: boolean };
    w.__gaps = [];
    w.__stop = false;
    let last = performance.now();
    const tick = (t: number) => {
      w.__gaps.push(t - last);
      last = t;
      if (!w.__stop) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    (window as unknown as { __long: number[] }).__long.length = 0;
  });
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  for (let y = 0; y < height; y += 400) {
    await page.mouse.wheel(0, 400);
    await page.waitForTimeout(40);
  }
  const { gaps, longScroll } = await page.evaluate(() => {
    const w = window as unknown as { __gaps: number[]; __stop: boolean; __long: number[] };
    w.__stop = true;
    return { gaps: w.__gaps.slice(1), longScroll: w.__long.slice() };
  });
  const sorted = [...gaps].sort((a, b) => a - b);
  results.catalog = {
    cards: count,
    longTasksOnLoadMs: longOnLoad.map(round),
    scroll: {
      frames: gaps.length,
      p50FrameMs: round(sorted[Math.floor(sorted.length * 0.5)]),
      p95FrameMs: round(sorted[Math.floor(sorted.length * 0.95)]),
      maxFrameMs: round(sorted[sorted.length - 1]),
      framesOver50ms: gaps.filter((g) => g > 50).length,
      longTasksMs: longScroll.map(round),
    },
  };
  // every hub card the catalog can show at once (all sections expanded); the dataset has fewer than 150 per side
  expect(count).toBeGreaterThanOrEqual(100);
  // "without jank": no long task while scrolling and ≤ 1% of frames over 50 ms
  expect(longScroll.length).toBe(0);
  expect(gaps.filter((g) => g > 50).length).toBeLessThanOrEqual(Math.ceil(gaps.length * 0.01));
});
