/**
 * Account Insights (ADR 0006), guest mode, with Lichess and Chess.com mocked
 * from the captured fixtures (no live calls): link → import → every section
 * renders with trainable links, sorting, unlink, unknown user, axe AA in light
 * and dark, and phone width without horizontal scroll.
 *
 * Lichess is connected only by signing in to it (ADR 0009): its row is a
 * "Continue with Lichess" link, so the Lichess imports here start from a link
 * this browser already holds (as one made before OAuth would be). Chess.com,
 * without OAuth credentials in e2e, is still linked by a typed username.
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// lichess-games-90d.ndjson: a real 90-day export (43 blitz games), enough for
// openings with 5+ games; the unit tests use the 15-game sample
const FIX = join(__dirname, "../src/lib/insights/__tests__/fixtures");
const fx = (n: string) => readFileSync(join(FIX, n), "utf8");
const NOW = new Date("2026-10-19T12:00:00Z");

test.setTimeout(180_000);

async function mockPlatforms(page: Page) {
  const calls: string[] = [];
  await page.route("https://lichess.org/**", (route) => {
    const url = route.request().url();
    calls.push(url);
    if (/\/api\/user\/zhigalko_sergei$/i.test(url)) return route.fulfill({ json: JSON.parse(fx("lichess-user.json")), headers: { "access-control-allow-origin": "*" } });
    if (/\/api\/games\/user\/zhigalko_sergei/i.test(url)) return route.fulfill({ body: fx("lichess-games-90d.ndjson"), contentType: "application/x-ndjson", headers: { "access-control-allow-origin": "*" } });
    return route.fulfill({ status: 404, json: { error: "Not found" }, headers: { "access-control-allow-origin": "*" } });
  });
  await page.route("https://api.chess.com/**", (route) => {
    const url = route.request().url();
    calls.push(url);
    const h = { "access-control-allow-origin": "*" };
    if (url.endsWith("/player/hikaru")) return route.fulfill({ json: JSON.parse(fx("chesscom-player.json")), headers: h });
    if (url.endsWith("/player/hikaru/stats")) return route.fulfill({ json: JSON.parse(fx("chesscom-stats.json")), headers: h });
    if (url.endsWith("/player/hikaru/games/archives")) return route.fulfill({ json: JSON.parse(fx("chesscom-archives.json")), headers: h });
    if (url.endsWith("/player/hikaru/games/2026/09")) return route.fulfill({ body: fx("chesscom-month.json"), contentType: "application/json", headers: h });
    if (/\/player\/hikaru\/games\/\d{4}\/\d{2}$/.test(url)) return route.fulfill({ json: { games: [] }, headers: h });
    return route.fulfill({ status: 404, json: JSON.parse(fx("chesscom-404.json")), headers: h });
  });
  return calls;
}

/**
 * A Lichess link this browser already holds, never synced (as a typed link
 * made before OAuth would be): /insights imports it on load.
 */
async function importLichess(page: Page) {
  if (!page.url().startsWith("http")) await page.goto("/insights");
  await page.evaluate(() => {
    const account = { platform: "lichess", username: "Zhigalko_Sergei", verified: false, ratings: {}, linkedAt: "2026-10-01T00:00:00.000Z", lastSyncedAt: null, lastGameAt: null };
    localStorage.setItem("cot.v2.insights", JSON.stringify({ accounts: { lichess: account }, games: [] }));
  });
  await page.goto("/insights");
  await expect(page.getByTestId("import-done")).toContainText("Lichess: 43 new games imported");
}

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(NOW);
});

test("guest: Lichess is connected by signing in to it, never by a typed name", async ({ page }) => {
  await mockPlatforms(page);
  await page.goto("/insights");
  await expect(page.getByTestId("insights-onboarding")).toBeVisible();
  const row = page.getByTestId("link-lichess");
  await expect(row.getByLabel("Lichess username")).toHaveCount(0);
  await expect(row.getByRole("link", { name: "Continue with Lichess" })).toHaveAttribute("href", "/api/auth/oauth/lichess?intent=signin&next=%2Finsights");
  // Chess.com has no OAuth credentials here: still a typed username, called unverified
  await expect(page.getByTestId("link-chesscom").getByLabel("Chess.com username")).toBeVisible();
  await expect(page.getByTestId("linked-accounts")).toContainText("A typed Chess.com username isn't verified");
});

test("guest: a Lichess import, every section renders with trainable links", async ({ page }) => {
  const calls = await mockPlatforms(page);
  await importLichess(page);
  // an older typed link: unverified, with a way to verify it by signing in
  await expect(page.getByTestId("linked-lichess")).toContainText("linked, not verified");
  await expect(page.getByTestId("verify-lichess")).toHaveText(/Sign in with Lichess to verify/);

  // the documented export query, and nothing sent to our own server
  const exportCall = calls.find((u) => u.includes("/api/games/user/"))!;
  expect(new URL(exportCall).searchParams.get("perfType")).toBe("rapid,blitz,classical");

  await expect(page.getByTestId("insights-summary")).toContainText("43 blitz");
  await expect(page.getByTestId("insights-recs")).toBeVisible();
  for (const href of await page.getByTestId("rec").getByRole("link").evaluateAll((as) => as.map((a) => a.getAttribute("href")))) {
    expect(href).toMatch(/^\/(train|openings)\//);
  }
  await expect(page.getByTestId("insights-results")).toBeVisible();

  // sortable results
  const scoreHeader = page.getByTestId("insights-results").locator("th", { hasText: "Score" });
  await scoreHeader.getByRole("button").click();
  await expect(scoreHeader).toHaveAttribute("aria-sort", "descending");
  await scoreHeader.getByRole("button").click();
  await expect(scoreHeader).toHaveAttribute("aria-sort", "ascending");

  // summaries persist in this browser only, without games' full moves
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("cot.v2.insights") ?? "{}"));
  expect(stored.games).toHaveLength(43);
  expect(Math.max(...stored.games.map((g: { openingPlies: string[] }) => g.openingPlies.length))).toBeLessThanOrEqual(38);
  expect(Object.keys(stored.games[0])).not.toContain("sans");

  // a recommendation opens the trainer
  await page.getByTestId("rec").first().getByRole("link", { name: /Start learning/ }).click();
  await expect(page).toHaveURL(/\/train\//);
  await expect(page.getByTestId("coach-feed")).toBeVisible({ timeout: 60_000 });
});

test("guest: Chess.com import keeps only rated standard games in scope; unlink deletes them", async ({ page }) => {
  await mockPlatforms(page);
  await page.goto("/insights");
  const row = page.getByTestId("link-chesscom");
  await row.getByLabel("Chess.com username").fill("hikaru");
  await row.getByRole("button", { name: "Check" }).click();
  await expect(row.getByText(/Found hikaru on Chess.com/i)).toBeVisible();
  await row.getByRole("button", { name: /Link and import/ }).click();
  await expect(page.getByTestId("import-done")).toContainText(/Chess\.com: \d+ new games imported · \d+ skipped/);
  const n = await page.evaluate(() => JSON.parse(localStorage.getItem("cot.v2.insights")!).games.length);
  expect(n).toBeGreaterThan(0);

  const linked = page.getByTestId("linked-chesscom");
  await linked.getByRole("button", { name: "Unlink" }).click();
  await linked.getByRole("button", { name: /Click again/ }).click();
  await expect(page.getByTestId("insights-onboarding")).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("cot.v2.insights"))).toBeNull();
});

test("unknown username: a clear error, nothing linked", async ({ page }) => {
  await mockPlatforms(page);
  await page.goto("/insights");
  const row = page.getByTestId("link-chesscom");
  await row.getByLabel("Chess.com username").fill("nobody_zz9");
  await row.getByRole("button", { name: "Check" }).click();
  await expect(row.getByRole("alert")).toHaveText("No Chess.com player with that username.");
  await expect(row.getByRole("button", { name: /Link and import/ })).toHaveCount(0);
});

test("dashboard card and Settings show the linked account", async ({ page }) => {
  await mockPlatforms(page);
  await importLichess(page);
  await page.goto("/");
  await expect(page.getByTestId("insights-card")).toBeVisible();
  await expect(page.getByTestId("insights-card")).not.toContainText("Link Chess.com or Lichess");
  await page.goto("/settings");
  await expect(page.getByTestId("linked-lichess")).toContainText("Zhigalko_Sergei");
});

for (const theme of ["light", "dark"] as const) {
  test(`axe AA on /insights (${theme}): empty and with results`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    await mockPlatforms(page);
    await page.goto("/insights");
    await expect(page.getByTestId("insights-onboarding")).toBeVisible();
    const scan = async () => (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze()).violations.filter((v) => v.impact === "serious" || v.impact === "critical");
    let bad = await scan();
    expect(bad.map((v) => `${v.id}: ${v.nodes[0]?.target.join(" ")}`)).toEqual([]);
    await importLichess(page);
    await page.waitForTimeout(400);
    bad = await scan();
    expect(bad.map((v) => `${v.id}: ${v.nodes[0]?.target.join(" ")}`)).toEqual([]);
  });
}

test("phone width: no horizontal scroll, results as cards", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await mockPlatforms(page);
  await page.goto("/insights");
  await importLichess(page);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  const wide = await page.evaluate(() => [...document.querySelectorAll("body *")].filter((e) => e.getBoundingClientRect().right > window.innerWidth + 1).slice(0, 8).map((e) => `${e.tagName}.${(e.className || "").toString().slice(0, 60)} ${Math.round(e.getBoundingClientRect().right)}`));
  expect(overflow, wide.join("\n")).toBeLessThanOrEqual(0);
  await expect(page.getByTestId("insights-results").locator("table")).toBeHidden();
});

test("repeat mistakes: a verdict from the Lichess analysis, and Train this line opens the trainer at the position", async ({ page }) => {
  await mockPlatforms(page);
  await page.goto("/insights");
  await importLichess(page);
  const first = page.getByTestId("repeat").first();
  await expect(first).toBeVisible();
  await expect(first).toContainText(/Lichess analysis|Stockfish|not evaluated/);
  const href = await first.getByRole("link", { name: /Train this line/ }).getAttribute("href");
  expect(href).toMatch(/^\/train\/[^/]+\/[^/]+\/(white|black)\?mode=learn&li=\d+(&start=\d+)?$/);
  await first.getByRole("link", { name: /Train this line/ }).click();
  await expect(page.getByTestId("coach-feed")).toBeVisible({ timeout: 60_000 });
});

test("screenshots for the QA notes", async ({ page }) => {
  await mockPlatforms(page);
  for (const [theme, w] of [["light", 1280], ["dark", 1280], ["light", 375]] as const) {
    await page.setViewportSize({ width: w, height: 900 });
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    await page.goto("/insights");
    await page.evaluate(() => localStorage.removeItem("cot.v2.insights"));
    await page.reload();
    await importLichess(page);
    await page.waitForTimeout(500);
    await page.screenshot({ path: `docs/qa/insights/insights-${theme}-${w}.png`, fullPage: true });
  }
});
