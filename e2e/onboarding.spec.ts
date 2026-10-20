/**
 * First-login setup (ADR 0008) against e2e/supabase-stub.mjs (real 0009 on a
 * local Postgres). Lichess and Chess.com are mocked from the captured
 * fixtures; the /api/insights routes need server keys the e2e build doesn't
 * have, so they're answered here and write the same linked_accounts row the
 * route would. Covers: established accounts → estimate → dashboard, catalog,
 * course depth and Settings; a brand-new account at Lichess's "1500?" → asked
 * for a level; "not now", skip and re-running setup; axe AA and phone width.
 *
 * Lichess is connected by signing in to it (ADR 0009), so its accounts here
 * start as the OAuth callback leaves them (connectLichess); Chess.com, without
 * OAuth credentials in e2e, is still a checked username.
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { lichessProfile, type LichessUser } from "../src/lib/insights/sources/lichess";

const STUB = `http://127.0.0.1:${process.env.E2E_SUPABASE_PORT ?? 54398}`;
const FIX = join(__dirname, "../src/lib/insights/__tests__/fixtures");
const fx = (n: string) => readFileSync(join(FIX, n), "utf8");
const IDS = { dave: "00000000-0000-0000-0000-0000000000d4", erin: "00000000-0000-0000-0000-0000000000e5", frank: "00000000-0000-0000-0000-0000000000f6" } as const;
type Who = keyof typeof IDS;

test.setTimeout(180_000);

async function sql(q: string): Promise<string> {
  const r = await fetch(`${STUB}/__e2e/sql`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sql: q }) });
  expect(r.ok, await r.clone().text()).toBe(true);
  return ((await r.json()) as { out: string }).out;
}

test.beforeEach(async () => {
  const r = await fetch(`${STUB}/__e2e/reset`, { method: "POST" });
  expect(r.ok).toBe(true);
});

const cors = { "access-control-allow-origin": "*" };

/** Lichess / Chess.com from the fixtures, plus a brand-new Lichess account ("newbie": 1500? after 3 games). */
async function mockPlatforms(page: Page) {
  await page.route("https://lichess.org/**", (route) => {
    const url = route.request().url();
    if (/\/api\/user\/zhigalko_sergei$/i.test(url)) return route.fulfill({ json: JSON.parse(fx("lichess-user.json")), headers: cors });
    if (/\/api\/user\/newbie$/i.test(url))
      return route.fulfill({ json: { id: "newbie", username: "Newbie", perfs: { blitz: { games: 3, rating: 1500, prov: true }, rapid: { games: 0, rating: 1500, prov: true } } }, headers: cors });
    if (/\/api\/games\/user\//i.test(url)) return route.fulfill({ body: "", contentType: "application/x-ndjson", headers: cors });
    return route.fulfill({ status: 404, json: { error: "Not found" }, headers: cors });
  });
  await page.route("https://api.chess.com/**", (route) => {
    const url = route.request().url();
    if (url.endsWith("/player/hikaru")) return route.fulfill({ json: JSON.parse(fx("chesscom-player.json")), headers: cors });
    if (url.endsWith("/player/hikaru/stats")) return route.fulfill({ json: JSON.parse(fx("chesscom-stats.json")), headers: cors });
    if (url.endsWith("/games/archives")) return route.fulfill({ json: { archives: [] }, headers: cors });
    return route.fulfill({ status: 404, json: JSON.parse(fx("chesscom-404.json")), headers: cors });
  });
}

/** /api/insights/{link,sync}: what the route would store, without the server keys. */
async function mockInsightsRoutes(page: Page, who: Who) {
  await page.route("**/api/insights/link", async (route) => {
    const b = route.request().postDataJSON() as { platform: string; username: string; ratings: unknown };
    await sql(
      `insert into linked_accounts (user_id, platform, username, ratings) values ('${IDS[who]}', ${lit(b.platform)}, ${lit(b.username)}, ${lit(JSON.stringify(b.ratings))})
       on conflict (user_id, platform) do update set username = excluded.username, ratings = excluded.ratings`
    );
    return route.fulfill({ json: { ok: true } });
  });
  await page.route("**/api/insights/sync", (route) => route.fulfill({ json: { ok: true, stored: 0 } }));
}

const lit = (v: string) => `'${v.replace(/'/g, "''")}'`;

/** What the Lichess OAuth callback stores (ADR 0009): the identity, and the linked account, verified, with the account's ratings. */
async function connectLichess(who: Who, user: LichessUser & { id: string }) {
  const p = lichessProfile(user)!;
  await sql(`insert into oauth_identities (provider, provider_user_id, user_id, username) values ('lichess', ${lit(user.id)}, '${IDS[who]}', ${lit(p.username)})`);
  await sql(`insert into linked_accounts (user_id, platform, username, verified, ratings) values ('${IDS[who]}', 'lichess', ${lit(p.username)}, true, ${lit(JSON.stringify(p.ratings))})`);
}
const ZHIGALKO = () => JSON.parse(fx("lichess-user.json")) as LichessUser & { id: string };

async function signIn(browser: Browser, who: Who): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await mockPlatforms(page);
  await mockInsightsRoutes(page, who);
  await page.goto("/auth");
  await page.locator("#auth-email").fill(`${who}@e2e.test`);
  await page.locator("#auth-password").fill("password1!");
  await page.locator('form button[type="submit"]').first().click();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible({ timeout: 30_000 });
  return page;
}

const modal = (page: Page) => page.getByTestId("setup-modal");

test("established accounts → estimated Elo → dashboard, catalog, course depth, Settings", async ({ browser }) => {
  await connectLichess("dave", ZHIGALKO());
  const page = await signIn(browser, "dave");
  await expect(modal(page)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("dialog", { name: "Link your chess accounts" })).toBeVisible();
  // Lichess came connected (no username field for it); Chess.com is checked by name
  await expect(page.getByTestId("setup-lichess-found")).toContainText("blitz 2815");
  await expect(page.getByLabel("Lichess username")).toHaveCount(0);
  await page.getByLabel("Chess.com username").fill("nobody_here");
  await page.getByTestId("setup-chesscom").getByRole("button", { name: "Check" }).click();
  await expect(page.getByTestId("setup-chesscom")).toContainText("No Chess.com player with that username.");
  await page.getByLabel("Chess.com username").fill("hikaru");
  await page.getByTestId("setup-chesscom").getByRole("button", { name: "Check" }).click();
  await expect(page.getByTestId("setup-chesscom-found")).toContainText("rapid 2838");
  await modal(page).getByRole("button", { name: "Continue" }).click();

  // the estimate, from both accounts, with what it sets up
  const est = page.getByTestId("setup-estimate");
  await expect(est).toContainText("Estimated Elo");
  await expect(est).toContainText("Expert+");
  await expect(modal(page)).toContainText("Lichess blitz 2815 (17868 games)");
  await expect(modal(page)).toContainText("Chess.com rapid 2838");
  await expect(page.getByTestId("setup-effects")).toContainText("Courses start at Complete depth");
  await expect(page.getByTestId("setup-effects")).toContainText("8 new lines a day");
  await expect(modal(page)).toContainText("leaderboard rating is separate");
  const elo = Number((await est.locator("p.text-3xl").innerText()).replace(/\D/g, ""));
  expect(elo).toBeGreaterThan(2400);
  await modal(page).getByRole("button", { name: "Start training" }).click();
  await expect(modal(page)).toBeHidden();

  // stored: setup done with the estimate, accounts linked, leaderboard rating untouched
  expect(await sql(`select completed_at is not null, estimated_elo, skipped from player_setup where user_id = '${IDS.dave}'`)).toBe(`t|${elo}|f`);
  expect(await sql(`select string_agg(platform || ':' || username || ':' || verified, ',' order by platform) from linked_accounts where user_id = '${IDS.dave}'`)).toBe(
    "chesscom:hikaru:false,lichess:Zhigalko_Sergei:true"
  );
  expect(await sql(`select rating from profiles where id = '${IDS.dave}'`)).toBe("800");

  // dashboard: level card and "Start here" courses
  await page.goto("/");
  await expect(page.getByTestId("level-card")).toContainText(`≈ ${elo}`);
  await expect(page.getByTestId("level-card")).toContainText("Expert+");
  const suggested = page.getByTestId("suggested-for-level");
  await expect(suggested).toContainText("Start here");
  await expect(suggested.getByRole("link").first()).toHaveAttribute("href", /^\/openings\/[^/]+\/[^/]+\/(white|black)$/);
  // no modal on later visits
  await page.reload();
  await expect(page.getByTestId("level-card")).toBeVisible();
  await expect(modal(page)).toHaveCount(0);

  // catalog row and course depth follow the level
  await page.goto("/openings");
  await expect(page.getByTestId("suggested-for-level")).toContainText("For your level");
  const href = await page.getByTestId("suggested-for-level").getByRole("link").first().getAttribute("href");
  await page.goto(href!);
  await expect(page.getByRole("radio", { name: /^Complete/ })).toHaveAttribute("aria-checked", "true", { timeout: 60_000 });

  // Settings shows it, with a way to run setup again
  await page.goto("/settings");
  await expect(page.getByTestId("level-card")).toContainText(`≈ ${elo}`);
  await page.getByRole("button", { name: "Update accounts or level" }).click();
  await expect(modal(page)).toBeVisible();
  await expect(page.getByTestId("setup-lichess-found")).toContainText("Zhigalko_Sergei");
});

test("a brand-new account at 1500? doesn't count: asked for a level, which then sets everything", async ({ browser }) => {
  await connectLichess("erin", { id: "newbie", username: "Newbie", perfs: { blitz: { games: 3, rating: 1500, prov: true }, rapid: { games: 0, rating: 1500, prov: true } } });
  const page = await signIn(browser, "erin");
  await expect(modal(page)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("setup-lichess-found")).toContainText("blitz 1500 (provisional)");
  await modal(page).getByRole("button", { name: "Continue" }).click();

  await expect(page.getByRole("dialog", { name: "How would you describe your chess?" })).toBeVisible();
  await expect(page.getByTestId("setup-new-account")).toContainText("Lichess blitz 1500 after 3 games, still at the starting rating: too new to count (needs 20).");
  await expect(modal(page).getByRole("button", { name: "Continue" })).toBeDisabled();
  await page.getByRole("radio", { name: /Casual player/ }).check();
  await modal(page).getByRole("button", { name: "Continue" }).click();

  await expect(page.getByTestId("setup-estimate")).toContainText("≈ 1200");
  await expect(page.getByTestId("setup-estimate")).toContainText("Improving");
  await expect(modal(page)).toContainText("From what you told us: Casual player.");
  await expect(page.getByTestId("setup-effects")).toContainText("Courses start at Essentials depth");
  await expect(page.getByTestId("setup-effects")).toContainText("4 new lines a day");
  await modal(page).getByRole("button", { name: "Start training" }).click();
  await expect(modal(page)).toBeHidden();
  expect(await sql(`select estimated_elo, self_level from player_setup where user_id = '${IDS.erin}'`)).toBe("1200|casual");

  await page.goto("/");
  await expect(page.getByTestId("level-card")).toContainText("≈ 1200");
  await expect(page.getByTestId("level-card")).toContainText("casual player");
  const href = await page.getByTestId("suggested-for-level").getByRole("link").first().getAttribute("href");
  await page.goto(href!);
  await expect(page.getByRole("radio", { name: /^Essentials/ })).toHaveAttribute("aria-checked", "true", { timeout: 60_000 });
  // the daily plan follows the level
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("cot.v2.prefs") ?? "{}").dailyNewLines)).toBe(4);
});

test("not now lasts the session; skip is remembered; setup can run later from Settings", async ({ browser }) => {
  const page = await signIn(browser, "frank");
  await expect(modal(page)).toBeVisible({ timeout: 30_000 });
  // nothing linked: Continue needs an account, and Lichess is connected by signing in to it
  await expect(modal(page).getByRole("button", { name: "Continue" })).toBeDisabled();
  await expect(page.getByTestId("setup-lichess-connect")).toHaveAttribute("href", /^\/api\/auth\/oauth\/lichess\?intent=link&next=%2F/);
  await page.keyboard.press("Escape");
  await expect(modal(page)).toBeHidden();
  await page.goto("/openings");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(modal(page)).toHaveCount(0);
  expect(await sql(`select count(*) from player_setup where user_id = '${IDS.frank}'`)).toBe("0");

  // a new session asks again; skip it this time
  const again = await signIn(browser, "frank");
  await expect(modal(again)).toBeVisible({ timeout: 30_000 });
  await again.getByRole("button", { name: /Skip setup/ }).click();
  await expect(modal(again)).toBeHidden();
  expect(await sql(`select skipped, completed_at is not null from player_setup where user_id = '${IDS.frank}'`)).toBe("t|t");
  const third = await signIn(browser, "frank");
  await third.goto("/");
  await expect(third.getByTestId("dashboard")).toBeVisible();
  await expect(modal(third)).toHaveCount(0);

  // Settings: run setup without an online account
  await third.goto("/settings");
  await expect(third.getByText("You skipped setup")).toBeVisible();
  await third.getByRole("button", { name: "Run setup" }).click();
  await expect(modal(third)).toBeVisible();
  await third.getByRole("button", { name: "I don't play online" }).click();
  await third.getByRole("radio", { name: /Club player/ }).check();
  await modal(third).getByRole("button", { name: "Continue" }).click();
  await expect(third.getByTestId("setup-estimate")).toContainText("≈ 1600");
  await expect(third.getByTestId("setup-estimate")).toContainText("Club");
  await modal(third).getByRole("button", { name: "Start training" }).click();
  await expect(modal(third)).toBeHidden();
  await expect(third.getByTestId("level-card")).toContainText("≈ 1600");
  expect(await sql(`select skipped, estimated_elo, self_level from player_setup where user_id = '${IDS.frank}'`)).toBe("f|1600|club");
});

for (const theme of ["light", "dark"] as const) {
  test(`setup modal: axe AA, 0 serious/critical, and phone width (${theme})`, async ({ browser }) => {
    await connectLichess("dave", ZHIGALKO());
    const page = await signIn(browser, "dave");
    await page.emulateMedia({ colorScheme: theme });
    await expect(modal(page)).toBeVisible({ timeout: 30_000 });
    const bad: string[] = [];
    const audit = async (name: string) => {
      await page.waitForTimeout(300);
      const r = await new AxeBuilder({ page }).include('[data-testid="setup-modal"]').withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
      for (const v of r.violations.filter((v) => v.impact === "serious" || v.impact === "critical")) bad.push(`${name}: ${v.id} (${v.impact}) ×${v.nodes.length} — ${v.nodes[0]?.target.join(" ")}`);
    };
    await audit("accounts");
    await page.getByLabel("Chess.com username").fill("hikaru");
    await page.getByTestId("setup-chesscom").getByRole("button", { name: "Check" }).click();
    await expect(page.getByTestId("setup-chesscom-found")).toBeVisible();
    await audit("accounts (found)");
    await modal(page).getByRole("button", { name: "Continue" }).click();
    await expect(page.getByTestId("setup-estimate")).toBeVisible();
    await audit("result");
    await modal(page).getByRole("button", { name: "Back" }).click();
    await page.getByRole("button", { name: "I don't play online" }).click();
    await audit("level");
    expect(bad, bad.join("\n")).toEqual([]);

    await page.setViewportSize({ width: 360, height: 700 });
    await page.waitForTimeout(300);
    const box = await modal(page).boundingBox();
    expect(box!.width).toBeLessThanOrEqual(360);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  });
}
