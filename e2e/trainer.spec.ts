/**
 * Phase 3 acceptance — the trainer (§5 Phase 3). Guest mode, fresh storage
 * per test. Moves are played by dragging on the board unless a test is
 * about the keyboard.
 */
import { expect, test, type Page } from "@playwright/test";

const RUY = "/train/ruy-lopez/closed/white";

async function phaseIs(page: Page, phase: string, ply?: number) {
  await page.waitForFunction(
    ([ph, p]) => {
      const d = (document.querySelector('[data-testid="trainer"]') as HTMLElement | null)?.dataset;
      return d?.phase === ph && (p === null || Number(d.ply) === p);
    },
    [phase, ply ?? null] as const,
    { timeout: 30_000 }
  );
}

async function ply(page: Page): Promise<number> {
  return Number(await page.getByTestId("trainer").getAttribute("data-ply"));
}

/** Drag a piece on the chessground board (board orientation from the side). */
async function drag(page: Page, from: string, to: string, white = true) {
  const box = (await page.locator(".board-cg cg-board").boundingBox())!;
  const at = (s: string) => {
    const f = s.charCodeAt(0) - 97;
    const r = Number(s[1]) - 1;
    const x = white ? f : 7 - f;
    const y = white ? 7 - r : r;
    return { x: box.x + ((x + 0.5) * box.width) / 8, y: box.y + ((y + 0.5) * box.height) / 8 };
  };
  const a = at(from);
  const b = at(to);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 6 });
  await page.mouse.up();
}

/** The SAN the Learn coach asks for right now ("Play 4.Ba4." → "Ba4"). */
async function askedSan(page: Page): Promise<string> {
  const t = await page.locator('[data-kind="turn"] [data-testid="coach-title"]').last().innerText();
  return /Play \d+(?:\.|…)(\S+?)\.$/.exec(t)![1];
}

/** Learn: play the asked moves until the live ply reaches `until` (or the end). */
async function learnUntil(page: Page, until = Infinity) {
  for (;;) {
    await page.waitForFunction(() => ["await", "end"].includes((document.querySelector('[data-testid="trainer"]') as HTMLElement | null)?.dataset.phase ?? ""), null, { timeout: 30_000 });
    const p = await ply(page);
    if ((await page.getByTestId("trainer").getAttribute("data-phase")) === "end" || p >= until) return;
    await page.getByTestId("san-input").fill(await askedSan(page));
    await page.getByTestId("san-input").press("Enter");
    await page.waitForFunction((p0) => Number((document.querySelector('[data-testid="trainer"]') as HTMLElement | null)?.dataset.ply ?? -1) > p0, p, { timeout: 30_000 });
  }
}

test.setTimeout(240_000);

test("Learn Ruy Lopez as White (Essentials): prompts, feed, scrubbing, branch card, end card, next line", async ({ page }) => {
  await page.goto(`${RUY}?mode=learn`);
  await phaseIs(page, "await", 0);
  // the first line: the approach is played with prompts and arrows
  for (const [from, to, label] of [
    ["e2", "e4", "Play 1.e4."],
    ["g1", "f3", "Play 2.Nf3."],
    ["f1", "b5", "Play 3.Bb5."],
  ] as const) {
    const p = await ply(page);
    await phaseIs(page, "await", p);
    await expect(page.locator('[data-kind="turn"] [data-testid="coach-title"]').last()).toHaveText(label);
    await expect(page.locator('.cg-wrap svg line[stroke="#15781B"]').first()).toBeAttached(); // the play arrow
    await drag(page, from, to);
    await page.waitForFunction((p0) => Number((document.querySelector('[data-testid="trainer"]') as HTMLElement | null)?.dataset.ply ?? -1) >= p0 + 2, p);
  }
  await learnUntil(page);
  await phaseIs(page, "end");

  const kinds = await page.locator('[data-testid="coach-msg"]').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.kind));
  const plies = await ply(page);
  const learner = Math.ceil(plies / 2);
  // every learner move had an imperative; every move posted a persistent message
  expect(kinds.filter((k) => k === "turn")).toHaveLength(learner);
  expect(kinds.filter((k) => k === "ok")).toHaveLength(learner);
  expect(kinds.filter((k) => k === "opponent")).toHaveLength(plies - learner);
  // a branch card at the first opponent branch
  expect(kinds).toContain("branch");
  const branch = page.locator('[data-kind="branch"]').first();
  await expect(branch).toContainText("We'll take");

  // clicking an old message scrubs the board; Back to live returns
  await page.locator('[data-kind="ok"]').first().getByRole("button").first().click();
  await expect(page.getByTestId("back-to-live")).toBeVisible();
  await expect(page.locator('[data-testid="move-chip"][aria-current="step"]')).toHaveText(/1\.e4/);
  await page.getByTestId("back-to-live").click();
  await expect(page.getByTestId("back-to-live")).toHaveCount(0);

  // the end card offers Recall and Next line; Next line starts at the divergence point
  await expect(page.getByTestId("end-recall")).toHaveText("Recall it now");
  const next = page.getByTestId("end-next");
  await expect(next).toHaveText(/^Next line: .+ — starts at move \d+$/);
  const move = Number(/starts at move (\d+)/.exec(await next.innerText())![1]);
  await next.click();
  await page.waitForFunction(() => (document.querySelector('[data-testid="trainer"]') as HTMLElement | null)?.dataset.phase === "await");
  await expect(page.locator('[data-kind="ff"]')).toContainText("Replaying the known moves 1.e4 e5 2.Nf3");
  const start = await ply(page);
  expect(start).toBeGreaterThan(4);
  // the reply that makes this line new is played and explained, not swallowed by the replay
  await expect(page.locator('[data-kind="opponent"]').first().getByTestId("coach-title")).toHaveText(new RegExp(`^Black plays ${move}…`));
});

test("a wrong move stays with ✕ for ≥ 900 ms, then Try again puts it back", async ({ page }) => {
  await page.goto(`${RUY}?mode=learn&line=ln_c4e43ggaphii`);
  await learnUntil(page, 6);
  await phaseIs(page, "await", 6);
  await drag(page, "e1", "f1"); // 4.Kf1: not theory, not a master move
  await phaseIs(page, "wrong");
  const t0 = Date.now();
  await expect(page.locator('[data-kind="mistake"]').last()).toContainText("4.Kf1 ✕");
  await expect(page.locator('[data-kind="mistake"]').last()).toContainText("Not in this course's book.");
  await page.waitForTimeout(950);
  await expect(page.locator(".cg-badge-bad")).toHaveCount(1);
  await expect(page.getByTestId("wrong-chip")).toHaveText("Kf1");
  await page.getByTestId("action-try").click();
  await phaseIs(page, "await", 6);
  expect(Date.now() - t0).toBeGreaterThanOrEqual(900);
  await expect(page.locator(".cg-badge-bad")).toHaveCount(0);
  await expect(page.getByTestId("wrong-chip")).toHaveCount(0);
});

test("4.Bxc6 in the 4.Ba4 course: theory soft-fail, Make it my move switches to the course that plays it", async ({ page }) => {
  await page.goto(`${RUY}?mode=learn&line=ln_c4e43ggaphii`);
  await learnUntil(page, 6);
  await drag(page, "b5", "c6");
  await phaseIs(page, "wrong");
  const msg = page.locator('[data-kind="mistake"]').last();
  await expect(msg).toContainText("That's the Exchange Variation (4.Bxc6), also theory.");
  await expect(msg).toContainText("This course plays 4.Ba4 here.");
  await page.getByTestId("action-make-mine").click();
  await page.waitForURL(/\/train\/ruy-lopez\/exchange-variation\/white/);
  await phaseIs(page, "opponent", 7);
  await expect(page.locator('[data-kind="hint"]').first()).toContainText("plays 4.Bxc6");
});

test("another theory move at an ordinary node becomes my move (override) and re-derives the course", async ({ page }) => {
  // Berlin line: 4.d3 instead of the course's 4.O-O
  await page.goto(`${RUY}?mode=learn&line=ln_f57po7nbtwmb`);
  await learnUntil(page, 6);
  await page.getByTestId("san-input").fill("d3");
  await page.getByTestId("san-input").press("Enter");
  await phaseIs(page, "wrong");
  await page.getByTestId("action-make-mine").click();
  await page.waitForFunction(() => Number((document.querySelector('[data-testid="trainer"]') as HTMLElement | null)?.dataset.ply ?? -1) === 7);
  await expect(page.locator('[data-kind="hint"]').last()).toContainText("4.d3 is now your move in this course");
  const overrides = await page.evaluate(() => JSON.parse(localStorage.getItem("cot.v2.overrides") ?? "{}"));
  expect(Object.values(overrides["ruy-lopez/closed@white"] ?? {})).toContain("d3");
});

test("hints H1 → H2 → H3 in Recall, from the keyboard", async ({ page }) => {
  await page.goto(`${RUY}?mode=recall&line=ln_c4e43ggaphii`);
  await phaseIs(page, "await", 0);
  await expect(page.locator('[data-kind="turn"] [data-testid="coach-title"]').last()).toHaveText("Your move");
  await page.keyboard.press("h");
  await expect(page.locator('[data-kind="hint"]').last()).toContainText("Hint · idea");
  await page.keyboard.press("h");
  await expect(page.locator("cg-board square.sq-hint")).toHaveCount(1);
  await page.keyboard.press("h");
  await expect(page.locator('.cg-wrap svg line[stroke="#15781B"]').first()).toBeAttached();
  await expect(page.locator('[data-kind="hint"]').last()).toContainText("Play 1.e4.");
});

test("arrows: plan arrows in the Vienna Gambit; a red threat arrow with tinted squares after 4.Ng5 (Two Knights as Black)", async ({ page }) => {
  await page.goto("/train/vienna-game/vienna-gambit/white?mode=learn&line=ln_fhs3xlprw6ma");
  await learnUntil(page, 6); // after 3…d5
  await page.keyboard.press("p");
  await expect(page.locator('[data-kind="hint"]').last()).toContainText("The plan: 4.fxe5, 5.Qf3, 6.d4");
  await expect(page.locator(".cg-wrap svg line[stroke='#2a9d3c']")).toHaveCount(3);

  await page.goto("/train/italian-game/two-knights-defense/black?mode=learn&line=ln_2awuh7cni6gw");
  await learnUntil(page, 7); // after 4.Ng5
  await expect(page.locator('[data-kind="opponent"]').last()).toContainText("White threatens Bxf7+");
  await expect(page.locator(".cg-wrap svg line[stroke='#b3261e']")).toHaveCount(1);
  await expect(page.locator("cg-board square.sq-threat")).toHaveCount(2);
});

test("Re-teach: a wrong move in Review re-posts the position's Learn note", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => {
    const epd = "r1bqkbnr/1ppp1ppp/p1n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R w KQkq -";
    const past = new Date(Date.now() - 2 * 86400_000).toISOString();
    const card = {
      side: "white", epd, answer: "Ba4", due: past, stability: 2, difficulty: 5, elapsed_days: 2, scheduled_days: 2, learning_steps: 0,
      reps: 2, lapses: 0, state: 2, last_review: past, seen: 2, correct: 2, lastCourseId: "ruy-lopez/closed@white", lastLineId: "ln_c4e43ggaphii",
    };
    localStorage.setItem("cot.v2.cards", JSON.stringify({ [`white|${epd}|Ba4`]: card }));
  });
  await page.goto(`${RUY}?mode=review`);
  await phaseIs(page, "await", 6);
  await page.getByTestId("san-input").fill("Kf1");
  await page.getByTestId("san-input").press("Enter");
  await expect(page.locator('[data-kind="mistake"]').last()).toContainText("4.Kf1 ✕");
  const re = page.locator('[data-kind="hint"]').last();
  await expect(re).toContainText("Re-teach");
  await expect(re).toContainText("Remember:");
  await expect(re).not.toContainText("Ba4");
});

test("Drill starts at the chapter trunk and never touches the schedule; /train/review runs the cross-course queue", async ({ page }) => {
  await page.goto(`${RUY}?mode=drill`);
  await page.waitForFunction(() => ["await", "opponent"].includes((document.querySelector('[data-testid="trainer"]') as HTMLElement | null)?.dataset.phase ?? ""), null, { timeout: 30_000 });
  expect(await ply(page)).toBeGreaterThan(4);
  await expect(page.locator('[data-kind="ff"]')).toHaveCount(1);
  expect(await page.evaluate(() => localStorage.getItem("cot.v2.cards"))).toBeNull();

  await page.evaluate(() => {
    const epd = "r1bqkbnr/1ppp1ppp/p1n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R w KQkq -";
    const past = new Date(Date.now() - 86400_000).toISOString();
    const card = {
      side: "white", epd, answer: "Ba4", due: past, stability: 2, difficulty: 5, elapsed_days: 2, scheduled_days: 2, learning_steps: 0,
      reps: 2, lapses: 0, state: 2, last_review: past, seen: 2, correct: 2, lastCourseId: "ruy-lopez/closed@white", lastLineId: "ln_c4e43ggaphii",
    };
    localStorage.setItem("cot.v2.cards", JSON.stringify({ [`white|${epd}|Ba4`]: card }));
  });
  await page.goto("/train/review");
  await phaseIs(page, "await", 6);
  await page.getByTestId("san-input").fill("Ba4");
  await page.getByTestId("san-input").press("Enter");
  await phaseIs(page, "end");
  const card = await page.evaluate(() => Object.values(JSON.parse(localStorage.getItem("cot.v2.cards")!))[0] as { reps: number; due: string });
  expect(card.reps).toBe(3);
  expect(new Date(card.due).getTime()).toBeGreaterThan(Date.now());
});

test("keyboard only: Recall a line without the mouse", async ({ page }) => {
  await page.goto(`${RUY}?mode=recall&line=ln_c4e43ggaphii`);
  await phaseIs(page, "await", 0);
  await page.keyboard.press("?");
  await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  for (const san of ["e4", "Nf3", "Bb5"]) {
    const p = await ply(page);
    await page.keyboard.press("m");
    await page.keyboard.type(san);
    await page.keyboard.press("Enter");
    await page.waitForFunction((p0) => {
      const d = (document.querySelector('[data-testid="trainer"]') as HTMLElement | null)?.dataset;
      return Number(d?.ply) === p0 + 2 && d?.phase === "await";
    }, p);
    await page.keyboard.press("Escape"); // back to the board from the move box
  }
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByTestId("back-to-live")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("back-to-live")).toHaveCount(0);
  await page.keyboard.press("s");
  await expect(page.locator('[data-kind="hint"]').last()).toContainText("Play 4.Ba4.");
  await page.keyboard.press("f");
  await expect(page.locator(".cg-wrap.orientation-black")).toHaveCount(1);
});

test.describe("mobile", () => {
  test.use({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
  test("at 375 px the board fills the width, the coach is a bottom sheet with a 30% peek, buttons are ≥ 44 px", async ({ page }) => {
    await page.goto(`${RUY}?mode=learn`);
    await phaseIs(page, "await", 0);
    const board = (await page.locator(".board-cg").boundingBox())!;
    // the eval bar (on by default) shares the row: together they fill the width
    const bar = await page.getByTestId("eval-bar").boundingBox();
    const row = bar ? board.x + board.width - bar.x : board.width;
    expect(row).toBeGreaterThanOrEqual(375 - 32);
    expect(board.width).toBeGreaterThanOrEqual(375 - 32 - 24);
    const panel = (await page.getByTestId("coach-panel").boundingBox())!;
    expect(panel.y + panel.height).toBeCloseTo(812, 0);
    expect(panel.height / 812).toBeGreaterThan(0.27);
    expect(panel.height / 812).toBeLessThan(0.33);
    const heights = await page
      .locator('[data-testid="coach-panel"] button:visible, [role="toolbar"] button:visible, [role="toolbar"] a:visible')
      .evaluateAll((els) => els.filter((e) => !e.closest('[data-testid="coach-msg"]') || e.closest("[data-testid^='action-']")).map((e) => e.getBoundingClientRect().height));
    for (const h of heights) expect(h).toBeGreaterThanOrEqual(44);
    await page.getByTestId("sheet-handle").click();
    await expect.poll(async () => (await page.getByTestId("coach-panel").boundingBox())!.height / 812).toBeGreaterThan(0.7);
  });
});

test("What if: play on for both sides from any position, the engine's top moves as numbered arrows, take back, back to the line", async ({ page }) => {
  await page.goto(`${RUY}?mode=learn&line=ln_c4e43ggaphii`);
  await learnUntil(page, 6); // after 3…a6, White to play 4.Ba4
  await phaseIs(page, "await", 6);
  const trainer = page.getByTestId("trainer");

  // W starts a What If at the live position: both sides move, nothing grades
  await page.keyboard.press("w");
  await expect(trainer).toHaveAttribute("data-phase", "free");
  await expect(page.locator('[data-kind="whatif"]').last()).toContainText("What if?");
  await page.getByTestId("san-input").fill("Bxc6");
  await page.getByTestId("san-input").press("Enter");
  await drag(page, "d7", "c6"); // Black's reply, dragged as Black
  await expect(page.getByTestId("whatif-chip")).toHaveText(["4.Bxc6", "dxc6"]);
  await expect(page.getByTestId("move-chip")).toHaveCount(6);
  await expect(page.locator('[data-kind="whatif"]').nth(1)).toContainText("Exchange Variation");
  await expect(page.getByTestId("name-crumb")).toContainText("Exchange Variation");
  // the engine's top moves: an engine message with clickable moves, numbered violet arrows on the board
  const engine = page.locator('[data-kind="engine"]');
  await expect(engine.last()).toContainText("Engine: top moves for White", { timeout: 60_000 });
  await expect(engine.last().getByTestId("engine-move")).toHaveCount(3);
  await expect(page.locator(".cg-wrap svg line[stroke='#6b3fc4']")).toHaveCount(3);
  // Learn introduced cards for 1.e4, 2.Nf3 and 3.Bb5; the what-if moves added none
  const cards = await page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem("cot.v2.cards") ?? "{}")));
  expect(cards).toHaveLength(3);
  expect(cards.some((k) => /Bxc6|dxc6/.test(k))).toBe(false);
  // clicking an engine move plays it
  const first = await engine.last().getByTestId("engine-move").first().locator(".font-mono").innerText();
  await engine.last().getByTestId("engine-move").first().click();
  await expect(page.getByTestId("whatif-chip").last()).toHaveText(`5.${first}`);
  // take back, then back to the line: the position and the prompt are exactly as before
  await page.getByTestId("whatif-undo").click();
  await expect(page.getByTestId("whatif-chip")).toHaveCount(2);
  await page.getByTestId("whatif-exit").click();
  await phaseIs(page, "await", 6);
  await expect(page.getByTestId("whatif-chip")).toHaveCount(0);
  await expect(page.locator('[data-kind="whatif"]').last()).toContainText("Back to the line");
  await expect(page.locator('.cg-wrap svg line[stroke="#15781B"]').first()).toBeAttached(); // Learn's play arrow is back

  // a wrong move offers "Play it out"; leaving the What If brings the wrong move back
  await drag(page, "e1", "f1"); // 4.Kf1
  await phaseIs(page, "wrong");
  await page.getByTestId("action-whatif").click();
  await expect(trainer).toHaveAttribute("data-phase", "free");
  await expect(page.getByTestId("whatif-chip")).toHaveText(["4.Kf1"]);
  await expect(page.getByTestId("wrong-chip")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(trainer).toHaveAttribute("data-phase", "wrong");
  await expect(page.getByTestId("wrong-chip")).toHaveText("Kf1");
  await page.getByTestId("action-try").click();
  await phaseIs(page, "await", 6);

  // the end card offers it too
  await learnUntil(page);
  await phaseIs(page, "end");
  await page.getByTestId("end-whatif").click();
  await expect(trainer).toHaveAttribute("data-phase", "free");
  await expect(page.getByTestId("whatif-btn")).toHaveAttribute("aria-pressed", "true");
});

test("What if is never offered at a graded position still waiting for its answer", async ({ page }) => {
  await page.goto(`${RUY}?mode=recall&line=ln_c4e43ggaphii`);
  await phaseIs(page, "await", 0);
  await expect(page.getByTestId("whatif-btn")).toBeDisabled();
  await page.keyboard.press("w");
  await expect(page.getByTestId("trainer")).toHaveAttribute("data-phase", "await");
  // scrubbed back to a position already answered, it is
  await page.getByTestId("san-input").fill("e4");
  await page.getByTestId("san-input").press("Enter");
  await phaseIs(page, "await", 2);
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByTestId("whatif-btn")).toBeEnabled();
  await page.keyboard.press("w");
  await expect(page.getByTestId("trainer")).toHaveAttribute("data-phase", "free");
  await expect(page.getByTestId("trainer")).toHaveAttribute("data-ply", "1");
  await expect(page.getByTestId("back-to-live")).toHaveCount(0);
});
