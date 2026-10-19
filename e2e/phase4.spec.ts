/**
 * Phase 4 acceptance (§5): legacy redirects, catalog search, "+N new lines"
 * badges from the changelog, and Explore → "Learn this line".
 */
import { expect, test } from "@playwright/test";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA, TSV_DIR } from "./fixtures";
import { parseDatasetV2 } from "../src/lib/openings";
import { loadCourse, findSystem } from "../src/lib/courses-client";

const envMs = Number(process.env.E2E_LIVE_MS);
const LIVE_MS = Number.isFinite(envMs) && envMs > 0 ? envMs : 3000;

test.setTimeout(180_000);

test("legacy URLs redirect via the legacy map", async ({ page }) => {
  const map = JSON.parse(readFileSync(join(DATA, "legacy-map.v1.json"), "utf8"));
  const id = map.entries.findIndex((e: { sans: string[] }) => e.sans.join(" ") === "e4 e5 Nf3 Nc6 Bb5 a6");
  expect(id).toBeGreaterThanOrEqual(0);
  const e = map.entries[id];
  const [hub, rest] = e.bestCourseId.split("/");
  const [system, side] = rest.split("@");

  await page.goto(`/learn/${id}`);
  await page.waitForURL(new RegExp(`/train/${hub}/${system}/${side}\\?mode=learn&line=${e.bestLineId}`));
  await expect(page.getByTestId("trainer")).toBeVisible();

  await page.goto(`/quiz/${id}`);
  await page.waitForURL(new RegExp(`/train/${hub}/${system}/${side}\\?mode=recall&line=${e.bestLineId}`));

  await page.goto("/learn");
  await page.waitForURL(/\/openings$/);
  await page.goto("/quiz");
  await page.waitForURL((u) => u.pathname === "/");
  await page.goto("/quiz/review");
  await page.waitForURL(/\/train\/review$/);
});

test("catalog search finds najdorf, B90, e4 c5 Nf3 d6 d4 and grunfeld", async ({ page }) => {
  await page.goto("/openings");
  const search = page.getByTestId("catalog-search");
  const first = page.getByTestId("search-hit").first();
  await search.fill("najdorf");
  await expect(first).toContainText("Najdorf");
  await search.fill("B90");
  await expect(first).toContainText("B90");
  await search.fill("e4 c5 Nf3 d6 d4");
  await expect(first).toContainText("1.e4 c5 2.Nf3 d6 3.d4");
  await search.fill("grunfeld");
  await expect(first).toContainText("Grünfeld");
  // the query is in the URL, so results are shareable
  await expect(page).toHaveURL(/q=grunfeld/);
});

test("'+N new lines' badges follow the changelog (catalog card and hub)", async ({ page }) => {
  const C_TSV = join(TSV_DIR, "c.tsv");
  const original = readFileSync(C_TSV, "utf8");
  try {
    await page.goto("/openings");
    const card = page.locator('[data-testid="hub-card"][data-hub="ruy-lopez"]');
    await expect(card).toBeVisible();
    await expect(card.getByTestId("new-lines-badge")).toHaveCount(0);
    appendFileSync(C_TSV, "C92\tRuy Lopez: Closed, E2E Badge Line\t1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O 9. h3 Kh8\n");
    // correctness, not speed: the 3 s live budget is asserted in live-courses.spec
    await expect(card.getByTestId("new-lines-badge")).toHaveText(/\+1 new line$/, { timeout: Math.max(LIVE_MS * 3, 30_000) });
    // dismissable per user
    await card.getByRole("button", { name: /Dismiss the new-lines badge/ }).click();
    await expect(card.getByTestId("new-lines-badge")).toHaveCount(0);
  } finally {
    writeFileSync(C_TSV, original);
  }
});

test("Explore → Learn this line lands on the right course and line", async ({ page }) => {
  await page.goto("/explore?line=e4,e5,Nf3,Nc6,Bb5,a6");
  const link = page.getByTestId("learn-this-line");
  await expect(link).toBeVisible();
  await link.click();
  await page.waitForURL(/\/train\/ruy-lopez\/closed\/white\?mode=learn&li=\d+/);
  const li = Number(new URL(page.url()).searchParams.get("li"));
  // the same course the browser derives: its line li passes through the explored position
  const raw = JSON.parse(readFileSync(join(DATA, "openings.v2.json"), "utf8"));
  const meta = JSON.parse(readFileSync(join(DATA, "openings.v2.meta.json"), "utf8"));
  const ds = parseDatasetV2(raw, meta.outputHash);
  const course = loadCourse(ds, findSystem(ds, "ruy-lopez", "closed", "white")!)!;
  expect(course.lines[li].sans.slice(0, 6)).toEqual(["e4", "e5", "Nf3", "Nc6", "Bb5", "a6"]);
  await expect(page.locator('[data-kind="intro"] [data-testid="coach-title"]')).toHaveText(course.lines[li].name);
});

test("course page: mode cards, tree view and Course Explorer link into the trainer", async ({ page }) => {
  await page.goto("/openings/ruy-lopez/closed/white");
  await expect(page.getByTestId("mode-learn")).toContainText(/\d+ new lines/);
  await expect(page.getByTestId("mode-review")).toContainText("nothing due");
  await page.getByTestId("view-tree").click();
  const tree = page.getByTestId("course-tree");
  await expect(tree).toContainText("1.e4");
  await page.getByTestId("view-explorer").click();
  await expect(page.getByTestId("lines-through").locator("li").first()).toBeVisible();
  const learn = page.getByTestId("lines-through").getByRole("link").first();
  await learn.click();
  await page.waitForURL(/\/train\/ruy-lopez\/closed\/white\?mode=learn&line=ln_\w+&start=0/);
});
