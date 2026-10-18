/** ADR 0004 server grading (route logic) against an in-memory Db built from the real v2 seed edges. */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDatasetV2 } from "@/lib/openings";
import type { RawDatasetV2 } from "@/lib/openings-build/dataset";
import { findSystem, loadCourse } from "@/lib/courses-client";
import { cardKey, State, type CardState } from "@/lib/srs/fsrs";
import { START_EPD } from "@/lib/openings-build/replay";
import { seedEdges } from "../seed-v2";
import { answer, defer, issue, progress, remap, RATE_LIMIT_PER_MIN, type ChallengeRow, type CommitArgs, type TrainDb } from "../train";

const ds = parseDatasetV2(JSON.parse(readFileSync(join(__dirname, "../../../../public/data/openings.v2.json"), "utf8")) as RawDatasetV2, "t");
const edges = seedEdges(ds);
const byFrom = new Map<string, typeof edges>();
for (const e of edges) byFrom.set(e.from_epd, [...(byFrom.get(e.from_epd) ?? []), e]);
const NOW = new Date("2026-10-18T12:00:00Z");
const U = "11111111-1111-4111-8111-111111111111";

function fakeDb() {
  const challenges = new Map<string, ChallengeRow>();
  const cards = new Map<string, CardState>();
  const commits: CommitArgs[] = [];
  let seq = 0;
  const db: TrainDb = {
    async walk(sans) {
      const out = [];
      let epd = START_EPD;
      for (let i = 0; i < sans.length; i++) {
        const e = byFrom.get(epd)?.find((x) => x.san === sans[i]);
        if (!e) break;
        out.push({ ply: i + 1, from_epd: epd, san: e.san, to_epd: e.to_epd, is_ext: e.is_ext });
        epd = e.to_epd;
      }
      return out;
    },
    async edgesFrom(epd) {
      return (byFrom.get(epd) ?? []).map((e) => ({ san: e.san, games: e.games, is_ext: e.is_ext }));
    },
    async challengesSince(userId, since) {
      return [...challenges.values()].filter((c) => c.user_id === userId && new Date(c.issued_at) >= since).length;
    },
    async insertChallenge(c) {
      const id = `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
      challenges.set(id, { ...c, id, answered: false, issued_at: NOW.toISOString() });
      return id;
    },
    async getChallenge(userId, id) {
      const c = challenges.get(id);
      return c && c.user_id === userId ? c : null;
    },
    async getCard(_u, side, epd, answer) {
      return cards.get(cardKey(side, epd, answer)) ?? null;
    },
    async commit(a) {
      const c = challenges.get(a.challengeId)!;
      if (c.answered) return null;
      c.answered = true;
      commits.push(a);
      cards.set(cardKey(a.card.side, a.card.epd, a.card.answer), a.card);
      return { rating: 800 + (a.correct ? 10 : -10), rating_delta: a.correct ? 10 : -10 };
    },
    async defer(_u, c) {
      return c.length;
    },
    async remap(_u, m) {
      return m.length;
    },
    async upsertProgress() {},
  };
  return { db, challenges, cards, commits };
}

const ruy = loadCourse(ds, findSystem(ds, "ruy-lopez", "closed", "white")!)!;
const line = ruy.lines[0];
// White's 3rd move in the course: Bb5
const at = 4;
const ok = { courseId: ruy.id, lineId: line.id, sans: line.sans.slice(0, at), expected: line.sans[at] };

describe("issue: validates the line against stored edges", () => {
  it("a real course position → a challenge for the side to move", async () => {
    const { db, challenges } = fakeDb();
    const r = await issue(db, U, ok, NOW);
    expect(r.status).toBe(200);
    const c = challenges.get(r.body.challengeId as string)!;
    expect(c).toMatchObject({ side: "white", expected: line.sans[at].replace(/[+#]$/, ""), ext: false, cap_epd: null });
  });
  it("rejects a line that leaves the tree, a wrong side, a non-edge book move, bad input", async () => {
    const { db } = fakeDb();
    // 1.e4 e5 2.h3 is legal but not stored (2.Ke2, the Bongcloud, is named theory)
    expect((await issue(db, U, { ...ok, sans: ["e4", "e5", "h3", "Nc6"] }, NOW)).body.message).toMatch(/ply 3 is not in the stored tree/);
    expect((await issue(db, U, { ...ok, courseId: "ruy-lopez/closed@black" }, NOW)).body.message).toMatch(/course/);
    expect((await issue(db, U, { ...ok, expected: "h4" }, NOW)).body.message).toMatch(/expected/);
    expect((await issue(db, U, { ...ok, courseId: "x'; drop table--" }, NOW)).status).toBe(400);
    expect((await issue(db, U, { ...ok, sans: "e4 e5" }, NOW)).status).toBe(400);
  });
  it("rate limit: 60 per minute", async () => {
    const { db } = fakeDb();
    for (let i = 0; i < RATE_LIMIT_PER_MIN; i++) expect((await issue(db, U, ok, NOW)).status).toBe(200);
    expect((await issue(db, U, ok, NOW)).status).toBe(429);
  });
  it("extension challenges carry the cap position (last named theory on the line)", async () => {
    const { db, challenges } = fakeDb();
    // breadth-first over named theory; then an extension edge from a position it reaches
    const prev = new Map<string, { from: string; san: string }>();
    const q = [START_EPD];
    while (q.length) {
      const e = q.shift()!;
      for (const x of byFrom.get(e) ?? []) {
        if (x.is_ext || prev.has(x.to_epd) || x.to_epd === START_EPD) continue;
        prev.set(x.to_epd, { from: e, san: x.san });
        q.push(x.to_epd);
      }
    }
    const ext = edges.find((e) => e.is_ext && prev.has(e.from_epd))!;
    expect(ext).toBeTruthy();
    const sans: string[] = [];
    for (let e = ext.from_epd; e !== START_EPD; e = prev.get(e)!.from) sans.unshift(prev.get(e)!.san);
    const side = ext.from_epd.split(" ")[1] === "w" ? "white" : "black";
    const r = await issue(db, U, { courseId: `x/y@${side}`, sans, expected: ext.san }, NOW);
    expect(r.status).toBe(200);
    const c = challenges.get(r.body.challengeId as string)!;
    expect(c.ext).toBe(true);
    expect(c.cap_ply).toBe(sans.length);
    expect(c.cap_epd).toBe(ext.from_epd);
  });
});

describe("answer: the grade map (ADR 0003) is computed server-side", () => {
  async function play(body: Record<string, unknown>, dbx = fakeDb()) {
    const r = await issue(dbx.db, U, ok, NOW);
    return { ...dbx, res: await answer(dbx.db, U, { challengeId: r.body.challengeId, ...body }, new Date(NOW.getTime() + 5000)) };
  }
  it("book move, no hint → Good; the card is stored with FSRS state and the course", async () => {
    const { res, cards } = await play({ san: line.sans[at], wrongAttempts: 0, hintLevel: 0, ms: 4000 });
    expect(res.body.grade).toBe("good");
    const c = [...cards.values()][0];
    expect(c).toMatchObject({ answer: line.sans[at].replace(/[+#]$/, ""), side: "white", reps: 1, lastCourseId: ruy.id, lastLineId: line.id });
  });
  it("H1/H2 → Hard; H3 → Again; a real mistake → Again; a wrong final move → Again", async () => {
    expect((await play({ san: line.sans[at], hintLevel: 2, ms: 4000 })).res.body.grade).toBe("hard");
    expect((await play({ san: "", hintLevel: 3, ms: 4000 })).res.body.grade).toBe("again");
    expect((await play({ san: line.sans[at], wrongAttempts: 1, ms: 4000 })).res.body.grade).toBe("again");
    const wrong = await play({ san: "Bc4", ms: 4000 });
    expect(wrong.res.body.grade).toBe("again");
    expect(wrong.commits[0].correct).toBe(false);
  });
  it("Easy only when < 2.5 s and the card has ≥ 2 reps", async () => {
    const d = fakeDb();
    expect((await play({ san: line.sans[at], ms: 1000 }, d)).res.body.grade).toBe("good"); // reps 0
    expect((await play({ san: line.sans[at], ms: 1000 }, d)).res.body.grade).toBe("good"); // reps 1
    expect((await play({ san: line.sans[at], ms: 1000 }, d)).res.body.grade).toBe("easy"); // reps 2
  });
  it("single use; unknown; another user's challenge; expired", async () => {
    const d = fakeDb();
    const r = await issue(d.db, U, ok, NOW);
    const body = { challengeId: r.body.challengeId, san: line.sans[at], ms: 3000 };
    expect((await answer(d.db, U, body, NOW)).status).toBe(200);
    expect((await answer(d.db, U, body, NOW)).status).toBe(409);
    expect((await answer(d.db, "22222222-2222-4222-8222-222222222222", body, NOW)).status).toBe(404);
    const r2 = await issue(d.db, U, ok, NOW);
    expect((await answer(d.db, U, { ...body, challengeId: r2.body.challengeId }, new Date(NOW.getTime() + 6 * 60_000))).status).toBe(410);
  });
  it("lapse: a reviewed card answered wrong relearns", async () => {
    const d = fakeDb();
    await play({ san: line.sans[at], ms: 4000 }, d);
    const { res } = await play({ san: "Bc4", ms: 4000 }, d);
    expect((res.body.card as CardState).lapses).toBe(0); // still learning: no lapse counted yet
    expect((res.body.card as CardState).state).not.toBe(State.Review);
  });
});

describe("course ids with ~ and book moves that give check", () => {
  // a course whose id has "~" and a learner ply whose book move gives check
  const pick = (() => {
    for (const h of ds.raw!.catalog!.hubs) {
      for (const side of ["white", "black"] as const) {
        for (const i of h.systems[side]) {
          const sys = ds.raw!.catalog!.systems[i];
          if (!sys.slug.includes("~")) continue;
          const course = loadCourse(ds, findSystem(ds, h.slug, sys.slug, side)!)!;
          for (const l of course.lines) {
            for (let p = side === "white" ? 0 : 1; p < l.sans.length; p += 2) if (/[+#]$/.test(l.sans[p])) return { course, line: l, p };
          }
        }
      }
    }
    return null;
  })();
  it("issue + answer work, and the card is keyed by the SAN without +/#", async () => {
    expect(pick).not.toBeNull();
    const { course, line: l, p } = pick!;
    expect(course.id).toContain("~");
    const d = fakeDb();
    const r = await issue(d.db, U, { courseId: course.id, lineId: l.id, sans: l.sans.slice(0, p), expected: l.sans[p] }, NOW);
    expect(r.status).toBe(200);
    const res = await answer(d.db, U, { challengeId: r.body.challengeId, san: l.sans[p], ms: 4000 }, NOW);
    const card = res.body.card as CardState;
    expect(card.answer).toBe(l.sans[p].replace(/[+#]$/, ""));
    // the second review finds the same card (reps build up)
    const r2 = await issue(d.db, U, { courseId: course.id, lineId: l.id, sans: l.sans.slice(0, p), expected: l.sans[p] }, NOW);
    const res2 = await answer(d.db, U, { challengeId: r2.body.challengeId, san: l.sans[p], ms: 4000 }, NOW);
    expect((res2.body.card as CardState).reps).toBe(2);
    expect(d.cards.size).toBe(1);
  });
});

describe("defer / remap / progress validation", () => {
  it("rejects malformed bodies, passes valid ones", async () => {
    const { db } = fakeDb();
    expect((await defer(db, U, { cards: [{ side: "white", epd: "x", answer: "e4", due: "nope" }] })).status).toBe(400);
    expect((await defer(db, U, { cards: [{ side: "white", epd: START_EPD, answer: "e4", due: NOW.toISOString() }] })).body.deferred).toBe(1);
    expect((await remap(db, U, { moves: [{ epd: START_EPD, answer: "e4+" }] })).body.remapped).toBe(1);
    expect((await remap(db, U, { moves: [{ epd: START_EPD, answer: "e4; --" }] })).status).toBe(400);
    expect((await progress(db, U, { courseId: ruy.id, mastery: 1.5 })).status).toBe(400);
    expect((await progress(db, U, { courseId: ruy.id, mastery: 0.4, lastLineId: line.id })).status).toBe(200);
  });
});
