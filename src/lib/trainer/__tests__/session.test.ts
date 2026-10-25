/**
 * Trainer engine (§3.2 D, Phase 3) on the shipped dataset: the same course
 * the browser derives, driven move by move.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { modelFromRaw } from "@/lib/openings-build/model";
import { hubFromSeed } from "@/lib/openings-build/hubs";
import { deriveCourse, type Course } from "@/lib/openings-build/courses";
import { decodeAnnotations } from "@/lib/openings-build/annotations";
import type { RawDatasetV2 } from "@/lib/openings-build/dataset";
import { Chess } from "chess.js";
import { chapterTrunk, learnStartPly, TrainerSession, type Mode, type SessionCtx } from "../session";
import { drillPick, sameLine } from "../plan";

const raw = JSON.parse(readFileSync(join(__dirname, "../../../../public/data/openings.v2.json"), "utf8")) as RawDatasetV2;
const model = modelFromRaw(raw);
const cat = raw.catalog!;
const annotations = decodeAnnotations(raw.annotations);

function course(hubSlug: string, side: "white" | "black", systemSlug?: string): Course {
  const sum = cat.hubs.find((h) => h.slug === hubSlug)!;
  const hub = hubFromSeed(
    model,
    {
      slug: sum.slug,
      title: sum.title,
      kind: sum.kind,
      parent: sum.parent,
      def: sum.kind === "curated" ? { slug: sum.slug, title: sum.title, match: [], ...(sum.defSide ? { side: sum.defSide } : {}), ...(sum.signature ? { signature: sum.signature } : {}) } : null,
      rows: sum.rowIdx,
      primaryName: sum.primaryName,
    },
    sum.siblings
  );
  const s = sum.systems[side].map((i) => cat.systems[i]).find((x) => (systemSlug ? x.slug === systemSlug : x.recommended))!;
  return deriveCourse(model, hub, {
    hub: hubSlug,
    side: s.side,
    slug: s.slug,
    name: s.name,
    choices: s.choices,
    defining: s.defining,
    signatureNode: s.signatureNode,
    parent: s.parent >= 0 ? cat.systems[s.parent].slug : null,
  });
}

const ruy = course("ruy-lopez", "white", "closed");
const lineWith = (c: Course, prefix: string) => c.lines.find((l) => l.sans.join(" ").startsWith(prefix))!;

function session(c: Course, lineIdx: number, mode: Mode, extra: Partial<SessionCtx> = {}) {
  let t = 0;
  const s = new TrainerSession({ model, course: c, line: c.lines[lineIdx], mode, annotations, startPly: 0, now: () => t, ...extra });
  return { s, tick: (ms: number) => (t += ms) };
}

/** Play the line to the end with book moves (opponent replies included). */
function playThrough(s: TrainerSession, tick: (ms: number) => void) {
  while (s.phase !== "end") {
    if (s.phase === "ff") s.skipFF();
    else if (s.phase === "opponent") s.opponentMove();
    else if (s.phase === "await") {
      tick(4000);
      expect(s.play(s.bookSan())).toBe("correct");
    } else throw new Error(`stuck in ${s.phase}`);
  }
}

describe("Learn", () => {
  it("first line from move 1: every learner move gets an imperative with an arrow, every move a feed message", () => {
    const { s, tick } = session(ruy, 0, "learn");
    playThrough(s, tick);
    const turns = s.feed.filter((m) => m.kind === "turn");
    const learner = s.learnerPlies(0, s.endPly);
    expect(turns.map((m) => m.ply)).toEqual(learner);
    for (const m of turns) {
      expect(m.title).toMatch(/^Play \d+\./);
      expect(m.arrows?.some((a) => a.kind === "play")).toBe(true);
    }
    expect(turns[0].title).toBe("Play 1.e4.");
    expect(turns[1].title).toBe("Play 2.Nf3.");
    expect(turns[2].title).toBe("Play 3.Bb5.");
    // one ✓ per learner move, one opponent message per reply
    expect(s.feed.filter((m) => m.kind === "ok")).toHaveLength(learner.length);
    expect(s.feed.filter((m) => m.kind === "opponent")).toHaveLength(s.endPly - learner.length);
    expect(s.feed.at(-1)!.kind).toBe("complete");
    expect(s.drainEvents().filter((e) => e.type === "introduce")).toHaveLength(learner.length);
  });

  it("later lines fast-forward the known approach", () => {
    const known = new Set(["rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -|e4"]);
    const line = ruy.lines[1];
    const knownFn = (epd: string, a: string) => known.has(`${epd}|${a}`) || line.sans.slice(0, 5).includes(a);
    const start = learnStartPly(line, "white", model, knownFn);
    // it stops on the opponent reply before the first unknown move, so that reply is shown
    expect(start).toBeGreaterThanOrEqual(5);
    expect(start % 2).toBe(1);
    const { s } = session(ruy, 1, "learn", { startPly: start });
    expect(s.phase).toBe("ff");
    expect(s.feed.some((m) => m.kind === "ff" && /Replaying the known moves 1\.e4 e5/.test(m.text))).toBe(true);
    while (s.ffStep());
    expect(s.ply).toBe(start);
    expect(s.phase).toBe("opponent");
  });

  it("a branch card appears at the first opponent branch, with alternatives", () => {
    const { s, tick } = session(ruy, 0, "learn");
    const firstBranch = ruy.lines[0].branchPlies.find((p) => p % 2 === 1)!;
    playThrough(s, tick);
    const card = s.feed.find((m) => m.kind === "branch")!;
    expect(card.ply).toBe(firstBranch);
    expect(card.options!.length).toBeGreaterThanOrEqual(2);
    expect(card.arrows!.every((a) => a.kind === "alt")).toBe(true);
    expect(card.text).toMatch(/We'll take/);
  });

  it("4.Bxc6 in a 4.Ba4 course is a theory soft-fail with Make it my move (a system choice: switches course)", () => {
    const li = lineWith(ruy, "e4 e5 Nf3 Nc6 Bb5 a6 Ba4").idx;
    const { s } = session(ruy, li, "learn", { switchSystem: (_n, norm) => (norm === "Bxc6" ? "Exchange Variation" : null) });
    while (s.ply < 6) {
      if (s.phase === "opponent") s.opponentMove();
      else s.play(s.bookSan());
    }
    expect(s.play("Bxc6")).toBe("soft");
    const m = s.feed.at(-1)!;
    expect(m.kind).toBe("mistake");
    expect(m.title).toMatch(/Exchange Variation \(4\.Bxc6\), also theory/);
    expect(m.actions).toEqual(["try", "make-mine", "explore", "whatif"]);
    expect(s.attempts).toBe(0); // soft-fails are not lapses
    expect(s.wrong?.soft).toBe(true);
    s.tryAgain();
    expect(s.play("Ba4")).toBe("correct");
  });

  it("another theory move at an ordinary course node can be made my move (override)", () => {
    const [node, alts] = [...ruy.alternatives].find(([n, a]) => a.length && !ruy.systemNodes.has(n))!;
    const line = ruy.lines.find((l) => l.nodes.indexOf(node) >= ruy.sigmaPly)!;
    const ply = line.nodes.indexOf(node);
    const { s } = session(ruy, line.idx, "learn", { startPly: ply });
    s.skipFF();
    expect(s.ply).toBe(ply);
    const alt = model.nodes[node].theoryByNorm.get(alts[0])!;
    expect(s.play(alt.san)).toBe("soft");
    expect(s.feed.at(-1)!.actions).toContain("make-mine");
  });
});

/** A legal move at the session's ply that is neither theory nor in the master stats. */
function junk(s: TrainerSession, skip: string[] = []): string {
  const nd = model.nodes[s.ctx.line.nodes[s.ply]];
  const c = new Chess(s.fenAt(s.ply));
  const mv = c.moves().find((m) => !skip.includes(m) && !nd.moves.some((x) => x.norm === m.replace(/[+#]$/, "")));
  if (!mv) throw new Error("no junk move");
  return mv;
}

describe("hints and grading (Recall)", () => {
  const BA4 = lineWith(ruy, "e4 e5 Nf3 Nc6 Bb5 a6 Ba4").idx;
  const graded = (setup: (s: TrainerSession, tick: (ms: number) => void) => void) => {
    const { s, tick } = session(ruy, BA4, "recall", { startPly: 6 });
    s.skipFF();
    expect(s.phase).toBe("await");
    setup(s, tick);
    expect(s.play(s.bookSan())).toBe("correct");
    return s.drainEvents()[0].grade;
  };
  it("no hint → Good, H1 → Hard, H2 → Hard, H3 → Again, a wrong move → Again", () => {
    expect(graded((_, tick) => tick(4000))).toBe("good");
    expect(graded((s) => s.hintStep())).toBe("hard");
    expect(graded((s) => (s.hintStep(), s.hintStep()))).toBe("hard");
    expect(graded((s) => (s.hintStep(), s.hintStep(), s.hintStep()))).toBe("again");
    expect(
      graded((s) => {
        expect(s.play(junk(s))).toBe("wrong");
        s.tryAgain();
      })
    ).toBe("again");
  });
  it("a lapse is scheduled at once and never overwritten by the later correct move", () => {
    const { s } = session(ruy, BA4, "recall", { startPly: 6 });
    s.skipFF();
    s.play(junk(s));
    expect(s.drainEvents()).toMatchObject([{ type: "grade", ply: 6, grade: "again" }]);
    s.tryAgain();
    expect(s.play("Ba4")).toBe("correct");
    expect(s.drainEvents()).toEqual([]);
    expect(s.gradedDone.has(6)).toBe(true);
  });
  it("H1 → H2 → H3 apply in order: idea text, piece square, then the arrow", () => {
    const { s } = session(ruy, 0, "recall");
    s.hintStep();
    expect(s.feed.at(-1)!.title).toBe("Hint · idea");
    expect(s.feed.at(-1)!.text).not.toMatch(/e4/);
    s.hintStep();
    expect(s.tints).toEqual({ e2: "hint" });
    s.hintStep();
    expect(s.arrows).toEqual([{ from: "e2", to: "e4", kind: "play" }]);
  });
  it("Recall shows no imperative and no arrows", () => {
    const { s } = session(ruy, 0, "recall");
    const turn = s.feed.find((m) => m.kind === "turn")!;
    expect(turn.title).toBe("Your move");
    expect(turn.arrows).toBeUndefined();
    expect(s.arrows).toEqual([]);
  });
  it("escalation: the 2nd wrong attempt applies H2, the 3rd H3", () => {
    const { s } = session(ruy, BA4, "recall", { startPly: 6 });
    s.skipFF();
    const tried: string[] = [];
    const wrongOnce = () => {
      const m = junk(s, tried);
      tried.push(m);
      expect(s.play(m)).toBe("wrong");
      s.tryAgain();
    };
    wrongOnce();
    expect(s.hint).toBe(0);
    wrongOnce();
    expect(s.hint).toBe(2);
    wrongOnce();
    expect(s.hint).toBe(3);
    expect(s.arrows[0]).toMatchObject({ kind: "play", from: "b5", to: "a4" });
  });
});

describe("mistakes", () => {
  it("a master move outside theory quotes the real numbers", () => {
    // the first learner position on a Ruy line with a master move that isn't named theory
    let found: { line: number; ply: number; san: string; games: number } | null = null;
    for (const l of ruy.lines) {
      for (let p = 0; p < l.sans.length && !found; p += 2) {
        const off = model.nodes[l.nodes[p]].moves.find((m) => !m.theory && m.games > 0);
        if (off) found = { line: l.idx, ply: p, san: off.san, games: off.games };
      }
      if (found) break;
    }
    expect(found).not.toBeNull();
    const { s } = session(ruy, found!.line, "review", { startPly: found!.ply });
    s.skipFF();
    expect(s.play(found!.san)).toBe("wrong");
    const verdict = s.feed.filter((m) => m.kind === "mistake").at(-1)!;
    expect(verdict.text).toMatch(new RegExp(`^Played in ${found!.games} master game`));
    expect(verdict.text).toMatch(/This course plays /);
  });
  const deep = () => {
    const r = session(ruy, lineWith(ruy, "e4 e5 Nf3 Nc6 Bb5 a6 Ba4").idx, "review", { startPly: 6 });
    r.s.skipFF();
    return r.s;
  };
  it("anything else: 'Not in this course's book.' (no invented reasons) and Re-teach in Review", () => {
    const s = deep();
    expect(s.play(junk(s))).toBe("wrong");
    const m = s.feed.at(-2)!;
    expect(m.kind).toBe("mistake");
    expect(m.text).toBe("Not in this course's book.");
    expect(m.actions).toEqual(["try", "show", "whatif"]);
    const re = s.feed.at(-1)!;
    expect(re.title).toBe("Re-teach");
    expect(re.text).toMatch(/^Remember: /);
    expect(re.text).not.toMatch(/Ba4|a4/);
  });
  it("the wrong move stays on the board with both squares tinted until Try again", () => {
    const s = deep();
    const m = new Chess(s.fenAt(s.ply)).move(junk(s));
    s.play(m.san);
    expect(s.phase).toBe("wrong");
    expect(s.wrong).toMatchObject({ from: m.from, to: m.to, soft: false });
    expect(s.tints).toEqual({ [m.from]: "wrong", [m.to]: "wrong" });
    s.tryAgain();
    expect(s.phase).toBe("await");
    expect(s.wrong).toBeNull();
  });
  it("another enrolled course's move is a soft-fail that names it", () => {
    const probe = deep();
    const mv = junk(probe);
    const r = session(ruy, probe.ctx.line.idx, "review", {
      startPly: 6,
      enrolledMove: (_epd, norm) => (norm === mv.replace(/[+#]$/, "") ? { courseName: "Scotch Game", san: mv } : null),
    });
    r.s.skipFF();
    expect(r.s.play(mv)).toBe("soft");
    expect(r.s.feed.at(-1)!.title).toBe("That's your Scotch Game move.");
  });
});

describe("arrows", () => {
  it("Two Knights as Black: after 4.Ng5 the threat arrow c4–f7 and tints on f7 and e8", () => {
    const tk = course("italian-game", "black", "two-knights-defense");
    const li = lineWith(tk, "e4 e5 Nf3 Nc6 Bc4 Nf6 Ng5").idx;
    const { s } = session(tk, li, "learn");
    while (s.ply < 7) {
      if (s.phase === "opponent") s.opponentMove();
      else s.play(s.bookSan());
    }
    const op = s.feed.filter((m) => m.kind === "opponent").at(-1)!;
    expect(op.title).toMatch(/4\.Ng5/);
    expect(op.text).toMatch(/White threatens Bxf7\+/);
    expect(op.arrows).toContainEqual({ from: "c4", to: "f7", kind: "threat" });
    expect(op.tints).toEqual({ f7: "threat", e8: "threat" });
    expect(s.arrows).toContainEqual({ from: "c4", to: "f7", kind: "threat" });
  });
  it("plan arrows show the next learner moves, numbered", () => {
    const vg = course("vienna-game", "white", "vienna-gambit");
    const { s } = session(vg, 0, "learn");
    s.showPlan();
    const plan = s.feed.at(-1)!;
    expect(plan.text).toMatch(/^The plan: 1\.e4, 2\.Nc3, 3\.f4$/);
    expect(plan.arrows!.map((a) => a.label)).toEqual(["1", "2", "3"]);
  });
});

describe("Drill", () => {
  it("under a position: only lines continuing past it, started there; a leaf has no subtree", () => {
    const line = ruy.lines[0];
    const under = line.nodes[6];
    for (let k = 0; k < 20; k++) {
      const pick = drillPick(ruy, null, null, Math.random, under)!;
      expect(ruy.lines[pick.line].nodes[pick.startPly]).toBe(under);
      expect(pick.startPly).toBeLessThan(ruy.lines[pick.line].sans.length);
    }
    const leaf = line.nodes[line.nodes.length - 1];
    const alsoInner = ruy.lines.some((l) => l.nodes.indexOf(leaf) >= 0 && l.nodes.indexOf(leaf) < l.sans.length);
    if (!alsoInner) expect(drillPick(ruy, null, null, Math.random, leaf)).toBeNull();
  });
  it("an index from the override-free course maps to the same line in the learner's course", () => {
    const [node, alts] = [...ruy.alternatives].find(([n, a]) => a.length && !ruy.systemNodes.has(n))!;
    const sum = cat.hubs.find((h) => h.slug === "ruy-lopez")!;
    const s = sum.systems.white.map((i) => cat.systems[i]).find((x) => x.slug === "closed")!;
    const hub = hubFromSeed(model, { slug: sum.slug, title: sum.title, kind: sum.kind, parent: sum.parent, def: { slug: sum.slug, title: sum.title, match: [], ...(sum.defSide ? { side: sum.defSide } : {}), ...(sum.signature ? { signature: sum.signature } : {}) }, rows: sum.rowIdx, primaryName: sum.primaryName }, sum.siblings);
    const withOverride = deriveCourse(model, hub, { hub: "ruy-lopez", side: "white", slug: s.slug, name: s.name, choices: s.choices, defining: s.defining, signatureNode: s.signatureNode, parent: null }, { overrides: new Map([[node, alts[0]]]) });
    const untouched = ruy.lines.find((l) => !l.nodes.includes(node))!;
    expect(sameLine(withOverride, untouched)!.sans).toEqual(untouched.sans);
    const changed = ruy.lines.find((l) => l.nodes.includes(node))!;
    const p = changed.nodes.indexOf(node);
    expect(sameLine(withOverride, changed)!.sans.slice(0, p)).toEqual(changed.sans.slice(0, p));
  });
  it("starts where the line leaves its chapter trunk, and never grades", () => {
    const line = ruy.lines.find((l) => ruy.chapters[l.chapter].lines.length > 2)!;
    const start = chapterTrunk(ruy, line);
    expect(start).toBeGreaterThan(ruy.sigmaPly - 1);
    const { s, tick } = session(ruy, line.idx, "drill", { startPly: start });
    playThrough(s, tick);
    expect(s.drainEvents()).toEqual([]);
  });
});

describe("What if", () => {
  const BA4 = lineWith(ruy, "e4 e5 Nf3 Nc6 Bb5 a6 Ba4").idx;
  /** The 4.Ba4 line at the learner's 4th move (after 3…a6). */
  const atMove4 = (mode: Mode) => {
    const r = session(ruy, BA4, mode, { startPly: 6 });
    r.s.skipFF();
    return r.s;
  };

  it("plays on for both sides from the live position; the board's timeline extends the line; exit restores it", () => {
    const s = atMove4("learn");
    expect(s.phase).toBe("await");
    expect(s.playFree("Bxc6")).toBe("ignored");
    expect(s.canWhatIf()).toBe(true);
    expect(s.startWhatIf()).toBe(true);
    expect(s.phase).toBe("free");
    expect(s.feed.at(-1)).toMatchObject({ kind: "whatif", title: "What if?", free: true, ply: 6 });
    expect(s.arrows).toEqual([]);
    expect(s.playFree("Bxc6")).toBe("ok");
    expect(s.playFree("Ra5")).toBe("illegal"); // the a6 pawn blocks the rook
    expect(s.playFree("dxc6")).toBe("ok");
    expect(s.boardPly).toBe(8);
    expect(s.ply).toBe(6); // the line itself didn't move
    expect([5, 6, 7].map((p) => s.boardSan(p))).toEqual(["a6", "Bxc6", "dxc6"]);
    expect(s.boardMove(6)).toMatchObject({ from: "b5", to: "c6" });
    expect(s.boardFen(6)).toBe(s.fens[6]);
    expect(s.boardFen(8)).toBe(s.freeFen());
    expect(new Chess(s.freeFen()).turn()).toBe("w");
    const msgs = s.feed.filter((m) => m.kind === "whatif");
    expect(msgs.at(-2)).toMatchObject({ who: "you", title: "4.Bxc6", ply: 7, free: true });
    expect(msgs.at(-1)).toMatchObject({ who: "black", title: "4…dxc6", ply: 8, free: true });
    // 4.Bxc6 is a master move into named theory: the message says so
    expect(msgs.at(-2)!.text).toMatch(/of master games from here/);
    expect(msgs.at(-2)!.text).toMatch(/Exchange Variation/);
    expect(s.nameAtBoard(7).row?.name).toMatch(/Exchange Variation/);
    expect(s.nameAtBoard(8).row?.name).toMatch(/Exchange Variation/); // 4…dxc6 itself is unnamed: the deepest name reached stays
    expect(s.nameAtBoard(6).row?.name).toMatch(/Morphy Defense/);
    expect(s.undoFree()).toBe(true);
    expect(s.boardPly).toBe(7);
    expect(s.drainEvents()).toEqual([]); // nothing grades or introduces
    s.exitWhatIf();
    expect(s.phase).toBe("await");
    expect(s.free).toBeNull();
    expect(s.boardPly).toBe(6);
    expect(s.boardSan(5)).toBe("a6");
    expect(s.arrows.some((a) => a.kind === "play")).toBe(true); // Learn's play arrow is back
    expect(s.feed.at(-1)).toMatchObject({ kind: "whatif", title: "Back to the line" });
    expect(s.play("Ba4")).toBe("correct");
  });

  it("from a wrong move: plays it out, and exit brings the wrong move back exactly", () => {
    const s = atMove4("learn");
    expect(s.play("Bxc6")).toBe("soft");
    const m = s.feed.at(-1)!;
    expect(m.actions).toContain("whatif");
    expect(s.startWhatIf(m.ply, m.wrong!.san)).toBe(true);
    expect(s.boardPly).toBe(7);
    expect(s.boardSan(6)).toBe("Bxc6");
    expect(s.wrong).toBeNull();
    expect(s.tints).toEqual({});
    s.exitWhatIf();
    expect(s.phase).toBe("wrong");
    expect(s.wrong?.san).toBe("Bxc6");
    expect(s.tints).toEqual({ b5: "wrong", c6: "wrong" });
    s.tryAgain();
    expect(s.play("Ba4")).toBe("correct");
  });

  it("never from a graded position still waiting for its answer; fine after its lapse, from earlier plies, and at the end", () => {
    const s = atMove4("review");
    expect(s.canWhatIf()).toBe(false);
    expect(s.startWhatIf()).toBe(false);
    expect(s.phase).toBe("await");
    expect(s.canWhatIf(4)).toBe(true);
    expect(s.canWhatIf(7)).toBe(false); // not a position on the board yet
    expect(s.play(junk(s))).toBe("wrong");
    expect(s.canWhatIf()).toBe(true); // the lapse is recorded
    s.tryAgain();
    expect(s.canWhatIf()).toBe(true);

    const { s: done, tick } = session(ruy, BA4, "recall");
    playThrough(done, tick);
    expect(done.phase).toBe("end");
    expect(done.canWhatIf()).toBe(true);
    expect(done.startWhatIf()).toBe(true);
    expect(done.boardPly).toBe(done.ply);
    done.exitWhatIf();
    expect(done.phase).toBe("end");

    const { s: replay } = session(ruy, BA4, "learn", { startPly: 6 });
    expect(replay.phase).toBe("ff");
    expect(replay.canWhatIf()).toBe(false);
  });

  it("from an earlier position (the board scrubbed back): the timeline forks there and names what it reaches", () => {
    const s = atMove4("learn");
    expect(s.startWhatIf(4)).toBe(true); // after 2…Nc6: White's 3rd move again
    expect(s.boardPly).toBe(4);
    expect(s.playFree("Bc4")).toBe("ok");
    expect([3, 4].map((p) => s.boardSan(p))).toEqual(["Nc6", "Bc4"]);
    expect(s.nodeAtBoard(5)).not.toBeNull();
    expect(s.nameAtBoard(5).row?.name).toMatch(/Italian/);
    expect(s.feed.at(-1)!.text).toMatch(/Italian/);
    expect(s.linePlyOf(5)).toBe(4);
    s.exitWhatIf();
    expect(s.boardPly).toBe(6);
    expect(s.boardSan(4)).toBe("Bb5");
    expect(s.nameAtBoard(6).row?.name).toMatch(/Ruy Lopez/);
  });

  it("engine suggestions: numbered arrows and a message for the position on the board; stale results are dropped", () => {
    const s = atMove4("learn");
    s.startWhatIf();
    s.playFree("Bxc6");
    const seq = s.free!.seq;
    const moves = [
      { san: "dxc6", from: "d7", to: "c6", score: "+0.3" },
      { san: "bxc6", from: "b7", to: "c6", score: "+0.5" },
      { san: "Nf6", from: "g8", to: "f6", score: "+1.0" },
      { san: "Qh4", from: "d8", to: "h4", score: "+9.0" },
    ];
    expect(s.engineSuggest(seq - 1, moves, 12)).toBe(false);
    expect(s.engineSuggest(seq, moves, 12)).toBe(true);
    expect(s.arrows).toEqual([
      { from: "d7", to: "c6", kind: "engine", label: "1" },
      { from: "b7", to: "c6", kind: "engine", label: "2" },
      { from: "g8", to: "f6", kind: "engine", label: "3" },
    ]);
    const m = s.feed.at(-1)!;
    expect(m).toMatchObject({ kind: "engine", who: "black", ply: 7, free: true });
    expect(m.engine).toMatchObject({ seq, depth: 12 });
    expect(m.engine!.moves).toHaveLength(3);
    expect(m.text).toBe("1. 4…dxc6 +0.3 · 2. 4…bxc6 +0.5 · 3. 4…Nf6 +1.0 · depth 12");
    s.playFree("dxc6");
    expect(s.arrows).toEqual([]);
    expect(s.engineSuggest(seq, moves, 12)).toBe(false);
    s.exitWhatIf();
    expect(s.engineSuggest(s.free?.seq ?? seq, moves, 12)).toBe(false);
  });
});
