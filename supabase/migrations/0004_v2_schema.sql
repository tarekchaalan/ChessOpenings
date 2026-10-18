-- v2 schema (ADR 0004). SCHEMA ONLY: no user data moves here.
--
-- Order of operations (also the dry run's, scripts/supabase/dry-run-v2.ts):
--   1. this migration: new tables/columns, FK changes, grants, train_commit;
--   2. the v2 seed: supabase/seed.sql (theory_edges + is_ext, theory_lines,
--      dataset_version; re-runnable), then scripts/supabase/seed-legacy-v1.sql
--      (the one-time legacy_* staging rows);
--   3. scripts/supabase/migrate-v2-data.sql: cards + progress move to v2, the
--      v1 tables are renamed *_v1_backup (never dropped), staging tables dropped.
--
-- Security model (unchanged in spirit from 0001): clients only SELECT their own
-- rows. Every write to cards / attempts / ratings / progress goes through the
-- /api/train/* route handlers, which validate against theory_edges and then
-- call the service-role-only train_* functions below.

-- ───────────────────────── reference data ─────────────────────────────────
alter table public.theory_edges add column if not exists is_ext boolean not null default false;

create table if not exists public.theory_lines (
  id        text primary key,          -- the v2 rowId (content hash of the move sequence)
  eco       text,
  name      text not null,
  sans      text[] not null,
  final_epd text not null
);

create table if not exists public.dataset_version (
  hash     text primary key,           -- the client's openings.v2 outputHash
  built_at timestamptz not null default now()
);

-- staging for the v1 → v2 data move (seeded, dropped by migrate-v2-data.sql).
-- Regular tables, not TEMP: the seed and the data migration are separate sessions.
create table if not exists public.legacy_openings_v1 (
  opening_id     int primary key,       -- v1 theory_openings.id (row index)
  row_id         text,                  -- v2 row with the same moves, null if removed
  final_epd      text not null,
  sans           text[] not null,       -- the row's moves, +/# stripped
  best_course_id text,
  best_line_id   text
);
-- one row per position on each v1 row: where a card on the row lands
create table if not exists public.legacy_row_answers_v1 (
  opening_id int not null,
  ply        int not null,
  epd        text not null,
  answer_san text not null,
  course_id  text,
  primary key (opening_id, ply)
);
-- one row per v2 position: where a card off its row lands
create table if not exists public.legacy_answers_v1 (
  epd        text primary key,
  answer_san text not null,
  course_id  text
);

-- ───────────────────────── v1 → v2 FK hygiene ─────────────────────────────
-- The v1 user tables referenced theory_openings. Drop those FKs first, so the
-- renamed backups reference nothing and no reseed can cascade into them.
alter table public.srs_cards        drop constraint if exists srs_cards_opening_id_fkey;
alter table public.opening_progress drop constraint if exists opening_progress_opening_id_fkey;
alter table public.quiz_challenges  drop constraint if exists quiz_challenges_opening_id_fkey;

-- quiz_attempts outlives quiz_challenges: challenge_id becomes optional and is
-- nulled (not cascaded) if a v1 challenge row is ever deleted
alter table public.quiz_attempts drop constraint if exists quiz_attempts_challenge_id_fkey;
alter table public.quiz_attempts alter column challenge_id drop not null;
alter table public.quiz_attempts
  add constraint quiz_attempts_challenge_id_fkey foreign key (challenge_id)
  references public.quiz_challenges (id) on delete set null;
alter table public.quiz_attempts alter column opening_id drop not null;

-- ───────────────────────── v2 user state ──────────────────────────────────
-- FSRS cards keyed (side, epd, answer), shared across courses (ADR 0003).
-- Renamed to srs_cards by migrate-v2-data.sql.
create table if not exists public.srs_cards_v2 (
  user_id        uuid not null references public.profiles (id) on delete cascade,
  side           text not null check (side in ('white', 'black')),
  epd            text not null,
  answer_san     text not null,
  due            timestamptz not null default now(),
  stability      double precision not null default 0,
  difficulty     double precision not null default 0,
  elapsed_days   double precision not null default 0,
  scheduled_days double precision not null default 0,
  learning_steps int not null default 0,
  reps           int not null default 0,
  lapses         int not null default 0,
  state          smallint not null default 0 check (state between 0 and 3),  -- ts-fsrs State
  last_review    timestamptz,
  seen           int not null default 0,
  correct        int not null default 0,
  archived       boolean not null default false,
  migrated_from  text,
  deferred_from  timestamptz,
  last_course_id text,
  last_line_id   text,
  updated_at     timestamptz not null default now(),
  primary key (user_id, side, epd, answer_san)
);
create index if not exists srs_cards_v2_due_idx on public.srs_cards_v2 (user_id, due);

create table if not exists public.course_progress (
  user_id      uuid not null references public.profiles (id) on delete cascade,
  course_id    text not null,
  seen         int not null default 0,
  correct      int not null default 0,
  streak       int not null default 0,
  best_streak  int not null default 0,
  mastery      numeric not null default 0,   -- client-reported, display only (never feeds the leaderboard)
  last_line_id text,
  updated_at   timestamptz not null default now(),
  primary key (user_id, course_id)
);

-- server-issued, single-use (5 min) challenges for one graded ply
create table if not exists public.train_challenges (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles (id) on delete cascade,
  course_id   text not null,
  line_id     text,
  side        text not null check (side in ('white', 'black')),
  sans        text[] not null,                -- validated path to epd
  epd         text not null,
  expected    text not null,                  -- the client's book move: a stored edge at epd
  ext         boolean not null default false, -- expected is an extension edge
  cap_epd     text,                           -- last position reached by named theory (ext difficulty cap)
  cap_ply     int,
  answered    boolean not null default false,
  answered_at timestamptz,
  issued_at   timestamptz not null default now()
);
create index if not exists train_challenges_user_idx on public.train_challenges (user_id, issued_at desc);

alter table public.quiz_attempts add column if not exists side text;
alter table public.quiz_attempts add column if not exists answer_san text;
alter table public.quiz_attempts add column if not exists course_id text;
alter table public.quiz_attempts add column if not exists line_id text;
alter table public.quiz_attempts add column if not exists grade smallint;       -- 1 again … 4 easy
alter table public.quiz_attempts add column if not exists hint_level smallint;
alter table public.quiz_attempts add column if not exists train_challenge_id uuid unique
  references public.train_challenges (id) on delete set null;

-- ───────────────────────── RLS + grants (0002 only covered old tables) ────
alter table public.theory_lines          enable row level security;
alter table public.dataset_version       enable row level security;
alter table public.legacy_openings_v1    enable row level security;
alter table public.legacy_row_answers_v1 enable row level security;
alter table public.legacy_answers_v1     enable row level security;
alter table public.srs_cards_v2          enable row level security;
alter table public.course_progress       enable row level security;
alter table public.train_challenges      enable row level security;

drop policy if exists "theory lines are public" on public.theory_lines;
create policy "theory lines are public" on public.theory_lines for select using (true);
drop policy if exists "dataset version is public" on public.dataset_version;
create policy "dataset version is public" on public.dataset_version for select using (true);
drop policy if exists "own srs cards" on public.srs_cards_v2;
create policy "own srs cards" on public.srs_cards_v2 for select using (user_id = auth.uid());
drop policy if exists "own course progress" on public.course_progress;
create policy "own course progress" on public.course_progress for select using (user_id = auth.uid());
-- answered only: an open challenge's `expected` would reveal nothing the client
-- didn't send, but keep v1's rule
drop policy if exists "own answered train challenges" on public.train_challenges;
create policy "own answered train challenges" on public.train_challenges
  for select using (user_id = auth.uid() and answered);
-- legacy_* staging: no policies (service role only)

-- older projects' default privileges grant clients everything (incl. TRUNCATE, which RLS doesn't cover)
revoke all on public.theory_lines, public.dataset_version, public.legacy_openings_v1, public.legacy_row_answers_v1,
  public.legacy_answers_v1, public.srs_cards_v2, public.course_progress, public.train_challenges from anon, authenticated;
grant select on public.theory_lines, public.dataset_version to anon, authenticated;
grant select on public.srs_cards_v2, public.course_progress, public.train_challenges to authenticated;
grant all privileges on public.theory_lines, public.dataset_version, public.legacy_openings_v1,
  public.legacy_row_answers_v1, public.legacy_answers_v1, public.srs_cards_v2,
  public.course_progress, public.train_challenges to service_role;

-- ───────────────────────── retire the v1 RPCs ─────────────────────────────
-- Stale v1 clients get a permission error instead of writing against tables
-- that migrate-v2-data.sql renames. Dropping them is a later, approved step.
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('issue_challenge', 'issue_review_challenge', 'answer_challenge', 'compute_mastery', 'family_next_moves')
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', f.sig);
  end loop;
end $$;

-- ───────────────────────── server grading helpers ─────────────────────────
-- Replays `p_sans` from the start position over theory_edges. Returns one row
-- per ply (ply, from_epd, san, to_epd, is_ext); fewer rows than plies means
-- the line left the stored tree at that ply (the caller rejects it).
create or replace function public.train_walk(p_sans text[])
returns table (ply int, from_epd text, san text, to_epd text, is_ext boolean)
language sql stable
security definer set search_path = public, pg_temp
as $$
  with recursive w(ply, epd) as (
    select 0, public.start_epd()
    union all
    select w.ply + 1, e.to_epd
    from w join public.theory_edges e on e.from_epd = w.epd and e.san = p_sans[w.ply + 1]
    where w.ply < cardinality(p_sans)
  )
  select w.ply + 1, w.epd, e.san, e.to_epd, e.is_ext
  from w join public.theory_edges e on e.from_epd = w.epd and e.san = p_sans[w.ply + 1]
  where w.ply < cardinality(p_sans)
  order by 1;
$$;

-- Position difficulty for the Elo update (as v1): depth + rarity of the
-- MOST-PLAYED move at the position, never of the client's claimed move.
create or replace function public.train_difficulty(p_epd text, p_ply int)
returns int
language plpgsql stable
security definer set search_path = public, pg_temp
as $$
declare
  v_node numeric;
  v_top numeric;
  v_rarity int;
begin
  select coalesce(sum(games), 0), coalesce(max(games), 0) into v_node, v_top
  from public.theory_edges where from_epd = p_epd;
  if v_node > 0 and v_top > 0 then
    v_rarity := least(600, round(300 * log(greatest(1.0, v_node / v_top))));
  else
    v_rarity := 150;
  end if;
  return least(2800, 600 + p_ply * 55 + v_rarity);
end;
$$;

-- One graded answer, atomically: claim the challenge (single use, 5 min),
-- Elo from the stored challenge, upsert the FSRS card computed by the route,
-- insert the attempt, update the profile and the course counters.
-- Returns null when the challenge can't be claimed.
create or replace function public.train_commit(
  p_user uuid,
  p_challenge uuid,
  p_san text,
  p_correct boolean,      -- route-graded: book move, no real mistake, below H3
  p_grade smallint,       -- 1 again, 2 hard, 3 good, 4 easy
  p_hint smallint,
  p_ms int,
  p_card jsonb            -- the next FSRS state (src/lib/srs/fsrs.ts)
)
returns jsonb
language plpgsql
security definer set search_path = public, pg_temp
as $$
declare
  v_ch public.train_challenges;
  v_ms int := greatest(200, least(coalesce(p_ms, 200), 600000));
  v_difficulty int;
  v_rating int;
  v_expected numeric;
  v_speed numeric;
  v_delta int;
  v_new int;
begin
  update public.train_challenges
  set answered = true, answered_at = now()
  where id = p_challenge and user_id = p_user and not answered and issued_at > now() - interval '5 minutes'
  returning * into v_ch;
  if not found then return null; end if;

  -- Elo (server-authoritative; the route can't pass a rating)
  v_difficulty := public.train_difficulty(v_ch.epd, cardinality(v_ch.sans));
  if v_ch.ext and v_ch.cap_epd is not null then
    v_difficulty := least(v_difficulty, public.train_difficulty(v_ch.cap_epd, v_ch.cap_ply));
  end if;
  select rating into v_rating from public.profiles where id = p_user for update;
  if not found then raise exception 'no profile'; end if;
  v_expected := 1.0 / (1.0 + power(10, (v_difficulty - v_rating) / 400.0));
  if p_correct then
    v_speed := case when v_ms <= 3000 then 1.0 when v_ms >= 20000 then 0.5 else 1.0 - 0.5 * (v_ms - 3000) / 17000.0 end;
    v_delta := greatest(1, round(24 * (1.0 - v_expected) * v_speed));
  else
    v_delta := round(24 * (0.0 - v_expected));
  end if;
  v_new := greatest(100, v_rating + v_delta);
  update public.profiles
  set rating = v_new, attempts = attempts + 1, correct = correct + case when p_correct then 1 else 0 end, updated_at = now()
  where id = p_user;

  insert into public.srs_cards as c (user_id, side, epd, answer_san, due, stability, difficulty, elapsed_days,
    scheduled_days, learning_steps, reps, lapses, state, last_review, seen, correct, archived, last_course_id, last_line_id, updated_at)
  values (p_user, v_ch.side, v_ch.epd, regexp_replace(v_ch.expected, '[+#]$', ''), (p_card ->> 'due')::timestamptz, (p_card ->> 'stability')::float8,
    (p_card ->> 'difficulty')::float8, (p_card ->> 'elapsed_days')::float8, (p_card ->> 'scheduled_days')::float8,
    (p_card ->> 'learning_steps')::int, (p_card ->> 'reps')::int, (p_card ->> 'lapses')::int, (p_card ->> 'state')::smallint,
    (p_card ->> 'last_review')::timestamptz, (p_card ->> 'seen')::int, (p_card ->> 'correct')::int, false,
    v_ch.course_id, v_ch.line_id, now())
  on conflict (user_id, side, epd, answer_san) do update
  set due = excluded.due, stability = excluded.stability, difficulty = excluded.difficulty,
      elapsed_days = excluded.elapsed_days, scheduled_days = excluded.scheduled_days,
      learning_steps = excluded.learning_steps, reps = excluded.reps, lapses = excluded.lapses,
      state = excluded.state, last_review = excluded.last_review, seen = excluded.seen, correct = excluded.correct,
      archived = false, deferred_from = null, last_course_id = excluded.last_course_id,
      last_line_id = excluded.last_line_id, updated_at = now();

  insert into public.quiz_attempts (user_id, train_challenge_id, epd, san, correct, ms, used_hint, rating_before,
    rating_after, side, answer_san, course_id, line_id, grade, hint_level)
  values (p_user, v_ch.id, v_ch.epd, p_san, p_correct, v_ms, coalesce(p_hint, 0) > 0, v_rating, v_new,
    v_ch.side, regexp_replace(v_ch.expected, '[+#]$', ''), v_ch.course_id, v_ch.line_id, p_grade, p_hint);

  insert into public.course_progress as p (user_id, course_id, seen, correct, streak, best_streak, last_line_id, updated_at)
  values (p_user, v_ch.course_id, 1, case when p_correct then 1 else 0 end, case when p_correct then 1 else 0 end,
    case when p_correct then 1 else 0 end, v_ch.line_id, now())
  on conflict (user_id, course_id) do update
  set seen = p.seen + 1,
      correct = p.correct + case when p_correct then 1 else 0 end,
      streak = case when p_correct then p.streak + 1 else 0 end,
      best_streak = greatest(p.best_streak, case when p_correct then p.streak + 1 else 0 end),
      last_line_id = coalesce(excluded.last_line_id, p.last_line_id),
      updated_at = now();

  return jsonb_build_object('rating', v_new, 'rating_delta', v_delta, 'difficulty', v_difficulty);
end;
$$;

-- service role only (the route handlers); never callable from a browser
revoke execute on function public.train_walk(text[]) from public, anon, authenticated;
revoke execute on function public.train_difficulty(text, int) from public, anon, authenticated;
revoke execute on function public.train_commit(uuid, uuid, text, boolean, smallint, smallint, int, jsonb) from public, anon, authenticated;
grant execute on function public.train_walk(text[]) to service_role;
grant execute on function public.train_difficulty(text, int) to service_role;
grant execute on function public.train_commit(uuid, uuid, text, boolean, smallint, smallint, int, jsonb) to service_role;

-- Daily-cap deferral for signed-in users (ADR 0003): moves `due` LATER only,
-- to at most 7 days past the card's original due (no chaining), on the caller's own cards. p_cards: [{side, epd, answer, due}].
create or replace function public.train_defer(p_user uuid, p_cards jsonb)
returns int
language plpgsql
security definer set search_path = public, pg_temp
as $$
declare v_n int;
begin
  with req as (
    select x ->> 'side' as side, x ->> 'epd' as epd, x ->> 'answer' as answer, (x ->> 'due')::timestamptz as due
    from jsonb_array_elements(p_cards) x
    limit 1000
  )
  update public.srs_cards c
  set deferred_from = coalesce(c.deferred_from, c.due), due = req.due, updated_at = now()
  from req
  where c.user_id = p_user and c.side = req.side and c.epd = req.epd and c.answer_san = req.answer
    and req.due > c.due and req.due <= coalesce(c.deferred_from, c.due) + interval '7 days';
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- First v2 sign-in: re-key MIGRATED cards to the learner's course book moves.
-- p_moves: [{epd, answer}]. Only cards with migrated_from = 'sm2' move; the
-- target (epd, answer) must be a stored edge with the card's side to move.
-- Collisions merge by the ADR 0003 rule (most reps, then earliest due;
-- lapses/seen/correct summed). Never creates a card.
create or replace function public.train_remap(p_user uuid, p_moves jsonb)
returns int
language plpgsql
security definer set search_path = public, pg_temp
as $$
declare
  m record;
  c public.srs_cards;
  t public.srs_cards;
  v_n int := 0;
begin
  for m in
    select distinct on (x ->> 'epd') x ->> 'epd' as epd, x ->> 'answer' as answer
    from jsonb_array_elements(p_moves) x
    limit 5000
  loop
    if not exists (select 1 from public.theory_edges e where e.from_epd = m.epd and regexp_replace(e.san, '[+#]$', '') = m.answer) then
      continue;
    end if;
    for c in
      select * from public.srs_cards
      where user_id = p_user and epd = m.epd and answer_san <> m.answer and migrated_from = 'sm2'
        and side = case when split_part(m.epd, ' ', 2) = 'w' then 'white' else 'black' end
      for update
    loop
      select * into t from public.srs_cards
      where user_id = p_user and side = c.side and epd = c.epd and answer_san = m.answer for update;
      if found then
        -- merge into the existing card: keep the stronger state, sum the counters
        if c.reps > t.reps or (c.reps = t.reps and c.due < t.due) then
          update public.srs_cards
          set due = c.due, stability = c.stability, difficulty = c.difficulty, elapsed_days = c.elapsed_days,
              scheduled_days = c.scheduled_days, learning_steps = c.learning_steps, reps = c.reps,
              state = c.state, last_review = c.last_review
          where user_id = p_user and side = t.side and epd = t.epd and answer_san = t.answer_san;
        end if;
        update public.srs_cards
        set lapses = t.lapses + c.lapses, seen = t.seen + c.seen, correct = t.correct + c.correct, updated_at = now()
        where user_id = p_user and side = t.side and epd = t.epd and answer_san = t.answer_san;
        delete from public.srs_cards where user_id = p_user and side = c.side and epd = c.epd and answer_san = c.answer_san;
      else
        update public.srs_cards set answer_san = m.answer, updated_at = now()
        where user_id = p_user and side = c.side and epd = c.epd and answer_san = c.answer_san;
      end if;
      v_n := v_n + 1;
    end loop;
  end loop;
  return v_n;
end;
$$;

revoke execute on function public.train_defer(uuid, jsonb) from public, anon, authenticated;
revoke execute on function public.train_remap(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.train_defer(uuid, jsonb) to service_role;
grant execute on function public.train_remap(uuid, jsonb) to service_role;
