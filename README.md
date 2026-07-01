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
- **Supabase** — Auth (email, magic link, Google/GitHub OAuth), Postgres with
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
3. Seed the theory tables (used server-side to validate quiz answers):
   - `psql "$DATABASE_URL" -f supabase/seed.sql`, or without psql:
     `NEXT_PUBLIC_SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npm run seed:remote`
4. Copy `.env.example` to `.env.local` and fill in
   `NEXT_PUBLIC_SUPABASE_URL` + `NEXT_PUBLIC_SUPABASE_ANON_KEY`.
5. (Optional) enable Google/GitHub providers under Auth → Providers, and add
   `https://<your-domain>/auth/callback` to the redirect allowlist.

Local stack instead: `supabase start && supabase db reset` applies migrations
and `seed.sql` automatically.

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

```bash
npm run ingest                   # rebuild the dataset from pinned sources
npm run ingest -- --skip-corpus  # names/graph only (no frequency stats)
```

The ingest (`scripts/ingest.ts`):

1. Downloads the ECO database from `lichess-org/chess-openings` at the commit
   pinned in `scripts/sources.json`, plus the broadcast months pinned there
   (cached in `data/cache/`; requires the `zstd` CLI — the dumps are
   multi-frame archives that node:zlib cannot stream).
2. Replays all ~3,700 named lines with chess.js into a variation graph keyed
   by EPD (FEN minus move clocks) — transposition-aware by construction.
3. Streams ~180k professional games through the graph (both players ≥2200,
   deduplicated), accumulating per-position and per-move game counts and
   W/D/L results while each game remains in book, plus the top "off book"
   moves per position for the explorer.
4. Emits:
   - `public/data/openings.v1.json` — the compact runtime dataset
   - `public/data/openings.meta.json` — version, source pins, counts, sha256
   - `supabase/seed.sql` — theory tables for server-side validation

Same pins ⇒ the same dataset, so re-ingest is reproducible; bump
`datasetVersion` in `scripts/sources.json` when changing sources.

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
supabase/seed.sql            generated theory data
```

## Notes

- Without Supabase env vars the app runs in guest-only mode (no leaderboard).
- The explorer optionally augments stats with the public Lichess masters API
  at runtime and falls back silently to the seeded stats when unreachable.
- Guest progress is not merged into an account on sign-in (by design: the
  leaderboard only counts server-validated answers).
