/**
 * Friends (ADR 0007) end to end, with two (or three) signed-in players in
 * separate browser contexts against e2e/supabase-stub.mjs: the real 0008
 * migration on a local Postgres. Follow, request / accept / decline, remove,
 * block / unblock, privacy settings changing what the other player sees,
 * view-as, the feed, compare, the friends board, challenge links (asserted,
 * never opened), the badge, axe AA in light and dark, and phone width.
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Browser, type Page } from "@playwright/test";

const STUB = `http://127.0.0.1:${process.env.E2E_SUPABASE_PORT ?? 54398}`;

test.setTimeout(180_000);

async function resetDb() {
  const r = await fetch(`${STUB}/__e2e/reset`, { method: "POST" });
  expect(r.ok).toBe(true);
}

async function sql(q: string) {
  const r = await fetch(`${STUB}/__e2e/sql`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sql: q }) });
  expect(r.ok, await r.clone().text()).toBe(true);
}

async function signedIn(browser: Browser, who: "alice" | "bob" | "carol"): Promise<Page> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto("/auth");
  await page.locator("#auth-email").fill(`${who}@e2e.test`);
  await page.locator("#auth-password").fill("password1!");
  await page.locator('form button[type="submit"]').first().click();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible({ timeout: 30_000 });
  return page;
}

async function openProfile(page: Page, username: string) {
  await page.goto(`/u/${username}`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 60_000 });
}

async function setPrivacy(page: Page, section: string, level: string) {
  await page.goto("/settings?tab=privacy");
  const select = page.getByLabel(section, { exact: true });
  await expect(select).toBeEnabled({ timeout: 30_000 });
  await select.selectOption({ label: level });
  await expect(page.getByText("Saved.")).toBeVisible();
}

test.beforeEach(async () => {
  await resetDb();
});

test("follow, become friends, sections open up, feed, compare, board, challenge, block and unblock", async ({ browser }) => {
  const alice = await signedIn(browser, "alice");
  const bob = await signedIn(browser, "bob");

  // alice follows bob: everything of bob's is private by default
  await openProfile(alice, "bob");
  await expect(alice.getByText("Some of this profile is private.")).toBeVisible();
  await expect(alice.getByRole("region", { name: "Learning now" })).toHaveCount(0);
  await expect(alice.getByRole("region", { name: "Ratings" })).toHaveCount(0);
  await alice.getByRole("button", { name: "Follow bob", exact: true }).click();
  await expect(alice.getByRole("button", { name: /^Following bob/ })).toBeVisible();
  await expect(alice.getByTestId("follower-count")).toContainText("1 follower");
  // the preset card appears after a first follow
  await expect(alice.getByTestId("preset-card")).toBeVisible();
  await alice.getByRole("button", { name: "Keep everything private" }).click();
  await expect(alice.getByTestId("preset-card")).toHaveCount(0);

  // bob: a badge, the notification, the preset, follow back
  await bob.goto("/");
  await expect(bob.getByTestId("friends-badge-count")).toHaveText("1", { timeout: 30_000 });
  await bob.getByRole("link", { name: /Friends/ }).first().click();
  await expect(bob.getByTestId("notifications")).toContainText("alice started following you");
  await bob.getByRole("button", { name: /Let friends see/ }).click();
  await expect(bob.getByTestId("preset-card")).toHaveCount(0);
  await bob.getByRole("tab", { name: /Followers/ }).click();
  await bob.getByTestId("follower-alice").getByRole("button", { name: "Follow alice", exact: true }).click();
  await expect(bob.getByTestId("follower-alice").getByRole("button", { name: /^Following alice/ })).toBeVisible();
  await expect(bob.getByTestId("friends-badge-count")).toHaveCount(0);

  // friends now: bob's learning and stats show for alice, ratings stay hidden (linked = only me)
  await openProfile(alice, "bob");
  await expect(alice.getByTestId("friends-badge")).toBeVisible();
  const learning = alice.getByRole("region", { name: "Learning now" });
  await expect(learning).toBeVisible();
  await expect(learning).toContainText("Italian Game");
  await expect(learning.getByRole("link", { name: "Learn this too" }).first()).toHaveAttribute("href", "/openings/italian-game/main/white");
  await expect(alice.getByRole("region", { name: "Stats" })).toContainText("Lines trained");
  await expect(alice.getByRole("region", { name: "Ratings" })).toHaveCount(0);
  await expect(alice.getByTestId("challenge-button")).toHaveCount(0);
  await expect(alice.getByTestId("challenge-link")).toHaveCount(0);

  // bob shares linked accounts with friends: ratings, played openings and a two-platform challenge
  await setPrivacy(bob, "Linked accounts", "Friends (mutual)");
  await openProfile(alice, "bob");
  const ratings = alice.getByRole("region", { name: "Ratings" });
  await expect(ratings).toContainText("bob_li");
  await expect(ratings).toContainText("unverified");
  await expect(alice.getByRole("region", { name: "Openings they play" })).toContainText("Italian Game");
  await alice.getByTestId("challenge-button").click();
  const dialog = alice.getByRole("dialog", { name: "Challenge on Chess.com or Lichess?" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("challenge-lichess")).toHaveAttribute("href", "https://lichess.org/?user=bob_li#friend");
  await expect(dialog.getByTestId("challenge-chesscom")).toHaveAttribute("href", "https://www.chess.com/play/bob_cc");
  await expect(dialog.getByTestId("challenge-lichess")).toHaveAttribute("target", "_blank");
  await expect(dialog).toContainText("alice_li");
  await alice.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  // one shared platform → a direct link (alice unlinks Chess.com)
  await sql("delete from linked_accounts where platform = 'chesscom' and user_id = '00000000-0000-0000-0000-0000000000a1'");
  await openProfile(alice, "bob");
  await expect(alice.getByTestId("challenge-link")).toHaveAttribute("href", "https://lichess.org/?user=bob_li#friend");

  // the feed: bob's grouped activity
  await alice.goto("/friends");
  const feed = alice.getByTestId("feed");
  await expect(feed).toContainText("bob");
  await expect(feed).toContainText("trained 3 new lines in Italian Game");
  await expect(feed).toContainText("started Italian Game");

  // compare
  await alice.getByLabel("Compare with").selectOption("bob");
  const cmp = alice.getByTestId("compare");
  await expect(cmp).toContainText("Italian Game");
  await expect(cmp).toContainText("30% mastery");
  await expect(cmp).toContainText("60% mastery");
  await expect(cmp).toContainText("Lichess blitz: you 1650, bob 1720");

  // the friends board: alice + bob, not carol
  await alice.goto("/leaderboard");
  await alice.getByRole("button", { name: "Friends" }).click();
  const board = alice.locator("tbody");
  await expect(board).toContainText("bob");
  await expect(board).toContainText("alice");
  await expect(board).not.toContainText("carol");

  // block: gone for both, everywhere
  await openProfile(alice, "bob");
  alice.once("dialog", (d) => d.accept());
  await alice.getByRole("button", { name: "More actions" }).click();
  await alice.getByRole("menuitem", { name: "Block" }).click();
  await alice.waitForURL("**/friends");
  await openProfile(alice, "bob");
  await expect(alice.getByRole("heading", { name: "No such player" })).toBeVisible();
  await openProfile(bob, "alice");
  await expect(bob.getByRole("heading", { name: "No such player" })).toBeVisible();
  await bob.goto("/friends");
  await bob.getByRole("tab", { name: "Search" }).click();
  await bob.getByLabel("Find a player by username").fill("al");
  await expect(bob.getByText("No players start with “al”.")).toBeVisible();
  await alice.goto("/leaderboard");
  await alice.getByRole("button", { name: "Friends" }).click();
  await expect(alice.locator("tbody")).not.toContainText("bob");

  // unblock: visible again, follows don't come back
  await alice.goto("/settings?tab=privacy");
  await expect(alice.getByTestId("blocked-list")).toContainText("bob");
  await alice.getByRole("button", { name: "Unblock" }).click();
  await expect(alice.getByText("Nobody. Block someone")).toBeVisible();
  await openProfile(alice, "bob");
  await expect(alice.getByRole("button", { name: "Follow bob", exact: true })).toBeVisible();
  await expect(alice.getByTestId("friends-badge")).toHaveCount(0);
});

test("approve followers: request, accept, decline, remove follower", async ({ browser }) => {
  const alice = await signedIn(browser, "alice");
  const bob = await signedIn(browser, "bob");
  const carol = await signedIn(browser, "carol");

  await bob.goto("/settings?tab=privacy");
  await bob.getByLabel(/Approve followers/).check();
  await expect(bob.getByText("Saved.")).toBeVisible();

  await openProfile(alice, "bob");
  await alice.getByRole("button", { name: "Request to follow bob" }).click();
  await expect(alice.getByRole("button", { name: /^Requested bob/ })).toBeVisible();
  await openProfile(carol, "bob");
  await carol.getByRole("button", { name: "Request to follow bob" }).click();
  await expect(carol.getByRole("button", { name: /^Requested bob/ })).toBeVisible();

  await bob.goto("/friends");
  await expect(bob.getByTestId("notifications")).toContainText("alice asked to follow you");
  await bob.getByRole("tab", { name: /Requests/ }).click();
  await bob.getByTestId("request-alice").getByRole("button", { name: "Accept" }).click();
  await expect(bob.getByTestId("request-alice")).toHaveCount(0);
  await bob.getByTestId("request-carol").getByRole("button", { name: "Decline" }).click();
  await expect(bob.getByText("No follow requests.")).toBeVisible();

  // alice is told and follows; carol is back to a plain request button
  await alice.goto("/friends");
  await expect(alice.getByTestId("notifications")).toContainText("bob accepted your follow request");
  await expect(alice.getByTestId("following-bob")).toBeVisible();
  await openProfile(carol, "bob");
  await expect(carol.getByRole("button", { name: "Request to follow bob" })).toBeVisible();

  // remove follower without blocking
  await bob.goto("/friends");
  await bob.getByRole("tab", { name: /Followers/ }).click();
  await bob.getByRole("button", { name: "Remove follower alice" }).click();
  await expect(bob.getByText("No followers yet.")).toBeVisible();
  await openProfile(alice, "bob");
  await expect(alice.getByRole("button", { name: "Request to follow bob" })).toBeVisible();
});

test("view-as preview, anonymous visitors and search", async ({ browser }) => {
  const bob = await signedIn(browser, "bob");
  await setPrivacy(bob, "Openings I'm learning", "Everyone");
  await setPrivacy(bob, "Training stats", "Followers");

  await openProfile(bob, "bob");
  await bob.getByRole("button", { name: "Everyone" }).click();
  await expect(bob.getByRole("status").filter({ hasText: "Previewing what anyone with the link sees" })).toBeVisible();
  await expect(bob.getByRole("region", { name: "Learning now" })).toBeVisible();
  await expect(bob.getByRole("region", { name: "Stats" })).toHaveCount(0);
  await expect(bob.getByText("Some of this profile is private.")).toBeVisible();
  await bob.getByRole("button", { name: "A follower" }).click();
  await expect(bob.getByRole("region", { name: "Stats" })).toBeVisible();
  await bob.getByRole("button", { name: "You" }).click();
  await expect(bob.getByRole("region", { name: "Ratings" })).toBeVisible();

  // an anonymous visitor sees the Everyone sections only, and is asked to sign in to follow
  const anon = await (await browser.newContext()).newPage();
  await openProfile(anon, "bob");
  await expect(anon.getByRole("region", { name: "Learning now" })).toBeVisible();
  await expect(anon.getByRole("region", { name: "Stats" })).toHaveCount(0);
  await expect(anon.getByRole("region", { name: "Ratings" })).toHaveCount(0);
  await expect(anon.getByRole("link", { name: "Sign in to follow" })).toBeVisible();
  await anon.goto("/friends");
  await expect(anon.getByRole("heading", { name: "Follow other players" })).toBeVisible();

  // search: prefix, case-insensitive, follow from the results
  const alice = await signedIn(browser, "alice");
  await alice.goto("/friends");
  await alice.getByRole("tab", { name: "Search" }).click();
  await alice.getByLabel("Find a player by username").fill("BO");
  const results = alice.getByTestId("search-results");
  await expect(results).toContainText("bob");
  await results.getByRole("button", { name: "Follow bob", exact: true }).click();
  await expect(results.getByRole("button", { name: /^Following bob/ })).toBeVisible();
  await alice.getByRole("tab", { name: /Following/ }).click();
  await expect(alice.getByTestId("following-bob")).toBeVisible();
});

const AUDITED = [
  { name: "friends", url: "/friends", ready: '[aria-labelledby="feed-title"]' },
  { name: "profile", url: "/u/bob", ready: "h1" },
  { name: "own profile", url: "/u/alice", ready: '[aria-label="View your profile as"]' },
  { name: "leaderboard: friends", url: "/leaderboard", ready: "tbody", then: (p: Page) => p.getByRole("button", { name: "Friends" }).click() },
  { name: "settings: privacy", url: "/settings?tab=privacy", ready: "#privacy-linked" },
];

for (const theme of ["light", "dark"] as const) {
  test(`friends pages: axe AA, 0 serious/critical (${theme})`, async ({ browser }) => {
    // some data on every page: alice and bob are friends and share everything with friends
    await sql(`
      insert into follows (follower_id, followee_id, status) values
        ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b2', 'active'),
        ('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000a1', 'active');
      insert into privacy_settings (user_id, linked, learning, stats, activity, preset_answered) values
        ('00000000-0000-0000-0000-0000000000b2', 'friends', 'friends', 'friends', 'friends', true);
      insert into notifications (user_id, actor_id, kind) values
        ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b2', 'new_follower');`);
    const alice = await signedIn(browser, "alice");
    await alice.emulateMedia({ colorScheme: theme });
    const bad: string[] = [];
    for (const p of AUDITED) {
      await alice.goto(p.url);
      await alice.locator(p.ready).first().waitFor({ timeout: 60_000 });
      if (p.then) await p.then(alice);
      await alice.waitForTimeout(500);
      const r = await new AxeBuilder({ page: alice }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
      for (const v of r.violations.filter((v) => v.impact === "serious" || v.impact === "critical"))
        bad.push(`${p.name}: ${v.id} (${v.impact}) ×${v.nodes.length} — ${v.nodes[0]?.target.join(" ")}`);
    }
    expect(bad, bad.join("\n")).toEqual([]);

    // phone width: no horizontal scroll
    await alice.setViewportSize({ width: 360, height: 780 });
    for (const p of AUDITED) {
      await alice.goto(p.url);
      await alice.locator(p.ready).first().waitFor({ timeout: 60_000 });
      if (p.then) await p.then(alice);
      await alice.waitForTimeout(300);
      const overflow = await alice.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, `${p.name} scrolls horizontally at 360px`).toBeLessThanOrEqual(0);
    }
  });
}
