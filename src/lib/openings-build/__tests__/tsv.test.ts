import { describe, expect, it } from "vitest";
import { parseTsv, selectTsvFiles, tokenizeMoves } from "../tsv";
import type { Issue } from "../types";

describe("tokenizeMoves", () => {
  it("strips numbers, glued numbers, results, NAGs and !? suffixes", () => {
    expect(tokenizeMoves("1. e4 e5 2.Nf3 Nc6 3... Bb5!? $1 a6?! 1-0")).toEqual(["e4", "e5", "Nf3", "Nc6", "Bb5", "a6"]);
    expect(tokenizeMoves("12.e4 {comment here} d5 *")).toEqual(["e4", "d5"]);
  });
});

describe("parseTsv", () => {
  it("handles BOM, CRLF, comments, blank lines, column order and extra columns", () => {
    const issues: Issue[] = [];
    const text = "﻿name\tpgn\teco\tnote\r\n# comment\r\n\r\nRuy Lopez\t1. e4 e5 2. Nf3 Nc6 3. Bb5\tC60\tclassic\r\n";
    const rows = parseTsv({ path: "x/f.tsv", text }, issues);
    expect(issues).toEqual([]);
    expect(rows).toEqual([
      { file: "x/f.tsv", line: 4, eco: "C60", name: "Ruy Lopez", tokens: ["e4", "e5", "Nf3", "Nc6", "Bb5"], extra: { note: "classic" } },
    ]);
  });
  it("warns on bad ECO (kept as null) and errors on empty names (skipped)", () => {
    const issues: Issue[] = [];
    const rows = parseTsv({ path: "f.tsv", text: "eco\tname\tpgn\nZ99\tOdd\t1. e4\nA00\t\t1. d4\n" }, issues);
    expect(rows.map((r) => [r.name, r.eco])).toEqual([["Odd", null]]);
    expect(issues.map((i) => [i.level, i.line])).toEqual([["warning", 2], ["error", 3]]);
  });
  it("errors when a required column is missing", () => {
    const issues: Issue[] = [];
    expect(parseTsv({ path: "f.tsv", text: "eco\tname\nA00\tX\n" }, issues)).toEqual([]);
    expect(issues[0]).toMatchObject({ level: "error", file: "f.tsv", line: 1 });
  });
});

describe("selectTsvFiles", () => {
  it("keeps *.tsv case-insensitively in sorted order and warns on the rest", () => {
    const issues: Issue[] = [];
    const out = selectTsvFiles(
      [
        { path: "all-openings/b.TSV", text: "" },
        { path: "all-openings/postcss.config.mjs", text: "" },
        { path: "all-openings/a.tsv", text: "" },
        { path: "all-openings/sub/f-my-lines.tsv", text: "" },
      ],
      issues
    );
    expect(out.map((f) => f.path)).toEqual(["all-openings/a.tsv", "all-openings/b.TSV", "all-openings/sub/f-my-lines.tsv"]);
    expect(issues).toEqual([
      { level: "warning", file: "all-openings/postcss.config.mjs", message: "ignored non-TSV file all-openings/postcss.config.mjs" },
    ]);
  });
});
