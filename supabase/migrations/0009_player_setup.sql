-- Player setup (ADR 0008): the first-login onboarding answers and the
-- estimated Elo that personalises the app. Tested on a local Postgres
-- (scripts/supabase/test-0009.sh); the owner applies it to the hosted project.
--
-- Its own table, not columns on profiles: profiles is readable by everyone
-- (leaderboard), and a self-reported level or an estimate is private.
--
-- The estimate is computed in the browser from the linked accounts' ratings
-- (src/lib/rating/estimate.ts) and only personalises the app for its owner:
-- it never touches profiles.rating, so the leaderboard stays earned. The
-- server checks shapes and ranges, nothing more.
--
-- Security model: own-row select; every write through save_setup().
-- Deletion: cascades from profiles (→ auth.users).
-- Idempotent: safe to re-run.

create table if not exists public.player_setup (
  user_id       uuid primary key references public.profiles (id) on delete cascade,
  -- set when the player finished or skipped setup; null = show the setup modal
  completed_at  timestamptz,
  skipped       boolean not null default false,
  -- the answer to "how would you describe your chess?" (used when no linked
  -- rating is reliable yet, e.g. a brand-new account at Lichess's 1500?)
  self_level    text check (self_level in ('new', 'basics', 'casual', 'club', 'strong')),
  -- on one Elo-like scale (approximately FIDE), see estimate.ts
  estimated_elo smallint check (estimated_elo between 100 and 3500),
  -- how it was reached: {confidence, low, high, basis: [{platform, timeClass, rating, games, weight}], source}
  estimate      jsonb not null default '{}'::jsonb check (jsonb_typeof(estimate) = 'object' and pg_column_size(estimate) <= 4096),
  updated_at    timestamptz not null default now()
);

alter table public.player_setup enable row level security;
drop policy if exists "own player setup" on public.player_setup;
create policy "own player setup" on public.player_setup for select using (user_id = auth.uid());
revoke all on public.player_setup from public, anon, authenticated;
grant select on public.player_setup to authenticated;
grant all on public.player_setup to service_role;

-- The caller's setup, or null before they've seen the modal.
create or replace function public.get_setup()
returns jsonb
language sql stable
security definer set search_path = public, pg_temp
as $$
  select to_jsonb(s) - 'user_id'
  from public.player_setup s
  where s.user_id = auth.uid()
$$;

-- p: any of
--   complete (boolean)      true = finished setup (sets completed_at once)
--   skipped (boolean)       true = "skip setup" (also sets completed_at)
--   self_level (text|null)  one of the levels above
--   estimated_elo (int|null)
--   estimate (object)
-- Unknown keys are refused. Returns the stored row.
create or replace function public.save_setup(p jsonb)
returns jsonb
language plpgsql
security definer set search_path = public, pg_temp
as $$
declare
  v_user uuid := auth.uid();
  k text;
begin
  if v_user is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if p is null or jsonb_typeof(p) <> 'object' then
    raise exception 'bad setup' using errcode = '22023';
  end if;
  for k in select jsonb_object_keys(p) loop
    if k in ('complete', 'skipped') then
      if jsonb_typeof(p -> k) <> 'boolean' then raise exception 'bad value for %', k using errcode = '22023'; end if;
    elsif k = 'self_level' then
      if jsonb_typeof(p -> k) <> 'null' and coalesce(p ->> k, '') not in ('new', 'basics', 'casual', 'club', 'strong') then
        raise exception 'bad value for self_level' using errcode = '22023';
      end if;
    elsif k = 'estimated_elo' then
      if jsonb_typeof(p -> k) <> 'null' and (jsonb_typeof(p -> k) <> 'number' or (p ->> k)::numeric not between 100 and 3500) then
        raise exception 'bad value for estimated_elo' using errcode = '22023';
      end if;
    elsif k = 'estimate' then
      if jsonb_typeof(p -> k) <> 'object' or pg_column_size(p -> k) > 4096 then
        raise exception 'bad value for estimate' using errcode = '22023';
      end if;
    else
      raise exception 'unknown setup key %', k using errcode = '22023';
    end if;
  end loop;

  insert into player_setup (user_id) values (v_user) on conflict (user_id) do nothing;
  update player_setup
     set skipped       = case when p ? 'skipped' then (p ->> 'skipped')::boolean else skipped end,
         completed_at  = case when coalesce((p ->> 'complete')::boolean, false) or coalesce((p ->> 'skipped')::boolean, false)
                              then coalesce(completed_at, now()) else completed_at end,
         self_level    = case when p ? 'self_level' then p ->> 'self_level' else self_level end,
         estimated_elo = case when p ? 'estimated_elo' then round((p ->> 'estimated_elo')::numeric)::smallint else estimated_elo end,
         estimate      = case when p ? 'estimate' then p -> 'estimate' else estimate end,
         updated_at    = now()
   where user_id = v_user;
  return public.get_setup();
end;
$$;

revoke all on function public.get_setup() from public, anon, authenticated;
revoke all on function public.save_setup(jsonb) from public, anon, authenticated;
grant execute on function public.get_setup() to authenticated;
grant execute on function public.save_setup(jsonb) to authenticated;
grant execute on function public.get_setup() to service_role;
grant execute on function public.save_setup(jsonb) to service_role;
