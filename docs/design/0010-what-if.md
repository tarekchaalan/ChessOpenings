# ADR 0010 — What If: play on from any position

- **Status:** accepted, implemented.
- **Origin:** TODO — "User can continue on their own, either during or at the
  end of a line, and the engine will just provide the top 3 arrows for the
  moves that come after it. So in case a line doesn't cover a specific
  scenario, a user can play it out on their own."

## Context

A course line ends where theory ends, and it covers one reply per branch. The
learner often wants to ask "and if they play *this* instead?" or "what happens
after the line?". Until now the only answers were the mistake ladder (a verdict
and a 2–4 ply refutation of one wrong move) and leaving for Explore. Neither
lets the learner play a position out.

## Decision

A **What If** is a detour inside the trainer: the learner plays on from a
position for **both sides**, Stockfish shows its **top three moves** for the
side to move after every move, and nothing is graded. Leaving it puts the line
back exactly where it was.

### Where it starts

| From | How |
|---|---|
| the live position (Learn, Drill, a lapsed Recall/Review ply) | toolbar flask button, `W` |
| a position scrubbed back to | the same button; the fork is at the shown ply |
| a wrong move still on the board | **Play it out** on the mistake message: the wrong move becomes the first what-if move |
| the end of a line | **What if? Play on from here** on the end card |

Never during the replay or the opponent's reply, and never from a **graded
position still waiting for its answer** (Recall/Review): the engine's arrows
would give the move away. Once the ply has lapsed (a wrong move records
"Again" at once), it is allowed.

### Session model (`lib/trainer/session.ts`)

- A new phase, `free`, with `free: FreePlay` holding the fork ply `from`, the
  what-if moves (SAN, verbose move, FEN after), a `seq` that bumps on every
  play and take-back, and a snapshot of the line's state (phase, arrows,
  tints, wrong move, ✓ square) to restore on exit.
- The **board's timeline** is the line's plies up to `from`, then the what-if
  moves. `boardPly`, `boardFen`, `boardMove`, `boardSan`, `nodeAtBoard` and
  `nameAtBoard` answer for any ply of that timeline; the view no longer
  indexes `fens`/`moves` directly. `ply` (the line's position) never moves
  during a What If.
- `playFree(san)` applies a move for whichever side is to move and posts a
  `whatif` message: the coach's fact sentences and threats (the same engine as
  the line's, with an empty fallback instead of "A book move in this line"),
  master frequency when the position is in the database, and a milestone when
  the position reached is named theory ("This is the Italian Game · C50").
  `undoFree()` takes one move back. `exitWhatIf()` restores the snapshot and
  posts "Back to the line".
- `engineSuggest(seq, moves, depth)` posts an `engine` message with the moves
  (clickable while that position is on the board) and sets the arrows. A
  result whose `seq` is not the current one is dropped.
- Mistake messages (soft and hard, and the engine's verdict) carry the new
  `whatif` action.

### Engine (`lib/engine`)

- `analyse()` takes `multipv`; the result's `lines` holds every rank, best
  first, each the deepest info seen for that rank (`rememberInfo`). The
  `MultiPV` option is set only when it changes.
- `useWhatIfEngine` runs one 1 s MultiPV-3 search per what-if position and
  returns the latest analysis. The eval bar takes it as `external` while a
  What If is live, so the two don't race each other for the single worker.
- Arrow brush `engine`: violet, numbered 1-2-3 (`lib/coach/brushes.ts`). The
  number badge takes the arrow's own colour.

### View (`components/trainer`)

- Both colours are movable in `free`; the SAN box works for either side.
- What-if chips are dashed and italic after the line's chips; the first one
  restarts the numbering ("4…dxc6"). The breadcrumb names the deepest named
  theory position reached along the what-if moves, else the position the fork
  left. Stats show the master data of the position by EPD, or say it is
  outside the database.
- Toolbar: flask (start / back to the line, `W`), take back (`Backspace`),
  and a **Back to the line** button in place of "Back to live" when live.
  `Esc` also leaves a What If. The panel header reads "What if (Learn)".
- Messages posted during a What If are marked `free`; selecting one after
  the What If ended scrubs to the fork at most.

## Consequences

- A What If never writes a card, an event, a line mark or an override, and
  never changes the URL.
- The feed stays append-only: a What If's messages remain in the log, dashed,
  between the line's messages.
- Unit tests cover the session (fork, forks from earlier plies, the wrong-move
  entry, the graded-position gate, stale engine results); the trainer e2e
  covers the board, chips, arrows, clickable engine moves, take back, exit and
  the gate.
