# Claude Code Prompt — Opening Trainer v2

> **How to use:** start Claude Code in the repo root and say: *"Read `docs/prompts/opening-trainer-v2.md` and execute it."*
> Both docs are committed outside `.claude/`, which is gitignored in this repo.
> **Companion research:** read `docs/research/opening-trainers-teardown.md` before you start. It is a teardown of Chessbook, Chessable, ChessAtlas, Chessreps and Chessly, plus an audit of this app with verified numbers.

---

## 0. Your mission

Rebuild this app's opening-learning experience so it beats Chessbook, Chessable, ChessAtlas, Chessreps and Chessly together. Combine the best idea from each, fix what each gets wrong, and add what none of them have.

Four outcomes matter most:

1. **Variations feel seamless.**
   - The learner always knows which branch they are in, why it matters, what is done and what comes next.
   - Moving from one line to the next continues from the point where they diverge. It never restarts from move 1.
2. **Real lines, not one-move "openings".**
   - Openings start at multi-move *signature positions*.
   - The learner's moves are fixed; the opponent's replies branch.
   - Lines are concrete, deep and named.
3. **The board and the coach panel teach.**
   - Every move comes with a short, persistent explanation.
   - Mistakes are graded and explained, not just shaken off.
4. **The opening data is live.**
   - Anything in `public/data/all-openings/` is the source of truth.
   - Adding, editing or removing a file or a row updates the app automatically (in dev, within seconds, with no restart) and shows a diff ("+3 new lines in Ruy Lopez").
   - User progress survives every data change.

Quality bar:
- Every interaction has a designed state: loading, empty, error, success and disabled.
- Every claim the coach makes is true.
- Every number shown to the user is computed, never invented.

---

## 1. Ground rules

- **Branch:** work on `feat/trainer-v2`. Commit after each phase with a clear message. Never push, merge, or force-push without asking.
- **Supabase:** never apply migrations to the remote project, run `npm run seed:remote`, or use service-role keys against anything but a local stack without my explicit approval. Write migrations and scripts, test them on `supabase start` locally if available, then stop and ask.
- **Guest mode must keep working** with no backend at every commit (`npm run dev` with no env vars).
- **Stack:**
  - No new UI framework. Stay on Next 16 / React 19 / TS / Tailwind 4 / chessground / chess.js / zustand / lucide-react.
  - Every new dependency needs a one-line justification in the phase report, plus its license.
  - chessground is GPL-3.0 already. Flag any other GPL dependency (e.g. Stockfish) before adding it.
- **Keep what works:**
  - EPD-keyed position graph
  - Server-side anti-forge quiz grading
  - Sounds
  - Theme tokens in `src/app/globals.css`
  - Keyboard support
  - Leaderboard
  - `startPlyFor` divergence logic in `src/lib/quiz/playlist.ts`

  Refactor freely, but preserve behaviour unless this spec changes it.
- **Verify, don't trust.** Recompute every number in this prompt from the files before relying on it. If reality disagrees with this prompt, follow reality and say so in your report.
- **Asking.** If something is ambiguous and a wrong guess is cheap, state your assumption and proceed. Ask only when a guess would be expensive or irreversible.
- **Use the repo's agents** in `.claude/agents/`:
  - `scout` — inventory and call-site searches (read-only)
  - `designer` — ADRs in `docs/design/` (no source edits)
  - `engineer` — data pipeline, identity, migrations and SRS: anything cross-cutting
  - `builder` — UI features
  - `reviewer` — independent review after each phase. It reviews against **this file**, runs build and tests, and reports blocking, non-blocking and not-done items.
  - `mechanic` — config, scripts and .gitignore

  After each phase: reviewer → fix all blocking items → commit → short report to me. Then continue.

---

## 2. Verified current state (2026-10-18)

### Stack and layout

- **Data pipeline:** `scripts/ingest.ts`
  - Downloads lichess `chess-openings` TSVs at commit `51a55d9` and six months of the Lichess broadcast PGN corpus into `data/cache/` (gitignored, needs the `zstd` CLI).
  - Builds an EPD graph and streams the corpus. Games count only while they stay "in book"; one off-book ply is kept as "extras".
  - Emits `public/data/openings.v1.json`, `openings.meta.json` and `supabase/seed.sql`.
- **Runtime:**
  - `src/lib/openings.ts` — `loadDataset`, `familyOf`, `familyNextMoves`, `openingCatalog`, `defaultSide`
  - `src/lib/mainline.ts` — greedy mainline
  - `src/lib/explain.ts` + `src/content/annotations.ts` — coach text
  - `src/components/learn/*` — Learn
  - `src/components/quiz/*` + `src/lib/quiz/*` — Quiz, with playlists, the local engine and the remote RPC engine
  - `src/lib/srs.ts` — SM-2, mirrored in plpgsql
  - `src/lib/progress/*` — localStorage `cot.v1.*` or Supabase
  - `supabase/migrations/0001–0003`

### The new data, verified by SHA-1

- `public/data/all-openings/{a,b,c,d,e}.tsv` are byte-identical to lichess-org/chess-openings `master` today.
  - 3,865 rows (vs 3,733 in the current dataset): +143 / −11 rows, 136 new move sequences, 4 removed.
  - Header: `eco	name	pgn`.
  - All rows replay legally.
  - No two rows share a PGN, and no two share a final position.
  - **308 names are used by more than one row**, so a name is not a key.
  - Name depth: 198 one-segment names, 1,589 "Family: Variation", 1,694 with one comma level, 374 with two, and 10 deeper. There are 150 families (the text before the colon).
- **`public/data/all-openings/postcss.config.mjs` is a byte-identical copy of `a.tsv`.** It was almost certainly misnamed by accident.
  - Delete it with `git rm` as your first commit and tell me in the report.
  - The loader must ignore non-`.tsv` files anyway, with a warning.

### Defects you are fixing

1. **Progress is keyed to row indices.**
   - `openingId` is the row's index in `openings.v1.json`.
   - Used by `srs_cards`, `opening_progress` and `quiz_challenges` (FKs to `theory_openings.id`), `quiz_attempts.opening_id` (no FK), localStorage `cot.v1.cards` / `cot.v1.openingProgress`, and the `/learn/[id]` and `/quiz/[id]` URLs.
   - Any data change re-indexes the rows and **silently attaches progress to the wrong opening**.
2. **Learn mode can't reach a large share of each family.** The cause: no transposition or sibling handling.
   - `familyOf()` keeps only the lines that extend the family root. The root is the *shortest* row with that family name (ties → most popular).
   - On the shipped `openings.v1.json`, 533 of 3,733 rows are unreachable from their family's Learn page:
     - QGD (root `1.d4 d5 2.c4 e6`): 114/171 lost
     - KID (root `…3.Nc3`): 26/119 lost
     - Semi-Slav: 53/68 lost
     - Benoni (root `1.d4 c5`): 43/61 lost
     - King's Gambit Declined: 32/53 lost
   - On the new TSVs it is about 570 of 3,865. QGD: only 80/211 reachable.
   - The Learn catalog also shows only the top 30 families (`.slice(0, 30)`). Search opens any row as its own root.
3. **One-move openings head the catalog.**
   - 20 family roots are a single ply (1.Nh3, 1.g4, 1.b4…) and 29 are two plies.
   - Families are split by name: "King's Gambit" / "…Accepted" / "…Declined".
   - Popular openings are scattered across families. London rows are spread across several groups:
     - names starting `London System` (8 rows, several of them separate no-colon "families" such as `London System, with Be2`)
     - `Queen's Pawn Game: London System` (7)
     - `Queen's Pawn Game: Accelerated London System` (5)
   - The Torre and Colle live under "Queen's Pawn Game".
4. **The coach is thin.**
   - 74 curated notes, keyed by move-order string, so transpositions miss them.
   - Heuristics fill the rest, and some never fire (`createsPin` always returns `false`).
   - A wrong move in Learn = a 0.35 s shake, with no reason and no escalation.
5. **Smaller issues:**
   - `Board.tsx` always promotes to a queen. Latent, since no current row underpromotes.
   - No test framework at all.

---

## 3. Product design — what you are building

### 3.1 Information architecture

The hierarchy is **Opening hub → System (course) → Chapter → Line**.

- **Opening hub.** What players call "an opening": Sicilian Defense, London System, Queen's Gambit Declined…
  - It is defined by a *query over names*, not by one family string, so the London unifies its three name groups.
  - It has a **signature position σ**, the true start of the opening (§4.4).
  - Moves before σ are the *approach* and fast-forward in training.
- **System.** One way to play the hub *for one side*: Najdorf, Dragon or Taimanov as Black in the Sicilian. It is a course.
  - **The learner's moves are fixed: exactly one book move per position on their side.** The opponent's moves branch, covering every named-theory reply.
  - Opponent deviations after σ but before the system's own signature (e.g. 2.c3 Alapin against a Najdorf player) become chapters too. A system is a complete repertoire from σ, which is how players actually prepare.
  - Present systems the way Chessly frames "Weapon 1 / Weapon 2": *"Choose your weapon against 1.e4 c5…"*
- **Chapter.** One opponent reply (or a group of rare ones). Named by the deepest common opening name plus the key move in parentheses:
  - *"Morphy Defense (3…a6)"*
  - *"Berlin Defense (3…Nf6)"*
  - *"Other 3rd moves (3…f5, 3…Bc5)"*

  Chapters may nest one level (chapter → section) when a chapter has ≥ 12 lines.
- **Line.** A concrete root-to-leaf path through the system's tree.
  - Named by its deepest opening name relative to the course, plus distinguishing moves: *"Closed · Breyer (9…Nb8)"*.
  - Shows its depth and its **reach probability** (§4.6).
- **Depth tiers per system:**
  - **Essentials**: the smallest set of lines reaching ≥ 80% reach mass, with at least min(5, all lines) and at most 20 lines. If two tiers end up identical, collapse them in the UI.
  - **Core**: ≥ 95% mass, max 60 lines.
  - **Complete**: every line.

  Each tier shows *"covers 92% of master games from σ"*. On a course's first visit, show a Chessreps-style chooser: *"How deep do you want to go? Essentials · 14 lines — most players start here / Core · 38 / Complete · 71 — you can change this anytime."*
- **Offbeat & surprise weapons.**
  - A hub becomes a top-level catalog entry only if it has **≥ 3 lines** and a **max depth ≥ 8 plies** after building.
  - Smaller hubs (Amar, Grob, Barnes, single-trap lines…) go in a collapsible *Offbeat & surprise weapons* section, presented as mini-courses.
  - Never hide data: every TSV row must be reachable from some course for at least one side, or be listed in the build's `unassigned` report. The target is 0.
- **Learner alternatives.** When a theory move differs from the system's book move at a learner-to-move position:
  - Accept it as a **soft-fail**: "That's the Exchange Variation, also theory. This course plays 4.Ba4 here."
  - Offer **"Make 4.Bxc6 my move here"**. This writes a per-user, **per-course** override for that EPD, and the course tree re-derives from it (§4.5). It isn't offered at system-defining moves; "Switch system" appears there instead. This gives Chessbook's own-repertoire power without its overload.

### 3.2 Screens

All screens: designed for light and dark mode, 375 / 768 / 1280+ widths, keyboard-complete, and `prefers-reduced-motion` respected.

**A. Openings catalog** (`/openings`; replaces `/learn`, which redirects)

- **Top bar:**
  - Search: name, ECO (`B90`), move strings (`e4 c5 Nf3 d6`, with or without numbers, SAN or figurine), fuzzy and accent-insensitive. Keep `searchOpenings`' ECO behaviour.
  - **White / Black** segmented control.
  - Filter chips: *Against 1.e4 · Against 1.d4 · Against others* (Black only), *Gambit · Solid · Sharp · System*, and level *Beginner · Intermediate · Advanced*.
  - Style tags come from data rules plus a curated override; level comes from tier sizes and depth. Document the rules.
- **Continue** row: in-progress courses with due counts, last-studied line, and a "Resume" button. Chessly's "Pick up where you left off" is the reference; add due counts, which it lacks.
- **Featured** grid of curated hubs, then **All openings** grouped by ECO volume (A Flank, B Semi-open, C Open, D Closed, E Indian), then **Offbeat & surprise weapons** (collapsed).
- **Card contents:**
  - A **static mini-board at σ** — a lightweight SVG board component, not a chessground instance per card.
  - Hub name.
  - σ moves (approach + signature, shortened with "…" when long).
  - Chips: lines (Essentials / Complete), average depth, master games, a mini W/D/L bar.
  - Side badge.
  - Progress ring + due count.
  - On hover or focus (desktop, no reduced motion): the approach animates on the mini-board, then it rests on σ.
- **"+N new lines" badge** on any hub whose lines changed in the latest data build (§4.8). Dismissable per user.
- **Map view** (stretch, Phase 6): a zoomable sunburst/icicle of the theory tree from the start position to depth 8.
  - Arc size = master games; colour = ECO volume.
  - Click → zoom; double-click → open hub.
  - An accessible tree-list fallback is required. No competitor has this.

**B. Hub page** (`/openings/[hub]`)

- **Header:**
  - Board at σ.
  - Name, ECO range, and a 2–3 sentence description (authored if present, else fact-generated).
  - "Assumes 1.d4 d5 2.c4. Other move orders: see *Queen's Pawn Game*" whenever σ excludes hub rows by move order.
  - Side switch.
- **"Choose your system"** list: name, defining moves, reach %, line count, average depth, style tags, a **Recommended** badge (the most popular), and progress. Each row opens the system course.
- If the hub has a single system for that side, skip straight to the course page (keep a breadcrumb back).

**C. Course page** (`/openings/[hub]/[system]/[side]`, where `side` is `white` or `black`)

**One URL scheme everywhere:** course ID `hub/system@side` maps to the path segments `[hub]/[system]/[side]`. Never put a raw course ID containing `/` into a single dynamic segment.

- **Header:** board at the system signature, a breadcrumb (Hub › System), the tier selector with coverage %, and a progress bar showing mastery % and due count.
- **Mode cards with live counters** (Chessreps pattern, but nothing is locked; show a *recommended next* highlight instead):
  - **Learn** — *n new lines*
  - **Review** — *n due · ~m min*
  - **Drill** — shuffle chosen chapters; no schedule effect, like Chessable's Overstudy
  - **Play it** — out of scope now; leave a disabled card reading "Coming soon" only if it doesn't look broken, otherwise omit it
- **Chapters accordion.** Each chapter shows a progress bar and its line rows: status dot (new / learning / due / mastered), line name, key moves, depth, reach %, last reviewed, and a ▶ button to learn or review that line.
  - This is the **line picker** Chessreps users ask for.
- **Tree view** toggle: an indented, collapsible move tree of the course.
  - Learner moves in bold, opponent branches indented, transpositions marked ↪ with a link.
  - Click a node → the trainer, opened at that position in Learn.
- **Your alternatives:** the list of per-user overrides, each with a revert button.
- **Course Explorer** (from Chessly [FH], improved):
  - A board where you play any moves. The course's moves at the current position are drawn as arrows, with a toggle.
  - A move list.
  - A **"Lines through this position"** list, filtered live from the position→line index, with status dots and ▶ to learn or review that line from here.

**D. Trainer** (`/train/[hub]/[system]/[side]?mode=learn|recall|review|drill&line=<lineId>`, plus `/train/review` for the cross-course due queue) — the heart of the product

Route migration:
- `/quiz` → the dashboard's Review card.
- `/quiz/review` → `/train/review`.
- `/quiz/[id]` and `/learn/[id]` → redirect via the legacy map.
- Header nav becomes **Dashboard · Openings · Explore · Leaderboard**. Review and Drill live in courses and on the dashboard.

*Desktop layout:*
- Board on the left, max 640 px, sticky.
- Panel on the right, 400–440 px. Above the panel: a breadcrumb plus the line progress bar.

*Under the board:*
- **Name breadcrumb**, updating every ply with a subtle cross-fade: *Ruy Lopez › Morphy Defense › Closed › Breyer*. ECO code at the right. (Chessbook's name-under-board, made hierarchical.)
- **Move chips**: the current ply highlighted, chips for future plies hidden or dimmed, and ★ on the move that defines an opening name. Clicking a past chip scrubs the board; scrubbing never affects grading.
- **Controls:** restart line · back · forward · flip · settings.

*Panel tabs:* **Coach** (default), **Lines** (this course's tree, current line highlighted, done lines ✓, upcoming dimmed; clickable in Learn and Drill only, read-only in Review), **Stats** (masters %, W/D/L, games, and the eval bar toggle).

*Coach feed* — the most important component:
- A **persistent, scrollable chat feed** for the current line, auto-scrolling to the newest message.
- **Every message is tied to a ply. Clicking a message scrubs the board to that ply**; "Back to live" returns you.
- Messages never disappear and are never replaced. Chessly and ChessAtlas both overwrite the previous note [FH].
- Message types, styled distinctly but quietly. Default text is **1–2 sentences, ≤ 240 characters**, with a "More" expander for authored long-form notes, so you never get a Chessreps wall of text.
  1. **Line intro:** line name, chapter, reach %, plies to learn.
  2. **Approach fast-forward:** "Replaying the known moves 1.e4 c5 2.Nf3 d6 3.d4 cxd4 4.Nxd4 Nf6 5.Nc3…" with a skip link.
  3. **Your turn:** a bold imperative (in Learn) plus a short idea. Example: **"Play 6.Be3."** *Prepares Qd2 and long castling — the English Attack.* In Recall and Review the imperative is hidden; only "Your move" plus context is shown.
  4. **Your move ✓:** the "why" of the move just played (authored, else fact-generated).
  5. **Opponent's move:** what it is, what it wants or threatens, and its frequency: "Black plays 6…e5 (41% of master games): kicks the knight and grabs d4." Labelled **YOU** and **WHITE / BLACK**, as in ChessAtlas, with figurine SAN.
  6. **Branch point:** "Black's main tries here: **6…e5** 41% · **6…e6** 33% · **6…Ng4** 14%. We'll take 6…e5 first; the others are lines 4–7." Status dots per option; clickable in Learn.
  7. **Name milestone:** "You've reached the **Najdorf, English Attack** · B80."
  8. **Mistake:** see the ladder below.
  9. **Transposition:** "This position also arises from the Scheveningen move order; you'll recognise it there."
  10. **Line complete:** a summary card with the moves, the new positions learned, and **"What happens next"**:
      - Top master continuations from the line's final position, with %, from the position stats.
      - Authored plans with arrows if present (Chessly's end-of-line plans).
      - Buttons: **Recall it now** (no arrows; counts as the first SRS rep) and **Next line: <name> — starts at move 9** (continues from the divergence point).

*Board behaviour (chessground):*
- Click-click and drag. Legal-move dots. Last-move and check highlights. Premoves off in training. Coordinates on.
- **Arrow vocabulary.** This takes Chessly's [FH] blue / green / red system (the best board teaching of the five) and generalises it. Define the brushes in one place. They are colour-blind safe: they also differ by opacity, width and dash, never by hue alone.
  - **Play now:** solid green, the expected move. Learn first pass only.
  - **Plan:** thinner, translucent green, numbered 1-2-3 via `customSvg` labels. These are the next ≤ 3 learner moves of the current line. Shown at the line intro, after each branch card, and on demand with `P`, with the coach line "The plan: 4.e5, 5.Nf3, 6.d4". Never shown in Recall or Review.
  - **Threat:** red, plus a red tint on the target square (and the king's square for check threats).
    - Drawn when the opponent's last move creates a *verified* threat: a capture of an undefended or higher-value piece, a check, or a mate-in-1.
    - To compute it, generate the opponent's moves from the current position with the side to move flipped (skip this when in check).
    - The coach's threat message uses the same computation, e.g. "Black threatens …Qh4+".
  - **Alternatives:** blue, shown at branch cards.
  - **Authored:** yellow, from PGN `[%cal]` / `[%csl]`.
- **Correct move:** a ✓ badge on the destination square, fading over 600 ms, plus the move sound.
- **Wrong move** (Chessreps pattern): the move **stays on the board** with a ✕ badge on the destination square (chessground `autoShapes` `customSvg`) and both squares tinted. The coach posts a verdict with **[Try again]** and **[Show me]**. *Try again* animates the piece back.
- **Opponent reply** after a configurable delay (default 500 ms, range 0–1500), after your move's animation finishes.
- **Pause after line end:** no auto-advance. This fixes Chessbook's complaint.
- **Fast-forward** of approach and known trunk at about 120 ms per ply with the chips flashing. Space or Esc skips.
- **Promotion picker:** a real 4-piece overlay. Never auto-queen in training.
- Board and piece themes: keep brown/cburnett as the default; add 2–3 board themes and 1–2 piece sets via chessground CSS, stored in prefs.
- Eval bar (Stats tab toggle): off by default in Learn and Review, available everywhere. It needs an engine (§5 Phase 6); hide it when the engine is unavailable.

*Hint ladder* (Recall, Review and Drill; feeds the SRS grade):
- **H1 Idea:** authored `[%hint …]` text, else a fact-based idea that doesn't reveal the move ("Develop a knight toward the centre, attacking e5" → shown *without* the square).
- **H2 Piece:** highlight the origin square.
- **H3 Show:** green arrow. The learner must still play it.

*Mistake ladder:* classify the wrong move, in this order:
1. **Another named-theory move at this EPD** → **soft-fail**. Not a lapse. Example: "That's the **Exchange Variation** (4.Bxc6), also theory. This course plays **4.Ba4** here." Offer **[Try again]** **[Make 4.Bxc6 my move]** **[Explore that line]**.
2. **This learner's book move for another enrolled course at this EPD** → soft-fail: "That's your **Dragon** move. In this **Najdorf** course we play 5…a6."
3. **A move that appears in the position stats** (master games, but not named theory) → "Played in 37 master games, but it scores 41% for White vs 55% for the book move. This course plays 6.Be3." The numbers must come from the data.
4. **Anything else** →
   - With the engine available: classify the eval drop (inaccuracy / mistake / blunder), show the **refutation** as a red arrow, and offer **[Show refutation]**, which plays 2–4 plies on the board and returns.
   - Without the engine: "Not in this course's book." No invented reasons.
5. **Re-teach** (Chessly [FH]): after any non-soft-fail mistake in Recall, Review or Drill, re-post this position's Learn note (the "why" of the book move, without naming it) under the verdict, then wait for the retry.
6. **Escalation:** the 2nd wrong attempt auto-applies H2; the 3rd applies H3. Grade = Again.

*Modes:*
- **Learn**
  1. Line intro.
  2. Fast-forward the approach and any trunk already learned in this course ("Skip to new moves", on by default).
  3. Coach prompt and arrow for each learner move; you play it.
  4. ✓ and the "why".
  5. Opponent reply with explanation.
  6. Branch cards and milestones as they occur.
  7. End card.

  A missed move in Learn is replayed immediately.
- **Recall:** the same line again immediately, with no arrows or imperatives. This is the first SRS rep for its cards (Chessable's "learn = 1 extra pass", made explicit).
- **Review:**
  - Due cards grouped by line, so you keep context.
  - Each line fast-forwards to the earliest due position and keeps the trunk visible as dimmed chips.
  - Back-scrub is allowed; the "how did I get here?" complaint must be impossible.
  - Interleave lines from different chapters.
- **Drill:** random lines from selected chapters (chapter checklist with line counts, like Chessly's Drill Shuffle setup) with no schedule effect. Optional timer, off by default.
  - Each drill **fast-forwards to the line's divergence from its chapter trunk**, with a "From move 1" toggle.
  - Chessly [FH] replays every drill from move 1; that is the trunk repetition users complain about.
- **Relearn** is available on every line and chapter, always. It resets nothing: it runs Learn, then Recall, and grades normally.

**E. Dashboard** (`/`)

- Continue card.
- Due today with a time estimate.
- Streak.
- A 7-day review forecast (simple bar chart).
- **Repeat offenders**: the positions with the most lapses, each with a "Drill these" button.
- "New in the openings data" (from the build changelog).
- Keep the leaderboard teaser if a backend is configured.

**F. Explore** (keep, then extend)

- Show the name breadcrumb.
- For the current position and side, add **"Learn this line"**: a deep link to the best course and line containing this EPD for the side to move. The position-to-course index comes from the build.
- Add **"Train from here"**: Drill limited to the subtree below this position.

### 3.3 Settings

- Opponent reply delay
- Hint arrows in Learn (on / off)
- Skip known moves (on / off)
- Daily new lines (default 5)
- Daily review cap (default 150)
- Target retention (default 0.90)
- Board and piece theme
- Sounds
- Eval bar
- Reduced motion override

### 3.4 Accessibility and quality bars

- **Full keyboard operation:**
  - ←/→ to scrub
  - Space/Enter = next / continue
  - `H` = hint step
  - `S` = show
  - `P` = plan arrows (Learn only)
  - `F` = flip
  - `L` = Lines tab
  - Esc = skip fast-forward or close

  Keep the existing Explorer keys. Show a `?` shortcut sheet.
- **Screen readers:** the coach feed is `aria-live="polite"`. Moves are announced in words ("White knight to f3"). The board has an accessible move-input fallback: a text input that accepts SAN, focusable from the panel.
- **Colour:** feedback never relies on colour alone (✓ / ✕ icons plus text). Contrast ≥ WCAG AA in both themes.
- **Performance budgets, measured and reported:**
  - Dataset gzipped ≤ 700 KB.
  - Dataset parse ≤ 150 ms on a mid laptop; use a Web Worker if over.
  - User move → feedback ≤ 50 ms.
  - Catalog renders 150 cards without jank. Virtualise if needed.

---

## 4. Data and engine design

### 4.1 Source contract: `public/data/all-openings/`

- **Accepted files:** every `*.tsv` (case-insensitive), processed in sorted filename order, with any name (e.g. `f-my-lines.tsv`).
  - Other files are ignored, with a warning that names the file.
  - Subfolders are allowed, walked recursively in sorted order.
- **Format:**
  - UTF-8 with the BOM stripped, LF or CRLF.
  - A header row is required. Columns are matched by name: `eco`, `name` and `pgn` are required; extra columns are allowed and preserved as `extra` on the row (future use).
  - Empty lines and lines starting with `#` are ignored.
- **`pgn` parsing:**
  - Strip move numbers (`1.`, `1...`, and glued `12.e4`), result tokens, NAGs (`$1`) and `!?`-style suffixes.
  - Replay with chess.js.
- **Validation** — never crash the app because of data:
  - **Illegal SAN** → *error* with `file:line`, the ply index and the failing token. Skip the row and continue the build. `npm run openings:check` exits 1.
  - **Bad or missing ECO** (`/^[A-E]\d\d$/`) → *warning*; the row is kept with `eco: null`.
  - **Empty name** → *error*; skip the row.
  - **Duplicate normalised SAN sequence** → *warning*. Keep the first (deterministic order) and record the other names as `aliases`.
  - **Same final position via different move orders** → keep both rows as lines. The position's display name = the row with the shortest path (ties → first).

### 4.2 Annotations contract (new, optional): `public/data/annotations/**/*.pgn`

- These are standard PGNs, e.g. Lichess study exports. Process all games and all variations (RAV).
- **For each move `M` from position `P`, extract:**
  - The comment after `M` → `why` for `(P, M)`.
  - A comment before the first move of a game or variation → `intro` for `P`.
  - `[%cal Gc1f4,Re7e5]` arrows and `[%csl Gd4]` squares → board shapes for `(P, M)`.
  - NAGs → move-quality glyphs.
  - Custom `[%hint text]` → the H1 idea text.
  - Custom `[%plan text]` → the line-end plan.

  Strip the custom commands from display text.
- **Everything is keyed by `(EPD, SAN)`**, so transpositions share content (Chessreps' FEN-keyed model).
- Moves in annotation PGNs that aren't in the theory graph produce a warning and are attached anyway: they are shown if that position is reached via extension (§4.7) and are never used as line sources.
- **Migrate the 74 entries in `src/content/annotations.ts`** to `public/data/annotations/curated.pgn`, or to a JSON equivalent keyed by `(EPD, SAN)` if PGN is awkward for one-move notes. Use a script, and verify every key resolves. Delete the old file once nothing imports it.
- The same watcher (§4.8) hot-reloads annotations.

### 4.3 Stable identity (fixes defect 1)

- **Row ID** (data identity): `rw_` + the first 12 chars of base32(sha256(the row's normalised SAN sequence joined by spaces)). No two rows share a PGN, so this is unique; assert it in the build.
  - Used by the changelog (added / removed / renamed = same `rowId`, new name), the "+N new lines" badges and the legacy map.
- **Line ID** (course identity): `ln_` + hash(courseId + the line's named-theory SAN path, *excluding* `ext` plies).
  - Course lines aren't rows. They can end early at `transposesTo`, use transposed move orders, include extension plies, and depend on the learner's book moves.
  - Each line records the `rowId`s it realises.
  - Stable as long as the course's named theory along the path is unchanged.
- **Position key:** EPD, as today. If you need compactness, a 64-bit hash table index is fine, but the EPD stays canonical.
- **Hub ID:** a readable slug (`sicilian-defense`, `london-system`). It is defined in a curated hub config (§4.4), or auto-generated as a family slug.
- **Course (system) ID:** `<hubSlug>/<systemSlug>@<side>` (`sicilian-defense/najdorf@black`). Slugs must be stable under data changes.
  - If a system disappears, URLs resolve via an alias map to the nearest surviving system and show a notice.
- **SRS card key:** `(side, EPD, answerSAN)`. A card means "as `side` in position `EPD` I can play `answerSAN`".
  - Cards are **shared across all courses**, so shared trunks are reviewed once, as in Chessbook.
  - A position can have several cards with different answers, for different courses.
  - A course's card set = all `(side, EPD, bookMove)` pairs on its learner-to-move positions.
  - Mastery = the share of those cards that are mature (FSRS stability ≥ 21 days).
- **When data changes:**
  - A card whose `(EPD, answer)` is no longer in any course is **archived**, not deleted. It is excluded from queues and restored automatically if the line returns.
  - If a course's book move at an EPD changes, the old card stays (it is still valid knowledge) and the new pair starts as a new card. The coach notes "Book move updated here."
- **Legacy mapping:** the build emits `legacy-map.v1.json`, mapping v1 `openingId` (index in the committed `openings.v1.json`) → `{rowId | null, finalEpd, sans, bestCourseId, bestLineId | null}`. A v1 row can map to no course line (folded or transposed); then `bestCourseId` + `finalEpd` still give a sensible redirect target. Keep `openings.v1.json` in git until the migration ships. It is used for:
  - `/learn/[id]` and `/quiz/[id]` redirects to the best matching hub/course/line
  - the localStorage migration (§4.9)
  - the server migration (§4.10)

### 4.4 Hubs and signature positions (fixes defects 2 and 3)

**Hub definitions**

- `src/content/hubs.ts` holds curated hubs: `{slug, title, side?, match: NameQuery[], description?, tags?}`.
- `NameQuery` matches on the full name or on segments, e.g. `{nameStartsWith: "London System"}` OR `{family: "Queen's Pawn Game", variationStartsWith: "London System"}` OR `{…"Accelerated London System"}`.
  - Match on name prefixes, not exact family strings. Lichess has 32 no-colon names like `London System, with Be2` that form their own "family".
- Seed it with the ~40 most important openings. Include at least: Italian, Ruy Lopez, Scotch, Vienna, King's Gambit (Accepted + Declined unified under one hub), Petrov, Philidor, Sicilian, French, Caro-Kann, Scandinavian, Pirc/Modern, Alekhine, Queen's Gambit (QGD, QGA and Slav as separate hubs), Semi-Slav, London (unified), Catalan, Colle, Torre, Trompowsky, Jobava/Rapport-Jobava, Nimzo-Indian, Queen's Indian, Bogo-Indian, King's Indian, Grünfeld, Benoni, Benko, Dutch, English, Réti, Bird.
- Every family not claimed by a curated hub becomes an **auto hub** (slug = family).
- A row may belong to several hubs.

**Signature position σ**

Let `R` be the hub's rows. The **canonical row `C`** is the shortest row whose full name equals the hub's primary name, with ties going to the most master games. If there is no such row, use the shortest row in `R`. A curated hub may instead set `signature` moves explicitly.

**σ = `C`'s final position, trimmed back so that its last move belongs to the hub's defining side** (the default side, below). The defining side's move is what names the opening; a trailing opponent move is one of the opponent's choices, not part of the signature.

I prototyped this on today's data. These results should become unit-test fixtures (re-verify them):

| Hub | σ | Coverage |
|---|---|---|
| QGD (Black) | `1.d4 d5 2.c4 e6` | 80 rows pass through, +91 attach by transposition |
| KID (Black) | `1.d4 Nf6 2.c4 g6` (C ends `3.Nc3`, trimmed) | 119/119 covered |
| Sicilian | `1.e4 c5` | 400/400 |
| Ruy Lopez | `…3.Bb5` | 235/235 |
| Italian | `…3.Bc4` | 187/187 |
| Grünfeld | `…3.Nc3 d5` | 55/59 |
| Caro-Kann | `1.e4 c6` | 110/110 |
| Benoni | `1.d4 Nf6 2.c4 c5` | 34/66 |
| Semi-Slav | `1.d4 d5 2.c4 c6 3.Nf3 Nf6 4.Nc3 e6` | 57/72 |

QGD reaches about 206/211 once the sibling hubs (Austrian, Baltic, Chigorin, Albin) and early deviations are counted. **System-type openings (London, Colle, Torre, Stonewall, KIA) need a curated `signature`**: the rule gives London σ = `1.d4 Nf6 2.Nf3 g6 3.Bf4`. London is a required fixture.

**Rejected alternative:** "the deepest position on `C`'s path that ≥ 90% of rows pass through". It gives σ = `1.d4` for QGD and Benoni, because transposed move orders never contain the exact intermediate positions.

**Coverage.** A row is in the hub if:
- its path contains σ, **or**
- its path contains any position in σ's forward closure in the *global* theory graph. This is transposition attachment: e.g. `1.d4 Nf6 2.c4 e6 3.Nf3 d5` joins the QGD tree where the positions meet. Its earlier moves are shown as a move-order note.

**Rows not covered:** classify each by its first divergence from `C`'s path.
- **Divergence by the defining side before σ** (QGD-named 2…Nc6 Chigorin, 2…e5 Albin, 2…c5 Austrian are Black alternatives to 2…e6):
  - Group them by that move. Each group with ≥ 3 rows becomes an **auto sibling hub**, named by its deepest common name and built recursively with the same rules.
  - Smaller groups go to **Offbeat**.
  - The parent hub page lists its siblings: "Other Black 2nd moves: Albin Countergambit, Chigorin Defense…"
- **Divergence by the opponent before σ** (e.g. White's 2.Nf3 instead of 2.c4 in Benoni-named rows): attach as an **"Early deviations"** chapter. Its subtree starts at the divergence point, and learner moves inside it follow the book-move rule.
- **Anything else** goes in `unassigned`, with the reason.

The build prints a per-hub coverage table. Any curated hub below 95% coverage, counting siblings and early deviations, is a warning to fix by curation (explicit `signature` / `match`). Expect this for odd canonical rows such as Pterodactyl, Neo-Grünfeld, Old Indian and Bogo-Indian.

**Default (defining) side.** This is computed *before* σ, so the rule isn't circular.
1. The curated `side`, if set.
2. Otherwise, by name:
   - *Defense, Defence, Countergambit* → Black.
   - *Gambit, Attack, Opening, Game, System* → **the side that made `C`'s last (untrimmed) move**. This is why Englund, Benko, Latvian, Elephant and Budapest gambits → Black, and King's, Evans and Danish → White.
   - *Accepted / Declined* → **the opponent** of the gambit's side.
3. Otherwise the side that made `C`'s untrimmed last move.

Both sides are always selectable. Unit-test at least: QGD → Black, QGA → Black, King's Gambit → White, King's Gambit Accepted → Black, KID → Black, English → White, Latvian Gambit → Black, Latvian Gambit Accepted → White, Englund Gambit → Black, Benko Gambit → Black, Benko Gambit Declined → White, Evans Gambit → White.

### 4.5 Systems, chapters and lines

**Hub DAG** — the union of all paths of the hub's rows: positions are EPD nodes, edges are named-theory moves.

**Systems**
- Starting from σ, look at the learner's choice points within the first **4 learner moves after σ** (tunable), and stop early on any path whose opening name already differs from the hub's.
  - Example: Sicilian as Black. σ = `1.e4 c5`; the learner moves are 2…d6, 3…cxd4, 4…Nf6, 5…a6/g6. The Najdorf and the Dragon are the 4th learner move.
  - Najdorf + Dragon is a required fixture.
- At each choice point, every learner move whose subtree holds ≥ 3 lines (tunable) or ≥ 10% of the hub's rows becomes a **system**.
- Show at most 8 systems per side, ordered by reach. The rest go behind "More systems".
- The system's name = the deepest opening name common to ≥ 80% of its subtree's rows. Defining moves are shown in parentheses.
- Deeper learner choices are resolved by the **book-move rule**: the most master games; ties → the most descendant lines; ties → the first in data order. Every other choice is recorded as an *alternative*.
- A system must also cover **opponent deviations between σ and the system's own signature**. Example: a Najdorf system starts at σ = `1.e4 c5`, so White's 2.c3 / 2.Nc3 / 2.d4 cxd4 3.c3 become chapters. Inside those chapters, apply the book-move rule for learner moves.

**Course tree** — the hub DAG restricted to one learner move per learner-to-move position (system path ∪ book-move rule ∪ user overrides), keeping all named opponent replies.

**Approach moves.** The learner's own moves before σ (e.g. 1.e4, 2.Nf3, **3.Bb5** for the Ruy Lopez; 1…Nf6, 2…g6 for the KID) **are cards**.
- The learner plays them on the first Learn line of a course.
- After that they fast-forward as "known", and Review covers them like any other card.
- σ's defining move gets ★.

**Overrides.**
- Overrides are **per course** (`courseId, EPD → SAN`), not global, so they never leak into other courses.
- They're blocked at system-defining moves. There the UI says "Switch system" instead.
- Because overrides change the tree, tiers, reach and line lists can be per-user. The build ships default course trees; the client re-derives a course whenever it has overrides. Keep that derivation in the shared pure library and memoise it.

**Lines** — enumerate root-to-leaf paths in **descending reach probability**.
- When a path reaches a position already covered by an earlier line, the line **ends there** with a `transposesTo: <lineId>` marker. Shared positions are learned once.
- Leaf = no further named theory, or the extension end (§4.7).
- Run line extension (§4.7) **before** this step: reject lines that still have fewer than 2 learner moves after σ, and fold them into their parent line as notes.

**Chapters** — at the first opponent-to-move branch points after σ, each reply with ≥ 3 lines or ≥ 5% reach becomes a chapter. The rest group into "Other Nth moves (…)". Recurse once into sections for chapters with ≥ 12 lines.

**Naming**
- Line name = the deepest name segment(s) not already in the chapter or system name, plus "(key move)" for the move after the last branch point. If no new name exists, use the move label alone: "6…e5 line".
- Chapter name = the shared name plus the first move.
- No generic "#7" names, ever.

**Key moves** — the move that defines a name gets ★ in chips and a milestone message. Do not make it a separate study mode.

### 4.6 Statistics and reach

**Position stats** (master corpus): keep the current corpus pinning, but restructure the corpus step.
- Stream the pinned games once into a **position-stats table** keyed by `(EPD, SAN)` → `games, w, d, b` for **all positions up to `maxPly`** (§4.7), pruned to ≥ 3 games. This replaces "stats only while in book".
- Write it as a committed derived artifact, `data/derived/position-stats.v1.json.gz` (or a compact binary), with its own meta (source pins, sha256, counts). Budget ≤ 3 MB. If it's bigger, raise the pruning threshold and report.
- **Why:** the dataset build can then join stats for *any* line, including newly added ones, **without re-downloading the corpus**. That is what makes the dev watcher instant and data changes first-class.
- `npm run corpus:build` regenerates it from `data/cache/` (downloads and `zstd` as today). It is rarely needed.

**Reach probability** of a line = the product, over opponent-to-move positions after σ, of that reply's share among the course's kept replies, using master games with add-one smoothing.
- Learner moves contribute 1.
- These numbers drive tier selection, ordering ("most likely first"), chapter percentages and "covers X%".
- Label them "of master games". They are not rating-banded; say so in a tooltip.

### 4.7 Line extension beyond named theory (on by default; setting to disable)

Many TSV rows stop where the name is defined (3–6 plies), and that is exactly the "never gets into the real line" problem. Extend each leaf from position stats, using the same rules for the learner (book move = most played) and the opponent (all replies with ≥ 25% share and ≥ 8 games, max 2 branches):

- Up to **+8 plies**.
- Never beyond ply `maxPly` = max(30, deepest row + 2). Today's deepest row is 36 plies, so the position-stats table (§4.6) must use the same `maxPly`.
- Stop at the first position with fewer than 8 games.

Extended plies are flagged `ext`:
- The chip and arrow are dashed. Chessground's `DrawBrush` has no dash option, so draw these arrows with `autoShapes` `customSvg` (available in chessground 9.2.1) or with a CSS class on the arrow's SVG; chips are dashed via CSS.
- The coach labels them *"Master practice — beyond named theory"*.
- Grading is soft: any move among the top 3 in stats with ≥ 15% share is accepted and logged.

Extension edges carry no names. Document the thresholds as tunables and report how many plies extension added overall.

### 4.8 Build, watch, and hot reload

**Shared library**
- `src/lib/openings-build/` — pure TypeScript, no Node APIs: parse TSV, parse PGN annotations, replay, build graph, compute hubs, systems, courses, lines, tiers and ids, join stats, extend, diff.
- Node-only adapters live in `scripts/openings/` (fs, gzip, hashing, watching).

**Commands**
- `npm run openings:build` writes:
  - `public/data/openings.v2.json` — compact, versioned format `chess-openings-trainer/graph@2`
  - `public/data/openings.v2.meta.json` — `inputHash` over sorted file paths + contents + build-lib version; `outputHash`; counts; warnings and errors; `unassigned`; timings
  - `public/data/openings.changelog.json` — the diff vs the previous build: added, removed and renamed rows (same `rowId`, new name), plus per-hub and per-course deltas
  - `public/data/legacy-map.v1.json`
  - `supabase/seed.sql` — v2 theory tables
- `npm run openings:check` → recompute `inputHash`. Exit 1 if the committed artifacts are stale or if there are any errors. Wire it into `npm run lint`, or document it as a CI step.

**Dev**
- `npm run dev` runs `next dev` plus `scripts/openings/watch.ts` in parallel. Use `concurrently` or a tiny Node runner; justify the dependency.
- The watcher watches `public/data/all-openings/**` and `public/data/annotations/**`.
  - Use chokidar with `awaitWriteFinish`, or an equivalent that handles editor atomic-save renames, deletes and partial writes. Debounce 300 ms.
  - Keep a **replay cache keyed by row-PGN hash** and share prefixes, so an edit replays only the changed rows. A naive full chess.js replay measured about 7 s on a test VM; prefix-shared was about 2.5 s.
  - Incremental rebuild target: < 1 s. A cold full build may take longer, but report it.
  - It never crashes on bad data: it prints a clear error block and keeps the last good artifacts.
- `predev` / `prebuild` run a one-shot build, so production always ships fresh artifacts.

**Client**
- `loadDataset()` fetches the meta with `no-store`, then `openings.v2.json?v=<outputHash>`, which is long-cacheable.
- In dev only, the client subscribes to a **dev-only SSE route** that the watcher signals. Polling isn't enough: debounce + rebuild + a 2 s poll can exceed the 3 s budget.
- On a hash change, reload the dataset in place, keep the current board state if its EPD still exists, and show a toast: *"Openings updated · +2 lines · 1 renamed · Ruy Lopez, Sicilian"*, with a "See changes" link to the changelog.
- In production, revalidate on window focus at most every 10 min, and show the same toast if a deploy changed the data.
  - Production data changes still require a rebuild and deploy (`prebuild` regenerates everything). Say this in the README.
  - "Dynamic" means: no code edits, no manual steps; drop or edit files → dev updates live → deploy ships them.

**Changelog baseline:** the first v2 changelog diffs against the rows in the committed `openings.v1.json` (lichess pin `51a55d9`). After that, each build diffs against the previous build's meta.

**Gitignore and commit:** commit `openings.v2.*`, the changelog, `legacy-map.v1.json` and `seed.sql`, as today. Never commit `data/cache/`.

### 4.9 SRS: FSRS with auto-grading

- Replace SM-2 with **FSRS** via `ts-fsrs` (MIT). Verify the current version and API before using it. Use one TS implementation shared by guest and server code.
- **Auto-grade** — no rating buttons:
  - Correct with no hint → **Good**; **Easy** if answered in < 2.5 s and the card has ≥ 2 reps.
  - After H1 or H2 → **Hard**.
  - After H3, or a wrong move (not a soft-fail) → **Again**.
  - Soft-fails don't grade. The learner still has to play a book move.
- **Settings:** target retention (default 0.90), daily new-line cap, daily review cap.
  - When more cards are due than the cap, **explicitly defer** the overflow: review the lowest-retrievability cards today and push the rest to the next day(s) in that order.
  - Never drop cards. FSRS fuzz doesn't load-balance, so don't rely on it for this.
- **Forecast:** simulate the next 7 days with the user's cards and parameters, and show it on the dashboard and on the tier chooser: *"Core adds ~11 reviews/day next week"*.
- **Guest migration** (`cot.v1.*` → `cot.v2.*`, run once on load, idempotent, backup kept under `cot.v1.backup`):
  - Map each v1 card's `(openingId, epd)` via `legacy-map.v1.json` to `(side = side to move at epd, epd, answer)`.
  - The answer = the book move of the best matching v2 course at that EPD, else the most popular theory move.
  - Map SM-2 state into FSRS: stability ≈ `intervalDays` (min 0.5); difficulty from `ease` (2.5 → 5, 1.3 → 9, linear, clamped 1–10); keep `due`, `reps`, `lapses`; tag `migratedFrom: "sm2"`.
  - **Merge rule:** several v1 cards (different `openingId`s, same EPD) can collapse into one v2 key. Keep the state with the most reps (ties → the earliest `due`) and sum the lapses.
  - Migrate `cot.v1.prefs` to `cot.v2.prefs`.
  - Update `clearLocalData()` in `src/lib/prefs.ts`. It currently clears only `cot.v1.*`, so it would delete the backup and miss the v2 keys. Make it clear `cot.v2.*`, and only remove `cot.v1.backup` after the user confirms.
  - Document the mapping in the ADR and unit-test it.

### 4.10 Supabase (write it, test it locally, then ask before anything remote)

Write an ADR first (designer). Recommended direction:

- `theory_edges(from_epd, san, to_epd, …)` is already identity-free. Keep it, regenerated from v2.
- Replace `theory_openings` with `theory_lines(id text primary key, eco, name, sans text[], final_epd)`.
- Add `dataset_version(hash, built_at)`. The client compares it with its own `outputHash`; on a mismatch in a signed-in session, quizzing falls back to guest grading with a visible "server theory is updating" banner, instead of mis-grading.
- `srs_cards` → `(user_id, side, epd, answer_san)` primary key, plus FSRS fields. Add `course_progress(user_id, course_id, …)`. Migrate existing rows using the legacy map, which is emitted into the seed as a temp table.
- **Server grading stays anti-forge.** The server never needs course logic:
  - The client proposes the target line, as `0003_playlist_challenges.sql` already does.
  - The server validates every move against `theory_edges` (plus extension edges flagged as such), issues single-use challenges, grades, and schedules.
- Recommended: run FSRS scheduling in **one TS implementation** inside a Next route handler, using the existing `@supabase/server` `withSupabase` admin client. This removes the mirrored plpgsql scheduler. The ADR must weigh this against porting FSRS to plpgsql and against keeping RPCs. Either way, clients still can't write ratings or cards.
- Leaderboard views keep working.

Migrations are irreversible against real users. Produce the migration plus a dry-run script that reports row counts before and after on a local stack. Then **stop and ask me** before any remote action.

### 4.11 Coach content engine (`src/lib/coach/`)

Coach text comes from three layers, merged per message:

1. **Authored** (§4.2) — always wins.
2. **Facts** — deterministic, and only states what code has verified:
   - Name milestones and ECO.
   - Frequency and W/D/L shift vs the parent position.
   - Development count and castling.
   - Captures and recaptures.
   - Checks.
   - **Threats**: an undefended or under-defended piece attacked after the move, using chess.js `attackers`.
   - **Pins**: implement properly with ray scans along lines toward the king or queen.
   - Pawn breaks and central tension.
   - Gambits: material imbalance vs the start of the line.
   - Fianchetto.
   - Transpositions: the EPD is reachable from another named line.
3. **Stats chips** — masters % and a W/D/L mini bar.

Rules:
- Template phrasing varies, but **no claim without a check**.
- Every fact has unit tests on real positions.
- **No LLM-generated text ships in this pass.** Chessbook tried it and pulled it for inaccuracy.

---

## 5. Phases, gates, and acceptance criteria

Each phase:
1. Implement with the appropriate agent.
2. `reviewer` checks the work against this file and runs `npm run build`, `npm run typecheck`, `npm run lint` and the full test suite.
3. Fix all blocking items.
4. Commit.
5. Post a ≤ 15-line report: what changed, decisions made, deviations from this spec with reasons, open questions, next phase.

### Phase 0 — Recon and ADRs

- **scout:** inventory every use of `openingId`, `familyOf`, `openingCatalog`, `ANNOTATIONS`, `srs.ts` and the `cot.v1.*` keys, plus routes and RPC call sites.
- **designer:** ADRs in `docs/design/`:
  - `0001-data-pipeline-and-identity.md`
  - `0002-hubs-systems-lines.md` — with the thresholds as tunables
  - `0003-fsrs-and-progress-migration.md`
  - `0004-supabase-v2.md` — marked IRREVERSIBLE where it applies
  - `0005-coach-content.md`
- First commit: `git rm public/data/all-openings/postcss.config.mjs`.

### Phase 1 — Tests and data pipeline

- Add **Vitest** (unit) and **Playwright** (E2E; use the system Chromium if one is configured, otherwise install per the docs). Add `npm test` and `npm run test:e2e`.
- Implement §4.1, §4.3, §4.6 (position stats), §4.8 and the legacy map. Annotations can be stubbed until Phase 3.

**Acceptance**
- `openings:build` on the current files has **0 errors**. It prints counts and timing and reports 1 warning for `postcss.config.mjs` if the file still exists.
- Row IDs are stable across two builds. The changelog vs the v1 baseline shows +136 / −4 move sequences and the renames (verify).
- **Live dev check (Playwright + fixture copy):** while `npm run dev` runs,
  - Appending a legal row to a TSV makes it appear **in the dataset (Explore names it at its position) and in the changelog toast within 3 s** on the incremental path, with no reload.
  - Renaming a row updates its name in Explore and the changelog marks it as renamed. Hub and course appearance is checked in Phase 2.
  - Adding a row with an illegal move leaves the app on the last good data, prints `file:line` in the terminal, and `openings:check` exits 1.
  - Adding `f.tsv` works.
  - A non-TSV file is ignored with a warning.
- The position-stats artifact exists, is within budget, and joins stats onto newly added lines with no corpus download.

### Phase 2 — Hubs, systems, chapters, lines, tiers

Implement §4.4, §4.5 and §4.7.

**Acceptance**
- **Fixture tests** for σ, default side, systems, chapter names and tier sizes on QGD, KID, Sicilian, Ruy Lopez, London (unified), Caro-Kann, Italian and King's Gambit.
- **Coverage:** every TSV row is reachable from ≥ 1 course for ≥ 1 side, or listed in `unassigned`. **The target is `unassigned` = 0.** Report the number and the reason for each remaining row.
- **Prefix bug fixed:** ≥ 95% of QGD-named rows are reachable from the QGD hub (as lines, transposition attachments or early-deviation chapters) or from a sibling hub linked on its page. Today only 80/211 are reachable. KID must be 119/119.
- No top-level catalog hub has σ shorter than 2 plies unless curated. 1-ply families appear only under Offbeat.
- **No generic line names.** Every line name is unique within its course.
- **Live data, end to end:** while `npm run dev` runs, appending a legal Ruy Lopez row makes the new line appear in the right course and chapter, with a "+1 new line" badge, within 3 s.

### Phase 3 — Trainer, coach, and board

Implement §3.2 D, the hint and mistake ladders, all modes, §4.2 annotations and §4.11 coach facts.

**Acceptance (Playwright)**
- **Learn Ruy Lopez as White, Essentials:**
  - On the first line, the learner plays the approach moves 1.e4, 2.Nf3 and 3.Bb5 with prompts. On later lines they fast-forward as known.
  - Every learner move that isn't fast-forwarded shows an imperative and an arrow.
  - Every move posts a persistent feed message; clicking an old message scrubs the board.
  - A branch card appears at the first opponent branch.
  - The end card offers *Recall* and *Next line*, and Next line starts at the divergence point.
- **Mistakes:**
  - A wrong non-theory move keeps the ✕ on the board for ≥ 900 ms and posts a verdict. *Try again* animates the piece back.
  - 4.Bxc6 in a 4.Ba4 course produces a theory soft-fail with "Make it my move", and choosing it re-derives the course.
- **Hints:** H1 → H2 → H3 apply in order, and the SRS grade reflects the hint level (unit test).
- **Arrows:**
  - In the Vienna Gambit after 3…exf4, plan arrows show the next learner moves.
  - After …Ng8 (when …Qh4+ is threatened), a red threat arrow d8–h4 appears with tinted squares.
  - Unit tests cover threat detection on 10 real positions, including one with no threat.
- **Re-teach:** a wrong move in Review re-posts that position's Learn note under the verdict.
- **Keyboard:** the full flow works with no mouse.
- **Mobile:** at 375 px the board fills the width, the coach is a bottom sheet with a 30% peek, and action buttons are ≥ 44 px.
- **Visual QA:** screenshots of the catalog, hub, course and trainer (learn, wrong move, branch card, end card) at 375, 768 and 1280, in light and dark, saved to `docs/qa/phase3/` and attached to the report.

### Phase 4 — Catalog, hub, course, dashboard, explore; routing

Implement §3.2 A–C, E and F.

**Acceptance**
- Legacy URLs `/learn/[id]` and `/quiz/[id]` redirect via the legacy map.
- Search finds `najdorf`, `B90`, `e4 c5 Nf3 d6 d4` and `grunfeld` (accent-insensitive).
- The "+N new lines" badges reflect the changelog.
- Explore → "Learn this line" lands on the right course and line.

### Phase 5 — FSRS and progress migration

Implement §4.9, plus §4.10 migrations and scripts. **Do not apply anything remotely.**

**Acceptance**
- Unit tests cover the grading map, the overflow deferral, the forecast, and the guest migration (with a fixture of real v1 localStorage).
- A local Supabase dry-run report is in `docs/qa/phase5/`.
- Then **stop and ask me** before any remote migration.

### Phase 6 — Polish, performance, accessibility, stretch

- Meet the performance budgets (report the measurements).
- Run an a11y audit: axe in Playwright, 0 serious or critical issues.
- Respect `prefers-reduced-motion`.
- Add the promotion picker.
- **Stretch, in order. Each one ships only if it is complete:**
  1. **Opening Map view** (§3.2 A).
  2. **Engine on demand** (Stockfish WASM in a Web Worker, lazy-loaded, single-threaded lite build) for the eval bar and mistake refutations. Check the GPL-3.0 implications, tell me before adding it, and note the bundle size.
  3. **"What happens next" plans** from authored `[%plan]` content.

---

## 6. Out of scope for this pass (design so they plug in later)

- Game import and deviation finder (Chessbook / ChessAtlas). The card model `(side, EPD, answer)` and the position→course index make this a drop-in later.
- Sparring bots (Chessly's Levi, Chessable's bots).
- Video.
- Leagues and shops.
- A course-authoring UI. Authoring = drop PGN or TSV files into the watched folders.
- LLM-generated coach text.

---

## 7. Final report (when all phases are done or you stop for approval)

- A per-phase summary.
- Every deviation from this spec and why.
- Dataset counts:
  - rows, lines, hubs (curated / auto / offbeat), systems, plies added by extension
  - `unassigned` count
  - build time
  - dataset size
- Performance and a11y numbers.
- Screenshots index.
- Open questions.
- What's needed from me (remote migration approval, etc.).

**Rule for the report:** separate what you verified (ran, measured, tested) from what you assumed.
