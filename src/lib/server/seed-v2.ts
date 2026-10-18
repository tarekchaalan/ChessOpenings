/**
 * v2 server seed (ADR 0004): the reference tables the route handlers grade
 * against, plus the staging tables the v1 → v2 data migration reads. Pure
 * builders over the shipped dataset; scripts/supabase/gen-seed-v2.ts writes
 * the SQL. The staging rows are the guest migration's own placer
 * (lib/progress/migrate-v1.ts), so a v1 card lands on the same v2 card for
 * guests and for accounts.
 */
import type { Dataset } from "@/lib/openings";
import type { LegacyMap } from "@/lib/openings-build/legacy";
import { normSan, sideToMove } from "@/lib/openings-build/model";
import { ReplayCache } from "@/lib/openings-build/replay";
import { modelOf } from "@/lib/courses-client";
import { datasetPlacer } from "@/lib/progress/migrate-v1";

export interface EdgeRow {
  from_epd: string;
  san: string;
  to_epd: string;
  games: number;
  white_wins: number;
  draws: number;
  black_wins: number;
  is_ext: boolean;
}
export interface LineRow {
  id: string;
  eco: string | null;
  name: string;
  sans: string[];
  final_epd: string;
}
export interface LegacyOpeningRow {
  opening_id: number;
  row_id: string | null;
  final_epd: string;
  sans: string[];
  best_course_id: string | null;
  best_line_id: string | null;
}
export interface RowAnswerRow {
  opening_id: number;
  ply: number;
  epd: string;
  answer_san: string;
  course_id: string | null;
}
export interface AnswerRow {
  epd: string;
  answer_san: string;
  course_id: string | null;
}

export interface SeedV2 {
  version: { hash: string };
  edges: EdgeRow[];
  lines: LineRow[];
  legacyOpenings: LegacyOpeningRow[];
  rowAnswers: RowAnswerRow[];
  answers: AnswerRow[];
}

/**
 * Every move with a destination node that is named theory or passes the
 * extension thresholds (`ext`: ADR 0004 point 7 — all of them, not only
 * those on default courses, so courses re-derived with overrides validate).
 */
export function seedEdges(ds: Dataset): EdgeRow[] {
  const model = modelOf(ds);
  const out: EdgeRow[] = [];
  for (const n of model.nodes) {
    for (const m of n.moves) {
      if (m.to < 0 || !(m.theory || m.ext)) continue;
      out.push({ from_epd: n.epd, san: m.san, to_epd: model.nodes[m.to].epd, games: m.games, white_wins: m.w, draws: m.d, black_wins: m.b, is_ext: !m.theory });
    }
  }
  return out;
}

export function buildSeedV2(ds: Dataset, legacy: LegacyMap, version: { hash: string }): SeedV2 {
  const model = modelOf(ds);
  const placer = datasetPlacer(ds);
  const lines: LineRow[] = model.rows.map((r) => ({ id: r.rowId, eco: r.eco, name: r.name, sans: r.sans, final_epd: model.nodes[r.path[r.path.length - 1]].epd }));

  const legacyOpenings: LegacyOpeningRow[] = [];
  const rowAnswers: RowAnswerRow[] = [];
  const replay = new ReplayCache();
  legacy.entries.forEach((e, id) => {
    legacyOpenings.push({ opening_id: id, row_id: e.rowId, final_epd: e.finalEpd, sans: e.sans.map(normSan), best_course_id: e.bestCourseId, best_line_id: e.bestLineId });
    const res = replay.replay(e.sans);
    const epds = [model.nodes[0].epd, ...res.plies.map((p) => p.epd)];
    for (let ply = 0; ply < e.sans.length && ply < epds.length; ply++) {
      const epd = epds[ply];
      const side = epd.split(" ")[1] === "b" ? "black" : "white";
      const row = normSan(e.sans[ply]);
      const p = placer.place(epd, side, row, e.bestCourseId);
      if (!p) continue;
      rowAnswers.push({ opening_id: id, ply, epd, answer_san: p.answer, course_id: p.courseId });
    }
  });

  const answers: AnswerRow[] = [];
  model.nodes.forEach((n, i) => {
    const p = placer.place(n.epd, sideToMove(model, i), null, null);
    if (p) answers.push({ epd: n.epd, answer_san: p.answer, course_id: p.courseId });
  });

  return { version, edges: seedEdges(ds), lines, legacyOpenings, rowAnswers, answers };
}

// ── SQL ───────────────────────────────────────────────────────────────────

const str = (s: string | null) => (s === null ? "null" : `'${s.replace(/'/g, "''")}'`);
const arr = (a: string[]) => `${str("{" + a.map((s) => '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"').join(",") + "}")}::text[]`;

function inserts(table: string, cols: string, rows: string[], batch = 1000): string[] {
  const out: string[] = [];
  for (let i = 0; i < rows.length; i += batch) out.push(`insert into public.${table} (${cols}) values\n${rows.slice(i, i + batch).join(",\n")};`);
  return out;
}

/**
 * Reference data (theory_edges, theory_lines, dataset_version) as one
 * transaction: re-runnable on every dataset update. Rows are deleted table by
 * table — never TRUNCATE … CASCADE, which could reach user tables through an
 * FK; an unexpected FK makes the delete fail loudly instead (ADR 0004).
 */
export function seedSql(seed: SeedV2, header: string[]): string {
  const out = [
    ...header.map((h) => `-- ${h}`),
    "begin;",
    "delete from public.theory_edges;",
    "delete from public.theory_lines;",
    "delete from public.dataset_version;",
    // built_at defaults to the seeding time (the build output has no timestamp: the seed stays deterministic)
    `insert into public.dataset_version (hash) values (${str(seed.version.hash)});`,
    ...inserts(
      "theory_edges",
      "from_epd, san, to_epd, games, white_wins, draws, black_wins, is_ext",
      seed.edges.map((e) => `(${str(e.from_epd)}, ${str(e.san)}, ${str(e.to_epd)}, ${e.games}, ${e.white_wins}, ${e.draws}, ${e.black_wins}, ${e.is_ext})`)
    ),
    ...inserts("theory_lines", "id, eco, name, sans, final_epd", seed.lines.map((l) => `(${str(l.id)}, ${str(l.eco)}, ${str(l.name)}, ${arr(l.sans)}, ${str(l.final_epd)})`), 500),
    "commit;",
    "analyze public.theory_edges, public.theory_lines;",
  ];
  return out.join("\n") + "\n";
}

/**
 * The one-time v1 → v2 staging rows, loaded after 0004 and the reference
 * seed, read by scripts/supabase/migrate-v2-data.sql (which drops them).
 */
export function legacySql(seed: SeedV2, header: string[]): string {
  const out = [
    ...header.map((h) => `-- ${h}`),
    "begin;",
    "delete from public.legacy_row_answers_v1;",
    "delete from public.legacy_answers_v1;",
    "delete from public.legacy_openings_v1;",
    ...inserts(
      "legacy_openings_v1",
      "opening_id, row_id, final_epd, sans, best_course_id, best_line_id",
      seed.legacyOpenings.map((o) => `(${o.opening_id}, ${str(o.row_id)}, ${str(o.final_epd)}, ${arr(o.sans)}, ${str(o.best_course_id)}, ${str(o.best_line_id)})`)
    ),
    ...inserts(
      "legacy_row_answers_v1",
      "opening_id, ply, epd, answer_san, course_id",
      seed.rowAnswers.map((r) => `(${r.opening_id}, ${r.ply}, ${str(r.epd)}, ${str(r.answer_san)}, ${str(r.course_id)})`)
    ),
    ...inserts("legacy_answers_v1", "epd, answer_san, course_id", seed.answers.map((a) => `(${str(a.epd)}, ${str(a.answer_san)}, ${str(a.course_id)})`)),
    "commit;",
    "analyze public.legacy_row_answers_v1, public.legacy_answers_v1, public.legacy_openings_v1;",
  ];
  return out.join("\n") + "\n";
}
