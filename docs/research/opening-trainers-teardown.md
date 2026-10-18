# Opening Trainers — UX/UI Teardown

**Products:** Chessbook · Chessable · ChessAtlas · Chessreps · Chessly
**Date:** 2026-10-18
**Audience:** the Claude Code session that will rebuild this app's learning experience (see `docs/prompts/opening-trainer-v2.md`).

**Evidence labels**

- **[FH]** — first-hand. I used the product myself on 2026-10-18 in a browser:
  - the Chessbook no-login onboarding, builder and practice flow
  - the ChessAtlas public Learn-mode trainer
  - the Chessreps public London trainer
  - **Chessly, on a subscribed account:** home path, course catalog, course page, Course Explorer, a full Study variation, the Review step after it, Drill Shuffle setup and play, and the Play Levi setup
- **[R]** — reported. Taken from the product's own pages, help docs, app-store listings, review blogs, YouTube transcripts and forums. Reddit was readable only through search snippets.
- Chessable keeps its trainer behind a login. I didn't create an account, so everything about its trainer is [R].

---

## 1. One-screen comparison

| | **Chessbook** | **Chessable** | **ChessAtlas** | **Chessreps** | **Chessly** |
|---|---|---|---|---|---|
| **Model** | Personal repertoire builder (graph) | Author courses (MoveTrainer) | Courses + own repertoire | GM / community courses | Levy's courses (video-led) |
| **Unit of content** | Position→move in a per-colour graph | Flat variations inside chapters | Course > Chapter > Variation | One PGN tree → generated lines (no chapters) | Course > Chapter > Video/Study/Drill/Quiz |
| **Transpositions** | Merged (graph); move orders shuffled in review | None (line storage) | Unknown | Comments, evals and arrows keyed by FEN, so shared | None (each drill separate) |
| **Branch / depth rule** | Coverage target "1 in N games" + "Go to your biggest gap" | Author-defined; Quickstarter / Priority lines | Author-defined; trap lines first | Depth tiers: Essentials 30 / Full Mastery 64 [FH] | Chapters by opponent reply, "Weapon 1 / 2" |
| **Spaced repetition** | FSRS, per move, shared across repertoires | 8 levels 4h→6mo, per move | FSRS, auto-graded, target retention | Unnamed "Reps" | None |
| **Wrong move** | Silent snap-back + ✗ counter [FH] | Shows correct move, restarts | Silent snap-back, squares tinted [FH] | Move stays, red ✕ on square, "While fine, this course recommends…" + Try again [FH] | Move stays briefly with a red "−" badge, then reverts; the correct piece's square lights green and the lesson note for that position is shown again [FH] |
| **Hints** | Semantic description of the move [FH] + hint button | Hint button (not progressive) | Hint → "Show Solution" (2-step) [FH] | Hint button | Hint = origin square → Solution = destination square [FH] |
| **Coach text** | Short description per candidate; few annotations | Long author prose, linear | Mascot speech bubbles, YOU / BLACK pair per move [FH] | GM speech bubble, prospective "why", ends "Play bishop to f4." [FH] | Panel note per position: opponent's move + what we play next and why, replaced each move, with step-back arrows; plan and threat arrows on the board [FH] |
| **Catalog** | Plain lists of pre-made repertoires | Store with heavy filters | Card grid, filters colour/access, no search | Course cards with board thumbnail | Search, tabs (White / Black / Beginners…), "Pick up where you left off", numbered Top-10 row [FH] |
| **Stand-out** | Candidate table: Masters % · Eval · Peer results [FH] | Key Moves, soft fail, Explorer v2, bots | Deviation Finder (your vs their deviation) | Mode ladder with counters; FEN-keyed content | Plan / threat arrows; Course Explorer (position → matching studies); Levi bot with "Prevent deviations" [FH] |
| **Biggest weakness** | Review overload, thin explanations | Review pile-up, rote learning, no tree | Thin content, no stats | Doesn't explain moves; one move per position | No SRS (no due queue anywhere [FH]); drills replay every line from move 1 [FH] |

---

## 2. Product by product

### 2.1 Chessbook — the repertoire graph done right

**How it works**

- **Onboarding is a 2-minute tutorial with no login [FH].**
  - Step 1 asks your rating, platform and time control. A slider defaults to 1500, with Chess.com + Blitz selected. The copy is explicit: *"This is used to determine which moves your opponents are likely to play."* You can skip.
  - Step 2 says *"Let's add your first move — Select from the list or play it on the board."* It lists candidate first moves. Each row shows the SAN, the opening name and a one-line description (1.e4 "King's Pawn Game — 'Best by test'…"). There is also a *Show stats* toggle and *Something else…*.
- **Building a line [FH].** After you choose, the opponent's most likely reply plays itself (1…e5). The panel title then names that move: *"Choose a response to 2…Nc6."* The candidate table has these columns:
  - **Potential moves** — the SAN, plus a `?!` badge on dubious moves such as 2.f4.
  - **Masters %** — e.g. 87%.
  - **Eval** — e.g. +0.3.
  - **Peer results** — a White% / Black% bar at your rating.

  Each row also has the opening name (when the move reaches a new name) and a 1–2 sentence purpose ("Threatening the knight on c6, which is a key defender of the e5 pawn…"). *Show more* reveals the long tail.
- **Opening name under the board [FH].** It updates on every move (King's Pawn Game → King's Knight Opening → Ruy Lopez). Compact move chips sit beside it, with the current move highlighted.
- **Practice [FH].**
  - The header reads *"Practicing moves"*, with live counters: **4 Due · 0 ✓ · 0 ✗**.
  - The prompt says *"Play the correct move on the board"*, with an empty move slot "2. ＿". Under it is the description of the expected move ("The most natural move, developing the Knight with tempo"). This is a semantic hint that tells you the idea without naming the move.
  - *"I don't know, give me a hint."*
  - A wrong move simply snaps back and the ✗ counter goes up. There is no explanation.
- **Under the hood [R].**
  - FSRS (the Anki algorithm) schedules **per move, not per line**. Progress on a move is shared across repertoires.
  - The repertoire is a **graph of positions**, so transpositions merge. When several move orders reach a position, review shuffles between them.
  - Depth is controlled by a **coverage goal**: "cover positions seen in 1 in N games" (75 / 150 / 300 / 400 "bulletproof"). The app says when you've reached it, and **"Go to your biggest gap"** jumps to the most frequent uncovered reply.
  - Opponent replies are weighted by Lichess games in 200-point rating bands.
  - Other features: model games that branch from your lines (with "Guess the move"), game import that turns your deviations into review items, and repertoire **Soundness** / **Effectiveness** scores.

**Weaknesses [R]**

- Saving many moves at once creates 100–200 reviews a day.
- Most moves have no explanation, and some existing ones are wrong. LLM-written notes were tried and dropped as inaccurate.
- Bugs with large repertoires.
- Tournament players find it "rarely goes beyond the real starting position".

**Steal**

- The candidate-move table (Masters % / Eval / Peer results, plus a `?!` badge).
- The coverage stopping rule and "biggest gap".
- Per-position SRS shared across courses.
- The opening name under the board.
- The semantic hint.
- Opponent auto-reply weighted by real frequency.

### 2.2 Chessable — the course engine everyone copied

**How it works [R]**

- **Course structure:** Course → chapters → many **flat, linear variations**. For example, the Bird course has 1,326 trainable variations with an average depth of 12.6.
- **MoveTrainer:** the author's text plus the move are shown, then you're quizzed. In Learn, each variation is shown once more before it counts as learned. Review shows nothing first, either over the whole line or at random positions.
- **Spaced repetition:** 8 levels (4h, 1d, 3d, 1w, 2w, 1mo, 3mo, 6mo), timed per move. The difficulty setting can be Standard, Hard (repeat the level after an error) or Extra hard (back to L1).
- **Line types:** *Quickstarter* (the top ~10% by popularity), *Trainable*, *Alternative*, *Informational* (never scheduled) and *Priority* (from game data).
- **Key Moves:** up to 2 per variation; review starts at the key move.
- **Soft fail:** a playable alternative lets you retry instead of failing.
- **Review order:** learned order, course order or random. *Overstudy* drills without touching the schedule.
- **Since 2026:** play a bot from any position, train any sideline via right-click "Add to Repertoire (up to this move)", and Explorer v2 with masters + Chess.com stats, "Related Courses" and a Learn deep-link.

**Weaknesses [R]**

- Review pile-up, swinging between 10 and 90 minutes a day.
- Rote memory without understanding. Review drops you into a position with "no way to move backward and see how did I get here".
- **All Moves vs Key Moves is a bad choice either way.** All Moves means typing the Najdorf intro "~500 times"; Key Moves loses all context. A "review from tabiya" mode was requested but never shipped.
- You can't relearn a chapter (Learn is greyed out).
- No transpositions and no tree view. Lines get generic names like "4.Be6 #7".
- Long walls of text.

**Steal**

- Line types: informational vs trainable vs priority.
- Soft fail.
- Per-move timers.
- A time planner that forecasts load.
- "Play bot from here".
- Explorer → Learn deep link.

**Fix**

- Make "train from the divergence point" the default, with a back-scrub.
- Use a tree, not flat lines.
- Make relearning always possible.

### 2.3 ChessAtlas — a chatty coach and a deviation loop

**How it works**

- **Learn screen [FH], no login needed:**
  - A large board (brown/cream) takes ~60% of the width, with a dark card on the right.
  - Card header: a **LEARNING** pill and a breadcrumb, *"Giuoco Piano (3...Bc5, after 2...Nc6 3.Bc4)"*, titled **Main Line**, with a progress bar and a ply counter **1/19**.
- **The coach is a mascot with speech bubbles [FH].** It opens with *"Let's learn the Italian Game! Our bishop points straight at f7… Let's begin with 1.e4."* A gold arrow shows the expected move.
- **After each correct move, two bubbles appear [FH]:**
  - **YOU e4** — "This grabs central space and opens the diagonal for our bishop and queen."
  - **BLACK e5** — "Black mirrors our center pawn…"

  SAN is figurine (a knight icon + f3). Only the latest pair stays; earlier ones are replaced. There is a 🔥 streak counter.
- **Wrong move [FH]:** the piece snaps back, the from/to squares stay tinted, there's no message and the arrow remains.
- **Hint [FH]** turns into **Show Solution** (two steps). Also on the card: **→ Play** to skip, and an **SF 19 NNUE** engine toggle.
- **Under the hood [R]:**
  - FSRS with **automatic grading** (no Again/Good buttons) and a target retention setting.
  - Course → Chapters → Variations. Chapters are named by the opponent's reply and its key move: *"Classical Variation (4.c3)"*, *"Other 3rd moves (3...h6, 3...f5)"*.
  - Traps are listed first as priority lines. Master games are linked at the move where they leave the course.
  - Openings are defined by **multi-move signature positions** (Caro-Kann = 1.e4 c6 2.d4 d5), never by move 1.
  - Opening pages have a **"How deep should you study this?"** block for Under 1200, 1200–1600 and 1600+.
  - **Deviation Finder:** syncs your games and labels each deviation *your deviation (forgotten line)* vs *opponent's (new sideline)*, with one-click "Train this line".

**Weaknesses [R]**

- No explorer stats or popularity weighting.
- Deviations come without explanations.
- Thin catalog and no search.
- The editor doesn't autosave.
- Despite the name, there is no map or atlas view.

**Steal**

- Speech-bubble feed with YOU / OPPONENT pairs.
- Breadcrumb with move context.
- Two-step hint.
- Auto-graded SRS.
- Chapters named by opponent reply.
- Signature positions.
- Advice on depth by rating.
- Deviation attribution.

**Fix**

- Keep the whole feed (don't replace bubbles).
- Explain wrong moves.

### 2.4 Chessreps — mode ladder and position-keyed content

**How it works**

- **The page opens with a modal [FH]:** *"How deep do you want to go? London System · 64 lines"*:
  - **Essentials — 30 lines, "Most players start here"**
  - **Full Mastery — 64 lines**
  - *"You can change this anytime."*
- **Layout [FH]:**
  - A vertical eval bar on the far left.
  - A large board.
  - A right panel with *Learn · London System · #1*, a GM avatar, and a speech bubble with a long intro. The bubble ends in a bold imperative: **"Play pawn to d4."**
  - Below the bubble, **mode cards with counters**: Learn *0/30 discovered* (active), Practice *"1 line away"* (locked), then Drill, Time, Puzzles and Arena (locked).
  - Footer: settings, Mode, Hint and prev/next. A thin progress bar runs along the top.
- **Wrong move [FH]:** the move **stays on the board**, with a red ✕ badge on the destination square and both squares tinted. The bubble reads *"While fine, this course recommends playing pawn to d4."* with a **Try again** button, and Undo appears. The feedback grades how bad the move was ("While fine").
- **Explanation comes before the move [FH].** After 1.d4 d5 the bubble explains the *next* move (Bf4) at length and ends *"Play bishop to f4."*
- **Under the hood [R]:**
  - Comments, evals and arrows are stored per **FEN**, so transpositions are free.
  - Lines are ordered by the probability of meeting them, with coverage stats (`entryProb`, `residualRisk`).
  - The free first line is a trap.
  - Course authors are told to write *what the opponent did / what to play / why* in 1–2 sentences for every student move.
  - Exactly **one correct move per position**, and no chapters.

**Weaknesses [R]**

- "Doesn't explain the moves." There's a viral r/chess thread about it.
- At least one engine-wrong line.
- No line picker or tree browser.
- Walls of text on early moves [FH].

**Steal**

- The depth-tier modal.
- Mode cards with unlock counters.
- Wrong move left on the board with a ✕ badge and graded verdict.
- Bold imperative prompt.
- FEN-keyed content.
- A trainer at the top of the opening page.

**Fix**

- Add a line picker and tree.
- Keep text short, with "More" to expand.
- Allow multiple accepted moves.

### 2.5 Chessly — personality, video, plan arrows and a sparring bot

**How it works [FH]** (subscribed account, course *1.e4 Gotham Style Part 1: The Vienna*)

- **Home is a learning path.** A card for the current chapter ("Chapter 1 — Vienna Gambit (Accepted & Declined)") shows isometric tiles in a Duolingo-style path:
  - a ▶ video tile
  - a 📖 Study tile
  - locked tiles for what follows
- **Studies are named by the opponent's reply:** "The Gambit Accepted (3...exf4)", "Declining the Gambit (3...Nc6)", "Black Plays 3...d6", "Black Plays 2...d6", "Move 2 Sidelines".
- **XP and streak.** An "XP Earned Last 7 Days" chart sits on the left, a level badge at the top, and a trial countdown banner runs across the top.
- **Course page.**
  - Header: course blurb and a **Course Progress %** bar.
  - Chapter path, plus side cards **Play Levi** and **Drill this Opening → Drill Shuffle**.
  - A **Course Explorer** modal: a board with the course's moves drawn as arrows ("Show Course Moves" toggle), a move list, and a **"Matching Studies"** list that filters to the studies containing the current position. It's a position → lesson index.
- **Study (Learn) screen.**
  - Header: "Variation 1 of 2", a segmented progress bar, and a ⋯ menu (*Analyze Position ↗, Go to Variation ↗, Watch Video ▶, End Session*).
  - Board on the left; a text panel on the right with |◀ ◀ ▶ ▶| step arrows.
  - **Blue arrow = your next move.** Only that move is accepted; any other move is silently refused.
- **The note is prospective and replaces itself each move.** It explains the opponent's reply and what we play next and why:
  - *"Black replies with the mirror image 1...e5, the most popular reply at all levels. We develop our queenside knight. This is slightly different than 2.Nf3…"*
  - *"You MUST play Nf3 before you push d4, as this prevents Black's Qh4+."*
- **Arrow vocabulary — the richest of the five:**
  - **Green arrows** preview the *plan* several moves ahead. After 3...exf4 the panel lists "This is our plan: 4.e5, 5.Nf3, 6.d4" and the board shows green arrows for Nf3 and d4 plus a green target square on f4.
  - **Red arrows and red squares** show the opponent's *threat*: Qd8–h4 with h4 and the king's square tinted red.
  - **Blue** is the move to play now.
- **End of variation.**
  - The final note ("Success! We capture Black's e-pawn and Black is going to lose everything.").
  - A **Completed** badge, a **+5 XP** toast and a first-streak modal.
  - Buttons: **REDO** and **NEXT: REVIEW**.
- **Review**, straight after the study:
  - The same variation from move 1, with no arrows and no text. A mascot illustration fills the panel ("The more you practice, the easier it gets.").
  - A **Hint** button.
- **Wrong move in Review:**
  1. The piece lands, and a **red "−" badge** appears on the destination square.
  2. After about 1–2 s it reverts. The **correct piece's origin square lights green** (an automatic hint), and the **lesson note for that position is shown again**.
  3. The button turns into **Solution**, which also lights the destination square.
- **Drill Shuffle.** Pick a course, then tick chapters, each with its variation count (*"Select All Chapters 98 variations"*, Ch. 1 = 31). Then **START DRILL SHUFFLE**.
  - Drills read "PRACTICE · Drill 1 of 31".
  - **Every drill replays the line from move 1**, with Black's moves auto-played.
  - No text. Hint → Solution.
- **Play Levi:** "simulates how real humans at your Elo will play". Settings: difficulty, colour, course, chapters, and **Prevent deviations** ("Levi will try to not deviate from the course"). There's a Latest games list.
- **Catalog:**
  - Search, and tabs All / White Openings / Black Openings / Beginners / Middlegame / Endgame / Coming soon.
  - A **"Pick up where you left off"** card with % progress and Continue Course.
  - A numbered **Top Chessly Courses** row.
  - Blurbs in Levy's voice with pairing and level advice ("Pair this course with the 'Dark Vienna'…", "Harder to play above 2000 elo").

**Reported [R]:**
- Post-game Levi feedback with an out-of-book marker and an opening rating.
- Leagues and events.
- Quizzes and Strategy quizzes in later tiles (locked on this account).

**Weaknesses**

- **No spaced repetition [FH].** There's no due queue or review schedule anywhere. Users report "98 variations… I only remember about 1 in 3" [R].
- **Drills always restart from move 1 [FH].** The shared trunk is replayed every time.
- **Notes replace each other [FH]** and are prospective. To re-read why you played a move, you have to step back with the arrows.
- **Wrong moves get no reason [FH].** The lesson note is re-shown, but nothing says why your move was wrong.

**Steal**

- **Plan arrows** (multi-move green preview) and **threat arrows** (red, with tinted target squares).
- Studies named by the opponent's reply.
- **Course Explorer** (position → matching lessons).
- Re-showing the lesson note after a mistake.
- Learn → immediate Review of the same line.
- "Pick up where you left off".
- Weapon framing.
- A course-aware sparring bot with "Prevent deviations".

**Fix**

- Add spaced repetition.
- Start drills from the divergence point.
- Make notes persist in a feed.
- Explain *why* a wrong move fails.

---

## 3. Cross-cutting patterns — what "seamless variations" actually means

### 3.1 Getting past 1-move "openings" into real lines

All five products avoid showing "1.e4 — King's Pawn Game" as a thing to learn. They do it in three ways:

1. **Signature positions** (ChessAtlas, Chessreps). The opening *starts* at a multi-move position (Caro-Kann = 1.e4 c6 2.d4 d5). Earlier moves are an approach that plays out quickly.
2. **Your moves fixed, opponent's moves branch** (all five). A course commits to one move per position on the learner's side. The tree only fans out on the opponent's moves, so a "line" is always a concrete path 12–16 plies deep.
3. **Chapters named after the opponent's reply plus its key move** (ChessAtlas, Chessly): *"Hungarian Defense (3...Be7)"*, *"Weapon 1: 4...Nc6"*, *"Other 3rd moves (3...h6, 3...f5)"*. The learner always knows which branch they're in.

### 3.2 Integrating variations while you learn

**Best observed**

- Chessbook names the opponent's move in the prompt ("Choose a response to 2…Nc6") and updates the opening name under the board every ply.
- ChessAtlas's breadcrumb carries move context ("3...Bc5, after 2...Nc6 3.Bc4").
- Chessreps orders lines by the probability of meeting them and tiers them (Essentials / Mastery).
- Chessable "Learn Next" and review start from where the next line diverges. Your current app's `startPlyFor` already does this.

**Missing everywhere**

- A **visible branch map** inside the trainer showing where you are, which lines are done and what's next.
- A coach line at each branch point saying *"Black's main tries here are A (68%) and B (22%); we'll take A first."*

### 3.3 Wrong-move handling, ranked

1. **Chessreps [FH]** — the move stays on the board with a ✕, a graded verdict and *Try again*. Best of the five.
2. **Chessly [FH]** — a red badge, then revert. The origin square of the correct piece lights automatically and the lesson note for that position is re-shown, then Solution is offered. It re-teaches well but never says why your move was wrong.
3. **Chessable [R]** — soft fail for playable alternatives; shows the correct move.
4. **ChessAtlas [FH]** — silent snap-back with tinted squares.
5. **Chessbook [FH]** — silent snap-back plus the ✗ counter.

**None of them explain *why* a wrong move fails** with a concrete refutation.

### 3.4 Coach messages

- **Format.** The best format is a **persistent chat-style feed** (ChessAtlas bubbles) where each message is tied to a ply, plus a **bold imperative** (Chessreps) and short **what / play / why** notes (Chessreps author guide).
- **The best board companion** is Chessly's [FH] arrow vocabulary: blue = play now, green = plan several moves ahead, red = opponent threat, with tinted target squares. The board explains as much as the text does.
- **What fails.** Walls of text (Chessreps intro, Chessable), messages that are replaced (Chessly and ChessAtlas both overwrite the previous note [FH]), and no explanation at all (Chessbook).

### 3.5 Opening selection

- Card grids split **White / Black**. A mini-board at the signature position (Chessreps) is the strongest visual.
- Useful metadata on each card:
  - line count and average depth (Chessable)
  - level and pairing advice (Chessly)
  - difficulty tag and ECO range (ChessAtlas)
- Search is missing at ChessAtlas and weak elsewhere.
- **Nobody has a visual map of the opening tree.** That's an open opportunity.

### 3.6 Retention and workload

- **Per-position FSRS beats per-line.** Chessbook and ChessAtlas both moved to FSRS.
- **Auto-grade from correctness and hint use.** ChessAtlas does this; nobody likes Again/Good buttons for chess.
- **The workload must be controlled.** Chessbook (100–200 reviews a day) and Chessable (10–90 minutes) both generate complaints. Use a daily new-line cap, a forecast, and a "comeback" relearn instead of wiping progress.

---

## 4. Synthesis — the design principles for our app

1. **Position-first data.** The graph is keyed by EPD. Content (comments, arrows), stats and SRS cards attach to positions or moves, never to row indices or move-order strings.
2. **Hub → System → Chapter → Line.**
   - An opening *hub* (Sicilian Defense) offers *systems* as weapons (Najdorf, Dragon…).
   - A system is a course where your moves are fixed.
   - Chapters are the opponent's replies, named with key moves.
   - Lines are concrete leaves.
3. **Signature positions, not first moves.** Approach moves fast-forward. 1–2-ply names are breadcrumbs, not courses.
4. **Depth by probability.** Use Essentials / Core / Complete tiers with an explicit "covers 92% of master games" number, plus "next biggest gap".
5. **Always know where you are.** Show a breadcrumb of names, a mini branch map, move chips, a coach line at every branch point, and a Course-Explorer-style position → lines index (Chessly).
5b. **The board teaches too.** Use a fixed arrow vocabulary: play now, the plan for the next few moves, the opponent's threat with tinted squares, alternatives, and authored highlights (Chessly's plan and threat arrows, generalised).
6. **Every message persists and is clickable.** The feed is tied to plies; clicking a message scrubs the board. Notes are 1–2 sentences with "More" to expand.
7. **Mistakes teach.** A graded verdict comes first: theory alternative → soft-fail with "switch my repertoire to this?"; playable → "while fine…"; bad → show the refutation. Then a progressive hint ladder (idea → piece → arrow), and the hint level feeds the SRS grade.
8. **Train from the divergence point.** Shared trunks fast-forward, with a scrub-back for context. You can always relearn; nothing ever needs wiping.
9. **Auto-graded FSRS with workload control.** Daily caps, a forecast and target retention.
10. **Data changes are first-class.** New or edited TSVs show up automatically with a diff ("+3 new lines in Ruy Lopez"), and progress survives.

---

## 5. Audit of the current app (verified 2026-10-18)

Facts checked against the repo and the files in `public/data/all-openings/`:

- **The new TSVs are lichess-org/chess-openings `master`, byte-for-byte.** The SHA-1 of all five files matches upstream. The current dataset was built from the older pin `51a55d9`. Differences:
  - 3,865 rows vs 3,733
  - +143 / −11 rows
  - 136 new move sequences and 4 removed
- **`public/data/all-openings/postcss.config.mjs` is a byte-identical copy of `a.tsv`** (same SHA-1). It was almost certainly added by accident. A loader that globs every file in the folder would double-load the A-section.
- **Every row replays legally with chess.js. No two rows share a PGN, and no two share a final position.** 308 names are reused by different rows, so a name is **not** a key.
- **Progress is keyed by `openingId` = the row's index in `openings.v1.json`.** This applies to `srs_cards`, `opening_progress`, `quiz_challenges`, and localStorage `cot.v1.*`. Any data change reorders the indices and silently attaches progress to the wrong openings.
- **Learn mode can't reach large parts of many openings.**
  - `familyOf()` treats a family as "every line that extends the **shortest** row of that name" (ties → most popular). It has no transposition or sibling handling.
  - On the shipped `openings.v1.json`, **533 of 3,733 rows** are unreachable from their family's Learn page:
    - QGD (root `1.d4 d5 2.c4 e6`): 114/171 lost
    - KID (root `…3.Nc3`): 26/119 lost
    - Semi-Slav: 53/68 lost
    - Benoni (root `1.d4 c5`): 43/61 lost
    - King's Gambit Declined: 32/53 lost
  - On the new TSVs it is about 570 of 3,865, and only 80 of 211 QGD rows are reachable.
  - The Learn catalog shows only the top 30 families.
  - 13 families have no row with exactly the family name, and 40 have several.
- **Catalog roots are often 1–2 plies.**
  - 20 family roots are a single ply (Amar 1.Nh3, Grob 1.g4, Polish 1.b4…) and 29 are two plies.
  - Families split by name ("King's Gambit" vs "King's Gambit Accepted" vs "…Declined").
- **Explanations:**
  - 74 hand-written annotations, keyed by **move-order string**, so transpositions miss them.
  - The remaining text comes from heuristics. Some don't work: `createsPin()` always returns `false`.
- **Feedback and board:**
  - A wrong move in Learn = a 0.35 s shake. No reason, no hint escalation.
  - `Board.tsx` always promotes to a queen. No underpromotion exists in the current TSVs, so this is latent.
- **No test suite.** The `.claude/agents` definitions (builder, engineer, reviewer) all assume one exists.

---

## Sources

**Chessbook**
- https://chessbook.com/ (first-hand)
- https://64squares.substack.com/p/chessbook-review
- https://saychess.substack.com/p/an-interview-with-marcus-buffett
- https://publish.obsidian.md/chessbookwiki/Chessbook+Spaced+Repetition+System
- https://chessbook.com/blog/chessbook-year-review-2024
- https://chessbook.com/repertoires
- https://www.youtube.com/watch?v=h5k3qCdNGEY

**Chessable**
- https://www.chessable.com/movetrainer/
- https://support.chess.com/en/articles/10319322-how-does-the-spaced-repetition-scheduling-work
- https://support.chess.com/en/articles/10319325-what-are-key-moves
- https://support.chess.com/en/articles/10319277-what-are-informational-lines
- https://chessentials.com/chessable-honest-review/
- https://www.chessable.com/blog/train-any-line-you-want-subvariations-are-now-trainable/
- https://www.chessable.com/discussion/thread/995327/opinions-on-move-trainer-/995334/

**ChessAtlas**
- https://app.chessatlas.net/library/italian-game (first-hand)
- https://chessatlas.net/features/spaced-repetition
- https://chessatlas.net/docs/find-opening-mistakes
- https://chessatlas.net/openings
- https://www.chesspivot.com/en/reviews/chessatlas

**Chessreps**
- https://www.chessreps.com/opening/london (first-hand)
- https://www.chessreps.com/course-author-guide
- https://www.chessreps.com/about
- https://www.reddit.com/r/chess/comments/1tc3l1c/

**Chessly**
- https://chessly.com/public/courses
- https://old.chessly.com/courses/a7d23f32-20fb-4cf9-9b56-7e63329f55e7
- https://www.youtube.com/watch?v=QYutDS0CTCo
- https://www.youtube.com/watch?v=OfZ1thrQrAQ
- https://www.youtube.com/watch?v=CEj9pxVCEaw

**Data source**
- https://github.com/lichess-org/chess-openings
