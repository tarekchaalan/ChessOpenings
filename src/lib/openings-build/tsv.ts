/**
 * TSV source contract (§4.1): header row required, columns matched by name,
 * `eco`/`name`/`pgn` required, extra columns preserved. BOM stripped, LF or
 * CRLF, blank and `#` lines ignored. Never throws — problems become Issues.
 */
import type { Issue, SourceFile, TsvRow } from "./types";

const ECO_RE = /^[A-E]\d\d$/;
const RESULT_RE = /^(1-0|0-1|1\/2-1\/2|\*)$/;

/** True for files the loader accepts (`*.tsv`, case-insensitive). */
export const isTsvPath = (path: string) => /\.tsv$/i.test(path);

/**
 * Split PGN movetext into SAN tokens: drops move numbers (`1.`, `1...`,
 * glued `12.e4`), result tokens, NAGs (`$1`), `!?`-style suffixes and
 * brace comments. Check suffixes are kept here; replay normalises them.
 */
export function tokenizeMoves(pgn: string): string[] {
  const out: string[] = [];
  const text = pgn.replace(/\{[^}]*\}/g, " ");
  for (const raw of text.split(/\s+/)) {
    if (!raw) continue;
    if (RESULT_RE.test(raw)) continue;
    if (/^\$\d+$/.test(raw)) continue;
    let tok = raw.replace(/^\d+\.+/, "");
    if (!tok) continue;
    tok = tok.replace(/[!?]+$/, "");
    if (!tok) continue;
    out.push(tok);
  }
  return out;
}

export function parseTsv(file: SourceFile, issues: Issue[]): TsvRow[] {
  const text = file.text.charCodeAt(0) === 0xfeff ? file.text.slice(1) : file.text;
  const lines = text.split(/\r?\n/);
  let header: string[] | null = null;
  let col = { eco: -1, name: -1, pgn: -1 };
  const rows: TsvRow[] = [];

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const line = lines[i];
    if (!line.trim() || line.startsWith("#")) continue;
    const cells = line.split("\t");
    if (!header) {
      header = cells.map((c) => c.trim().toLowerCase());
      col = { eco: header.indexOf("eco"), name: header.indexOf("name"), pgn: header.indexOf("pgn") };
      const missing = (["eco", "name", "pgn"] as const).filter((k) => col[k] === -1);
      if (missing.length) {
        issues.push({
          level: "error",
          file: file.path,
          line: lineNo,
          message: `header is missing required column(s): ${missing.join(", ")}`,
        });
        return [];
      }
      continue;
    }
    const name = (cells[col.name] ?? "").trim();
    if (!name) {
      issues.push({ level: "error", file: file.path, line: lineNo, message: "empty name; row skipped" });
      continue;
    }
    const ecoRaw = (cells[col.eco] ?? "").trim();
    let eco: string | null = ecoRaw.toUpperCase();
    if (!ECO_RE.test(eco)) {
      issues.push({
        level: "warning",
        file: file.path,
        line: lineNo,
        message: `bad or missing ECO "${ecoRaw}" for "${name}"; kept with eco = null`,
      });
      eco = null;
    }
    const tokens = tokenizeMoves(cells[col.pgn] ?? "");
    if (!tokens.length) {
      issues.push({ level: "error", file: file.path, line: lineNo, message: `empty pgn for "${name}"; row skipped` });
      continue;
    }
    let extra: Record<string, string> | undefined;
    header.forEach((h, j) => {
      if (j === col.eco || j === col.name || j === col.pgn || !h) return;
      const v = cells[j];
      if (v !== undefined && v !== "") (extra ??= {})[h] = v;
    });
    rows.push({ file: file.path, line: lineNo, eco, name, tokens, ...(extra ? { extra } : {}) });
  }
  if (!header) {
    issues.push({ level: "warning", file: file.path, message: "file has no header row; ignored" });
  }
  return rows;
}

/**
 * Filter the watched files: TSVs in sorted path order; everything else is
 * reported once as a warning that names the file.
 */
export function selectTsvFiles(files: SourceFile[], issues: Issue[]): SourceFile[] {
  const out: SourceFile[] = [];
  for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    if (isTsvPath(f.path)) out.push(f);
    else issues.push({ level: "warning", file: f.path, message: `ignored non-TSV file ${f.path}` });
  }
  return out;
}
