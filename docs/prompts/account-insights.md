# Claude Code Prompt — Account Insights (Chess.com + Lichess)

## 0. Your mission

Let a player link their Chess.com and/or Lichess account, import their recent
games, and answer three questions on a new **Insights** page:

1. **Where do my openings go wrong?** Where I leave book, who left first, and
   the moves I keep getting wrong in the same positions.
2. **How do my openings actually score?** Results per opening and color,
   from my own games.
3. **What should I learn next at my level?** Opening recommendations for my
   rating, each with a reason and a one-click link into the existing trainer.

Every finding must link to something the player can practise right now: a
course, a line, or the exact position in `/train/...`.

## 1. Ground rules

- Read the codebase first: `src/lib/openings*`, `src/lib/trainer/`,
  `src/lib/engine/`, `src/lib/progress/`, `src/lib/server/`,
  `supabase/migrations/`, `docs/design/`. Reuse the theory graph, the courses,
  the Stockfish worker and `classify()`; don't build parallel versions.
- Write an ADR (`docs/design/0006-account-insights.md`) before any code: data
  flow, storage, rate limits, privacy. Stop and show it to me.
- Tests first for every pure function (PGN → plies, book matching, deviation
  aggregation, rating bands, recommendation scoring), using fixture games
  checked into `src/lib/insights/__tests__/fixtures/`.
- Supabase: write the migration (`0006_...sql`) and test it, but **ask before
  anything touches the hosted project**. Never run `supabase config push`;
  it applies immediately and resets every omitted `[auth]` setting.
- Keep everything that exists: WCAG AA in both themes, reduced motion,
  keyboard navigation, phone width without horizontal scroll, guest mode.
- Make no claim the data can't back. Every number on the page must come from
  the imported games or from the dataset.

## 2. Data sources (verify each against current docs before relying on it)

**Lichess** (no auth needed for public games)
- Games: `GET https://lichess.org/api/games/user/{username}` with
  `Accept: application/x-ndjson`. Use `max`, `since`, `rated=true`,
  `perfType`, `opening=true`, and `evals=true` (server analysis, when present).
- Profile and ratings: `GET https://lichess.org/api/user/{username}`
- One request at a time; on 429, wait at least 60 s. Streams can be long:
  read incrementally.
- Optional later: OAuth (PKCE) to prove the account is theirs.

**Chess.com** (Published-Data API, read-only, no auth)
- Archives: `GET https://api.chess.com/pub/player/{username}/games/archives`
  returns monthly URLs; each month is
  `GET .../games/{YYYY}/{MM}` (pgn, time_class, rules, ratings, result).
- Ratings: `GET https://api.chess.com/pub/player/{username}/stats`
- Send a descriptive `User-Agent` with contact info, make serial requests,
  and handle 429 and 404 (unknown user).
- There's no OAuth, so a linked Chess.com name is "linked", not "verified".

**Scope of an import:** rated, standard chess only (no 960 or variants).
Default to the last 3 months or 200 games, whichever is smaller, configurable.
Time classes: rapid, blitz and classical by default; bullet optional.

Fetch through server routes (`/api/insights/import/{platform}`) so we control
the User-Agent, caching and rate limits; browsers can't set the User-Agent.

## 3. Product design

### 3.1 Linking (Settings → Account, plus an onboarding card on Insights)
- Enter a username per platform. Validate that it exists (show the profile
  name and current ratings), then import with visible progress.
- Re-sync button (also automatic when stale, e.g. older than 24 h).
- Unlink deletes that platform's imported data.
- Guests can analyse a username too; results are kept in this browser only.

### 3.2 Insights page (`/insights`, added to the header nav)
- **Summary:** games imported, rating per time class, date range.
- **Where you leave book:** for each opening you play (by color), the
  average ply you leave theory, who deviated first (you or your opponent),
  and the score after leaving.
- **Repeat mistakes:** positions where you made the same non-book move two
  or more times. Show the position (MiniBoard), your move, the theory move,
  how often, your score in those games, and the engine verdict (Stockfish
  via the existing worker, under a time budget, or Lichess evals when
  present). One button: "Train this line" deep-links to `/train/...` at
  that position.
- **Results by opening:** a table of opening and color with games, W/D/L,
  and score, sortable. Hide openings with too few games instead of showing
  noisy percentages.
- **Recommended for you:** see 3.3.

### 3.3 Recommendations
- **Rating band** from the platform ratings, banded per platform (don't
  pretend Chess.com and Lichess ratings convert exactly).
- Three kinds, each showing a one-line reason built from data:
  1. **Fix:** openings you already play but leave early or score badly in
     ("You leave the Italian by move 5 in 60% of games").
  2. **Fill:** gaps in your repertoire ("No consistent answer to 1.d4 as
     Black: 18 games, 7 different replies").
  3. **Grow:** courses that suit your band. Weigh course size (lines and
     depth), how forcing the theory is, and how the openings score at
     similar ratings when the dataset supports it.
- Every recommendation links to its course in the catalog, plus "Start
  learning" into the trainer.
- Make the scoring a pure, tested function with its weights in one place.

## 4. Data and storage

- **Supabase migration:**
  - `linked_accounts`: user_id, platform, username, linked_at,
    last_synced_at.
  - `game_summaries`: derived fields only. Platform game id, platform,
    color, time class, played_at, result, ratings, ECO and opening name,
    out_of_book_ply, deviated_by, deviation EPD, played SAN, book SANs.
  - Both tables have RLS limited to the owner, with `on delete cascade`
    from `profiles`, so the existing account deletion removes them.
- Don't store raw PGNs unless the ADR justifies it; derive and discard.
- **Book matching:** walk each game's moves through the existing theory
  graph and course trees, using the same EPD keys and normalisation as the
  trainer. Record the last book ply, the first non-book move and who
  played it.
- Make imports idempotent: re-syncing never duplicates games (unique on
  platform + game id) and only fetches what's new.

## 5. Phases and acceptance criteria

- **Phase 0:** ADR, API verification notes (actual responses captured as
  fixtures), and the migration draft. Stop for my approval.
- **Phase 1:** pure library (`src/lib/insights/`) — parsing, book matching,
  aggregation, rating bands, recommendation scoring. Full unit tests on
  fixtures.
- **Phase 2:** import routes, both platforms, with rate limiting, caching
  and progress. Errors for an unknown user, 429 and network failure.
- **Phase 3:** Insights page and linking UI. e2e test with mocked API
  responses (no live calls in tests); axe AA in light and dark.
- **Phase 4:** engine verdicts on repeat mistakes (budgeted, cancellable),
  deep links into the trainer, and the dashboard card ("3 positions you keep
  getting wrong").

**Done when:** a real Lichess and a real Chess.com account each import
without errors; every insight links to a trainable line; re-sync adds only
new games; unlink and account deletion remove all derived data;
`npm run lint`, `npm run typecheck`, `npm test` and the e2e suite pass.

## 6. Out of scope (design so they plug in later)

Lichess OAuth verification, middlegame and endgame analysis, time-trouble
stats, opponent preparation, and importing games from other sites or PGN
upload.

Friends / following (next run): store insights per user with a visibility
setting in mind, so a later feature can show a player's ratings, openings and
progress to people they allow, without reshaping these tables.

## 7. Final report

What shipped, test results with real numbers, anything skipped and why,
remaining risks (API changes, rate limits), and anything I need to do
remotely (migration, environment variables).
