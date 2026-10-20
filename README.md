<p align="center">
  <img src="docs/logo.png" alt="Chess Openings Trainer logo" width="128" height="128">
</p>

# Chess Openings Trainer

Learn chess openings by name, drill every mainline and variation against real
master theory, and climb a global leaderboard.

**Explore** the full ECO catalog (A00–E99, ~3,700 named lines) on an
interactive, keyboard-driven board with per-move popularity and win rates from
real professional games. **Learn** an opening with a guided move-by-move
walkthrough — explanations, next-expected-move hints, and branch points into
key sidelines. **Quiz** yourself: the app plays the opponent from
frequency-weighted theory and you must produce a book move, scored by accuracy
and speed. A spaced-repetition scheduler (SM-2) resurfaces exactly the
positions you miss, and the dashboard tracks mastery, streaks, and your review
queue per opening.

## Stack

- **Next.js 16 / React 19 / TypeScript / Tailwind 4**
- **chess.js** as the rules oracle + **chessground** (lichess's board)
- **Supabase** — Auth (email + password, email links with a one-time code,
  password reset, email change, account deletion), Postgres with row-level
  security, and SECURITY DEFINER RPCs for the anti-forge quiz loop
- **Resend** — auth email over SMTP from `do-not-reply@tarekchaalan.com`
- Opening data: **lichess-org/chess-openings** (ECO names, pinned commit) +
  the **lichess broadcast database** (professional OTB games) for real move
  frequencies and win rates

## Quick start (guest mode, no backend)

```bash
npm install
npm run dev
```

Open http://localhost:3000. Everything works out of the box: explorer, learn
mode, quizzes, SRS reviews, and the dashboard, with progress persisted in
localStorage. The versioned dataset ships in `public/data/openings.v1.json`.

## Full setup (accounts + leaderboard)

1. Create a project at [supabase.com](https://supabase.com).
2. Apply the schema — either:
   - `supabase link --project-ref <ref> && supabase db push`, or
   - paste `supabase/migrations/*.sql` into the SQL editor, in order.
3. Seed the theory tables (used server-side to validate answers). They are
   numbered files under 1 MB in `supabase/seed/`, applied in name order:
   - `for f in supabase/seed/*.sql; do psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f"; done`, or without psql:
     `NEXT_PUBLIC_SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npm run seed:remote`
4. Copy `.env.example` to `.env.local` and fill in
   `NEXT_PUBLIC_SUPABASE_URL` + `NEXT_PUBLIC_SUPABASE_ANON_KEY`.
5. Auth email (Authentication in the dashboard, or `supabase config push`
   from `supabase/config.toml`):
   - **URL Configuration**: Site URL `https://<your-domain>` (no trailing
     slash); Redirect URLs `https://<your-domain>/auth/callback**`.
   - **SMTP**: Resend, sending as `do-not-reply@tarekchaalan.com` (host
     `smtp.resend.com`, port 465, user `resend`, password = the sending-only
     Resend key). Supabase's built-in mailer only delivers to the project's
     team members, a few emails an hour, so other players would never receive
     sign-up, magic-link or reset emails.
   - **Email templates**: `supabase/templates/*.html` (confirm signup,
     magic link, reset password, change email). They link to
     `/auth/callback?token_hash=…`, which works on any device; the default
     templates' PKCE links only work in the browser that asked for the email.
     They use the site's palette (light, plus dark for clients that support
     it) and load the logo from `{{ .SiteURL }}/brand/logo-96.png`
     (`public/brand/`), so deploy before pushing them.
   - From the CLI (linked project, logged in as its owner; review the diff
     it prints before confirming, since it pushes every `[auth]` setting):
     `RESEND_API_KEY=… supabase config push`
6. Account deletion (Settings → Delete account) calls `DELETE /api/account`,
   which needs the server variables below (`SUPABASE_SECRET_KEY` etc.). It
   deletes the auth user; every user table cascades from it.
   `scripts/supabase/test-deletion.sh` proves it on a local Postgres: it fills
   every user table for two players, deletes one, and scans every uuid and
   text column for the deleted id.

Local stack instead: `supabase start && supabase db reset` applies migrations
and `seed/*.sql` automatically. Migrating an existing v1 project (user data):
see the rollout in `docs/design/0004-supabase-v2.md`.

### Server API routes (@supabase/server)

Server-side endpoints under `src/app/api/` use
[`@supabase/server`](https://www.npmjs.com/package/@supabase/server):
`withSupabase({ auth: "user" }, handler)` verifies the caller's JWT against
`SUPABASE_JWKS_URL` and injects an RLS-scoped client (`ctx.supabase`) plus an
RLS-bypassing admin client (`ctx.supabaseAdmin`), so handlers contain business
logic only. Example: `GET /api/progress` returns the signed-in player's
training summary — call it with
`Authorization: Bearer <session.access_token>`.

It reads `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY` and
`SUPABASE_JWKS_URL` from the environment (see `.env.example`; copy real values
from the Supabase dashboard's Connect dialog and never commit the secret key).
On Supabase Edge Functions those variables are injected automatically, and
functions using non-`"user"` auth modes need `verify_jwt = false` in
`supabase/config.toml`. Routes respond `503` when the variables are unset, so
guest-mode deployments keep working.

### Why scores can't be forged

Clients never write ratings, SRS state, or attempts. The server:

1. **Issues** each quiz challenge (`issue_challenge`) — it walks the theory
   graph itself, samples the opponent's move by real game frequency, stores
   the acceptable answers, and rate-limits issuance.
2. **Grades** each answer (`answer_challenge`) — single-use challenges expire
   after 5 minutes; Elo-style rating updates, SM-2 scheduling, streaks and
   mastery all happen inside the RPC.
3. Leaderboards are views over RPC-written data (`leaderboard_global`,
   `leaderboard_weekly`), with row-level security keeping raw rows private.

## Data pipeline

The opening data is **live**: everything under `public/data/all-openings/` (`*.tsv`, any name, subfolders allowed) is the source of truth. Design: `docs/design/0001-data-pipeline-and-identity.md`.

```bash
npm run dev               # next dev + a watcher; edits to the TSVs show up in the open app within seconds
npm run openings:build    # one-shot build of every artifact (also runs as predev/prebuild)
npm run openings:check    # exit 1 if artifacts are stale or the data has errors (part of npm run lint)
npm run corpus:build      # rarely: rebuild master-game position stats from the pinned corpus
npm test                  # unit tests (Vitest)
npm run test:e2e          # end-to-end tests (Playwright; starts its own dev server)
```

**TSV format.** A header row is required and columns are matched by name: `eco`, `name` and `pgn` are required; extra columns are kept. UTF-8, BOM or not, LF or CRLF; blank lines and `#` comments are ignored. Non-`.tsv` files are ignored with a warning.

**Validation never crashes the app.**

| Problem | Effect |
|---|---|
| Illegal move | Reported as `file:line` with the ply and token. The row is skipped. In dev, the app stays on the last good data; `openings:check` exits 1. |
| Bad ECO | Warning; row kept |
| Empty name | Error; row skipped |
| Duplicate move sequence | Warning; the first name wins and the others become aliases |

**Identity.** Every row gets a stable `rowId` derived from its moves, so renames and edits never re-attach progress to the wrong opening. Each build writes a changelog (`openings.changelog.json`, shown at `/changes`) with added, removed and renamed lines.

**Artifacts (committed).**

| File | Content |
|---|---|
| `public/data/openings.v2.json` | Runtime dataset (`graph@2`) |
| `public/data/openings.v2.meta.json` | Hashes, counts, warnings |
| `public/data/openings.changelog.json` | Changelog |
| `public/data/legacy-map.v1.json` | v1 index → v2 identity |
| `data/derived/position-stats.v1.json.gz` | Master statistics for every position up to ply 38 (≥ 3 games) |

The position stats are built from the lichess broadcast months pinned in `scripts/sources.json` (both players ≥ 2200, de-duplicated). Because they are a separate artifact, new lines get frequencies and W/D/L instantly, with no corpus download. `corpus:build` uses the `zstd` CLI when present, else a pure-JS decoder.

**Production.** Data changes ship with a rebuild and deploy: `prebuild` regenerates every artifact, so dropping or editing TSV files needs no code change and no manual step. Deployed clients re-check the dataset hash on window focus (at most every 10 minutes) and show the same "Openings updated" toast.

The legacy `npm run ingest` (v1 dataset `openings.v1.json` and the v1 seed `supabase/seed.v1.sql`) stays until the Supabase v2 migration ships. `openings.v1.json` is also the identity baseline for migrating v1 progress.

## Keyboard

| Key | Explorer | Learn |
| --- | --- | --- |
| `←` / `→` | back / forward (or play selected) | back / next move |
| `↑` / `↓` | choose candidate move | — |
| `Enter` | play selected move | next move |
| `F` | flip board | — |
| `H` | — | toggle hints |
| `Home` | reset to start | — |

…and you can always drag (or click-click) pieces on the board.

## Project layout

```
scripts/ingest.ts            data pipeline (ECO + games corpus → dataset + seed)
scripts/sources.json         pinned dataset sources + version
public/data/                 versioned dataset the app loads
src/lib/openings.ts          graph navigation, search, line families
src/lib/srs.ts               SM-2 scheduler (mirrored in plpgsql)
src/lib/scoring.ts           difficulty + Elo rating (mirrored in plpgsql)
src/lib/explain.ts           heuristic move explanations
src/content/annotations.ts   curated annotations for popular openings
src/lib/quiz/                quiz engines: local (guest) + remote (RPC)
src/lib/progress/            progress stores: localStorage + Supabase
src/components/              board, explorer, learn, quiz, dashboard, auth
supabase/migrations/         schema, RLS, RPCs
src/lib/friends/             friends: visibility, feed, compare, challenge, RPC client
src/lib/rating/              estimated Elo from linked ratings, levels and what they set
src/lib/setup/               first-login setup state (get_setup / save_setup)
supabase/seed/               generated v2 theory data (< 1 MB files, name order)
```

## Notes

- **Analytics:** Vercel Web Analytics (`@vercel/analytics`, the `<Analytics />`
  component in `src/app/layout.tsx`). Turn it on in the Vercel project
  (Analytics tab); it reports page views only on Vercel deployments.

- Without Supabase env vars the app runs in guest-only mode (no leaderboard).
- The explorer optionally augments stats with the public Lichess masters API
  at runtime and falls back silently to the seeded stats when unreachable.
- Guest progress is not merged into an account on sign-in (by design: the
  leaderboard only counts server-validated answers).

## Insights (Chess.com + Lichess)

`/insights` (and Settings → Account) links a Chess.com and/or Lichess
username, imports the last 350 rated standard games, however old (rapid,
blitz and classical, bullet optional) and shows where your openings
leave book, repeat mistakes with an engine verdict, results by opening, and
Fix / Fill / Grow recommendations, each linking into the trainer. Design:
`docs/design/0006-account-insights.md`.

- The **browser** fetches the games straight from lichess.org and
  api.chess.com (both allow cross-origin requests), one request at a time per
  platform, so imports count against the player's own rate limits, not the
  deployment's.
- Only derived summaries are kept: the first *n* opening moves (n = the
  longest theory path, 36 plies today) plus where and how the game left book.
  Guests keep them in `localStorage`; signed-in players save them through
  `POST /api/insights/{link,sync,unlink}` into `linked_accounts` and
  `game_summaries` (migrations `0006` and `0007`, owner-only RLS, cascading from the
  profile, so unlinking or deleting the account removes them).
- No new environment variables: the routes use the same `SUPABASE_*` server
  variables as `/api/train`. Without them, Insights works in the browser only.
- `npx tsx scripts/insights/live-check.ts [lichessUser] [chesscomUser]` runs a
  live import against real accounts (not part of `npm test`, which only uses
  captured fixtures).

## Sign in with Lichess / Chess.com

`/auth` offers **Continue with Lichess** (OAuth2 with PKCE; Lichess needs no
app registration). A first sign-in creates an account named after the Lichess
user, with Lichess linked and **verified**; signed-in players can connect or
verify Lichess from Settings → Account or the linked-accounts panel, which
also lets them sign in with it. No Lichess token is kept (it's revoked right
after reading the account). Insights accounts on a platform with OAuth are
connected **only** by signing in to it (the panel and the setup modal have no
username field for it, and `/api/insights/link` refuses unproven names);
Chess.com keeps a typed, unverified username until its OAuth is configured.
Design: `docs/design/0009-oauth-sign-in.md`;
migration `0010_oauth_identities.sql`; tests `src/lib/server/__tests__/oauth.test.ts`,
`scripts/supabase/test-0010.sh`.

- Lichess needs no new variables (optional `LICHESS_CLIENT_ID`, shown on the
  consent screen; it defaults to the site's host).
- Chess.com is wired but off until Chess.com approves the app: then set
  `NEXT_PUBLIC_CHESSCOM_CLIENT_ID`, `CHESSCOM_AUTHORIZE_URL`,
  `CHESSCOM_TOKEN_URL` (and `CHESSCOM_CLIENT_SECRET` if issued). Redirect URI:
  `https://<host>/api/auth/oauth/chesscom/callback`.

## First-login setup and estimated Elo

On a player's first signed-in visit (right after the email link verifies the
account), a modal asks for their Lichess and Chess.com usernames, checks them
live, and shows an **estimated Elo** with what it's based on. Ratings with
fewer than 20 games don't count (a new Lichess account sits at "1500?"); with
nothing reliable, the player picks their level instead. The estimate sets the
suggested openings (dashboard "Start here", catalog "For your level"), where a
course's depth starts, new lines a day, and Insights' level until enough games
are imported. The leaderboard rating stays separate and earned. Skip or re-run
from Settings → Account. Design: `docs/design/0008-player-setup.md`; migration
`0009_player_setup.sql`; tests `src/lib/rating/__tests__`,
`scripts/supabase/test-0009.sh`, `e2e/onboarding.spec.ts`.

## Friends

Players with accounts can follow each other (one-way; **friends** = both
follow), see what their friends are learning, compare, and challenge them on
Lichess or Chess.com. Design: `docs/design/0007-friends.md`.

- **Pages:** `/friends` (feed, Following / Followers / Requests / Search,
  Compare), `/u/[username]` (shareable profile with a "view as" preview for
  the owner), a Friends tab on the leaderboard, and Settings → Privacy.
- **Privacy:** four sections (linked accounts, openings I'm learning,
  training stats, activity), each Everyone / Followers / Friends / Only me.
  Everything starts at **Only me**; a one-click card offers "friends see my
  learning, stats and activity" on a first follow. Username, app rating and
  accuracy stay public, as on the leaderboard. Optional "approve followers".
  Blocking hides both players from each other everywhere in Friends.
- **Security:** migration `0008_friends.sql`. No table policy exposes another
  player's rows; every cross-user read is a `SECURITY DEFINER` function that
  takes the viewer from the JWT and checks each section (`friends_audience`,
  `friends_reaches`). Writes are RPCs too. Feed events come only from triggers
  on `quiz_attempts`, `course_progress` and `linked_accounts`.
- **Challenge:** links only, opened in a new tab:
  `https://lichess.org/?user={u}#friend` and `https://www.chess.com/play/{u}`,
  built from the friend's stored linked username.
- **Tests:** `npm test` (visibility truth table, feed, compare, challenge),
  `scripts/supabase/test-0008.sh` (the policy matrix and every RPC on a local
  Postgres), `scripts/supabase/plans-0008.sh` (query plans at 10k players),
  and `e2e/friends.spec.ts`.
- **e2e and Postgres:** `npm run test:e2e` starts `e2e/supabase-stub.mjs`, a
  stand-in for Supabase that runs the real migrations on a **local Postgres
  16** (`DATABASE_URL`, default `postgres://postgres@127.0.0.1:54329/postgres`,
  started with `scripts/supabase/local-pg.sh` when it isn't running) behind a
  small PostgREST/GoTrue subset, so signed-in specs exercise the real
  policies. Every spec now runs with accounts configured.
- No new environment variables.

## Engine

Stockfish 19 (lite, single-threaded WASM, from the [`stockfish`](https://github.com/nmrugg/stockfish.js) npm package) powers the trainer's eval bar (beside the board, on by default; E or the toolbar toggles it) and the engine verdict and refutation for off-book mistakes. `predev`/`prebuild` copy it into `public/engine/` (gitignored, 1.85 MB, 1.2 MB gzipped). The browser loads it in a Web Worker only on first use. Without it, both features stay hidden.

## Third-party licences

[chessground](https://github.com/lichess-org/chessground) and [Stockfish](https://github.com/official-stockfish/Stockfish) (via [stockfish.js](https://github.com/nmrugg/stockfish.js)) are GPL-3.0. Distributing the app with them carries the GPL-3.0's obligations. Stockfish's licence ships next to the engine as `/engine/COPYING.txt`, and the corresponding source for both is linked above.

## Brand

The logo comes from the Chess Analysis iOS app icon: the cburnett knight (Colin M.L. Burnett, GPL-2.0-or-later, the same piece set chessground draws) in forest green on a charcoal tile, with the knight a few shades lighter so it reads at small sizes. `src/app/icon.svg` is the source drawing (also the favicon) and `src/components/Logo.tsx` draws the same thing in React. `npm run brand:render` renders `src/app/apple-icon.png`, `public/brand/logo-96.png` (emails) and `docs/logo.png` (this README) from `icon.svg`; rerun it after changing the drawing. The theme tokens in `src/app/globals.css` take their accent and dark-theme neutrals from it; every text pair is WCAG AA.
