-- Chess Openings Trainer — schema, RLS and quiz RPCs.
--
-- Security model:
--   * theory_* tables are public reference data (seeded from supabase/seed.sql).
--   * All quiz state (rating, SRS cards, attempts, per-opening progress) is
--     written ONLY by SECURITY DEFINER RPCs. Clients cannot insert or update
--     these tables directly, so leaderboard scores cannot be forged: the
--     server issues each challenge, knows the acceptable theory moves, grades
--     the answer, and applies the rating/SRS updates itself.
--   * quiz challenges expire and are single-use; issuing is rate-limited.

create extension if not exists pgcrypto;

-- ───────────────────────────── theory (reference) ─────────────────────────
create table public.theory_openings (
  id         int primary key,
  eco        text not null,
  name       text not null,
  line_san   text[] not null,
  final_epd  text not null,
  popularity int not null default 0
);

create table public.theory_edges (
  from_epd   text not null,
  san        text not null,
  to_epd     text not null,
  games      int not null default 0,
  white_wins int not null default 0,
  draws      int not null default 0,
  black_wins int not null default 0,
  primary key (from_epd, san)
);

alter table public.theory_openings enable row level security;
alter table public.theory_edges enable row level security;
create policy "theory openings are public" on public.theory_openings for select using (true);
create policy "theory edges are public" on public.theory_edges for select using (true);

-- ───────────────────────────── profiles ───────────────────────────────────
create table public.profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  username   text unique not null check (username ~ '^[A-Za-z0-9_]{3,20}$'),
  rating     int not null default 800,
  attempts   int not null default 0,
  correct    int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;
create policy "profiles are viewable by everyone" on public.profiles for select using (true);
create policy "users update own profile" on public.profiles
  for update using (id = auth.uid()) with check (id = auth.uid());

-- clients may only change their username; rating/attempts are RPC-owned
revoke update on public.profiles from authenticated, anon;
grant update (username, updated_at) on public.profiles to authenticated;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public, pg_temp
as $$
declare
  v_name text;
begin
  for i in 1..5 loop
    v_name := 'player_' || substr(md5(new.id::text || clock_timestamp()::text), 1, 8);
    begin
      insert into public.profiles (id, username) values (new.id, v_name);
      return new;
    exception when unique_violation then
      -- collision: retry with a fresh suffix
    end;
  end loop;
  raise exception 'could not allocate username';
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ───────────────────────────── quiz state ─────────────────────────────────
create table public.srs_cards (
  user_id       uuid not null references public.profiles (id) on delete cascade,
  opening_id    int not null references public.theory_openings (id),
  epd           text not null,
  line_san      text[] not null,
  ease          double precision not null default 2.5,
  interval_days double precision not null default 0,
  reps          int not null default 0,
  lapses        int not null default 0,
  due           timestamptz not null default now(),
  seen          int not null default 0,
  correct       int not null default 0,
  primary key (user_id, opening_id, epd)
);
create index srs_cards_due_idx on public.srs_cards (user_id, due);

create table public.quiz_challenges (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references public.profiles (id) on delete cascade,
  opening_id       int not null references public.theory_openings (id),
  side             text not null check (side in ('white', 'black')),
  line_san         text[] not null,
  epd              text not null,
  expected         text[] not null,   -- acceptable theory moves, most popular first
  is_review        boolean not null default false,
  answered         boolean not null default false,
  answered_correct boolean,
  issued_at        timestamptz not null default now()
);
create index quiz_challenges_user_idx on public.quiz_challenges (user_id, issued_at desc);

create table public.quiz_attempts (
  id            bigint generated always as identity primary key,
  user_id       uuid not null references public.profiles (id) on delete cascade,
  challenge_id  uuid not null unique references public.quiz_challenges (id) on delete cascade,
  opening_id    int not null,
  epd           text not null,
  san           text not null,
  correct       boolean not null,
  ms            int not null,
  used_hint     boolean not null default false,
  rating_before int not null,
  rating_after  int not null,
  created_at    timestamptz not null default now()
);
create index quiz_attempts_user_created_idx on public.quiz_attempts (user_id, created_at desc);
create index quiz_attempts_created_idx on public.quiz_attempts (created_at desc);

create table public.opening_progress (
  user_id     uuid not null references public.profiles (id) on delete cascade,
  opening_id  int not null references public.theory_openings (id),
  seen        int not null default 0,
  correct     int not null default 0,
  streak      int not null default 0,
  best_streak int not null default 0,
  mastery     numeric not null default 0,
  updated_at  timestamptz not null default now(),
  primary key (user_id, opening_id)
);

alter table public.srs_cards enable row level security;
alter table public.quiz_challenges enable row level security;
alter table public.quiz_attempts enable row level security;
alter table public.opening_progress enable row level security;

-- read own rows; every write path goes through the RPCs below
create policy "own srs cards" on public.srs_cards for select using (user_id = auth.uid());
-- answered only: an open challenge's `expected` column would reveal the answer
create policy "own answered challenges" on public.quiz_challenges
  for select using (user_id = auth.uid() and answered);
create policy "own attempts" on public.quiz_attempts for select using (user_id = auth.uid());
create policy "own progress" on public.opening_progress for select using (user_id = auth.uid());

-- ───────────────────────────── helpers ────────────────────────────────────
create or replace function public.start_epd()
returns text
language sql immutable
as $$ select 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -' $$;

/** Theory moves that continue any line of `p_root`'s family from `p_prefix`. */
create or replace function public.family_next_moves(p_root int, p_prefix text[])
returns table (san text)
language sql stable
as $$
  with root as (select line_san from public.theory_openings where id = p_root)
  select distinct o.line_san[cardinality(p_prefix) + 1]
  from public.theory_openings o, root r
  where o.line_san[1:cardinality(r.line_san)] = r.line_san
    and cardinality(o.line_san) > cardinality(p_prefix)
    and o.line_san[1:cardinality(p_prefix)] = p_prefix;
$$;

/** Mastery %: mature SRS cards over user-turn positions in the family's core lines. */
create or replace function public.compute_mastery(p_user uuid, p_opening int, p_side text)
returns numeric
language plpgsql stable
security definer set search_path = public, pg_temp
as $$
declare
  v_root text[];
  v_denom int;
  v_mature int;
begin
  select line_san into v_root from theory_openings where id = p_opening;
  if v_root is null then return 0; end if;

  with core as (
    select line_san
    from theory_openings
    where line_san[1:cardinality(v_root)] = v_root
    order by popularity desc
    limit 10
  ),
  prefixes as (
    select distinct array_to_string(c.line_san[1:g - 1], ' ') as pre
    from core c, generate_series(1, cardinality(c.line_san)) as g
    where case when p_side = 'white' then (g - 1) % 2 = 0 else (g - 1) % 2 = 1 end
  )
  select count(*) into v_denom from prefixes;

  select count(*) into v_mature
  from srs_cards
  where user_id = p_user and opening_id = p_opening and interval_days >= 21;

  if v_denom is null or v_denom = 0 then return 0; end if;
  return least(100, round(100.0 * v_mature / v_denom));
end;
$$;

-- ───────────────────────────── issue_challenge ────────────────────────────
create or replace function public.issue_challenge(p_opening_id int, p_side text, p_prev uuid default null)
returns jsonb
language plpgsql
security definer set search_path = public, pg_temp
as $$
declare
  v_user uuid := auth.uid();
  v_prefix text[] := '{}';
  v_epd text := public.start_epd();
  v_prev record;
  v_prev_san text;
  v_user_turn boolean;
  v_candidates text[];
  v_pick record;
  v_id uuid;
  v_expected text[];
begin
  if v_user is null then raise exception 'not authenticated'; end if;
  if p_side not in ('white', 'black') then raise exception 'bad side'; end if;
  if not exists (select 1 from theory_openings where id = p_opening_id) then
    raise exception 'unknown opening';
  end if;

  -- rate limit: at most 60 issued challenges per minute
  if (select count(*) from quiz_challenges
      where user_id = v_user and issued_at > now() - interval '1 minute') >= 60 then
    raise exception 'rate_limited';
  end if;

  -- continue the previous line only after a correct answer
  if p_prev is not null then
    select c.*, a.san as answered_san into v_prev
    from quiz_challenges c
    join quiz_attempts a on a.challenge_id = c.id
    where c.id = p_prev and c.user_id = v_user;
    if found and v_prev.answered and v_prev.answered_correct then
      v_prev_san := v_prev.answered_san;
      v_prefix := v_prev.line_san || v_prev_san;
      select to_epd into v_epd from theory_edges
        where from_epd = v_prev.epd and san = v_prev_san;
      if v_epd is null then
        return jsonb_build_object('done', true);
      end if;
    end if;
  end if;

  -- walk opponent moves (weighted by real game counts) until the user's turn
  loop
    v_user_turn := (cardinality(v_prefix) % 2 = 0) = (p_side = 'white');

    select array_agg(san) into v_candidates
    from public.family_next_moves(p_opening_id, v_prefix);

    if v_candidates is null or cardinality(v_candidates) = 0 then
      return jsonb_build_object(
        'id', gen_random_uuid(), 'sans', to_jsonb(v_prefix), 'epd', v_epd,
        'ply', cardinality(v_prefix), 'done', true);
    end if;

    if v_user_turn then
      -- expected moves ordered by popularity
      select array_agg(e.san order by e.games desc) into v_expected
      from theory_edges e
      where e.from_epd = v_epd and e.san = any (v_candidates);
      if v_expected is null then v_expected := v_candidates; end if;

      insert into quiz_challenges (user_id, opening_id, side, line_san, epd, expected)
      values (v_user, p_opening_id, p_side, v_prefix, v_epd, v_expected)
      returning id into v_id;

      return jsonb_build_object(
        'id', v_id, 'sans', to_jsonb(v_prefix), 'epd', v_epd,
        'ply', cardinality(v_prefix), 'done', false);
    end if;

    -- opponent: weighted random pick among family continuations
    select e.san, e.to_epd into v_pick
    from theory_edges e
    where e.from_epd = v_epd and e.san = any (v_candidates)
    order by -ln(random()) / (e.games + 1)
    limit 1;
    if v_pick is null then
      return jsonb_build_object(
        'id', gen_random_uuid(), 'sans', to_jsonb(v_prefix), 'epd', v_epd,
        'ply', cardinality(v_prefix), 'done', true);
    end if;

    v_prefix := v_prefix || v_pick.san;
    v_epd := v_pick.to_epd;
  end loop;
end;
$$;

-- ───────────────────────────── issue_review_challenge ─────────────────────
create or replace function public.issue_review_challenge(p_opening_id int, p_epd text, p_line text[])
returns jsonb
language plpgsql
security definer set search_path = public, pg_temp
as $$
declare
  v_user uuid := auth.uid();
  v_card record;
  v_expected text[];
  v_candidates text[];
  v_id uuid;
begin
  if v_user is null then raise exception 'not authenticated'; end if;

  -- reviews only quiz positions the user actually has a card for
  select * into v_card from srs_cards
  where user_id = v_user and opening_id = p_opening_id and epd = p_epd;
  if not found then raise exception 'no such card'; end if;

  if (select count(*) from quiz_challenges
      where user_id = v_user and issued_at > now() - interval '1 minute') >= 60 then
    raise exception 'rate_limited';
  end if;

  select array_agg(san) into v_candidates
  from public.family_next_moves(p_opening_id, v_card.line_san);
  if v_candidates is null then
    return jsonb_build_object('id', gen_random_uuid(), 'sans', to_jsonb(v_card.line_san),
      'epd', p_epd, 'ply', cardinality(v_card.line_san), 'done', true);
  end if;

  select array_agg(e.san order by e.games desc) into v_expected
  from theory_edges e
  where e.from_epd = p_epd and e.san = any (v_candidates);
  if v_expected is null then v_expected := v_candidates; end if;

  insert into quiz_challenges (user_id, opening_id, side, line_san, epd, expected, is_review)
  values (v_user, p_opening_id,
          case when cardinality(v_card.line_san) % 2 = 0 then 'white' else 'black' end,
          v_card.line_san, p_epd, v_expected, true)
  returning id into v_id;

  return jsonb_build_object('id', v_id, 'sans', to_jsonb(v_card.line_san),
    'epd', p_epd, 'ply', cardinality(v_card.line_san), 'done', false);
end;
$$;

-- ───────────────────────────── answer_challenge ───────────────────────────
create or replace function public.answer_challenge(p_challenge uuid, p_san text, p_ms int, p_hint boolean default false)
returns jsonb
language plpgsql
security definer set search_path = public, pg_temp
as $$
declare
  v_user uuid := auth.uid();
  v_ch record;
  v_correct boolean;
  v_expired boolean;
  v_best text;
  v_ply int;
  v_node_games numeric;
  v_move_games numeric;
  v_rarity int;
  v_difficulty int;
  v_rating int;
  v_expected_score numeric;
  v_speed numeric;
  v_delta int;
  v_new_rating int;
  v_quality int;
  v_card record;
  v_ease double precision;
  v_interval double precision;
  v_reps int;
  v_lapses int;
  v_due timestamptz;
  v_continues boolean := false;
  v_next_epd text;
  v_cont_san text;
  v_mastery numeric;
  v_ms int := greatest(200, least(coalesce(p_ms, 200), 600000));
begin
  if v_user is null then raise exception 'not authenticated'; end if;

  select * into v_ch from quiz_challenges
  where id = p_challenge and user_id = v_user
  for update;
  if not found then raise exception 'unknown challenge'; end if;
  if v_ch.answered then raise exception 'already answered'; end if;

  v_expired := v_ch.issued_at < now() - interval '5 minutes';
  v_correct := (not v_expired) and p_san = any (v_ch.expected);
  v_best := v_ch.expected[1];
  v_ply := cardinality(v_ch.line_san);

  -- difficulty from depth + rarity of the expected move
  select coalesce(sum(games), 0) into v_node_games from theory_edges where from_epd = v_ch.epd;
  select coalesce(games, 0) into v_move_games from theory_edges where from_epd = v_ch.epd and san = v_best;
  if v_node_games > 0 and v_move_games > 0 then
    v_rarity := least(600, round(300 * log(greatest(1.0, v_node_games / v_move_games))));
  else
    v_rarity := 150;
  end if;
  v_difficulty := least(2800, 600 + v_ply * 55 + v_rarity);

  -- Elo update (server-authoritative)
  select rating into v_rating from profiles where id = v_user for update;
  v_expected_score := 1.0 / (1.0 + power(10, (v_difficulty - v_rating) / 400.0));
  if v_correct then
    v_speed := case
      when v_ms <= 3000 then 1.0
      when v_ms >= 20000 then 0.5
      else 1.0 - 0.5 * (v_ms - 3000) / 17000.0
    end;
    v_delta := greatest(1, round(24 * (1.0 - v_expected_score) * v_speed));
  else
    v_delta := round(24 * (0.0 - v_expected_score));
  end if;
  v_new_rating := greatest(100, v_rating + v_delta);

  update profiles
  set rating = v_new_rating,
      attempts = attempts + 1,
      correct = correct + case when v_correct then 1 else 0 end,
      updated_at = now()
  where id = v_user;

  -- SM-2 (mirrors src/lib/srs.ts)
  v_quality := case
    when not v_correct then 1
    when p_hint then 3
    when v_ms < 4000 then 5
    when v_ms < 12000 then 4
    else 3
  end;

  select * into v_card from srs_cards
  where user_id = v_user and opening_id = v_ch.opening_id and epd = v_ch.epd;
  if not found then
    v_ease := 2.5; v_interval := 0; v_reps := 0; v_lapses := 0;
  else
    v_ease := v_card.ease; v_interval := v_card.interval_days;
    v_reps := v_card.reps; v_lapses := v_card.lapses;
  end if;

  if v_quality < 3 then
    v_reps := 0;
    v_lapses := v_lapses + 1;
    v_interval := 0;
    v_due := now() + interval '10 minutes';
    v_ease := greatest(1.3, v_ease - 0.2);
  else
    v_reps := v_reps + 1;
    if v_reps = 1 then v_interval := 1;
    elsif v_reps = 2 then v_interval := 6;
    else v_interval := round((v_interval * v_ease)::numeric, 1);
    end if;
    v_ease := greatest(1.3, v_ease + (0.1 - (5 - v_quality) * (0.08 + (5 - v_quality) * 0.02)));
    v_due := now() + (v_interval || ' days')::interval;
  end if;

  insert into srs_cards (user_id, opening_id, epd, line_san, ease, interval_days, reps, lapses, due, seen, correct)
  values (v_user, v_ch.opening_id, v_ch.epd, v_ch.line_san, v_ease, v_interval, v_reps, v_lapses, v_due,
          1, case when v_quality >= 3 then 1 else 0 end)
  on conflict (user_id, opening_id, epd) do update
  set ease = excluded.ease,
      interval_days = excluded.interval_days,
      reps = excluded.reps,
      lapses = excluded.lapses,
      due = excluded.due,
      line_san = excluded.line_san,
      seen = srs_cards.seen + 1,
      correct = srs_cards.correct + case when v_quality >= 3 then 1 else 0 end;

  -- does theory continue after the (corrected) move?
  v_cont_san := case when v_correct then p_san else v_best end;
  select to_epd into v_next_epd from theory_edges where from_epd = v_ch.epd and san = v_cont_san;
  if v_next_epd is not null then
    v_continues := exists (
      select 1 from public.family_next_moves(v_ch.opening_id, v_ch.line_san || v_cont_san));
  end if;

  -- per-opening progress + mastery
  v_mastery := public.compute_mastery(v_user, v_ch.opening_id, v_ch.side);
  insert into opening_progress (user_id, opening_id, seen, correct, streak, best_streak, mastery, updated_at)
  values (v_user, v_ch.opening_id, 1, case when v_correct then 1 else 0 end,
          case when v_correct then 1 else 0 end, case when v_correct then 1 else 0 end,
          v_mastery, now())
  on conflict (user_id, opening_id) do update
  set seen = opening_progress.seen + 1,
      correct = opening_progress.correct + case when v_correct then 1 else 0 end,
      streak = case when v_correct then opening_progress.streak + 1 else 0 end,
      best_streak = greatest(opening_progress.best_streak,
                             case when v_correct then opening_progress.streak + 1 else 0 end),
      mastery = v_mastery,
      updated_at = now();

  insert into quiz_attempts (user_id, challenge_id, opening_id, epd, san, correct, ms, used_hint, rating_before, rating_after)
  values (v_user, p_challenge, v_ch.opening_id, v_ch.epd, p_san, v_correct, v_ms, p_hint, v_rating, v_new_rating);

  update quiz_challenges set answered = true, answered_correct = v_correct where id = p_challenge;

  return jsonb_build_object(
    'correct', v_correct,
    'expected', to_jsonb(v_ch.expected),
    'best', v_best,
    'rating_delta', v_delta,
    'rating', v_new_rating,
    'line_continues', v_continues,
    'due', v_due
  );
end;
$$;

-- ───────────────────────────── daily streak ───────────────────────────────
create or replace function public.daily_streak()
returns int
language plpgsql stable
security definer set search_path = public, pg_temp
as $$
declare
  v_user uuid := auth.uid();
  v_streak int := 0;
  v_day date := current_date;
begin
  if v_user is null then return 0; end if;
  -- today counts if active; otherwise the streak may still be alive from yesterday
  if not exists (select 1 from quiz_attempts where user_id = v_user and created_at::date = v_day) then
    v_day := v_day - 1;
  end if;
  while exists (select 1 from quiz_attempts where user_id = v_user and created_at::date = v_day) loop
    v_streak := v_streak + 1;
    v_day := v_day - 1;
  end loop;
  return v_streak;
end;
$$;

-- ───────────────────────────── leaderboards ───────────────────────────────
-- Views run as owner (postgres), so they can aggregate quiz_attempts across
-- users while row-level security keeps raw rows private.
create view public.leaderboard_global as
select
  p.username,
  p.rating,
  p.attempts,
  p.correct,
  rank() over (order by p.rating desc, p.attempts desc) as rank
from public.profiles p
where p.attempts >= 10
order by p.rating desc, p.attempts desc
limit 100;

create view public.leaderboard_weekly as
select
  p.username,
  sum(a.rating_after - a.rating_before)::int as rating_gain,
  count(*)::int as attempts,
  sum(case when a.correct then 1 else 0 end)::int as correct,
  rank() over (order by sum(a.rating_after - a.rating_before) desc, count(*) desc) as rank
from public.quiz_attempts a
join public.profiles p on p.id = a.user_id
where a.created_at >= date_trunc('week', now())
group by p.id, p.username
having count(*) >= 5
order by rating_gain desc, attempts desc
limit 100;

grant select on public.leaderboard_global, public.leaderboard_weekly to anon, authenticated;

-- ───────────────────────────── function grants ────────────────────────────
revoke execute on all functions in schema public from public, anon;
grant execute on function public.issue_challenge(int, text, uuid) to authenticated;
grant execute on function public.issue_review_challenge(int, text, text[]) to authenticated;
grant execute on function public.answer_challenge(uuid, text, int, boolean) to authenticated;
grant execute on function public.daily_streak() to authenticated;
grant execute on function public.start_epd() to anon, authenticated;
grant execute on function public.family_next_moves(int, text[]) to anon, authenticated;
