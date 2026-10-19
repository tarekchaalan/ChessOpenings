/**
 * PGN movetext → SAN tokens, without a full PGN parser: drops headers,
 * {comments} (Chess.com clocks), (variations), move numbers, NAGs and the
 * result. Legality is checked later, when the moves are replayed.
 */
const RESULT = /^(1-0|0-1|1\/2-1\/2|\*)$/;

export function sansFromPgn(pgn: string): string[] {
  const body = pgn
    .split(/\r?\n/)
    .filter((l) => !l.startsWith("["))
    .join(" ")
    .replace(/\{[^}]*\}/g, " ")
    .replace(/;[^\n]*/g, " ");
  // strip (nested) variations
  let text = body;
  for (let prev = ""; prev !== text; ) {
    prev = text;
    text = text.replace(/\([^()]*\)/g, " ");
  }
  const out: string[] = [];
  for (let tok of text.split(/\s+/)) {
    if (!tok) continue;
    tok = tok.replace(/^\d+\.(\.\.)?/, "");
    if (!tok || /^\$\d+$/.test(tok) || RESULT.test(tok) || /^\.+$/.test(tok)) continue;
    out.push(tok.replace(/[?!]+$/, ""));
  }
  return out;
}

/** A PGN header value, or null. */
export function pgnTag(pgn: string, tag: string): string | null {
  const m = pgn.match(new RegExp(`^\\[${tag} "([^"]*)"\\]`, "m"));
  return m ? m[1] : null;
}
