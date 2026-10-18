# ADR 0005 — Coach content engine

- **Status:** accepted (Phase 0). Implemented in Phase 3.
- **Spec:** §3.2 D (coach feed, arrows, mistake and hint ladders), §4.2, §4.11.

## Context

- v1 has 74 notes keyed by move-order strings, so transpositions miss them.
- The heuristics state things they never check: `createsPin` is a stub, and "Develops toward the center" fires on any minor-piece move to the extended centre.
- Wrong moves get a 0.35 s shake and nothing else.

## Decision

### Three layers, merged per message (`src/lib/coach/`)

1. **Authored** — always wins.
   - Source: `public/data/annotations/**/*.pgn`, parsed by the build library and shipped in the dataset.
   - Keyed by `(EPD, SAN)` for move notes, and by EPD for intros.
   - Fields:

     | Field | From |
     |---|---|
     | `why` | the comment after the move |
     | `intro` | a comment before the first move of a game or variation |
     | `shapes` | `[%cal]` / `[%csl]` |
     | `nag` | NAG glyphs |
     | `hint` | `[%hint …]` |
     | `plan` | `[%plan …]` |

   - Custom commands are stripped from display text.
   - The v1 `src/content/annotations.ts` is migrated by `scripts/openings/migrate-annotations.ts` into `public/data/annotations/curated.pgn`: one tiny game per note, keyed by replaying the v1 move-order string. Every key must resolve, or the script fails. The old file is deleted once nothing imports it.
2. **Facts** — deterministic, and every claim is checked by code first.

   | Fact | Check |
   |---|---|
   | Name milestone + ECO | node display name differs from the parent's |
   | Frequency and W/D/L shift | position stats: share of parent games; White score vs parent, |Δ| ≥ 5 pp and ≥ 30 games |
   | Development count, castling | piece-origin squares vs current; SAN `O-O` / `O-O-O` |
   | Capture / recapture | `move.captured`; recapture if the previous move captured on the same square |
   | Check / mate | `inCheck()` / `isCheckmate()` |
   | Threat | ADR §"Threat detection" below |
   | Pin | ray scan from the moved piece (B/R/Q) through exactly one enemy piece to the enemy K (absolute) or Q (relative); the pinned piece must be lower value than the target behind it |
   | Pawn break / central tension | a pawn move that creates a pawn-attacks-pawn contact on files c–f |
   | Gambit / material | Material balance (P=1, N=B=3, R=5, Q=9) vs the **start position**. Say "gambit" only when the hub, row or node name contains "Gambit" **and** the side is a pawn or more down. Otherwise state the deficit as a plain fact ("White is a pawn down for now"), and only once it has lasted ≥ 2 plies, so a recapture-in-one such as the QGA never triggers it. |
   | Fianchetto | bishop on b2/g2/b7/g7 with the knight-pawn advanced one square |
   | Transposition | EPD has ≥ 2 incoming named-theory parents and the other parent lies on a differently named row: "This position also arises from the Scheveningen move order" |

3. **Stats chips** — masters %, games, W/D/L mini bar. Numbers only, never prose.

**Template phrasing** varies deterministically (hash of EPD + SAN picks the variant), so screenshots are stable. **No LLM-generated text ships.**

### Threat detection (shared by the arrows and the coach)

After the opponent's move, with the learner to move and **not in check**:

- Clone the position, flip the side to move (and clear en-passant), and generate the opponent's legal moves.
- A threat is any of:
  - a mate-in-1;
  - a check (e.g. …Qh4+ in the Vienna, needed by Phase 3);
  - a capture of an **undefended** piece;
  - a capture of a **higher-value** piece by a lower-value one.
- **Only threats the last move created are reported.** Compute the same set for the position before the opponent's move (with the opponent to move again); report only threats absent from it. Long-standing hanging pawns never get arrows.
- Report at most 2, ranked mate > winning capture > check.
- Shapes: a red arrow from origin to target, a red tint on the target square, and also the king's square for check threats.
- When the learner is in check, the "threat" is the check itself (already shown by chessground) and nothing else is computed.

### Feed message model

- Every message has: `type` (one of the 10 in §3.2 D: intro, approach, yourTurn, yourMove, opponentMove, branch, milestone, mistake, transposition, lineComplete), `ply`, `text` (≤ 240 characters, enforced by a unit test over generated text), `more?` (authored long-form) and `shapes?`.
- Messages are append-only for the life of the line attempt. Clicking one scrubs the board to its `ply`.

### Annotation parsing

- All games and all RAVs are processed. A variation's moves start from the position **before** the move it replaces.
- Moves not in the theory graph produce a warning and are attached anyway. They are shown only when that position is reached via extension, and never become line sources.

### Mistake ladder

Classify the wrong move in order:

1. **Another named-theory move at this EPD** → soft-fail. Name it from the destination node, compare with the book move, and offer *Try again* / *Make it my move* / *Explore*. Not graded.
2. **The learner's book move for another enrolled course.** Computed from the enrolled courses' trees (courses with progress), never from card presence, because migrated cards may hold "most-played" answers. → Soft-fail naming that course.
3. **In position stats but not theory** → "Played in N master games, but it scores X% for White vs Y% for the book move", from data. Grade Again.
4. **Anything else** → engine refutation when available (Phase 6), else "Not in this course's book." Grade Again.
5. **Re-teach** (Recall / Review / Drill): re-post this position's Learn note under the verdict. Use the authored `why` when it doesn't contain the move's SAN or destination square; otherwise use the H1 idea text, which never reveals the destination.
6. **Learn mode:** a wrong move is not graded. The verdict is shown, then the expected move is replayed immediately with the arrow.
7. **Escalation:** the 2nd wrong attempt auto-applies H2; the 3rd applies H3.

### Hint ladder

- **H1 Idea:**
  - authored `hint`, else
  - a fact-based idea built from the book move's facts with the destination square removed ("Develop a knight toward the centre, attacking e5" → "Develop a knight, attacking a central pawn").
  - Never names the piece's destination.
- **H2 Piece:** highlight the origin square.
- **H3 Show:** green arrow; the learner still has to play it.

### Arrow vocabulary (one module, `src/lib/coach/brushes.ts`)

| Brush | Look |
|---|---|
| Play now | green, opacity 0.9, width 10 |
| Plan | green, opacity 0.45, width 6, numbered via `customSvg` |
| Threat | red, opacity 0.85, width 9 |
| Alternatives | blue, opacity 0.6, width 7 |
| Authored | yellow, opacity 0.75, width 8 |
| Extension | dashed, drawn as `customSvg` |

The brushes differ in width, opacity and dash as well as hue (colour-blind safe).

## Consequences

- Every sentence the coach prints traces to a check or an authored source.
- Unit tests cover each fact on real positions, including negative cases (no pin, no threat).
- Authors add content by dropping PGNs. The watcher hot-reloads them.
