/** Moves in words for screen readers (§3.4): "Nf3" by White → "White knight to f3". */
const PIECE: Record<string, string> = { K: "king", Q: "queen", R: "rook", B: "bishop", N: "knight" };

export function sanToWords(san: string, color: "white" | "black"): string {
  const who = color === "white" ? "White" : "Black";
  const check = san.endsWith("#") ? ", checkmate" : san.endsWith("+") ? ", check" : "";
  const s = san.replace(/[+#?!]+$/, "");
  if (s === "O-O") return `${who} castles kingside${check}`;
  if (s === "O-O-O") return `${who} castles queenside${check}`;
  const promo = /=([QRBN])$/.exec(s);
  const body = promo ? s.slice(0, -2) : s;
  const piece = PIECE[body[0]] ?? "pawn";
  const dest = /([a-h][1-8])$/.exec(body)?.[1] ?? "";
  const takes = body.includes("x");
  return `${who} ${piece} ${takes ? "takes on" : "to"} ${dest}${promo ? `, promotes to ${PIECE[promo[1]]}` : ""}${check}`;
}
