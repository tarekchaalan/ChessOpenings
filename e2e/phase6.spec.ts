/**
 * Phase 6: the promotion picker (mouse and keyboard) and reduced motion
 * (OS setting and the Settings override). Screenshots → docs/qa/phase6/.
 */
import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDatasetV2 } from "../src/lib/openings";
import { findSystem, loadCourse } from "../src/lib/courses-client";

const SHOTS = join(__dirname, "../docs/qa/phase6");
test.setTimeout(180_000);

async function drag(page: Page, from: string, to: string) {
  const board = page.locator('[data-testid="course-explorer"] .board-cg cg-board');
  await board.scrollIntoViewIfNeeded();
  const box = (await board.boundingBox())!;
  const at = (s: string) => ({ x: box.x + ((s.charCodeAt(0) - 97 + 0.5) * box.width) / 8, y: box.y + ((8 - Number(s[1]) + 0.5) * box.height) / 8 });
  const a = at(from);
  const b = at(to);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 6 });
  await page.mouse.up();
}

test("promotion picker: four pieces, Esc cancels, keys and clicks choose", async ({ page }) => {
  await page.goto("/openings/ruy-lopez/closed/white");
  await page.getByRole("tab", { name: /Course Explorer/ }).click();
  const moves = page.getByTestId("explorer-moves");
  // 1.a4 b5 2.axb5 a6 3.bxa6 Nc6 4.a7 Rb8, then a7 takes on b8
  for (const [f, t] of [["a2", "a4"], ["b7", "b5"], ["a4", "b5"], ["a7", "a6"], ["b5", "a6"], ["b8", "c6"], ["a6", "a7"], ["a8", "b8"]]) await drag(page, f, t);
  await expect(moves).toContainText("4.a7 Rb8");

  await drag(page, "a7", "b8");
  const picker = page.getByTestId("promo-picker");
  await expect(picker).toBeVisible();
  await expect(picker.getByRole("button")).toHaveCount(4);
  await expect(page.getByTestId("promo-q")).toBeFocused();
  await page.screenshot({ path: join(SHOTS, "promotion-picker.png") });
  // arrows move focus within the picker; Esc cancels and the pawn goes back
  await page.keyboard.press("ArrowDown");
  await expect(page.getByTestId("promo-r")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(picker).toHaveCount(0);
  await expect(moves).not.toContainText("=");
  await expect(page.locator('[data-testid="course-explorer"] cg-board piece.white.pawn:not(.ghost)')).toHaveCount(8);

  // a letter key picks directly (underpromotion)
  await drag(page, "a7", "b8");
  await expect(page.getByTestId("promo-q")).toBeFocused();
  await page.keyboard.press("n");
  await expect(moves).toContainText("5.axb8=N");
  // and a click
  await page.getByRole("button", { name: "Back" }).click();
  await expect(moves).not.toContainText("=");
  await drag(page, "a7", "b8");
  await page.getByTestId("promo-q").click();
  await expect(moves).toContainText("5.axb8=Q");
});

test("reduced motion: follows the OS, and the Settings choice overrides it", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/train/ruy-lopez/closed/white?mode=learn");
  await expect(page.locator("html")).toHaveAttribute("data-motion", "reduce");
  await expect(page.getByTestId("trainer")).toHaveClass(/reduced/);
  const dur = await page.evaluate(() => {
    const el = document.createElement("div");
    el.className = "crumb-fade";
    document.body.appendChild(el);
    const d = getComputedStyle(el).animationDuration;
    el.remove();
    return d;
  });
  expect(["0s", "1e-05s"]).toContain(dur);

  // Settings → Motion "Reduce" with the OS on no-preference
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.evaluate(() => localStorage.setItem("cot.v2.prefs", JSON.stringify({ motion: "reduce" })));
  await page.goto("/openings");
  await expect(page.locator("html")).toHaveAttribute("data-motion", "reduce");
  // …and "Full" with the OS on reduce
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.evaluate(() => localStorage.setItem("cot.v2.prefs", JSON.stringify({ motion: "full" })));
  await page.goto("/openings");
  await expect(page.locator("html")).toHaveAttribute("data-motion", "full");
});

test("opening map: click zooms, double-click opens the hub, the list view is navigable", async ({ page }) => {
  await page.goto("/openings");
  await page.getByTestId("map-link").click();
  await page.waitForURL(/\/openings\/map/);
  const map = page.getByTestId("opening-map");
  await expect(map).toBeVisible({ timeout: 60_000 });
  await page.screenshot({ path: join(SHOTS, "opening-map.png"), fullPage: true });
  // click 1.e4 → zoomed: the crumbs show it, the URL keeps it
  await map.locator('[data-path="e4"] rect').click();
  await expect(page.getByTestId("map-crumbs")).toContainText("1.e4");
  await expect(page).toHaveURL(/at=e4/);
  await map.locator('[data-path="e4,c5"] rect').click();
  await expect(page.getByTestId("map-crumbs")).toContainText("Sicilian Defense");
  await page.screenshot({ path: join(SHOTS, "opening-map-sicilian.png"), fullPage: true });
  // "Start" zooms all the way out
  await page.getByTestId("map-crumbs").getByRole("button", { name: "Start" }).click();
  await expect(page.getByTestId("map-crumbs")).not.toContainText("1.e4");
  // double-click → the hub of the cell's opening
  await map.locator('[data-path="e4,e5,Nf3,Nc6,Bb5"] rect').dblclick();
  await page.waitForURL(/\/openings\/ruy-lopez/);

  // the accessible list: expand with the keyboard, zoom the map from it
  await page.goto("/openings/map");
  await page.getByRole("tab", { name: "List" }).click();
  const list = page.getByTestId("map-list");
  const d4 = list.getByRole("button", { name: /1\.d4/ }).first();
  await d4.focus();
  await page.keyboard.press("Enter");
  await expect(d4).toHaveAttribute("aria-expanded", "true");
  await expect(list).toContainText("Queen's Pawn Game");
  await list.getByRole("button", { name: "Zoom map here" }).first().click();
  await expect(page.getByTestId("map-crumbs")).toContainText("1.e4");
});

test("authored plan: the Italian Canal line ends with the plan and its arrows", async ({ page }) => {
  const ds = parseDatasetV2(JSON.parse(readFileSync(join(__dirname, "../public/data/openings.v2.json"), "utf8")), "e2e");
  const course = loadCourse(ds, findSystem(ds, "italian-game", "two-knights-defense-modern-bishops-opening", "white")!)!;
  const line = course.lines.find((l) => l.sans.join(" ") === "e4 e5 Nf3 Nc6 Bc4 Nf6 d3 Bc5 Nc3 d6 Bg5")!;
  expect(line).toBeTruthy();
  await page.goto(`/train/italian-game/two-knights-defense-modern-bishops-opening/white?mode=learn&line=${line.id}`);
  const trainer = page.getByTestId("trainer");
  for (let i = 0; i < 20; i++) {
    await page.waitForFunction(() => ["await", "end"].includes((document.querySelector('[data-testid="trainer"]') as HTMLElement | null)?.dataset.phase ?? ""), null, { timeout: 60_000 });
    if ((await trainer.getAttribute("data-phase")) === "end") break;
    await page.getByTestId("san-input").fill(line.sans[Number(await trainer.getAttribute("data-ply"))]);
    await page.getByTestId("san-input").press("Enter");
  }
  await expect(trainer).toHaveAttribute("data-phase", "end");
  await expect(page.getByTestId("end-plan")).toContainText("Canal Variation");
  // the plan's arrows are on the board (Nc3–d5 and …h6)
  await expect(page.locator(".board-cg svg line, .board-cg svg path").first()).toBeAttached();
  await page.screenshot({ path: join(SHOTS, "authored-plan.png") });
});

test("catalog: a keyboard-focused card shows its focus ring (not clipped by content-visibility)", async ({ page }) => {
  await page.goto("/openings");
  const link = page.locator('[data-testid="hub-card"] a').first();
  await link.waitFor({ timeout: 60_000 });
  await link.focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await expect(link).toBeFocused();
  // the ring is drawn outside the link; the clipping box (the padded wrapper) must contain it
  const fits = await link.evaluate((a) => {
    const ring = a.getBoundingClientRect();
    const w = parseFloat(getComputedStyle(a).outlineWidth) + parseFloat(getComputedStyle(a).outlineOffset || "0");
    const clip = a.closest(".hub-cell")!.getBoundingClientRect();
    return ring.top - w >= clip.top && ring.left - w >= clip.left && ring.right + w <= clip.right && ring.bottom + w <= clip.bottom && w > 0;
  });
  expect(fits).toBe(true);
  await link.screenshot({ path: join(SHOTS, "catalog-focus.png") });
});

test("engine: an off-book blunder gets a verdict and a refutation; the eval bar is a Stats toggle", async ({ page }) => {
  await page.goto("/train/ruy-lopez/closed/white?mode=recall");
  const trainer = page.getByTestId("trainer");
  const awaitAt = (ply: number) =>
    page.waitForFunction((p) => {
      const d = (document.querySelector('[data-testid="trainer"]') as HTMLElement | null)?.dataset;
      return d?.phase === "await" && Number(d.ply) === p;
    }, ply, { timeout: 60_000 });
  await awaitAt(0);
  await page.getByTestId("san-input").fill("e4");
  await page.getByTestId("san-input").press("Enter");
  await awaitAt(2);
  // 2.Ba6?? is in no master game: the engine weighs in
  await page.getByTestId("san-input").fill("Ba6");
  await page.getByTestId("san-input").press("Enter");
  await expect(trainer).toHaveAttribute("data-phase", "wrong");
  const verdict = page.locator('[data-kind="mistake"]').filter({ hasText: "(engine)" });
  await expect(verdict).toHaveCount(1, { timeout: 60_000 });
  await expect(verdict).toContainText(/Blunder/);
  await expect(verdict).toContainText(/bxa6|Nxa6/);
  await page.screenshot({ path: join(SHOTS, "engine-verdict.png") });
  // [Show refutation]: the line plays on the board (the bishop is taken), then the board returns
  const pieces = page.locator(".board-cg cg-board piece");
  const before = await pieces.count();
  await page.getByTestId("action-refute").click();
  await expect.poll(() => pieces.count(), { timeout: 10_000 }).toBeLessThan(before);
  await expect.poll(() => pieces.count(), { timeout: 15_000 }).toBe(before);
  // Try again still works afterwards
  await page.getByTestId("action-try").click();
  await expect(trainer).toHaveAttribute("data-phase", "await");

  // eval bar: off by default, a toggle in Stats
  await page.getByRole("tab", { name: "Stats" }).click();
  const toggle = page.getByTestId("eval-toggle");
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  await expect(page.getByTestId("eval-text")).toContainText(/^[+−]?\d+\.\d|^#/, { timeout: 60_000 });
  await expect(page.getByTestId("eval-text")).toContainText(/depth \d+/);
});
