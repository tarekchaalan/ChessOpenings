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
- **Supabase** — Auth (email + password, magic links), Postgres with
  row-level security, and SECURITY DEFINER RPCs for the anti-forge quiz loop
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
   - paste `supabase/migrations/0001_schema.sql` into the SQL editor.
3. Seed the theory tables (used server-side to validate answers). They are
   numbered files under 1 MB in `supabase/seed/`, applied in name order:
   - `for f in supabase/seed/*.sql; do psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f"; done`, or without psql:
     `NEXT_PUBLIC_SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npm run seed:remote`
4. Copy `.env.example` to `.env.local` and fill in
   `NEXT_PUBLIC_SUPABASE_URL` + `NEXT_PUBLIC_SUPABASE_ANON_KEY`.
5. Add `https://<your-domain>/auth/callback` to Auth → URL Configuration →
   Redirect URLs (needed for magic-link sign-in).

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
supabase/seed/               generated v2 theory data (< 1 MB files, name order)
```

## Notes

- Without Supabase env vars the app runs in guest-only mode (no leaderboard).
- The explorer optionally augments stats with the public Lichess masters API
  at runtime and falls back silently to the seeded stats when unreachable.
- Guest progress is not merged into an account on sign-in (by design: the
  leaderboard only counts server-validated answers).
