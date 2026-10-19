/**
 * Trainer session (§3.2 D): the pure engine behind /train. One session = one
 * line in one mode. The UI drives it (timers, animation, persistence); the
 * engine decides what the board shows, what the coach says, and how each
 * learner move grades. Nothing here touches the DOM or storage, so every
 * rule is unit-testable.
 *
 * Plies are 0-based: ply p is line.sans[p], played from line.nodes[p].
 */
import { Chess, type Move } from "chess.js";
import type { Course, CourseLine } from "@/lib/openings-build/courses";
import type { Model, MMove, MRow } from "@/lib/openings-build/model";
import { deepestName, normSan } from "@/lib/openings-build/model";
import type { Annotations, Shape } from "@/lib/openings-build/annotations";
import { ideaText, noteFor, opponentText, whyText, type MoveStatsCtx } from "@/lib/coach/explain";
import { withClocks, PIECE_NAME } from "@/lib/coach/facts";
import type { Arrow, Tint } from "@/lib/coach/brushes";
import { gradeFor, type Grade, type Outcome } from "@/lib/srs/fsrs";

export type Mode = "learn" | "recall" | "review" | "drill";
export type Side = "white" | "black";

export type MsgKind =
  | "intro"
  | "ff"
  | "turn"
  | "ok"
  | "opponent"
  | "branch"
  | "milestone"
  | "mistake"
  | "transposition"
  | "hint"
  | "complete";

export type ActionKind = "try" | "show" | "make-mine" | "explore" | "skip-ff";

export interface BranchOption {
  san: string;
  label: string;
  pct: number;
  /** a course line that plays this option from here (first by order), or null */
  line: number | null;
  current: boolean;
}

export interface FeedMsg {
  id: number;
  kind: MsgKind;
  /** board ply the message belongs to (plies on the board when it applies) */
  ply: number;
  who?: "you" | "white" | "black";
  title?: string;
  text: string;
  more?: string;
  arrows?: Arrow[];
  tints?: Record<string, Tint>;
  actions?: ActionKind[];
  options?: BranchOption[];
  /** line-complete details */
  complete?: { moves: string; learned: number; next: { san: string; pct: number }[]; plan?: string };
  /** mistake details (the move stays on the board) */
  wrong?: { san: string; from: string; to: string; soft: boolean; theoryName?: string };
}

export type Phase = "ff" | "await" | "wrong" | "opponent" | "end";

export interface CardEvent {
  type: "introduce" | "grade";
  ply: number;
  epd: string;
  answer: string;
  grade?: Grade;
  /** what happened (server grading re-derives the grade from it, ADR 0004): the move that resolved the ply ("" after H3) */
  outcome?: { san: string; hintLevel: number; wrongAttempts: number; ms: number };
}

export interface SessionCtx {
  model: Model;
  course: Course;
  line: CourseLine;
  mode: Mode;
  annotations: Annotations;
  /** plies auto-played before the learner takes over (approach, known trunk) */
  startPly: number;
  /** last ply of the session (exclusive); default: the whole line */
  endPly?: number;
  /** learner plies that grade (Recall/Review); default: none in Learn/Drill, all after startPly in Recall */
  gradedPlies?: Set<number>;
  /** show the green play arrow in Learn (setting) */
  playArrows?: boolean;
  /** another system of this hub whose defining choice is (node, move), for "Make it my move" at a system node */
  switchSystem?: (node: number, norm: string) => string | null;
  /** this learner's book move for another enrolled course at an EPD */
  enrolledMove?: (epd: string, norm: string) => { courseName: string; san: string } | null;
  /** status of course lines for branch cards */
  lineDone?: (lineIdx: number) => boolean;
  /** card reps (for Easy) */
  repsOf?: (epd: string, answer: string) => number;
  now?: () => number;
}

const SIDE_NAME = { white: "White", black: "Black" } as const;
const pct = (x: number) => (x < 0.01 && x > 0 ? "<1%" : `${Math.round(x * 100)}%`);

/** "e4" at ply 0 → "1.e4"; "e5" at ply 1 → "1…e5". */
export function moveLabel(ply: number, san: string): string {
  return `${Math.floor(ply / 2) + 1}${ply % 2 === 0 ? "." : "…"}${san}`;
}

export function formatLine(sans: string[], from = 0): string {
  const out: string[] = [];
  sans.forEach((s, i) => {
    const p = from + i;
    if (p % 2 === 0) out.push(`${Math.floor(p / 2) + 1}.${s}`);
    else out.push(i === 0 ? `${Math.floor(p / 2) + 1}…${s}` : s);
  });
  return out.join(" ");
}

const isLearnerPly = (side: Side, ply: number) => (ply % 2 === 0) === (side === "white");

/** The name hierarchy at a ply ("Ruy Lopez › Morphy Defense › Closed"), plus ECO. */
export function nameAt(model: Model, line: CourseLine, ply: number): { row: MRow | null; crumb: string[]; eco: string | null } {
  const row = deepestName(model, line.nodes.slice(0, ply + 1));
  return { row, crumb: row ? row.segments : [], eco: row?.eco ?? null };
}

/** The opening name a move defines (★ on chips): the position after it is named. */
export function definesName(model: Model, line: CourseLine, ply: number): boolean {
  return model.nodes[line.nodes[ply + 1]]?.nameRow !== -1;
}

export class TrainerSession {
  readonly ctx: SessionCtx;
  readonly side: Side;
  readonly fens: string[];
  readonly moves: Move[];
  readonly endPly: number;
  ply: number;
  phase: Phase = "ff";
  feed: FeedMsg[] = [];
  events: CardEvent[] = [];
  /** live board decorations */
  arrows: Arrow[] = [];
  tints: Record<string, Tint> = {};
  /** the wrong move currently on the board */
  wrong: { san: string; from: string; to: string; fen: string; at: number; soft: boolean } | null = null;
  /** ✓ badge square after a correct move */
  okSquare: string | null = null;
  hint: 0 | 1 | 2 | 3 = 0;
  attempts = 0;
  /** learner moves introduced or graded this session */
  learned = 0;
  /** graded plies already scheduled (a lapse is recorded at once and never overwritten) */
  readonly gradedDone = new Set<number>();
  private turnStarted = 0;
  private nextId = 1;
  private showPlanNext = true;
  private lastNameRow: number | null = null;
  private transpositionSaid = false;

  constructor(ctx: SessionCtx) {
    this.ctx = ctx;
    this.side = ctx.course.side;
    this.endPly = Math.min(ctx.endPly ?? ctx.line.sans.length, ctx.line.sans.length);
    // replay the line once: FENs per ply and verbose moves (from/to for arrows)
    const c = new Chess();
    this.fens = [c.fen()];
    this.moves = [];
    for (const san of ctx.line.sans) {
      this.moves.push(c.move(san));
      this.fens.push(c.fen());
    }
    this.ply = 0;
    const start = Math.min(Math.max(0, ctx.startPly), this.endPly);
    const name = nameAt(ctx.model, ctx.line, ctx.line.sans.length);
    const ch = ctx.course.chapters[ctx.line.chapter];
    const learnerLeft = this.learnerPlies(start, this.endPly).length;
    this.post({
      kind: "intro",
      ply: 0,
      title: ctx.line.name,
      text:
        `${ch ? `${ch.name} · ` : ""}${ctx.line.early ? "early deviation" : `${pct(ctx.line.reach)} of master games after the signature`}` +
        ` · ${learnerLeft} move${learnerLeft === 1 ? "" : "s"} to ${ctx.mode === "learn" ? "learn" : "play"}` +
        (name.eco ? ` · ${name.eco}` : ""),
    });
    if (start > 0) {
      this.post({
        kind: "ff",
        ply: start,
        text: `Replaying the known moves ${formatLine(ctx.line.sans.slice(0, start))}`,
        actions: ["skip-ff"],
      });
      this.phase = "ff";
      this.ffTarget = start;
    } else {
      this.ffTarget = 0;
      this.enterPly();
    }
  }

  private ffTarget: number;

  private now() {
    return this.ctx.now ? this.ctx.now() : Date.now();
  }

  private post(m: Omit<FeedMsg, "id">): FeedMsg {
    const msg = { ...m, id: this.nextId++ };
    this.feed.push(msg);
    return msg;
  }

  learnerPlies(from: number, to: number): number[] {
    const out: number[] = [];
    for (let p = from; p < to; p++) if (isLearnerPly(this.side, p)) out.push(p);
    return out;
  }

  isLearnerTurn(): boolean {
    return isLearnerPly(this.side, this.ply);
  }

  /** The position on the board at a ply (the wrong move overrides the live position). */
  fenAt(ply: number): string {
    return this.fens[ply];
  }

  epdAt(ply: number): string {
    return this.ctx.model.nodes[this.ctx.line.nodes[ply]].epd;
  }

  bookSan(ply = this.ply): string {
    return this.ctx.line.sans[ply];
  }

  // ── fast-forward ────────────────────────────────────────────────────────

  /** One fast-forward ply (UI calls this every ~120 ms). Returns false when done. */
  ffStep(): boolean {
    if (this.phase !== "ff") return false;
    if (this.ply >= this.ffTarget) {
      this.finishFF();
      return false;
    }
    this.ply++;
    if (this.ply >= this.ffTarget) this.finishFF();
    return this.phase === "ff";
  }

  /** Space / Esc: jump to the end of the fast-forward. */
  skipFF(): void {
    if (this.phase !== "ff") return;
    this.ply = this.ffTarget;
    this.finishFF();
  }

  private finishFF(): void {
    const name = nameAt(this.ctx.model, this.ctx.line, this.ply);
    if (name.row) {
      this.lastNameRow = name.row.idx;
      this.post({ kind: "milestone", ply: this.ply, text: `You're in the ${name.row.name}${name.eco ? ` · ${name.eco}` : ""}.` });
    }
    this.enterPly();
  }

  // ── turn flow ───────────────────────────────────────────────────────────

  private enterPly(): void {
    this.arrows = [];
    this.tints = {};
    this.wrong = null;
    if (this.ply >= this.endPly) {
      this.complete();
      return;
    }
    if (this.isLearnerTurn()) {
      this.phase = "await";
      this.hint = 0;
      this.attempts = 0;
      this.turnStarted = this.now();
      const san = this.bookSan();
      const mv = this.moves[this.ply];
      const label = moveLabel(this.ply, san);
      const plan = this.showPlanNext ? this.planArrows() : [];
      this.showPlanNext = false;
      if (this.ctx.mode === "learn") {
        const idea = ideaText(this.fenAt(this.ply), san, this.ctx.annotations, this.ply > 0 ? this.moves[this.ply - 1] : null);
        const arrows: Arrow[] = [...(this.ctx.playArrows !== false ? [{ from: mv.from, to: mv.to, kind: "play" as const }] : []), ...plan.slice(1)];
        this.arrows = arrows;
        this.post({
          kind: "turn",
          ply: this.ply,
          who: "you",
          title: `Play ${label}.`,
          text: idea,
          arrows,
          ...(plan.length > 1 ? { more: `The plan: ${this.planText()}` } : {}),
        });
      } else {
        this.post({ kind: "turn", ply: this.ply, who: "you", title: "Your move", text: this.contextText() });
      }
    } else {
      this.phase = "opponent";
      if (this.ctx.line.branchPlies.includes(this.ply)) this.branchCard();
    }
  }

  private contextText(): string {
    const prev = this.ply > 0 ? moveLabel(this.ply - 1, this.ctx.line.sans[this.ply - 1]) : null;
    return prev ? `After ${prev}. What does this course play?` : "What does this course play?";
  }

  /** Next ≤ 3 learner moves of the line from the current ply, numbered. */
  planArrows(): Arrow[] {
    const out: Arrow[] = [];
    for (let p = this.ply; p < this.endPly && out.length < 3; p++) {
      if (!isLearnerPly(this.side, p)) continue;
      const mv = this.moves[p];
      out.push({ from: mv.from, to: mv.to, kind: "plan", label: String(out.length + 1) });
    }
    return out;
  }

  planText(): string {
    const out: string[] = [];
    for (let p = this.ply; p < this.endPly && out.length < 3; p++) if (isLearnerPly(this.side, p)) out.push(moveLabel(p, this.ctx.line.sans[p]));
    return out.join(", ");
  }

  /** `P`: show the plan arrows (Learn only). */
  showPlan(): void {
    if (this.ctx.mode !== "learn" || this.phase !== "await") return;
    const plan = this.planArrows();
    this.arrows = plan;
    this.post({ kind: "hint", ply: this.ply, text: `The plan: ${this.planText()}`, arrows: plan });
  }

  private branchCard(): void {
    const { course, line, model } = this.ctx;
    const node = line.nodes[this.ply];
    const nd = model.nodes[node];
    const opts = new Map<string, BranchOption>();
    for (const l of course.lines) {
      if (l.sans.length <= this.ply || l.nodes[this.ply] !== node) continue;
      let same = true;
      for (let i = 0; i < this.ply; i++) if (l.sans[i] !== line.sans[i]) { same = false; break; }
      if (!same && l.idx !== line.idx) continue;
      const san = l.sans[this.ply];
      if (opts.has(san)) continue;
      const mv = nd.moves.find((m) => m.norm === normSan(san));
      opts.set(san, {
        san,
        label: moveLabel(this.ply, san),
        pct: mv && nd.games ? mv.games / nd.games : 0,
        line: l.idx,
        current: san === line.sans[this.ply],
      });
    }
    const all = [...opts.values()].sort((a, b) => b.pct - a.pct || (a.san < b.san ? -1 : 1));
    if (all.length < 2) return;
    // the main tries: up to 4 with ≥ 1% of games, plus the one this line takes
    const options = all.filter((o, i) => o.current || (i < 4 && o.pct >= 0.01));
    const rarer = all.length - options.length;
    const fen = this.fenAt(this.ply);
    const c = new Chess(withClocks(fen));
    const arrows: Arrow[] = [];
    for (const o of options) {
      if (o.current) continue;
      try {
        const m = c.move(o.san);
        arrows.push({ from: m.from, to: m.to, kind: "alt" });
        c.undo();
      } catch {
        // not legal here (shouldn't happen)
      }
    }
    const who = this.side === "white" ? "Black" : "White";
    const cur = options.find((o) => o.current)!;
    const others = options.filter((o) => !o.current && o.line !== null).map((o) => o.line! + 1);
    const span = others.length ? ` The others are line${others.length === 1 ? "" : "s"} ${others.length === 1 ? others[0] : `${Math.min(...others)}–${Math.max(...others)}`}.` : "";
    this.arrows = arrows;
    this.showPlanNext = true;
    this.post({
      kind: "branch",
      ply: this.ply,
      who: this.side === "white" ? "black" : "white",
      title: `${who}'s main tries here`,
      text: `${options.map((o) => `${o.label} ${pct(o.pct)}`).join(" · ")}${rarer ? ` (+${rarer} rarer)` : ""}. We'll take ${cur.label} now.${span}`,
      options,
      arrows,
    });
  }

  /** The opponent's reply (UI calls this after the reply delay). */
  opponentMove(): void {
    if (this.phase !== "opponent") return;
    this.okSquare = null;
    const { model, line, annotations } = this.ctx;
    const ply = this.ply;
    const san = line.sans[ply];
    const fenBefore = this.fenAt(ply);
    const nd = model.nodes[line.nodes[ply]];
    const mv = nd.moves.find((m) => m.norm === normSan(san));
    const freq = mv && nd.games >= 10 ? ` (${pct(mv.games / nd.games)} of master games)` : "";
    const op = opponentText(fenBefore, san, {
      annotations,
      names: this.namesSoFar(ply + 1),
      // the title already gives the frequency; don't repeat it in the body
      stats: freq ? null : this.statsCtx(ply, mv),
      previous: ply > 0 ? this.moves[ply - 1] : null,
    });
    const arrows: Arrow[] = [];
    const tints: Record<string, Tint> = {};
    for (const t of op.threats.slice(0, 1)) {
      arrows.push({ from: t.from, to: t.to, kind: "threat" });
      for (const s of t.tint) if (s) tints[s] = "threat";
    }
    // authored arrows can give the next answer away: Learn only
    if (this.ctx.mode === "learn") arrows.push(...shapesToArrows(noteFor(annotations, nd.epd, san)?.shapes ?? []));
    this.ply++;
    this.arrows = arrows;
    this.tints = tints;
    const whoName = this.side === "white" ? "Black" : "White";
    this.post({
      kind: "opponent",
      ply: this.ply,
      who: this.side === "white" ? "black" : "white",
      title: `${whoName} plays ${moveLabel(ply, san)}${freq}`,
      text: op.text,
      ...(op.more ? { more: op.more } : {}),
      arrows,
      tints,
    });
    this.afterMove();
    const keepArrows = this.arrows;
    const keepTints = this.tints;
    this.enterPly();
    // threats and authored shapes stay visible while the learner thinks
    if ((this.phase as Phase) === "await") {
      this.arrows = [...keepArrows, ...this.arrows];
      this.tints = { ...keepTints, ...this.tints };
    }
  }

  private namesSoFar(ply: number): string[] {
    const r = deepestName(this.ctx.model, this.ctx.line.nodes.slice(0, ply + 1));
    return r ? [r.name, this.ctx.course.system.name] : [this.ctx.course.system.name];
  }

  private statsCtx(ply: number, mv: MMove | undefined): MoveStatsCtx | null {
    const nd = this.ctx.model.nodes[this.ctx.line.nodes[ply]];
    if (!mv) return null;
    const score = (w: number, d: number, g: number) => (g >= 30 ? (w + d / 2) / g : null);
    return { nodeGames: nd.games, moveGames: mv.games, scoreBefore: score(nd.w, nd.d, nd.games), scoreAfter: score(mv.w, mv.d, mv.games) };
  }

  /** Name milestones and transpositions after any move reaches `this.ply`. */
  private afterMove(): void {
    const { model, line } = this.ctx;
    const node = line.nodes[this.ply];
    const nd = model.nodes[node];
    if (nd.nameRow !== -1 && nd.nameRow !== this.lastNameRow) {
      const row = model.rows[nd.nameRow];
      this.lastNameRow = row.idx;
      this.post({ kind: "milestone", ply: this.ply, text: `You've reached the ${row.name}${row.eco ? ` · ${row.eco}` : ""}.` });
      // the same position, named by a row with a different move order
      const sameOrder = row.norms.length === this.ply && row.norms.every((n, i) => n === normSan(line.sans[i]));
      if (!sameOrder && !this.transpositionSaid && this.ply > 0) {
        this.transpositionSaid = true;
        this.post({ kind: "transposition", ply: this.ply, text: `This position also arises from the ${formatLine(row.sans)} move order; you'll recognise it there.` });
      }
    }
  }

  // ── learner moves ───────────────────────────────────────────────────────

  /**
   * The learner played `san` (from the board or the SAN input). Returns the
   * verdict; the session's feed, arrows and phase are updated.
   */
  play(san: string): "correct" | "soft" | "wrong" | "illegal" | "ignored" {
    if (this.phase !== "await") return "ignored";
    this.okSquare = null;
    const fen = this.fenAt(this.ply);
    const c = new Chess(withClocks(fen));
    let mv: Move;
    try {
      mv = c.move(san);
    } catch {
      return "illegal";
    }
    const book = this.bookSan();
    if (normSan(mv.san) === normSan(book)) {
      this.correct(mv);
      return "correct";
    }
    return this.mistake(mv, c.fen());
  }

  private correct(mv: Move): void {
    const ply = this.ply;
    const { annotations, mode } = this.ctx;
    const fenBefore = this.fenAt(ply);
    const epd = this.epdAt(ply);
    const answer = normSan(mv.san);
    const ms = this.now() - this.turnStarted;
    const graded = this.isGraded(ply);
    if (graded) {
      if (!this.gradedDone.has(ply)) {
        const outcome: Outcome = { correct: true, hintLevel: this.hint, wrongAttempts: this.attempts, ms, reps: this.ctx.repsOf?.(epd, answer) ?? 0 };
        this.gradeNow(ply, gradeFor(outcome), answer);
      }
    } else if (mode === "learn") {
      this.events.push({ type: "introduce", ply, epd, answer });
    }
    if (mode !== "drill") this.learned++;
    const why = whyText(fenBefore, mv.san, {
      annotations,
      names: this.namesSoFar(ply + 1),
      stats: this.statsCtx(ply, this.ctx.model.nodes[this.ctx.line.nodes[ply]].moves.find((m) => m.norm === answer)),
      previous: ply > 0 ? this.moves[ply - 1] : null,
    });
    const authored = shapesToArrows(noteFor(annotations, epd, mv.san)?.shapes ?? []);
    this.ply++;
    this.okSquare = mv.to;
    this.post({
      kind: "ok",
      ply: this.ply,
      who: "you",
      title: `${moveLabel(ply, mv.san)} ✓`,
      text: why.text,
      ...(why.more ? { more: why.more } : {}),
      ...(authored.length ? { arrows: authored } : {}),
    });
    this.afterMove();
    this.enterPly();
    if (authored.length && (this.phase as Phase) !== "await") this.arrows = authored;
  }

  /** Schedule a graded ply once (Again lands immediately on a lapse or H3). */
  private gradeNow(ply: number, grade: Grade, san: string): void {
    if (this.gradedDone.has(ply)) return;
    this.gradedDone.add(ply);
    const outcome = { san, hintLevel: this.hint, wrongAttempts: this.attempts, ms: this.now() - this.turnStarted };
    this.events.push({ type: "grade", ply, epd: this.epdAt(ply), answer: normSan(this.ctx.line.sans[ply]), grade, outcome });
  }

  isGraded(ply: number): boolean {
    const { mode, gradedPlies, startPly } = this.ctx;
    if (gradedPlies) return gradedPlies.has(ply);
    if (mode === "recall" || mode === "review") return ply >= startPly;
    return false;
  }

  private mistake(mv: Move, fenAfter: string): "soft" | "wrong" {
    const { model, line, course, mode, enrolledMove } = this.ctx;
    const ply = this.ply;
    const node = line.nodes[ply];
    const nd = model.nodes[node];
    const epd = nd.epd;
    const norm = normSan(mv.san);
    const book = this.bookSan();
    const bookLabel = moveLabel(ply, book);
    const label = moveLabel(ply, mv.san);
    const base = { san: mv.san, from: mv.from, to: mv.to };
    const tints: Record<string, Tint> = { [mv.from]: "wrong", [mv.to]: "wrong" };

    // 1. another named-theory move at this EPD → soft-fail
    const theory = nd.theoryByNorm.get(norm);
    if (theory) {
      const name = theoryName(model, theory);
      // overrides change one move of this course; a system choice switches course instead
      const canOverride = mode !== "drill" && ply >= course.sigmaPly && (course.systemNodes.has(node) ? !!this.ctx.switchSystem?.(node, norm) : true);
      this.wrong = { ...base, fen: fenAfter, at: this.now(), soft: true };
      this.phase = "wrong";
      this.tints = tints;
      this.post({
        kind: "mistake",
        ply,
        who: "you",
        title: name ? `That's the ${name} (${label}), also theory.` : `${label} is also theory.`,
        text: `This course plays ${bookLabel} here.`,
        actions: ["try", ...(canOverride ? (["make-mine"] as const) : []), "explore"],
        wrong: { ...base, soft: true, ...(name ? { theoryName: name } : {}) },
      });
      return "soft";
    }
    // 2. the learner's move in another enrolled course → soft-fail
    const other = enrolledMove?.(epd, norm);
    if (other) {
      this.wrong = { ...base, fen: fenAfter, at: this.now(), soft: true };
      this.phase = "wrong";
      this.tints = tints;
      this.post({
        kind: "mistake",
        ply,
        who: "you",
        title: `That's your ${other.courseName} move.`,
        text: `In this ${course.system.name} course we play ${bookLabel}.`,
        actions: ["try"],
        wrong: { ...base, soft: true },
      });
      return "soft";
    }
    // 3./4. a real mistake
    this.attempts++;
    const stat = nd.moves.find((m) => m.norm === norm && m.games > 0);
    const bookStat = nd.moves.find((m) => m.norm === normSan(book));
    let text: string;
    if (stat) {
      const sc = (m: MMove) => {
        const s = (m.w + m.d / 2) / m.games;
        return this.side === "white" ? s : 1 - s;
      };
      text =
        `Played in ${stat.games} master game${stat.games === 1 ? "" : "s"}` +
        (bookStat && bookStat.games > 0
          ? `, but it scores ${pct(sc(stat))} for ${SIDE_NAME[this.side]} vs ${pct(sc(bookStat))} for the book move.`
          : ", but it isn't in this course's book.") +
        ` This course plays ${bookLabel}.`;
    } else {
      text = "Not in this course's book.";
    }
    // re-teach (Recall / Review / Drill): the position's Learn note, without naming the move
    let reteach: string | undefined;
    if (mode !== "learn") reteach = this.reteachText();
    this.wrong = { ...base, fen: fenAfter, at: this.now(), soft: false };
    this.phase = "wrong";
    this.tints = tints;
    this.arrows = [];
    this.post({
      kind: "mistake",
      ply,
      who: "you",
      title: `${label} ✕`,
      text,
      actions: ["try", "show"],
      wrong: { ...base, soft: false },
    });
    // re-teach goes right under the verdict, as its own message
    if (reteach) this.post({ kind: "hint", ply, title: "Re-teach", text: reteach });
    // the lapse is scheduled now: leaving or restarting can't turn it into a Good
    if (this.isGraded(ply)) this.gradeNow(ply, "again", norm);
    // escalation: the 2nd wrong attempt applies H2, the 3rd H3
    if (mode !== "learn") {
      if (this.attempts >= 3) this.hint = Math.max(this.hint, 3) as 3;
      else if (this.attempts >= 2) this.hint = Math.max(this.hint, 2) as 2 | 3;
    }
    return "wrong";
  }

  /** The position's Learn note without the answer: the authored why/hint with the move masked, else the idea. */
  reteachText(): string {
    const san = this.bookSan();
    const note = noteFor(this.ctx.annotations, this.epdAt(this.ply), san);
    const mask = (t: string) => t.split(normSan(san)).join("…");
    if (note?.hint) return `Remember: ${mask(note.hint)}`;
    if (note?.why) return `Remember: ${mask(note.why)}`;
    return `Remember: ${ideaText(this.fenAt(this.ply), san, this.ctx.annotations, this.ply > 0 ? this.moves[this.ply - 1] : null)}`;
  }

  /** [Try again]: the wrong move goes back (UI waits until ≥ 900 ms after the mistake). */
  tryAgain(): void {
    if (this.phase !== "wrong") return;
    this.wrong = null;
    this.phase = "await";
    this.tints = {};
    this.applyHintDecorations();
  }

  /** [Show me] / `S`: straight to H3. */
  showMe(): void {
    if (this.phase === "wrong") this.tryAgain();
    if (this.phase !== "await") return;
    while (this.hint < 3) this.hintStep();
  }

  /** `H`: one rung up the hint ladder (H1 idea → H2 piece → H3 arrow). */
  hintStep(): void {
    if (this.phase !== "await" || this.hint >= 3) return;
    this.hint = (this.hint + 1) as 1 | 2 | 3;
    const san = this.bookSan();
    const mv = this.moves[this.ply];
    if (this.hint === 1) {
      this.post({ kind: "hint", ply: this.ply, title: "Hint · idea", text: ideaText(this.fenAt(this.ply), san, this.ctx.annotations, this.ply > 0 ? this.moves[this.ply - 1] : null) });
    } else if (this.hint === 2) {
      const piece = new Chess(withClocks(this.fenAt(this.ply))).get(mv.from as never);
      this.post({ kind: "hint", ply: this.ply, title: "Hint · piece", text: `Move the ${piece ? PIECE_NAME[piece.type] : "piece"} on ${mv.from}.`, tints: { [mv.from]: "hint" } });
    } else {
      this.post({ kind: "hint", ply: this.ply, title: "Hint · shown", text: `Play ${moveLabel(this.ply, san)}.`, arrows: [{ from: mv.from, to: mv.to, kind: "play" }] });
      if (this.isGraded(this.ply)) this.gradeNow(this.ply, "again", "");
    }
    this.applyHintDecorations();
  }

  private applyHintDecorations(): void {
    const mv = this.moves[this.ply];
    if (!mv) return;
    if (this.hint >= 2) this.tints = { ...this.tints, [mv.from]: "hint" };
    if (this.hint >= 3) this.arrows = [{ from: mv.from, to: mv.to, kind: "play" }];
    else if (this.ctx.mode === "learn" && this.ctx.playArrows !== false) this.arrows = [{ from: mv.from, to: mv.to, kind: "play" }];
  }

  // ── end ─────────────────────────────────────────────────────────────────

  private complete(): void {
    this.phase = "end";
    const { model, line, annotations } = this.ctx;
    const nd = model.nodes[line.nodes[this.ply]];
    const next = [...nd.moves]
      .filter((m) => m.games > 0)
      .sort((a, b) => b.games - a.games)
      .slice(0, 3)
      .map((m) => ({ san: moveLabel(this.ply, m.san), pct: nd.games ? m.games / nd.games : 0 }));
    const lastSan = line.sans[this.ply - 1];
    const endNote = this.ply > 0 ? noteFor(annotations, model.nodes[line.nodes[this.ply - 1]].epd, lastSan) : undefined;
    const plan = endNote?.plan;
    // authored plans come with their arrows ([%cal] on the same note): shown with the end card
    const planArrows = plan ? shapesToArrows(endNote?.shapes ?? []) : [];
    const plies = this.learnerPlies(this.ctx.startPly, this.endPly).length;
    this.post({
      kind: "complete",
      ply: this.ply,
      title: "Line complete",
      text:
        this.ctx.mode === "learn"
          ? `${plies} move${plies === 1 ? "" : "s"} learned.`
          : this.ctx.mode === "drill"
            ? "Drill line done."
            : `${plies} move${plies === 1 ? "" : "s"} reviewed.`,
      complete: { moves: formatLine(line.sans.slice(0, this.endPly)), learned: this.learned, next, ...(plan ? { plan } : {}) },
      ...(planArrows.length ? { arrows: planArrows } : {}),
    });
    if (planArrows.length) this.arrows = planArrows;
  }

  /** A plain coach note at the live ply (e.g. "4.Bxc6 is now your move"). */
  note(title: string, text: string): void {
    this.post({ kind: "hint", ply: this.ply, title, text });
  }

  /** Card events (introduce/grade) since the last drain, for the progress store. */
  drainEvents(): CardEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }
}

/** The name of the theory a move leads into (its shortest row's last segment). */
export function theoryName(model: Model, mv: MMove): string | null {
  const nd = model.nodes[mv.to];
  const row = nd && nd.nameRow !== -1 ? model.rows[nd.nameRow] : mv.rows.length ? model.rows[mv.rows[0]] : null;
  if (!row) return null;
  return row.segments[row.segments.length - 1] ?? row.name;
}

export function shapesToArrows(shapes: Shape[]): Arrow[] {
  return shapes.filter((s) => s.dest).map((s) => ({ from: s.orig, to: s.dest!, kind: "authored" as const }));
}

/** First ply where two lines differ (their shared trunk length). */
export function divergence(a: CourseLine, b: CourseLine): number {
  let i = 0;
  while (i < a.sans.length && i < b.sans.length && a.sans[i] === b.sans[i]) i++;
  return i;
}

/**
 * Learn's fast-forward: skip the approach and trunk whose learner moves are
 * all known (cards exist), stopping at the first unknown learner move.
 */
export function learnStartPly(line: CourseLine, side: Side, model: Model, known: (epd: string, answer: string) => boolean): number {
  for (let p = 0; p < line.sans.length; p++) {
    if (!isLearnerPly(side, p)) continue;
    // start on the opponent move just before it: that reply is what makes the line new
    // (its message, frequency, threats and branch card must not vanish into the replay)
    if (!known(model.nodes[line.nodes[p]].epd, normSan(line.sans[p]))) return Math.max(0, p - 1);
  }
  return line.sans.length;
}

/** Drill: start where the line leaves its chapter's trunk. */
export function chapterTrunk(course: Course, line: CourseLine): number {
  const ch = course.chapters[line.chapter];
  if (!ch || ch.lines.length < 2) return course.sigmaPly;
  let n = Infinity;
  for (const li of ch.lines) if (li !== line.idx) n = Math.min(n, divergence(line, course.lines[li]));
  return Number.isFinite(n) ? Math.min(n, line.sans.length) : course.sigmaPly;
}
