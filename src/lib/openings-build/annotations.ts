/**
 * Annotations contract (§4.2): standard PGNs under public/data/annotations/
 * (e.g. Lichess study exports). Every game and every variation (RAV) is
 * read; content is keyed by (EPD, SAN) so transpositions share it.
 *
 *   comment after a move            → `why` for (position before, move)
 *   comment before a game/variation → `intro` for that position
 *   [%cal Gc1f4,Re7e5] [%csl Gd4]   → board shapes for the move
 *   NAGs ($1, !, ?!)                → move-quality glyphs
 *   [%hint text] / [%plan text]     → H1 idea / line-end plan
 */
import { Chess } from "chess.js";
import { epdOf, normSan, START_FEN } from "./replay";
import type { Issue, SourceFile } from "./types";

export type Brush = "green" | "red" | "yellow" | "blue";

export interface Shape {
  orig: string;
  dest?: string;
  brush: Brush;
}

export interface MoveNote {
  why?: string;
  hint?: string;
  plan?: string;
  shapes?: Shape[];
  nags?: number[];
}

export interface Annotations {
  /** `${epd}|${normSan}` → note */
  moves: Map<string, MoveNote>;
  /** epd → intro text (+ shapes) */
  intros: Map<string, { text: string; shapes?: Shape[] }>;
}

/** Encoded form shipped in the dataset. */
export interface RawAnnotations {
  /** [epd, san, why, hint, plan, shapes "Gc1f4 Rd4", nags] */
  m: [string, string, string, string, string, string, number[]][];
  /** [epd, text, shapes] */
  i: [string, string, string][];
}

const BRUSH: Record<string, Brush> = { G: "green", R: "red", Y: "yellow", B: "blue" };
const NAG_GLYPH: Record<string, number> = { "!": 1, "?": 2, "!!": 3, "??": 4, "!?": 5, "?!": 6 };

type Token =
  | { t: "move"; san: string }
  | { t: "comment"; text: string }
  | { t: "nag"; n: number }
  | { t: "open" }
  | { t: "close" }
  | { t: "end" };

function tokenize(movetext: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < movetext.length) {
    const c = movetext[i];
    if (/\s/.test(c)) {
      i++;
    } else if (c === "{") {
      const j = movetext.indexOf("}", i + 1);
      const end = j === -1 ? movetext.length : j;
      out.push({ t: "comment", text: movetext.slice(i + 1, end) });
      i = end + 1;
    } else if (c === ";") {
      const j = movetext.indexOf("\n", i);
      const end = j === -1 ? movetext.length : j;
      out.push({ t: "comment", text: movetext.slice(i + 1, end) });
      i = end;
    } else if (c === "(") {
      out.push({ t: "open" });
      i++;
    } else if (c === ")") {
      out.push({ t: "close" });
      i++;
    } else if (c === "$") {
      const m = /^\$(\d+)/.exec(movetext.slice(i))!;
      out.push({ t: "nag", n: Number(m?.[1] ?? 0) });
      i += m ? m[0].length : 1;
    } else {
      const m = /^[^\s{}();]+/.exec(movetext.slice(i))!;
      const word = m[0];
      i += word.length;
      if (/^(1-0|0-1|1\/2-1\/2|\*)$/.test(word)) {
        out.push({ t: "end" });
        continue;
      }
      let w = word.replace(/^\d+\.+/, "");
      if (!w) continue;
      const suffix = /([!?]+)$/.exec(w);
      if (suffix) w = w.slice(0, -suffix[1].length);
      if (w) out.push({ t: "move", san: w });
      if (suffix && NAG_GLYPH[suffix[1]]) out.push({ t: "nag", n: NAG_GLYPH[suffix[1]] });
    }
  }
  return out;
}

/** Pull [%cal]/[%csl]/[%hint]/[%plan] commands out of a comment. */
export function parseComment(raw: string): { text: string; shapes: Shape[]; hint?: string; plan?: string } {
  const shapes: Shape[] = [];
  let hint: string | undefined;
  let plan: string | undefined;
  const text = raw
    .replace(/\[%(cal|csl)\s+([^\]]*)\]/g, (_, kind: string, body: string) => {
      for (const item of body.split(",").map((s) => s.trim()).filter(Boolean)) {
        const brush = BRUSH[item[0]];
        if (!brush) continue;
        if (kind === "cal" && /^[a-h][1-8][a-h][1-8]$/.test(item.slice(1))) {
          shapes.push({ orig: item.slice(1, 3), dest: item.slice(3, 5), brush });
        } else if (kind === "csl" && /^[a-h][1-8]$/.test(item.slice(1))) {
          shapes.push({ orig: item.slice(1, 3), brush });
        }
      }
      return " ";
    })
    .replace(/\[%hint\s+([^\]]*)\]/g, (_, t: string) => {
      hint = t.trim();
      return " ";
    })
    .replace(/\[%plan\s+([^\]]*)\]/g, (_, t: string) => {
      plan = t.trim();
      return " ";
    })
    .replace(/\[%[a-z]+[^\]]*\]/gi, " ") // other engine/clock commands
    .replace(/\s+/g, " ")
    .trim();
  return { text, shapes, hint, plan };
}

function splitGames(text: string): { tags: string; movetext: string; line: number }[] {
  const games: { tags: string; movetext: string; line: number }[] = [];
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  let tags: string[] = [];
  let moves: string[] = [];
  let start = 1;
  const flush = () => {
    if (moves.join("").trim() || tags.length) games.push({ tags: tags.join("\n"), movetext: moves.join("\n"), line: start });
    tags = [];
    moves = [];
  };
  lines.forEach((l, i) => {
    if (l.startsWith("%")) return; // PGN escape line (comments for humans)
    if (/^\s*\[\w+\s+".*"\]\s*$/.test(l)) {
      if (moves.join("").trim()) flush();
      if (!tags.length) start = i + 1;
      tags.push(l);
    } else {
      if (!tags.length && !moves.length) start = i + 1;
      moves.push(l);
    }
  });
  flush();
  return games;
}

/**
 * Parse every annotation file. `known(epd, norm)` says whether a move is in
 * the theory graph: unknown moves are attached anyway with a warning.
 */
export function parseAnnotations(files: SourceFile[], issues: Issue[], known?: (epd: string, norm: string) => boolean): Annotations {
  const moves = new Map<string, MoveNote>();
  const intros = new Map<string, { text: string; shapes?: Shape[] }>();
  for (const file of files) {
    if (!/\.pgn$/i.test(file.path)) {
      issues.push({ level: "warning", file: file.path, message: `ignored non-PGN annotation file ${file.path}` });
      continue;
    }
    for (const g of splitGames(file.text)) {
      const fenTag = /\[FEN\s+"([^"]+)"\]/.exec(g.tags)?.[1];
      const tokens = tokenize(g.movetext);
      // stack of positions: each frame = chess at the current point, plus the
      // position *before* the last move (where a variation branches from)
      interface Frame {
        chess: Chess;
        before: string | null;
        lastKey: string | null;
        atStart: boolean;
      }
      let frame: Frame = { chess: new Chess(fenTag ?? START_FEN), before: null, lastKey: null, atStart: true };
      const stack: Frame[] = [];
      let broken = false;
      for (const tok of tokens) {
        if (broken && tok.t !== "close" && tok.t !== "open") continue;
        if (tok.t === "move") {
          const epdBefore = epdOf(frame.chess.fen());
          let mv;
          try {
            mv = frame.chess.move(tok.san);
          } catch {
            issues.push({ level: "warning", file: file.path, line: g.line, token: tok.san, message: `annotation move "${tok.san}" is illegal here; rest of the variation skipped` });
            broken = true;
            continue;
          }
          const norm = normSan(mv.san);
          const key = `${epdBefore}|${norm}`;
          if (known && !known(epdBefore, norm)) {
            issues.push({ level: "warning", file: file.path, line: g.line, token: mv.san, message: `annotated move ${mv.san} is not in the theory graph (shown only via extension)` });
          }
          frame.before = mv.before;
          frame.lastKey = key;
          frame.atStart = false;
        } else if (tok.t === "comment") {
          const c = parseComment(tok.text);
          if (frame.atStart || !frame.lastKey) {
            const epd = epdOf(frame.chess.fen());
            if (c.text) intros.set(epd, { text: c.text, ...(c.shapes.length ? { shapes: c.shapes } : {}) });
          } else {
            const note = moves.get(frame.lastKey) ?? {};
            if (c.text) note.why = note.why ? `${note.why} ${c.text}` : c.text;
            if (c.hint) note.hint = c.hint;
            if (c.plan) note.plan = c.plan;
            if (c.shapes.length) note.shapes = [...(note.shapes ?? []), ...c.shapes];
            moves.set(frame.lastKey, note);
          }
        } else if (tok.t === "nag") {
          if (frame.lastKey) {
            const note = moves.get(frame.lastKey) ?? {};
            note.nags = [...(note.nags ?? []), tok.n];
            moves.set(frame.lastKey, note);
          }
        } else if (tok.t === "open") {
          // a variation replaces the last move: start from the position before it
          stack.push(frame);
          const from = frame.before ?? frame.chess.fen();
          frame = { chess: new Chess(from), before: null, lastKey: null, atStart: true };
          broken = false;
        } else if (tok.t === "close") {
          frame = stack.pop() ?? frame;
          broken = false;
        }
      }
    }
  }
  return { moves, intros };
}

const shapesToStr = (s?: Shape[]) =>
  (s ?? []).map((x) => `${Object.entries(BRUSH).find(([, b]) => b === x.brush)![0]}${x.orig}${x.dest ?? ""}`).join(" ");

export function shapesFromStr(s: string): Shape[] {
  return s
    .split(" ")
    .filter(Boolean)
    .map((x) => ({ orig: x.slice(1, 3), ...(x.length >= 5 ? { dest: x.slice(3, 5) } : {}), brush: BRUSH[x[0]] }));
}

export function encodeAnnotations(a: Annotations): RawAnnotations {
  const m: RawAnnotations["m"] = [...a.moves.entries()]
    .sort((x, y) => (x[0] < y[0] ? -1 : 1))
    .map(([k, n]) => {
      const bar = k.lastIndexOf("|");
      return [k.slice(0, bar), k.slice(bar + 1), n.why ?? "", n.hint ?? "", n.plan ?? "", shapesToStr(n.shapes), n.nags ?? []];
    });
  const i: RawAnnotations["i"] = [...a.intros.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1)).map(([epd, v]) => [epd, v.text, shapesToStr(v.shapes)]);
  return { m, i };
}

export function decodeAnnotations(raw: RawAnnotations | undefined): Annotations {
  const moves = new Map<string, MoveNote>();
  const intros = new Map<string, { text: string; shapes?: Shape[] }>();
  for (const [epd, san, why, hint, plan, shapes, nags] of raw?.m ?? []) {
    moves.set(`${epd}|${san}`, {
      ...(why ? { why } : {}),
      ...(hint ? { hint } : {}),
      ...(plan ? { plan } : {}),
      ...(shapes ? { shapes: shapesFromStr(shapes) } : {}),
      ...(nags.length ? { nags } : {}),
    });
  }
  for (const [epd, text, shapes] of raw?.i ?? []) intros.set(epd, { text, ...(shapes ? { shapes: shapesFromStr(shapes) } : {}) });
  return { moves, intros };
}
