# ADR 0004 — Supabase v2 schema and server grading

- **Status:** proposed (Phase 0). Migration written in Phase 5. **Nothing is applied to the remote project without the owner's explicit approval.**
- **Spec:** §4.10.

> ⚠️ **IRREVERSIBLE** sections are marked. They rewrite or drop tables holding real user progress. They ship with a dry-run script and a backup step.

## Context

- Authenticated users are graded by `SECURITY DEFINER` RPCs (`issue_challenge`, `issue_review_challenge`, `answer_challenge`) that walk `theory_openings` by row index, and by an SM-2 scheduler duplicated in plpgsql.
- v2 moves identity to positions and content hashes (ADR 0001) and the scheduler to FSRS in TypeScript (ADR 0003).

## Options for server grading and scheduling

| Option | Pros | Cons |
|---|---|---|
| **A. Keep the RPCs, port FSRS to plpgsql** | No new server surface | Two FSRS implementations that must match bit for bit (power and exp math, fuzz RNG). Hard to test. Ports lag ts-fsrs. |
| **B. Next route handlers with one TS FSRS (recommended)** | One scheduler shared with guest mode and unit-tested. Course logic stays on the client. Uses the existing `@supabase/server` `withSupabase` (already in `/api/progress`). | Needs `SUPABASE_SECRET_KEY` on the server. Route handlers become security-critical code. |
| **C. Edge Functions** | Close to the DB | Third runtime (Deno). Duplicates the build library or bundles it separately. |

**Decision: B.**

- The admin client is used only inside `/api/train/*` handlers that first verify the user's JWT (`withSupabase({auth: "user"})`).
- Clients still cannot write `srs_cards`, `course_progress`, `quiz_attempts` or `profiles.rating`: the RLS policies stay select-only, and writes happen through the admin client after server-side validation.

## Schema (migration `0004_v2_identity.sql`)

### Reference data (regenerated from `seed.sql`)

- `theory_edges(from_epd, san, to_epd, games, white_wins, draws, black_wins, is_ext boolean default false)`.
  - Kept, with `is_ext` added. Extension edges are flagged.
  - The primary key stays `(from_epd, san)`.
- `theory_lines(id text primary key, eco text, name text not null, sans text[] not null, final_epd text not null)`.
  - `id` = `rowId`. Replaces `theory_openings`.
- `dataset_version(hash text primary key, built_at timestamptz)` — one row.
  - When the client's `outputHash` ≠ `dataset_version.hash`, a signed-in client grades locally (guest engine; writes nothing remote) and shows the banner "Server theory is updating".
- `legacy_map_v1(opening_id int, epd text, answer_san text, row_id text, final_epd text, best_course_id text, primary key (opening_id, epd))`.
  - A **regular staging table** (not TEMP: a temp table does not survive from the seed session to the migration).
  - Holds one row per v1 trainable position: the answer the v1 card actually learned is recovered from the v1 row's `sans` at build time. The server therefore needs no course logic.
  - Dropped by the post-seed data-migration step once it has run.

**Order of operations** (also the dry-run order). Remote `db push` applies migrations before any seed, so the user-data move is split out:
1. `0004_v2_schema.sql` — schema only: new tables, columns and FK changes; nothing moves.
2. Seed v2 reference data: `theory_edges`, `theory_lines`, `dataset_version`, `legacy_map_v1`.
3. `scripts/supabase/migrate-v2-data.sql` — the data migration (cards, progress), run explicitly after the seed.
4. Drop `legacy_map_v1`.

### User state — IRREVERSIBLE

- `srs_cards`
  - Becomes `(user_id, side, epd, answer_san)` as the primary key, plus FSRS columns (`stability`, `difficulty`, `elapsed_days`, `scheduled_days`, `reps`, `lapses`, `state`, `due`, `last_review`, `seen`, `correct`, `archived`, `migrated_from`).
  - Migration: create `srs_cards_v2`; insert from the old rows via `legacy_map_v1` (answer = the move the v1 row played at that EPD); merge duplicates with the ADR 0003 rule; rename the old table to `srs_cards_v1_backup`; rename the new one into place.
- `course_progress(user_id, course_id text, seen, correct, streak, best_streak, mastery numeric, last_line_id text, updated_at)`.
  - Built from `opening_progress` via `legacy_map_v1.best_course_id`.
  - The old table is renamed `opening_progress_v1_backup`.
- `quiz_attempts`
  - Gains `side`, `answer_san`, `course_id`, `line_id`, `grade smallint`, `hint_level smallint`, and `train_challenge_id uuid unique references train_challenges(id) on delete set null`.
  - `challenge_id` becomes **nullable**, and its FK to `quiz_challenges` is re-created with `on delete set null`. A v2 attempt sets `train_challenge_id` and leaves `challenge_id` null.
  - `opening_id` becomes nullable. The leaderboard views only use `rating_*`, `correct` and `created_at`, so they keep working unchanged.
- `quiz_challenges`
  - Replaced by `train_challenges(id uuid, user_id, course_id, line_id, side, sans text[], epd, expected text[], soft text[], ext boolean, issued_at, answered, …)`.
  - Single-use, expires after 5 min, rate-limited at 60/min. The old table is renamed.
- **Backups.** The `*_v1_backup` tables are kept until the owner drops them by hand. The migration never drops user data.
- **FK hygiene — prevents data loss.**
  - Before renaming, `0004` **drops the foreign keys** from `srs_cards`, `opening_progress` and `quiz_challenges` to `theory_openings`. The renamed backups then reference nothing.
  - It also repoints `quiz_attempts.challenge_id` to `on delete set null`.
  - The v2 `seed.sql` **never uses `TRUNCATE … CASCADE`**. It deletes reference rows table by table (`delete from theory_edges; delete from theory_lines; …`) inside one transaction. A reseed can't cascade into user tables, and an unexpected FK makes the seed fail loudly instead.
- **RLS and grants.** Every new table gets RLS enabled plus explicit grants, because migration `0002` only granted the tables that existed then.
  - Reference tables: `select` for `anon` and `authenticated`.
  - User tables: own-row `select` for `authenticated`.
  - Everything: `all` for `service_role`.

### Answer choice for migrated server cards

- The server has no course logic. Migrated cards take the most-played theory move at the EPD.
- On the user's first v2 sign-in, the client sends its course book moves (`POST /api/train/remap`). The server re-keys only cards whose `(epd, answer)` exists in `theory_edges` and whose EPD has the learner to move. It never creates a card that doesn't exist.

## Server grading flow (anti-forge preserved)

1. `POST /api/train/issue {courseId, lineId, sans, side}`
   - The client proposes the target line, as `0003_playlist_challenges` already does.
   - The server replays `sans` against `theory_edges`. Every ply must be a stored edge; an `is_ext` edge is allowed only where flagged.
   - It computes `expected` = the client-claimed book move. That move **must** be a theory edge at `epd`; otherwise → 400.
   - It stores `soft` = all other theory edges at `epd` (soft-fail set) and issues a single-use challenge.
2. `POST /api/train/answer {challengeId, san, ms, hintLevel}`
   - Grades: correct / soft / wrong. Extension challenges accept the top-3 moves with ≥ 15% share.
   - Computes the FSRS rating (ADR 0003) and the new card state in TS.
   - Persists through **one** call to a service-role-only `SECURITY DEFINER` function, `train_commit(...)` (EXECUTE revoked from `public`, `anon` and `authenticated`). Each PostgREST call is its own transaction, so atomicity must live in that function. In one transaction it:
     - claims the challenge (`update … set answered = true where id = $1 and not answered and issued_at > now() - '5 min' returning …`, so it is single-use even under races);
     - upserts the card;
     - inserts the attempt;
     - updates `profiles` (`rating`, `attempts`, `correct`, which the leaderboard views read);
     - updates `course_progress` counters.
   - The function recomputes the Elo delta itself from the stored challenge (below). The route cannot pass a rating.
3. **Side is never client-supplied.** The server derives `side` from the side to move in the EPD reached by replaying `sans`.
4. **Rating integrity.**
   - The client now chooses `expected` (its book move). So difficulty must **not** depend on the claimed move, or a client could pick rare or `ext` moves to farm rating.
   - Difficulty = `600 + ply × 55 + rarity(position)`, where rarity uses the **most-played** theory move at the EPD (as v1 did when `expected[1]` was the most popular).
   - `ext` challenges are capped at the difficulty of the last named-theory position on the line.
   - `ms` is clamped as today. Soft answers don't change rating.
5. **Mastery is not stored server-side as truth.** `course_progress.mastery` needs course logic, so it is written by the client through `POST /api/train/progress` and labelled untrusted. It is display-only and never feeds the leaderboard.
6. **Daily-cap deferral** for signed-in users goes through `POST /api/train/defer`. It may only move `due` later, by at most 7 days, for the caller's own cards.
7. **Extension edges.** The seed stores **every** stats move that passes the extension thresholds (not only those on default courses), flagged `is_ext`. Courses re-derived with user overrides then validate too.
8. **Dataset-hash mismatch.** While the client's `outputHash` ≠ `dataset_version.hash`, signed-in work is graded locally and kept in a local outbox (`cot.v2.outbox`). It is **not** replayed to the server afterwards, because the server can't re-validate past challenges. The banner says so: *Server theory is updating — this session won't count toward the leaderboard.*

**Why the client may pick the book move.** The learner's book move is their own repertoire choice. The server only checks that it is real theory and that the position was reached through real theory, which is the guarantee v1 provides.

## Dry run

- `scripts/supabase/dry-run-v2.ts` runs against a **local** stack only. It refuses to run if `SUPABASE_URL` isn't `localhost` or `127.0.0.1`.
- Steps:
  1. Seed synthetic v1 users from fixtures.
  2. Apply `0004`.
  3. Report before/after row counts per table, merged-card counts and unmapped cards.
- The report is written to `docs/qa/phase5/`.
- **Then stop and ask** before any remote action.

## Consequences

- One FSRS implementation everywhere.
- The plpgsql scheduler and v1 RPCs stay defined, but `0004` **revokes EXECUTE** on `issue_challenge`, `issue_review_challenge`, `answer_challenge`, `compute_mastery` and `family_next_moves` from `authenticated` and `anon`. Stale clients get a permission error instead of writing against renamed tables. A later migration (with owner approval) drops them.
- On first v2 sign-in, `POST /api/train/remap` may re-key cards to the user's course book moves. Collisions use the ADR 0003 merge rule (most reps, then earliest due; lapses summed).
- The route handlers need `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY` and `SUPABASE_JWKS_URL` (already documented for `/api/progress`). Without them, signed-in grading falls back to guest-local with a banner, as on a dataset mismatch.
