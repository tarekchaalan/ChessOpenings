/**
 * Phase 6 a11y audit: axe (WCAG 2.0/2.1 A + AA rules) on every main route and
 * the trainer's interactive states, in light and dark. 0 serious or critical.
 * Results → docs/qa/phase6/a11y.json.
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT = join(__dirname, "../docs/qa/phase6");
type Row = { page: string; theme: string; violations: { id: string; impact: string | null; help: string; nodes: number; targets: string[]; why?: string }[] };
const rows: Row[] = [];

test.setTimeout(300_000);
test.use({ trace: "off" });
test.describe.configure({ mode: "serial" });
test.afterAll(() => {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "a11y.json"), JSON.stringify({ measuredAt: new Date().toISOString(), rows }, null, 2) + "\n");
});

async function audit(page: Page, name: string, theme: string) {
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  rows.push({
    page: name,
    theme,
    violations: r.violations.map((v) => ({ id: v.id, impact: v.impact ?? null, help: v.help, nodes: v.nodes.length, targets: v.nodes.slice(0, 5).map((n) => n.target.join(" ")), why: v.nodes[0]?.failureSummary?.split("\n").slice(1, 2).join(" ").trim() })),
  });
  return r.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
}

const PAGES: { name: string; url: string; ready: string; then?: (p: Page) => Promise<void> }[] = [
  { name: "dashboard", url: "/", ready: "main" },
  { name: "catalog", url: "/openings", ready: '[data-testid="hub-card"]' },
  { name: "hub", url: "/openings/ruy-lopez?side=white&stay=1", ready: "h1" },
  { name: "course: chapters", url: "/openings/ruy-lopez/closed/white", ready: '[data-testid="course-title"]' },
  { name: "course: tree", url: "/openings/ruy-lopez/closed/white", ready: '[data-testid="course-title"]', then: async (p) => p.getByRole("tab", { name: /Tree/ }).click() },
  { name: "course: explorer", url: "/openings/ruy-lopez/closed/white", ready: '[data-testid="course-title"]', then: async (p) => p.getByRole("tab", { name: /Course Explorer/ }).click() },
  { name: "trainer: learn", url: "/train/ruy-lopez/closed/white?mode=learn", ready: '[data-testid="coach-feed"]' },
  {
    name: "trainer: mistake",
    url: "/train/ruy-lopez/closed/white?mode=recall",
    ready: '[data-testid="san-input"]',
    then: async (p) => {
      await p.waitForFunction(() => (document.querySelector('[data-testid="trainer"]') as HTMLElement | null)?.dataset.phase === "await");
      await p.getByTestId("san-input").fill("a3");
      await p.getByTestId("san-input").press("Enter");
      await p.locator('[data-kind="mistake"]').first().waitFor();
    },
  },
  { name: "trainer: shortcuts sheet", url: "/train/ruy-lopez/closed/white?mode=learn", ready: '[data-testid="coach-feed"]', then: async (p) => { await p.locator("body").press("?"); await p.waitForTimeout(300); } },
  { name: "review (empty)", url: "/train/review", ready: "main" },
  { name: "explore", url: "/explore?line=e4,e5,Nf3,Nc6,Bb5", ready: "main" },
  { name: "opening map", url: "/openings/map", ready: '[data-testid="opening-map"]' },
  { name: "opening map: list", url: "/openings/map?view=list", ready: '[data-testid="map-list"]', then: async (p) => p.getByTestId("map-list").getByRole("button", { name: /1\.e4/ }).first().click() },
  { name: "settings: account", url: "/settings", ready: "h1" },
  { name: "settings: preferences", url: "/settings", ready: "h1", then: async (p) => p.getByRole("button", { name: "Preferences" }).click() },
  { name: "settings: data", url: "/settings", ready: "h1", then: async (p) => p.getByRole("button", { name: "Data" }).click() },
  { name: "leaderboard", url: "/leaderboard", ready: "h1" },
  { name: "insights (no account linked)", url: "/insights", ready: '[data-testid="insights-onboarding"]' },
  { name: "changes", url: "/changes", ready: "h1" },
  { name: "sign in", url: "/auth", ready: "main" },
];

for (const theme of ["light", "dark"] as const) {
  test(`axe: 0 serious/critical (${theme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme });
    const bad: string[] = [];
    for (const p of PAGES) {
      await page.goto(p.url);
      await page.locator(p.ready).first().waitFor({ timeout: 60_000 });
      if (p.then) await p.then(page);
      await page.waitForLoadState("load");
      await page.waitForFunction(() => document.title.length > 0);
      await page.waitForTimeout(400); // transitions settle (contrast is measured on final colours)
      for (const v of await audit(page, p.name, theme)) bad.push(`${p.name}: ${v.id} (${v.impact}) ×${v.nodes.length} — ${v.nodes[0]?.target.join(" ")}`);
    }
    expect(bad, bad.join("\n")).toEqual([]);
  });
}
