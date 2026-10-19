# ADR 0006 — Account Insights (Chess.com + Lichess)

- **Status:** accepted (Phase 0, 2026-10-19). The owner's decisions are recorded under "Decisions". Migration `0006_account_insights.sql` is tested locally; the owner applies it to the hosted project.
- **Spec:** `docs/prompts/account-insights.md`.
- **Evidence:** `docs/qa/insights/phase0/api-verification.md` (live responses, 2026-10-19), with fixtures in `src/lib/insights/__tests__/fixtures/`.

## Context

What exists and gets reused (spec §1):

| Piece | Where | Used for |
|---|---|---|
| Theory graph, EPD-keyed (`Model`: 9,934 nodes, 3,865 rows, `maxPly` 38) | `openings-build/model.ts`, loaded client-side by `dataset-live.ts` | Book matching |
| Normalised SAN (`normSan`: strip `+#?!`) and `epdOf` | `openings-build/model.ts`, `replay.ts` | The same keys as the trainer and the SRS cards |
| Position → `[course, line]` index for the side to move (`catalog.pos`) | `openings-build/catalog.ts` | Deep links. 6,917 of 9,934 nodes have an entry. |
| Course derivation (`courseFor`), hub `level`, `against`, tiers | `trainer/client.ts`, `catalog.ts` | Recommendations |
| Trainer deep links: `?li=<index>&start=<ply>`, `?line=<id>`, `?mode=drill&under=<epd>` | `components/trainer/TrainerClient.tsx` | "Train this line" |
| Stockfish worker, one search at a time; a new request supersedes the old one | `engine/engine.ts` | Verdicts on repeat mistakes |
| `classify(before, after)`: drop ≥ 300 blunder, ≥ 120 mistake, ≥ 50 inaccuracy | `engine/uci.ts` | The same thresholds as the trainer |
| Server convention: clients only `SELECT` their own rows; writes go through `withSupabase({auth: "user"})` routes plus the service role | ADR 0004, `/api/train/*` | Insights writes |
| Account deletion: deleting `auth.users` cascades through `profiles` | `/api/account` | Removes insights too |

Dataset limit: position stats come from **master games only** (Elo ≥ 2200 both sides, ADR 0001). The Lichess explorer's rating-filtered database answers **401** without a token. So "how the openings score at similar ratings" (spec §3.3 Grow) is **not supported by any data we have**, and is left out (see Recommendations).

## Decision 1 — Who fetches the games

| Option | Rate limits | Server cost / abuse | User-Agent | Guests |
|---|---|---|---|---|
| **A. Server routes fetch** (`/api/insights/import/{platform}`, as the spec says) | Every user shares the **deployment's IP**. Lichess: "only make one request at a time", so two concurrent imports from one IP invite a 429 that blocks *everyone* for ≥ 60 s. Serverless instances can't serialise without a DB lease. | A 200-game Lichess import streams for about 10 s (20 games/s anonymous) per request. Guest imports make our IP a free proxy for scraping any username; that's the IP Lichess would block. | Ours, with contact info | Same server path, needs per-IP limits |
| **B. Browser fetches directly; server stores derived rows (recommended)** | Per visitor IP, as if the player opened their own profile. One request at a time per platform in the client. | Nothing to proxy. Our routes only receive small derived rows. | The browser's (can't be set). Chess.com *recommends* a contact UA but doesn't require one; Lichess doesn't ask for one. Requests still carry our `Origin`. | Identical path, nothing leaves the browser except the calls to the platform |
| C. Server proxies, client derives | As A | As A | Ours | As A |

**Verified facts behind B:** both APIs send `access-control-allow-origin: *`. `Accept` is a safelisted header, so there's no preflight. Chess.com's docs say the endpoints "can be called, by any kind of client or browsers". The spec's reasons for A were User-Agent, caching and rate limits. The UA is optional. HTTP caching works in the browser too: Chess.com sends `ETag`, and the browser revalidates it. Rate limits are the reason *against* A.

**Decision: B** (accepted by the owner).

What would change it:
- Lichess OAuth (out of scope): the token would live server-side, so fetching moves to the server for verified accounts.
- Either platform dropping CORS. Then add option C as a fallback behind the same `Source` interface (below) and accept the shared-IP limits.
- Wanting server-verified data for the friends feature. See Privacy.

**Rejected, for the record: A.** If it's ever needed, the library, schema and UI below are unchanged. The `Source` adapters run in the route, and the extra work is:
- a `platform_throttle(platform, busy_until, cooldown_until)` lease table;
- per-IP guest limits;
- streaming progress (NDJSON response).

## Decision 2 — Derivation runs in the pure library, in the browser

`src/lib/insights/` follows ADR 0001's rule: no Node or DOM APIs, chess.js only, runs in Vitest unchanged. Modules, all test-first on the fixtures:

| Module | Pure function(s) |
|---|---|
| `sources/lichess.ts` | `parseLichessGame(json, me) → NormalGame \| Skip` |
| `sources/chesscom.ts` | `parseChesscomGame(json, me) → NormalGame \| Skip`; `monthsToFetch(archives, since, now, months)` |
| `filter.ts` | Scope (spec §2): standard rules only (`variant: "standard"` / `rules: "chess"` and `initial_setup` = start FEN), rated only, time class in the chosen set (default rapid, blitz, classical; bullet optional). Daily and correspondence are excluded. The window is last 3 months or 200 games, whichever is smaller (configurable). |
| `book.ts` | `maxBookPly(model) → n`; `matchBook(model, sans, color) → BookMatch` |
| `aggregate.ts` | `byOpening`, `leaveBook`, `repeatDeviations`, `summary` |
| `bands.ts` | `bandOf(platform, timeClass, rating)` |
| `recommend.ts` + `weights.ts` | `recommend(model, catalog, summaries, bands) → Rec[]`. All weights and thresholds live in `weights.ts`. |
| `links.ts` | `trainLink(model, catalog, path, color) → href` |

```ts
interface NormalGame {
  platform: "lichess" | "chesscom";
  gameId: string;            // "BCi6IZfn" | "live/183193101523"
  color: Side; timeClass: "bullet" | "blitz" | "rapid" | "classical";
  playedAt: string;          // ISO; Lichess lastMoveAt, Chess.com end_time
  result: "win" | "draw" | "loss";
  myRating: number | null; oppRating: number | null;
  eco: string | null; openingName: string | null;     // the platform's, display only
  sans: string[];            // whole game; never stored, never sent to our server
  evals: (Score | null)[] | null;                     // Lichess `analysis`, White's side, per ply
}
```

- Chess.com games are parsed with `chess.js` `loadPgn` (clock comments are dropped). Lichess `moves` is already space-separated SAN, replayed with chess.js to get EPDs and to reject illegal input.
- Opponent usernames are read only to work out `color`, then dropped.

## Book matching

Walk the game from `START_EPD` with chess.js, computing `epdOf(fen)` at every ply:

1. A move is **book** when the current node has a move with `norm === normSan(san)` and `to >= 0`, meaning a theory edge or an extension edge (`ext`). Extension edges are the master practice the courses already teach (ADR 0002), so they count as book.
2. **Transposition.** If the move isn't an edge but the resulting EPD is a known node (`model.byEpd`), the game is still in book there, and the walk continues from that node. The trainer and the SRS cards key on EPD, so a transposed position is just as trainable.
3. Stats-only moves (`to = -1`) are off book. Their master counts are shown ("masters played this 14 times"), not judged.
4. The walk stops at the first non-book move. It can't go past `n`, the longest theory path in the dataset (`maxBookPly(model)`, the longest chain of theory and extension edges from the start: **36 plies today**, equal to the deepest row).
5. It records:
   - `bookPly`, the plies in book;
   - `deviatedBy`: the side to move at the deviation vs `color` → `me` / `opponent`, or `none` when the game ended in book;
   - `deviationEpd`, `playedSan` (normalised);
   - `bookSans`, the theory moves available there;
   - `path`, the node indices (kept in memory for deep links and naming).

The opening is named by `deepestName(model, path)` (the dataset's names, the same as everywhere else in the app), grouped by `family` and color. The platform's own ECO and name are shown as secondary text only: Lichess and Chess.com name the same position differently.

Probe on the fixtures: out-of-book ply 3–12 (Lichess) and 2–16 (Chess.com). Numbers in the verification notes.

## Repeat mistakes

- **Candidates:** group the player's own deviations by `(deviationEpd, playedSan)`; keep groups with ≥ 2 games.
- **A candidate is called a mistake only with an evaluation**, so the page makes no claim the data can't back. A titled player's `1.e4 c5 2.c3 Qa5` is a deliberate sideline, not a mistake. Evaluation sources, in order:
  1. Lichess server analysis, when every game in the group has it. Before = `analysis[k−1]` and after = `analysis[k]` for deviation ply `k`, converted to the mover's side.
  2. Otherwise Stockfish through the existing worker:
     - `analyse(fen)` at the deviation for *before*, and after the played move for *after* (negated: the opponent is to move);
     - 700 ms each;
     - the 10 most frequent groups only;
     - one search at a time, cancelled by a generation token when the page unmounts or a re-sync starts;
     - results cached in `localStorage` keyed `epd|san|movetime`.
- `classify(before, after)` gives the verdict, with the trainer's thresholds. `playable` groups are listed as **"Your sideline"** (count, score, theory move) without the word mistake.
- With no evaluation (engine unavailable, budget spent), the group is shown as a repeat deviation with "not evaluated".
- Shown per group: MiniBoard at `deviationEpd`, your move, the theory move(s), how often, your score in those games, the verdict, and **Train this line**.

## Deep links (every finding links to something trainable)

`trainLink(path, color)`:
1. Take the deepest node on the book path where the **player is to move** and `catalog.pos` has an entry for that side. For a repeat mistake that is the deviation node itself whenever it has one.
2. Link to `/train/{hub}/{system}/{side}?li={line}&start={ply}`, where `ply` is the node's index in that course line. Both parameters exist today, so the trainer needs no change.
3. When no node on the path qualifies (about 30% of nodes have no entry; 4 of 15 Lichess fixture games missed at the final node, before the fallback), link to the hub course of the deepest named row (`/openings/{hub}/{system}/{side}`).

Phase 1 tests assert that every fixture finding gets a link, and report how many took the fallback.

## Aggregation (spec §3.2)

| Section | Definition |
|---|---|
| Summary | Games imported per platform and time class; date range; current rating per time class from the profile (not from games). |
| Where you leave book | Per (opening family, color): average `bookPly` (shown as a move number), the share deviated by me / by the opponent, and the score in each split. |
| Results by opening | Per (opening family, color): games, W/D/L, score = (W + ½D) / N. Rows with N < `MIN_GAMES` (default 5) are hidden behind "N openings with fewer than 5 games". Sortable by each column. |
| Repeat mistakes | As above. |

Every number is computed from the imported summaries. No platform-wide or master statistic is shown as the player's own.

## Rating bands

- Per platform and time class, from the profile rating at the last sync (Lichess `perfs.*.rating`, Chess.com `stats.chess_*.last.rating`). They are **never converted** between platforms.
- A provisional rating (Lichess `prov`, Chess.com `rd` > 100) is shown as "provisional", and bands then use one band lower for Grow.
- Proposed edges, in `weights.ts`:

| Band | Lichess | Chess.com |
|---|---|---|
| 1 Beginner | < 1300 | < 800 |
| 2 Improving | 1300–1599 | 800–1199 |
| 3 Club | 1600–1899 | 1200–1599 |
| 4 Strong club | 1900–2199 | 1600–1999 |
| 5 Expert+ | ≥ 2200 | ≥ 2000 |

- When both platforms are linked, recommendations use the platform with more games in the window. The page says which.

## Recommendations (spec §3.3)

`recommend()` is pure. Weights and thresholds live in `weights.ts`. Each recommendation has a reason string built only from numbers it computed, plus two links: the course in the catalog, and **Start learning** (`/train/...` in learn mode).

1. **Fix.** An opening family the player has at least `MIN_GAMES` games in, where either:
   - the player leaves book early (`deviatedBy = me` and `bookPly < EARLY_PLY` = 10) in at least 40% of games, or
   - the score is ≤ 40%.

   Score = `w.early·earlyShare + w.score·max(0, 0.5 − score) + w.volume·log2(N)`. Example reason: "You leave the Italian by move 5 in 60% of games (9 of 15)". Links to the course from `trainLink`.
2. **Fill.** For each first move the player faces as Black (`against`: e4 / d4 / other), and as White for each Black reply with at least `MIN_GAMES` games:
   - collect the player's replies;
   - with N ≥ 10 and the top reply's share < 50%, recommend the hubs whose `against` matches and whose `level` fits the band;
   - score = `w.gap·(1 − topShare) + w.volume·log2(N)`.

   Example reason: "No consistent answer to 1.d4 as Black: 18 games, 7 different replies".
3. **Grow** (decided 2026-10-19): a set of common openings for each level, ranked by the player's style.
   - **The per-level sets** come from the catalog, not from a hand-kept list, so they follow dataset changes:
     - hubs with `placement: "top"`, for the player's side, grouped by the hub's `level`, ordered by `games` (most common first);
     - today that is 48 hubs: 20 beginner, 27 intermediate, 1 advanced;
     - band → levels: bands 1–2 → beginner; 3 → beginner + intermediate; 4 → intermediate + advanced; 5 → any.
     - For Black, only hubs whose `against` matches a first move the player actually faces (most-faced first).
   - **Excluded:** hubs the player already plays, meaning any imported game whose book path reaches the hub's σ node.
   - **Style profile** from the player's own games. Each game whose book path reaches a hub's σ adds that hub's `tags` (`gambit`, `solid`, `sharp`, `system`), so the profile is the share of games per tag. Games in untagged hubs count toward the total but toward no tag.
     - Affinity(hub) = the sum of the profile's shares over the hub's tags, or 0 for an untagged hub.
     - With fewer than `MIN_GAMES` tagged games, the profile is "unknown" and style is left out of the score (and out of the reason).
   - **Score** = `w.common·(1 − rank / setSize) + w.style·affinity + w.level·exactLevel`, where `exactLevel` is 1 when the hub's level is the band's first level. The weights are in `weights.ts`.
   - **Example reason:** "Common at your level (Lichess blitz 1712) and close to how you play: 64% of your games are in solid openings". The style clause appears only when the profile is known.
   - **Omitted:** "how the openings score at similar ratings". The dataset is masters-only and the rated explorer needs a token. The UI never claims win rates at the player's level. That criterion can plug in later as one more weighted term, e.g. if Lichess OAuth gives explorer access.

## Storage (migration `0006_account_insights.sql`)

- `linked_accounts(user_id, platform, username, verified, ratings jsonb, visibility, linked_at, last_synced_at, last_game_at)`
  - Primary key `(user_id, platform)`.
  - `verified` stays false until an ownership proof exists. Chess.com has no OAuth, so a Chess.com link is always "linked", not "verified".
  - `visibility` (`private` default / `friends` / `public`) is reserved for the friends feature. Nothing reads it yet.
  - Usernames aren't unique across users: anyone can type a public name.
- `game_summaries`
  - Primary key `(user_id, platform, game_id)`: re-sync never duplicates. The key is per user because two users can import the same game, e.g. as opponents.
  - Columns:
    - `color, time_class, played_at, result, my_rating, opp_rating, eco, opening_name`
    - `opening_plies text[]` (the first `n` plies), `book_ply`, `deviated_by`, `deviation_epd`, `played_san`, `book_sans`
    - `eval_before`, `eval_after` (Lichess analysis, mover's side)
    - `dataset_hash`, `imported_at`
  - FK to `profiles` and a composite FK to `linked_accounts`, both `on delete cascade`, so **unlinking deletes that platform's summaries and account deletion deletes everything.**
  - Checks keep the shapes honest: deviation fields present iff deviated, enums, lengths.
- **`opening_plies` = the first `n` plies of each game** (decided 2026-10-19). `n` = `maxBookPly(model)`, 36 today, computed from the dataset and never hard-coded. No game can be in book past ply `n`, so nothing later can matter to book matching. The spec says to derive and discard PGNs; this is the one exception.
  - **Where it's kept:** in the DB for signed-in players, and in `localStorage` for guests (with the rest of their summaries).
    - The DB copy lets another device re-match after a dataset change without re-fetching. It's about 36 short strings per game.
    - It's also what the deep link walks.
  - **Dataset changes** (ADR 0001 live builds): summaries re-match locally when `dataset_hash` changes, with no re-fetch. Chess.com months are about 4 KB per game, and old games may also be gone or private by then.
  - **A game that leaves book right after ply `n`:** its deviating move (ply `n + 1`) is kept only in `played_san`, so `book_ply` may equal the number of stored plies.
  - **Column cap:** the column allows up to 38 plies (the dataset's `maxPly`). `n` can't pass that without a corpus rebuild (ADR 0001: rows deeper than `maxPly − 2` warn), so a deeper dataset still syncs; one beyond 38 needs a migration that raises the cap.
  - The deep link needs the path.
  - It holds only opening moves: no headers, clocks, opponent names or later moves. These are public games anyway.
- **Not stored:** full PGN or moves past ply `n`, opponent usernames, clocks, accuracy, or the platform's per-move analysis beyond the two numbers at the deviation.
- **Size and retention:** about 0.5 KB per row. A sync keeps the newest **1,000 games per platform** and prunes older rows in the same request.
- **RLS:** own-row `select` for `authenticated`; nothing for `anon`; `all` for `service_role`. Defaults are revoked first, as in 0004, so there's no client TRUNCATE.
- **Test:** `scripts/supabase/test-0006.sh` (local Postgres only; refuses other hosts). It applies 0001–0006, then 0006 again (idempotence), and checks:
  - dedupe, the FK to the linked account, and the shape checks;
  - own-rows-only reads, and client insert / update / delete / truncate denied;
  - anon denied;
  - unlink cascade (other platform kept) and account-deletion cascade (other users kept).

  Result: **all checks passed** (2026-10-19, Postgres 16 with `local-shim.sql`).

## Write path

`POST /api/insights/{link,sync,unlink}` follows the `/api/train/[action]` pattern: `withSupabase({auth: "user"})`, then service-role writes after validation in a pure, unit-tested `lib/server/insights.ts`.

- **link** `{platform, username, ratings}`: upserts `linked_accounts`. The client has already confirmed the user exists on the platform and shows the profile name and ratings.
- **sync** `{platform, ratings, games: Summary[] (≤ 200), lastGameAt}`:
  - Validates every field against the same rules as the SQL checks.
  - **Replays `opening_plies` with chess.js** to check legality and that `deviation_epd` / `played_san` match ply `book_ply`.
  - Upserts on the primary key (`do update` only when `dataset_hash` differs), updates `last_synced_at` / `last_game_at`, and prunes beyond 1,000.
  - Limited to 30 sync calls per user per hour, counted in the route like the train rate limit.
- **unlink** `{platform}`: deletes the `linked_accounts` row; the cascade removes the summaries.
- **Trust.**
  - The server doesn't re-run book matching; `dataset_hash` records which dataset did.
  - A client could forge its own summaries, but they're only ever shown to that user, and nothing feeds the leaderboard.
  - The friends feature must label imported data as "imported" (and "unverified" for unverified links), or re-fetch ratings server-side before showing them to others.

## Sync, progress and rate limits (client)

- **Validate on link:** `GET` the profile (Lichess `/api/user/{u}`, Chess.com `/pub/player/{u}` + `/stats`). A 404 shows "No Lichess / Chess.com user called …".
- **Lichess.** `GET /api/games/user/{u}?since={lastGameAt+1 or now−3 months}&max=200&rated=true&perfType=<chosen>&opening=true&evals=true&moves=true`, with `Accept: application/x-ndjson`.
  - The stream is read incrementally (`ReadableStream` reader, line splitter). Progress = games received / expected, where expected = min(200, the profile's game counts in the window when known); otherwise a count.
- **Chess.com.**
  - `GET /games/archives`, then the months from `max(month of lastGameAt, now − 3 months)` to now, **one request at a time**, newest first, stopping at 200 kept games.
  - Progress = months done / months. The current month is always re-fetched (the browser revalidates it with its ETag); older months are complete.
- **One request at a time per platform.** A small client queue enforces it, also across tabs via a `localStorage` lock with a TTL.
- **Errors:**

  | Error | Handling |
  |---|---|
  | 429 | Stop and show "Lichess (Chess.com) asked us to slow down". Retry automatically **once after 60 s**, then leave a Retry button. |
  | 404 | Unknown user. |
  | Network / CORS failure | "Couldn't reach lichess.org" plus Retry. |
  | Malformed line | Skipped and counted ("2 games couldn't be read"). |

- **Stale:** opening `/insights` with `last_synced_at` older than 24 h starts a sync in the background. Chess.com may lag; the docs say up to 12–24 h, so the page shows "latest game: <date>".
- **Dataset changed** (`dataset_hash` ≠ the current `outputHash`): re-match from `opening_plies` locally and post the updated rows through `sync`. No platform calls.
- **Guests:** the same pipeline. Summaries (not games) go to `localStorage` key `cot.v2.insights`, keeping the newest 400 per platform, with no server calls at all. Signing in offers "Save these insights to your account", which re-links and runs `sync` with them.

## Privacy

- **Data:** only public games and profiles, of a username the player typed. Nothing is fetched for a username the player didn't enter.
- **The visitor's browser contacts lichess.org / chess.com directly.** The linking card says so in one line: "Your browser fetches your public games from lichess.org; we store a summary of each game's opening".
- **Opponents:** none of their identifiers are stored. Their rating is kept as a number only.
- **Deletion:** unlink (per platform), account deletion (everything), and for guests "Clear insights" (local).
- **Friends (next run):** `linked_accounts.visibility` plus per-user rows let a later migration add a policy like `using (visibility = 'public' or (visibility = 'friends' and is_friend(user_id)))` without reshaping the tables. Summaries inherit their account's visibility through the FK.

## UI notes (Phase 3, constraints only)

- `/insights` is added to the header nav.
- The linking form lives in Settings → Account, plus an onboarding card on `/insights` when nothing is linked.
- Existing components are reused: `MiniBoard`, the `WinBar` styling, and the tokens from `globals.css`.
- **Accessibility and layout:**
  - Tables are real `<table>`s with `aria-sort`.
  - Progress uses `role="progressbar"` and announces through a polite live region.
  - Nothing animates under reduced motion.
  - Phone width: tables collapse to cards below `sm`, with no horizontal scroll.
- e2e tests mock both APIs with `page.route` using the fixtures. No live calls run in tests.

## Phases

| Phase | Deliverable |
|---|---|
| 0 (done) | This ADR, API verification notes and fixtures, migration 0006 and its local test. Approved 2026-10-19. |
| 1 | `src/lib/insights/` with unit tests on the fixtures (parsing, filter, book matching including transposition, aggregation, bands, recommendation scoring, deep links with fallback). |
| 2 | Client sources (Lichess stream, Chess.com months, queue, 429 / 404 / network), `/api/insights/*` with validation tests, and the guest store. |
| 3 | `/insights` page, the linking UI and the nav entry. e2e tests with mocked APIs, axe AA in light and dark. |
| 4 | Engine verdicts (budgeted, cancellable, cached), deep links, and the dashboard card ("N positions you keep getting wrong"). |

## Decisions (owner, 2026-10-19)

1. **Fetch location:** B. The browser fetches games directly from both platforms.
2. **Stored moves:** the first `n` plies of each game, `n` = the longest theory sequence in the dataset (36 today). Signed-in players: DB. Guests: browser only.
3. **Grow:** a set of common openings per level, weighted by the player's style. "Scores at similar ratings" stays out until a data source exists.
4. **Defaults accepted:** `MIN_GAMES` = 5, retention 1,000 games per platform, guest cap 400, the band edges above.

## Consequences

- No new dependencies: chess.js, Supabase and the engine are already in the app.
- One derivation path for guests and signed-in users, and the server never stores or sees full games.
- **Risks:**
  - Either platform can drop CORS. The `Source` interface lets a server proxy (option C) slot in.
  - Chess.com may change the monthly fields that are only documented elsewhere (`time_class`, `rated`). The parser tolerates their absence by skipping the game and counting it ("N games couldn't be classified"), rather than guessing a time class.
  - Lichess limits are per IP. Shared networks (schools, clubs) can still hit 429 and get the 60 s back-off.
- **Remote step:** the owner applies `0006_account_insights.sql`. No new environment variables are needed with B (the existing `SUPABASE_*` server variables cover the routes).

## Phases 1–4 amendments (as built)

**Files**

| Path | What |
|---|---|
| `src/lib/insights/` | `types`, `pgn`, `sources/{lichess,chesscom}`, `filter`, `book`, `summarize`, `aggregate`, `links`, `bands`, `weights`, `recommend` (pure, tested); `fetch` (browser importers, injectable `fetch`), `local` (guest store, merge, cross-tab lock), `client` (the store the UI uses), `verdicts` (Lichess / Stockfish) |
| `src/lib/server/insights.ts`, `insights-db.ts`, `src/app/api/insights/[action]/route.ts` | Write path |
| `src/components/insights/` | `InsightsClient` (`/insights`), `LinkedAccounts` (also in Settings → Account) |
| `src/components/dashboard/Dashboard.tsx` | Insights card |
| `e2e/insights.spec.ts` | Mocked platforms, axe, phone width, deep links |
| `scripts/insights/live-check.ts` | Live acceptance check → `docs/qa/insights/live-import.md` |

**Changes from the plan above**

- **Rate limit storage.** `0006` adds `linked_accounts.sync_window_start` and `sync_calls` (server bookkeeping; clients can read but not write them). They are added with `add column if not exists`, so a project that ran an earlier draft of `0006` picks them up on a re-run.
- **Upserts always update.** Same game, same values unless the dataset changed, so the conditional update bought nothing.
- **Lichess verdict:** taken from any game in the group that has the analysis (same position and move), not only when all of them do.
- **Engine cancellation:** the worker has no stop call besides a newer search. On unmount the remaining queue is dropped and the running search (≤ 700 ms) finishes unread.
- **Recommendations:** at most 4 per kind; Grow picks 2 per side. With no rating for the most-played time control, Grow uses the beginner and intermediate sets and says so.
- **Re-linking** a different username for a platform replaces the old account and its games (server and guest store alike).
- **Course names** drop the hub title when the system name already starts with it ("Sicilian Defense: Old Sicilian", not "Sicilian Defense: Sicilian Defense: Old Sicilian").

**Results**

- Unit tests: `src/lib/insights/__tests__/` and `src/lib/server/__tests__/insights.test.ts`, on the captured fixtures. Deep links on the 27 in-scope fixture games: 15 at the exit position, 12 at an earlier position on the path, 0 catalog-only.
- e2e: `e2e/insights.spec.ts` uses a second real fixture, `lichess-games-90d.ndjson` (43 blitz games, 2026-07-23 to 2026-08-15), because the 15-game sample has no opening with 5+ games.
- Live check, 2026-10-19 (`docs/qa/insights/live-import.md`):
  - Lichess `Zhigalko_Sergei`: 43 games, 11.5 s (the API's anonymous rate).
  - Chess.com `hikaru`: 200 games, 2.2 s; 401 bullet games skipped.
  - Every summary passed the server's `checkSummary`.
  - A re-sync from the cursor returned 0 games on both platforms.

## Review follow-up (after PR #4)

An adversarial review of the merged code found 12 issues; all are fixed:

- **Stale-user writes.** A sync or a dataset re-match that started for one user stops once the user changes: sign-out, a switch, or re-linking another username. A user switch also aborts the running import, and the page only auto-syncs once the store holds the current user's data. Before this, signing out mid-import could leave the previous player's games in guest storage.
- **Guest save.** "Save to your account" checks every upload and keeps the browser copy unless all of them succeed.
- **End of a theory line.** Playing on from a line's last position isn't "leaving book": `deviatedBy` stays `none`, unless the move transposes back into book. In the fixtures, 18 of 73 recorded deviations were such leaves.
- **Validation matches the SQL.** `playedAt` must be canonical ISO between 2000 and tomorrow. `playedSan` and the stored plies must be normalised SAN. `openingName` may not contain NUL or lone surrogates. Each of these was a 500 before; now it's a 400.
- **Atomic rate limit.** Migration `0007_insights_sync_claim.sql` adds `insights_claim_sync()`, which checks and increments in one `UPDATE`, only for the username being synced (service role only). It runs before validation. Re-linking the same name keeps the window.
- **Re-link race.** A sync now carries the username. The claim, the account check and the account update are all scoped to it, so a sync that loses a race with a re-link gets 409 and writes nothing to the new account.
- **Bullet toggle.** Turning bullet on makes the next import of each platform ignore the cursor once, so bullet games already inside the window are imported.
- **Re-match uploads** are flagged `rematch`. They no longer move `last_synced_at`, and they stop at the first failure.
- **Cancel** works during a 429 back-off and during profile lookups.
- **Route.** Action lookup is own-property only, and oversized bodies are refused by `content-length` before the body is read.
- **Reads.** Paging uses a total order (`played_at`, `platform`, `game_id`) and runs until an empty page, so a lower `max-rows` setting can't cut it short.

**Known and accepted:** after more than 200 new games, an incremental import keeps the newest 200. That is the spec's window ("last 3 months or 200 games, whichever is smaller"), so older games in between are out of scope by definition.
