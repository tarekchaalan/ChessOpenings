-- Account Insights (ADR 0006): linked Chess.com / Lichess accounts and the
-- derived per-game summaries the Insights page reads. Tested on a local
-- Postgres (scripts/supabase/test-0006.sh); the owner applies it to the hosted
-- project. Games are fetched by the browser (ADR 0006 Decision 1); only these
-- derived rows reach the server.
--
-- Security model (same as 0004): clients only SELECT their own rows. Link,
-- sync and unlink go through /api/insights/* route handlers, which validate
-- the payload and write with the service role.
--
-- Deletion: game_summaries → linked_accounts → profiles → auth.users, all
-- `on delete cascade`. Unlinking a platform deletes its summaries; deleting
-- the account (DELETE /api/account) deletes everything.
--
-- Raw PGNs are never stored. `opening_plies` keeps only the first n moves of a
-- game, n = the longest theory path in the dataset (36 plies today; computed
-- by src/lib/insights, never hard-coded), so summaries can be re-matched when
-- the theory dataset changes and "Train this line" can find the course line,
-- without re-fetching from the platform. The column cap is the dataset's
-- maxPly (38), the ceiling n can reach without a corpus rebuild (ADR 0001).
-- Idempotent: safe to re-run.

create table if not exists public.linked_accounts (
  user_id        uuid not null references public.profiles (id) on delete cascade,
  platform       text not null check (platform in ('lichess', 'chesscom')),
  -- as the platform displays it; both platforms treat usernames case-insensitively
  username       text not null check (username ~ '^[A-Za-z0-9][A-Za-z0-9_-]{1,29}$'),
  -- false = "linked" (anyone can type a public username); true only after an
  -- ownership proof (Lichess OAuth, out of scope for this run)
  verified       boolean not null default false,
  -- profile ratings at the last sync, per time class:
  -- {"blitz": {"rating": 1834, "games": 512, "provisional": false}, ...}
  ratings        jsonb not null default '{}'::jsonb check (jsonb_typeof(ratings) = 'object'),
  -- friends / following (next run) reads this; nothing grants access on it yet
  visibility     text not null default 'private' check (visibility in ('private', 'friends', 'public')),
  linked_at      timestamptz not null default now(),
  last_synced_at timestamptz,
  -- newest imported game: the incremental cursor (Lichess `since`, Chess.com first month)
  last_game_at   timestamptz,
  primary key (user_id, platform)
);
-- sync rate limit (30 per platform per hour), kept by the /api/insights route.
-- Added separately so a project that ran an earlier draft of 0006 gets them too.
alter table public.linked_accounts add column if not exists sync_window_start timestamptz;
alter table public.linked_accounts add column if not exists sync_calls int not null default 0 check (sync_calls >= 0);

create table if not exists public.game_summaries (
  user_id       uuid not null references public.profiles (id) on delete cascade,
  platform      text not null,
  -- Lichess game id ("BCi6IZfn") or Chess.com "<type>/<id>" ("live/183193101523")
  game_id       text not null check (game_id ~ '^[A-Za-z0-9/_-]{1,40}$'),
  color         text not null check (color in ('white', 'black')),
  time_class    text not null check (time_class in ('bullet', 'blitz', 'rapid', 'classical')),
  played_at     timestamptz not null,
  -- from the player's side
  result        text not null check (result in ('win', 'draw', 'loss')),
  my_rating     smallint check (my_rating between 0 and 4000),
  opp_rating    smallint check (opp_rating between 0 and 4000),
  -- the platform's own classification (shown as-is; book matching is ours)
  eco           text check (eco ~ '^[A-E][0-9]{2}$'),
  opening_name  text check (length(opening_name) <= 200),
  opening_plies text[] not null check (cardinality(opening_plies) between 1 and 38),
  -- plies played while every move was a theory (or extension) edge
  book_ply      smallint not null check (book_ply between 0 and 38),
  -- who played the first non-book move; 'none' = the game ended in book or
  -- stayed in book through the deepest theory
  deviated_by   text not null check (deviated_by in ('me', 'opponent', 'none')),
  -- position (EPD) before the first non-book move, the move played there and
  -- the theory moves that were available. The move is opening_plies[book_ply + 1],
  -- or, when the game left book right after n plies, only here
  deviation_epd text check (length(deviation_epd) <= 100),
  played_san    text check (played_san ~ '^[A-Za-z0-9+#=-]{2,8}$'),
  book_sans     text[] check (cardinality(book_sans) <= 40),
  -- Lichess server analysis at the deviation, centipawns from the mover's
  -- side, mates mapped like engine/uci.ts toCp and clamped; null when absent
  eval_before   smallint check (eval_before between -10000 and 10000),
  eval_after    smallint check (eval_after between -10000 and 10000),
  -- openings.v2 outputHash the summary was matched against
  dataset_hash  text not null check (length(dataset_hash) <= 80),
  imported_at   timestamptz not null default now(),
  primary key (user_id, platform, game_id),
  foreign key (user_id, platform) references public.linked_accounts (user_id, platform) on delete cascade,
  check ((deviated_by = 'none') = (deviation_epd is null)),
  check ((deviation_epd is null) = (played_san is null)),
  check (book_ply <= cardinality(opening_plies))
);

-- repeat mistakes: the player's own deviations grouped by position
create index if not exists game_summaries_my_deviations
  on public.game_summaries (user_id, deviation_epd, played_san)
  where deviated_by = 'me';
-- re-sync and retention: newest first per platform
create index if not exists game_summaries_recent
  on public.game_summaries (user_id, platform, played_at desc);

alter table public.linked_accounts enable row level security;
alter table public.game_summaries  enable row level security;

drop policy if exists "own linked accounts" on public.linked_accounts;
create policy "own linked accounts" on public.linked_accounts for select using (user_id = auth.uid());
drop policy if exists "own game summaries" on public.game_summaries;
create policy "own game summaries" on public.game_summaries for select using (user_id = auth.uid());

-- older projects' default privileges grant clients everything (incl. TRUNCATE, which RLS doesn't cover)
revoke all on public.linked_accounts, public.game_summaries from public, anon, authenticated;
grant select on public.linked_accounts, public.game_summaries to authenticated;
grant all on public.linked_accounts, public.game_summaries to service_role;
