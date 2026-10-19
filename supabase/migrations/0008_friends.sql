-- Friends (ADR 0007): follows, blocks, privacy settings, activity events,
-- notifications and the functions every cross-user read goes through.
-- Tested on a local Postgres (scripts/supabase/test-0008.sh); the owner
-- applies it to the hosted project.
--
-- Security model:
--   * No table policy grants another user's rows to anyone. Own-row reads
--     only (blocks, privacy_settings, notifications); the rest has none.
--   * Every cross-user read is a SECURITY DEFINER function that takes the
--     viewer from auth.uid() (never a parameter) and checks each section
--     with friends_audience() + friends_reaches(). Those two are not granted
--     to clients: with a viewer parameter they would reveal who follows whom.
--   * Every write is an RPC that reads auth.uid(); clients hold no
--     insert/update/delete grant on any of these tables.
--   * activity_events are written only by the triggers below.
--
-- Deletion: every user column cascades from profiles (→ auth.users), so
-- DELETE /api/account removes follows, blocks, settings, events,
-- notifications and rate-limit rows in both directions.
-- Idempotent: safe to re-run.

-- ───────────────────────────── tables ─────────────────────────────────────
create table if not exists public.follows (
  follower_id uuid not null references public.profiles (id) on delete cascade,
  followee_id uuid not null references public.profiles (id) on delete cascade,
  -- pending = a request to a player with approve_followers on; grants nothing
  status      text not null check (status in ('active', 'pending')),
  created_at  timestamptz not null default now(),
  primary key (follower_id, followee_id),
  check (follower_id <> followee_id)
);
-- followers list, requests, counts
create index if not exists follows_followee_idx on public.follows (followee_id, status);

create table if not exists public.blocks (
  blocker_id uuid not null references public.profiles (id) on delete cascade,
  blocked_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  check (blocker_id <> blocked_id)
);
create index if not exists blocks_blocked_idx on public.blocks (blocked_id);

-- one level per section; a missing row means every section is only_me (ADR 0007, defaults A)
create table if not exists public.privacy_settings (
  user_id           uuid primary key references public.profiles (id) on delete cascade,
  linked            text not null default 'only_me' check (linked   in ('everyone', 'followers', 'friends', 'only_me')),
  learning          text not null default 'only_me' check (learning in ('everyone', 'followers', 'friends', 'only_me')),
  stats             text not null default 'only_me' check (stats    in ('everyone', 'followers', 'friends', 'only_me')),
  activity          text not null default 'only_me' check (activity in ('everyone', 'followers', 'friends', 'only_me')),
  approve_followers boolean not null default false,
  -- the "what friends see" preset card was answered (either way)
  preset_answered   boolean not null default false,
  updated_at        timestamptz not null default now()
);

create table if not exists public.activity_events (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  kind       text not null check (kind in ('lines', 'streak', 'rating', 'course')),
  -- idempotence: one row per (user, key); see the triggers for each kind's key
  dedupe_key text not null check (length(dedupe_key) <= 200),
  payload    jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, dedupe_key)
);
create index if not exists activity_events_user_idx on public.activity_events (user_id, updated_at desc);

create table if not exists public.notifications (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  actor_id   uuid not null references public.profiles (id) on delete cascade,
  kind       text not null check (kind in ('new_follower', 'follow_request', 'request_accepted')),
  created_at timestamptz not null default now(),
  read_at    timestamptz,
  -- a follow → unfollow → follow loop refreshes one row instead of adding rows
  unique (user_id, actor_id, kind)
);
create index if not exists notifications_unread_idx on public.notifications (user_id) where read_at is null;

create table if not exists public.rate_limits (
  user_id      uuid not null references public.profiles (id) on delete cascade,
  bucket       text not null,
  window_start timestamptz not null default now(),
  calls        int not null default 0 check (calls >= 0),
  primary key (user_id, bucket)
);

-- prefix search on usernames: the unique lower() index doesn't serve LIKE under a non-C collation
create index if not exists profiles_username_prefix_idx on public.profiles (lower(username) text_pattern_ops);
-- "first correct answer on this line" (activity trigger) and "lines trained"
create index if not exists quiz_attempts_user_line_idx on public.quiz_attempts (user_id, course_id, line_id) where correct;

-- one switch per section replaces the per-account column reserved in 0006 (ADR 0007, decision 4)
alter table public.linked_accounts drop column if exists visibility;

-- ───────────────────────────── RLS + grants ───────────────────────────────
alter table public.follows          enable row level security;
alter table public.blocks           enable row level security;
alter table public.privacy_settings enable row level security;
alter table public.activity_events  enable row level security;
alter table public.notifications    enable row level security;
alter table public.rate_limits      enable row level security;

drop policy if exists "own blocks" on public.blocks;
create policy "own blocks" on public.blocks for select using (blocker_id = auth.uid());
drop policy if exists "own privacy settings" on public.privacy_settings;
create policy "own privacy settings" on public.privacy_settings for select using (user_id = auth.uid());
drop policy if exists "own notifications" on public.notifications;
create policy "own notifications" on public.notifications for select using (user_id = auth.uid());
-- follows, activity_events, rate_limits: no policies (functions only)

revoke all on public.follows, public.blocks, public.privacy_settings, public.activity_events,
  public.notifications, public.rate_limits from public, anon, authenticated;
grant select on public.blocks, public.privacy_settings, public.notifications to authenticated;
grant all on public.follows, public.blocks, public.privacy_settings, public.activity_events,
  public.notifications, public.rate_limits to service_role;

-- ───────────────────────────── visibility ─────────────────────────────────
-- The audience of viewer v for owner o (ADR 0007, decision 2), in order:
-- owner, blocked (either direction), anonymous, friend, follower, stranger.
-- 'none' = no such owner.
create or replace function public.friends_audience(p_viewer uuid, p_owner uuid)
returns text
language plpgsql stable
security definer set search_path = public, pg_temp
as $$
declare
  v_out boolean;
  v_in boolean;
begin
  if p_owner is null then return 'none'; end if;
  if p_viewer = p_owner then return 'owner'; end if;
  if p_viewer is not null and exists (
    select 1 from blocks
    where (blocker_id = p_viewer and blocked_id = p_owner) or (blocker_id = p_owner and blocked_id = p_viewer)
  ) then
    return 'blocked';
  end if;
  if p_viewer is null then return 'anonymous'; end if;
  v_out := exists (select 1 from follows where follower_id = p_viewer and followee_id = p_owner and status = 'active');
  v_in  := exists (select 1 from follows where follower_id = p_owner and followee_id = p_viewer and status = 'active');
  if v_out and v_in then return 'friend'; end if;
  if v_out then return 'follower'; end if;
  return 'stranger';
end;
$$;

-- Does an audience reach a section level? The truth table in ADR 0007
-- (mirrored by src/lib/friends/visibility.ts, both tested on one fixture).
create or replace function public.friends_reaches(p_audience text, p_level text)
returns boolean
language sql immutable
set search_path = public, pg_temp
as $$
  select case p_audience
    when 'owner'     then true
    when 'friend'    then p_level in ('everyone', 'followers', 'friends')
    when 'follower'  then p_level in ('everyone', 'followers')
    when 'stranger'  then p_level = 'everyone'
    when 'anonymous' then p_level = 'everyone'
    else false
  end
$$;

-- The owner's level for a section; no settings row = only_me.
create or replace function public.friends_level(p_owner uuid, p_section text)
returns text
language sql stable
security definer set search_path = public, pg_temp
as $$
  select coalesce((
    select case p_section
      when 'linked'   then linked
      when 'learning' then learning
      when 'stats'    then stats
      when 'activity' then activity
    end
    from privacy_settings where user_id = p_owner
  ), 'only_me')
$$;

create or replace function public.friends_can_view(p_viewer uuid, p_owner uuid, p_section text)
returns boolean
language sql stable
security definer set search_path = public, pg_temp
as $$
  select public.friends_reaches(public.friends_audience(p_viewer, p_owner), public.friends_level(p_owner, p_section))
$$;

-- ───────────────────────────── helpers ────────────────────────────────────
create or replace function public.friends_target(p_username text)
returns uuid
language sql stable
security definer set search_path = public, pg_temp
as $$
  select id from public.profiles where lower(username) = lower(trim(p_username))
$$;

create or replace function public.friends_require_user()
returns uuid
language plpgsql stable
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  return auth.uid();
end;
$$;

-- Takes one of p_limit calls per window, atomically (the insights_claim_sync
-- shape, 0007). Raises rate_limited with the seconds to wait in DETAIL.
create or replace function public.friends_claim(p_user uuid, p_bucket text, p_limit int, p_window interval)
returns void
language plpgsql
security definer set search_path = public, pg_temp
as $$
declare
  v_start timestamptz;
begin
  insert into rate_limits as r (user_id, bucket, window_start, calls)
  values (p_user, p_bucket, now(), 1)
  on conflict (user_id, bucket) do update
    set window_start = case when r.window_start <= now() - p_window then now() else r.window_start end,
        calls        = case when r.window_start <= now() - p_window then 1 else r.calls + 1 end
    where r.window_start <= now() - p_window or r.calls < p_limit
  returning window_start into v_start;
  if found then return; end if;
  select window_start into v_start from rate_limits where user_id = p_user and bucket = p_bucket;
  raise exception 'rate_limited'
    using detail = greatest(1, ceil(extract(epoch from (v_start + p_window - now())))::int)::text;
end;
$$;

-- Consecutive UTC days with a graded answer, ending on p_day (or the day
-- before, when p_day has none yet): the dashboard's rule over server rows.
create or replace function public.friends_streak(p_user uuid, p_day date default (now() at time zone 'UTC')::date)
returns int
language plpgsql stable
security definer set search_path = public, pg_temp
as $$
declare
  v_days date[];
  v_day date := p_day;
  v_n int := 0;
begin
  select array_agg(distinct (created_at at time zone 'UTC')::date) into v_days
  from quiz_attempts
  where user_id = p_user and created_at >= ((p_day - 400)::timestamp at time zone 'UTC')
    and created_at < ((p_day + 1)::timestamp at time zone 'UTC');
  if v_days is null then return 0; end if;
  if not (v_day = any (v_days)) then v_day := v_day - 1; end if;
  while v_day = any (v_days) loop
    v_n := v_n + 1;
    v_day := v_day - 1;
  end loop;
  return v_n;
end;
$$;

create or replace function public.friends_stats(p_user uuid)
returns jsonb
language sql stable
security definer set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'streak', public.friends_streak(p_user),
    'lines_trained', (
      select count(*) from (
        select distinct course_id, line_id from quiz_attempts
        where user_id = p_user and correct and course_id is not null and line_id is not null
      ) l),
    'moves_this_week', (
      select count(*) from quiz_attempts
      where user_id = p_user
        and created_at >= (date_trunc('week', now() at time zone 'UTC') at time zone 'UTC')),
    'attempts', p.attempts,
    'correct', p.correct
  )
  from profiles p where p.id = p_user
$$;

create or replace function public.friends_linked(p_user uuid)
returns jsonb
language sql stable
security definer set search_path = public, pg_temp
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'platform', platform, 'username', username, 'verified', verified,
    'ratings', ratings, 'last_synced_at', last_synced_at) order by platform), '[]'::jsonb)
  from linked_accounts where user_id = p_user
$$;

-- Top 5 openings per colour from the imported games, with results.
create or replace function public.friends_played(p_user uuid)
returns jsonb
language sql stable
security definer set search_path = public, pg_temp
as $$
  with g as (
    select color, coalesce(opening_name, eco, 'Unclassified') as name,
           count(*) as games,
           count(*) filter (where result = 'win') as wins,
           count(*) filter (where result = 'draw') as draws,
           count(*) filter (where result = 'loss') as losses
    from game_summaries where user_id = p_user
    group by 1, 2
  ), ranked as (
    select *, row_number() over (partition by color order by games desc, name) as n from g
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'color', color, 'name', name, 'games', games, 'wins', wins, 'draws', draws, 'losses', losses)
    order by color desc, games desc, name), '[]'::jsonb)
  from ranked where n <= 5
$$;

create or replace function public.friends_learning(p_user uuid)
returns jsonb
language sql stable
security definer set search_path = public, pg_temp
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'course_id', course_id, 'seen', seen, 'correct', correct, 'mastery', mastery, 'updated_at', updated_at)
    order by updated_at desc), '[]'::jsonb)
  from (select * from course_progress where user_id = p_user order by updated_at desc limit 12) c
$$;

-- Platforms both players linked, where the owner's `linked` section reaches
-- the viewer and neither blocked the other (spec §2.7).
create or replace function public.friends_challenge(p_viewer uuid, p_owner uuid)
returns jsonb
language sql stable
security definer set search_path = public, pg_temp
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'platform', t.platform,
    'my_username', m.username, 'my_ratings', m.ratings,
    'their_username', t.username, 'their_ratings', t.ratings) order by t.platform), '[]'::jsonb)
  from linked_accounts t
  join linked_accounts m on m.user_id = p_viewer and m.platform = t.platform
  where t.user_id = p_owner
    and p_viewer is not null and p_viewer <> p_owner
    and public.friends_can_view(p_viewer, p_owner, 'linked')
$$;

-- ───────────────────────────── reads ──────────────────────────────────────
-- One profile, with only the sections the caller may see. null when there's
-- no such player or a block exists either way (indistinguishable).
-- p_view_as ('everyone' | 'follower' | 'friend') previews the profile as that
-- audience; it only applies when the caller is the owner.
create or replace function public.get_profile(p_username text, p_view_as text default null)
returns jsonb
language plpgsql stable
security definer set search_path = public, pg_temp
as $$
declare
  v_viewer uuid := auth.uid();
  o record;
  v_aud text;
  v_preview boolean := false;
  v_linked boolean;
  v_learning boolean;
  v_stats boolean;
  v_activity boolean;
begin
  select id, username, rating, attempts, correct into o from profiles where lower(username) = lower(trim(p_username));
  if not found then return null; end if;
  v_aud := public.friends_audience(v_viewer, o.id);
  if v_aud = 'blocked' then return null; end if;
  if v_aud = 'owner' and p_view_as is not null then
    v_aud := case p_view_as when 'everyone' then 'stranger' when 'follower' then 'follower' when 'friend' then 'friend' else 'owner' end;
    v_preview := v_aud <> 'owner';
  end if;

  v_linked   := public.friends_reaches(v_aud, public.friends_level(o.id, 'linked'));
  v_learning := public.friends_reaches(v_aud, public.friends_level(o.id, 'learning'));
  v_stats    := public.friends_reaches(v_aud, public.friends_level(o.id, 'stats'));
  v_activity := public.friends_reaches(v_aud, public.friends_level(o.id, 'activity'));

  return jsonb_build_object(
    'username', o.username,
    'rating', o.rating,
    'attempts', o.attempts,
    'correct', o.correct,
    'followers', (select count(*) from follows where followee_id = o.id and status = 'active'),
    'following', (select count(*) from follows where follower_id = o.id and status = 'active'),
    'preview', v_preview,
    'relationship', case when v_viewer is null or v_preview then null else jsonb_build_object(
      'self', v_viewer = o.id,
      'following', exists (select 1 from follows where follower_id = v_viewer and followee_id = o.id and status = 'active'),
      'requested', exists (select 1 from follows where follower_id = v_viewer and followee_id = o.id and status = 'pending'),
      'follows_you', exists (select 1 from follows where follower_id = o.id and followee_id = v_viewer and status = 'active'),
      'friends', v_aud = 'friend',
      'approve_followers', coalesce((select approve_followers from privacy_settings where user_id = o.id), false)
    ) end,
    'some_private', not (v_linked and v_learning and v_stats and v_activity),
    'linked',   case when v_linked then public.friends_linked(o.id) end,
    'played',   case when v_linked then public.friends_played(o.id) end,
    'learning', case when v_learning then public.friends_learning(o.id) end,
    'stats',    case when v_stats then public.friends_stats(o.id) end,
    'challenge', case when v_preview then '[]'::jsonb else public.friends_challenge(v_viewer, o.id) end
  );
end;
$$;

-- Up to 20 players whose username starts with p_prefix (case-insensitive),
-- minus the caller and anyone blocked either way. 30 per minute.
create or replace function public.search_profiles(p_prefix text)
returns jsonb
language plpgsql
security definer set search_path = public, pg_temp
as $$
declare
  v_user uuid := public.friends_require_user();
  v_prefix text := lower(trim(coalesce(p_prefix, '')));
begin
  if v_prefix !~ '^[a-z0-9_]{2,20}$' then
    raise exception 'bad prefix' using errcode = '22023';
  end if;
  perform public.friends_claim(v_user, 'search', 30, interval '1 minute');
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'username', p.username,
      'following', exists (select 1 from follows where follower_id = v_user and followee_id = p.id and status = 'active'),
      'requested', exists (select 1 from follows where follower_id = v_user and followee_id = p.id and status = 'pending'),
      'follows_you', exists (select 1 from follows where follower_id = p.id and followee_id = v_user and status = 'active')
    ) order by lower(p.username))
    from (
      select id, username from profiles
      -- '_' is a LIKE wildcard: escape it
      where lower(username) like replace(v_prefix, '_', '\_') || '%'
        and id <> v_user
        and not exists (select 1 from blocks where (blocker_id = v_user and blocked_id = profiles.id) or (blocker_id = profiles.id and blocked_id = v_user))
      order by lower(username)
      limit 20
    ) p
  ), '[]'::jsonb);
end;
$$;

-- The caller's own lists: 'following' (incl. pending requests they sent),
-- 'followers', 'requests' (pending, to them). Other players' lists are never exposed.
create or replace function public.my_follows(p_kind text)
returns jsonb
language plpgsql stable
security definer set search_path = public, pg_temp
as $$
declare
  v_user uuid := public.friends_require_user();
begin
  if p_kind = 'following' then
    return coalesce((
      select jsonb_agg(jsonb_build_object(
        'username', p.username, 'status', f.status, 'since', f.created_at,
        'friends', exists (select 1 from follows r where r.follower_id = p.id and r.followee_id = v_user and r.status = 'active') and f.status = 'active',
        'challenge', public.friends_challenge(v_user, p.id)
      ) order by lower(p.username))
      from follows f join profiles p on p.id = f.followee_id
      where f.follower_id = v_user), '[]'::jsonb);
  elsif p_kind = 'followers' then
    return coalesce((
      select jsonb_agg(jsonb_build_object(
        'username', p.username, 'since', f.created_at,
        'following', exists (select 1 from follows r where r.follower_id = v_user and r.followee_id = p.id and r.status = 'active'),
        'requested', exists (select 1 from follows r where r.follower_id = v_user and r.followee_id = p.id and r.status = 'pending')
      ) order by lower(p.username))
      from follows f join profiles p on p.id = f.follower_id
      where f.followee_id = v_user and f.status = 'active'), '[]'::jsonb);
  elsif p_kind = 'requests' then
    return coalesce((
      select jsonb_agg(jsonb_build_object('username', p.username, 'since', f.created_at) order by f.created_at desc)
      from follows f join profiles p on p.id = f.follower_id
      where f.followee_id = v_user and f.status = 'pending'), '[]'::jsonb);
  end if;
  raise exception 'bad kind' using errcode = '22023';
end;
$$;

-- Events of the players the caller follows (active), newer than 30 days. An
-- item needs the owner's `activity` section AND the section it reveals.
create or replace function public.get_feed(p_before timestamptz default null, p_limit int default 30)
returns jsonb
language plpgsql stable
security definer set search_path = public, pg_temp
as $$
declare
  v_user uuid := public.friends_require_user();
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', e.id, 'username', e.username, 'kind', e.kind, 'payload', e.payload,
      'created_at', e.created_at, 'updated_at', e.updated_at) order by e.updated_at desc, e.id desc)
    from (
      select ev.*, p.username
      from follows f
      join profiles p on p.id = f.followee_id
      cross join lateral (select public.friends_audience(v_user, f.followee_id) as aud) a
      join activity_events ev on ev.user_id = f.followee_id
      where f.follower_id = v_user and f.status = 'active'
        and ev.updated_at > now() - interval '30 days'
        and (p_before is null or ev.updated_at < p_before)
        and public.friends_reaches(a.aud, public.friends_level(f.followee_id, 'activity'))
        and public.friends_reaches(a.aud, public.friends_level(f.followee_id,
              case ev.kind when 'rating' then 'linked' when 'streak' then 'stats' else 'learning' end))
        and (ev.kind <> 'rating'
             or abs(coalesce((ev.payload ->> 'to')::int, 0) - coalesce((ev.payload ->> 'from')::int, 0)) >= 20)
      order by ev.updated_at desc, ev.id desc
      limit least(greatest(coalesce(p_limit, 30), 1), 100)
    ) e), '[]'::jsonb);
end;
$$;

-- The caller's own learning and accounts next to the other player's visible ones.
create or replace function public.compare_with(p_username text)
returns jsonb
language plpgsql stable
security definer set search_path = public, pg_temp
as $$
declare
  v_user uuid := public.friends_require_user();
  v_other uuid := public.friends_target(p_username);
  v_aud text;
begin
  v_aud := public.friends_audience(v_user, v_other);
  if v_aud in ('none', 'blocked', 'owner') then return null; end if;
  return jsonb_build_object(
    'me', jsonb_build_object('username', (select username from profiles where id = v_user),
      'learning', public.friends_learning(v_user), 'linked', public.friends_linked(v_user)),
    'them', jsonb_build_object('username', (select username from profiles where id = v_other),
      'learning', case when public.friends_reaches(v_aud, public.friends_level(v_other, 'learning')) then public.friends_learning(v_other) end,
      'linked',   case when public.friends_reaches(v_aud, public.friends_level(v_other, 'linked')) then public.friends_linked(v_other) end)
  );
end;
$$;

-- The caller plus the players they follow (active), minus blocks, ranked like
-- leaderboard_global. Those numbers are public already: no section gating.
create or replace function public.friends_leaderboard()
returns jsonb
language plpgsql stable
security definer set search_path = public, pg_temp
as $$
declare
  v_user uuid := public.friends_require_user();
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'rank', r.rank, 'username', r.username, 'rating', r.rating, 'attempts', r.attempts, 'correct', r.correct)
      order by r.rank, lower(r.username))
    from (
      select p.username, p.rating, p.attempts, p.correct,
             rank() over (order by p.rating desc, p.attempts desc) as rank
      from profiles p
      -- driven by the caller's follows (pkey prefix), not a scan of every profile
      where p.id in (
        select v_user
        union
        select f.followee_id from follows f
        where f.follower_id = v_user and f.status = 'active'
          and not exists (select 1 from blocks b where (b.blocker_id = v_user and b.blocked_id = f.followee_id) or (b.blocker_id = f.followee_id and b.blocked_id = v_user)))
    ) r), '[]'::jsonb);
end;
$$;

create or replace function public.get_privacy()
returns jsonb
language sql stable
security definer set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'linked', coalesce(s.linked, 'only_me'), 'learning', coalesce(s.learning, 'only_me'),
    'stats', coalesce(s.stats, 'only_me'), 'activity', coalesce(s.activity, 'only_me'),
    'approve_followers', coalesce(s.approve_followers, false),
    'preset_answered', coalesce(s.preset_answered, false))
  from (select public.friends_require_user() as uid) u
  left join privacy_settings s on s.user_id = u.uid
$$;

create or replace function public.my_blocks()
returns jsonb
language sql stable
security definer set search_path = public, pg_temp
as $$
  select coalesce(jsonb_agg(jsonb_build_object('username', p.username, 'since', b.created_at) order by lower(p.username)), '[]'::jsonb)
  from blocks b join profiles p on p.id = b.blocked_id
  where b.blocker_id = public.friends_require_user()
$$;

create or replace function public.notification_count()
returns int
language sql stable
security definer set search_path = public, pg_temp
as $$
  select count(*)::int from notifications where user_id = public.friends_require_user() and read_at is null
$$;

create or replace function public.my_notifications()
returns jsonb
language sql stable
security definer set search_path = public, pg_temp
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'username', p.username, 'kind', n.kind, 'created_at', n.created_at, 'read', n.read_at is not null)
    order by n.created_at desc), '[]'::jsonb)
  from (select * from notifications where user_id = public.friends_require_user() order by created_at desc limit 50) n
  join profiles p on p.id = n.actor_id
$$;

create or replace function public.mark_notifications_read()
returns int
language plpgsql
security definer set search_path = public, pg_temp
as $$
declare
  v_n int;
begin
  update notifications set read_at = now() where user_id = public.friends_require_user() and read_at is null;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- ───────────────────────────── writes ─────────────────────────────────────
-- Unknown and blocked (either way) players get the same error, so a blocked
-- player isn't told.
create or replace function public.friends_resolve(p_user uuid, p_username text)
returns uuid
language plpgsql stable
security definer set search_path = public, pg_temp
as $$
declare
  v_target uuid := public.friends_target(p_username);
begin
  if v_target is null or v_target = p_user or public.friends_audience(p_user, v_target) = 'blocked' then
    raise exception 'no such player' using errcode = 'P0002';
  end if;
  return v_target;
end;
$$;

create or replace function public.follow(p_username text)
returns jsonb
language plpgsql
security definer set search_path = public, pg_temp
as $$
declare
  v_user uuid := public.friends_require_user();
  v_target uuid := public.friends_resolve(v_user, p_username);
  v_status text;
begin
  select status into v_status from follows where follower_id = v_user and followee_id = v_target;
  if found then return jsonb_build_object('status', v_status); end if;
  perform public.friends_claim(v_user, 'follow', 30, interval '1 hour');
  v_status := case when coalesce((select approve_followers from privacy_settings where user_id = v_target), false)
                   then 'pending' else 'active' end;
  insert into follows (follower_id, followee_id, status) values (v_user, v_target, v_status)
  on conflict do nothing;
  insert into notifications (user_id, actor_id, kind)
  values (v_target, v_user, case v_status when 'pending' then 'follow_request' else 'new_follower' end)
  on conflict (user_id, actor_id, kind) do update set created_at = now(), read_at = null;
  return jsonb_build_object('status', v_status);
end;
$$;

-- Unfollow, or cancel a request.
create or replace function public.unfollow(p_username text)
returns jsonb
language plpgsql
security definer set search_path = public, pg_temp
as $$
declare
  v_user uuid := public.friends_require_user();
  v_target uuid := public.friends_target(p_username);
begin
  if v_target is null then raise exception 'no such player' using errcode = 'P0002'; end if;
  delete from follows where follower_id = v_user and followee_id = v_target;
  delete from notifications where user_id = v_target and actor_id = v_user
    and kind in ('new_follower', 'follow_request') and read_at is null;
  return jsonb_build_object('status', null);
end;
$$;

create or replace function public.accept_follower(p_username text)
returns jsonb
language plpgsql
security definer set search_path = public, pg_temp
as $$
declare
  v_user uuid := public.friends_require_user();
  v_from uuid := public.friends_target(p_username);
begin
  update follows set status = 'active' where follower_id = v_from and followee_id = v_user and status = 'pending';
  if not found then raise exception 'no such request' using errcode = 'P0002'; end if;
  delete from notifications where user_id = v_user and actor_id = v_from and kind = 'follow_request';
  insert into notifications (user_id, actor_id, kind) values (v_from, v_user, 'request_accepted')
  on conflict (user_id, actor_id, kind) do update set created_at = now(), read_at = null;
  return jsonb_build_object('status', 'active');
end;
$$;

create or replace function public.decline_follower(p_username text)
returns jsonb
language plpgsql
security definer set search_path = public, pg_temp
as $$
declare
  v_user uuid := public.friends_require_user();
  v_from uuid := public.friends_target(p_username);
begin
  delete from follows where follower_id = v_from and followee_id = v_user and status = 'pending';
  if not found then raise exception 'no such request' using errcode = 'P0002'; end if;
  delete from notifications where user_id = v_user and actor_id = v_from and kind = 'follow_request';
  return jsonb_build_object('status', null);
end;
$$;

-- Removes a follower (active or pending) without blocking; they aren't told.
create or replace function public.remove_follower(p_username text)
returns jsonb
language plpgsql
security definer set search_path = public, pg_temp
as $$
declare
  v_user uuid := public.friends_require_user();
  v_from uuid := public.friends_target(p_username);
begin
  if v_from is null then raise exception 'no such player' using errcode = 'P0002'; end if;
  delete from follows where follower_id = v_from and followee_id = v_user;
  delete from notifications where user_id = v_user and actor_id = v_from and kind in ('new_follower', 'follow_request');
  return jsonb_build_object('status', null);
end;
$$;

-- Block: follows both ways and notifications between the two go; new follows
-- are refused either way; each disappears from the other's reads.
create or replace function public.block(p_username text)
returns jsonb
language plpgsql
security definer set search_path = public, pg_temp
as $$
declare
  v_user uuid := public.friends_require_user();
  v_target uuid := public.friends_target(p_username);
begin
  if v_target is null or v_target = v_user then raise exception 'no such player' using errcode = 'P0002'; end if;
  perform public.friends_claim(v_user, 'block', 60, interval '1 hour');
  insert into blocks (blocker_id, blocked_id) values (v_user, v_target) on conflict do nothing;
  delete from follows where (follower_id = v_user and followee_id = v_target) or (follower_id = v_target and followee_id = v_user);
  delete from notifications where (user_id = v_user and actor_id = v_target) or (user_id = v_target and actor_id = v_user);
  return jsonb_build_object('blocked', true);
end;
$$;

-- Follows don't come back.
create or replace function public.unblock(p_username text)
returns jsonb
language plpgsql
security definer set search_path = public, pg_temp
as $$
declare
  v_user uuid := public.friends_require_user();
begin
  delete from blocks where blocker_id = v_user and blocked_id = public.friends_target(p_username);
  return jsonb_build_object('blocked', false);
end;
$$;

-- p_settings: any of linked / learning / stats / activity (a level),
-- approve_followers / preset_answered (booleans). Unknown keys are refused.
create or replace function public.set_privacy(p_settings jsonb)
returns jsonb
language plpgsql
security definer set search_path = public, pg_temp
as $$
declare
  v_user uuid := public.friends_require_user();
  k text;
begin
  if p_settings is null or jsonb_typeof(p_settings) <> 'object' then
    raise exception 'bad settings' using errcode = '22023';
  end if;
  for k in select jsonb_object_keys(p_settings) loop
    if k in ('linked', 'learning', 'stats', 'activity') then
      if coalesce(p_settings ->> k, '') not in ('everyone', 'followers', 'friends', 'only_me') then
        raise exception 'bad level for %', k using errcode = '22023';
      end if;
    elsif k in ('approve_followers', 'preset_answered') then
      if jsonb_typeof(p_settings -> k) <> 'boolean' then
        raise exception 'bad value for %', k using errcode = '22023';
      end if;
    else
      raise exception 'unknown setting %', k using errcode = '22023';
    end if;
  end loop;
  insert into privacy_settings as s (user_id) values (v_user) on conflict (user_id) do nothing;
  update privacy_settings
     set linked            = coalesce(p_settings ->> 'linked', linked),
         learning          = coalesce(p_settings ->> 'learning', learning),
         stats             = coalesce(p_settings ->> 'stats', stats),
         activity          = coalesce(p_settings ->> 'activity', activity),
         approve_followers = coalesce((p_settings ->> 'approve_followers')::boolean, approve_followers),
         preset_answered   = coalesce((p_settings ->> 'preset_answered')::boolean, preset_answered),
         updated_at        = now()
   where user_id = v_user;
  return public.get_privacy();
end;
$$;

-- ───────────────────────────── activity triggers ──────────────────────────
-- quiz_attempts (written only by train_commit):
--   * a player's first correct answer on a line adds to their open `lines`
--     event for that course (30 min sessions), or opens a new one;
--   * their first attempt of a UTC day checks the streak for milestones and
--     prunes their events older than 90 days.
create or replace function public.friends_on_attempt()
returns trigger
language plpgsql
security definer set search_path = public, pg_temp
as $$
declare
  v_day date := (new.created_at at time zone 'UTC')::date;
  v_streak int;
  v_event bigint;
begin
  if new.user_id is null then return new; end if;

  if not exists (
    select 1 from quiz_attempts
    -- id < new.id, not <>: a multi-row insert fires these triggers after all its rows are in
    where user_id = new.user_id and id < new.id
      and created_at >= (v_day::timestamp at time zone 'UTC') and created_at < ((v_day + 1)::timestamp at time zone 'UTC')
  ) then
    delete from activity_events where user_id = new.user_id and updated_at < now() - interval '90 days';
    v_streak := public.friends_streak(new.user_id, v_day);
    if v_streak in (7, 14, 30, 50) or (v_streak >= 100 and v_streak % 100 = 0) then
      insert into activity_events (user_id, kind, dedupe_key, payload, created_at, updated_at)
      values (new.user_id, 'streak', 'streak:' || v_streak || ':' || (v_day - v_streak + 1),
              jsonb_build_object('days', v_streak), new.created_at, new.created_at)
      on conflict (user_id, dedupe_key) do nothing;
    end if;
  end if;

  if new.correct and new.course_id is not null and new.line_id is not null and not exists (
    select 1 from quiz_attempts
    where user_id = new.user_id and course_id = new.course_id and line_id = new.line_id and correct and id < new.id
  ) then
    select id into v_event from activity_events
    where user_id = new.user_id and kind = 'lines' and payload ->> 'course' = new.course_id
      and updated_at > new.created_at - interval '30 minutes'
    order by updated_at desc limit 1
    for update;
    if found then
      update activity_events
         set payload = jsonb_set(payload, '{count}', to_jsonb(coalesce((payload ->> 'count')::int, 0) + 1)),
             updated_at = greatest(updated_at, new.created_at)
       where id = v_event;
    else
      insert into activity_events (user_id, kind, dedupe_key, payload, created_at, updated_at)
      values (new.user_id, 'lines', 'lines:' || new.course_id || ':' || floor(extract(epoch from new.created_at))::bigint,
              jsonb_build_object('course', new.course_id, 'count', 1), new.created_at, new.created_at)
      on conflict (user_id, dedupe_key) do nothing;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists friends_on_attempt on public.quiz_attempts;
create trigger friends_on_attempt
  after insert on public.quiz_attempts
  for each row execute function public.friends_on_attempt();

-- course_progress: one `course` event per course ever.
create or replace function public.friends_on_course()
returns trigger
language plpgsql
security definer set search_path = public, pg_temp
as $$
begin
  insert into activity_events (user_id, kind, dedupe_key, payload)
  values (new.user_id, 'course', 'course:' || new.course_id, jsonb_build_object('course', new.course_id))
  on conflict (user_id, dedupe_key) do nothing;
  return new;
end;
$$;

drop trigger if exists friends_on_course on public.course_progress;
create trigger friends_on_course
  after insert on public.course_progress
  for each row execute function public.friends_on_course();

-- linked_accounts ratings (the Insights sync): one `rating` event per
-- platform, time class and ISO week; `from` is kept, `to` follows the sync.
create or replace function public.friends_on_ratings()
returns trigger
language plpgsql
security definer set search_path = public, pg_temp
as $$
declare
  k text;
  v_new int;
  v_old int;
  v_week text := to_char(now() at time zone 'UTC', 'IYYY-"W"IW');
begin
  for k in select jsonb_object_keys(new.ratings) loop
    if k not in ('bullet', 'blitz', 'rapid', 'classical') then continue; end if;
    v_new := nullif(new.ratings -> k ->> 'rating', '')::int;
    v_old := nullif(old.ratings -> k ->> 'rating', '')::int;
    if v_new is null or v_new is not distinct from v_old then continue; end if;
    insert into activity_events as e (user_id, kind, dedupe_key, payload)
    values (new.user_id, 'rating', 'rating:' || new.platform || ':' || k || ':' || v_week,
            jsonb_build_object('platform', new.platform, 'time_class', k, 'from', coalesce(v_old, v_new), 'to', v_new))
    on conflict (user_id, dedupe_key) do update
      set payload = jsonb_set(e.payload, '{to}', to_jsonb(v_new)), updated_at = now();
  end loop;
  return new;
end;
$$;

drop trigger if exists friends_on_ratings on public.linked_accounts;
create trigger friends_on_ratings
  after update of ratings on public.linked_accounts
  for each row execute function public.friends_on_ratings();

-- unlinking a platform takes its rating events with it
create or replace function public.friends_on_unlink()
returns trigger
language plpgsql
security definer set search_path = public, pg_temp
as $$
begin
  delete from activity_events where user_id = old.user_id and kind = 'rating' and payload ->> 'platform' = old.platform;
  return old;
end;
$$;

drop trigger if exists friends_on_unlink on public.linked_accounts;
create trigger friends_on_unlink
  after delete on public.linked_accounts
  for each row execute function public.friends_on_unlink();

-- ───────────────────────────── function grants ────────────────────────────
-- new functions are executable by PUBLIC by default: revoke everything, then grant
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('friends_audience', 'friends_reaches', 'friends_level', 'friends_can_view', 'friends_target',
        'friends_require_user', 'friends_claim', 'friends_streak', 'friends_stats', 'friends_linked', 'friends_played',
        'friends_learning', 'friends_challenge', 'friends_resolve', 'friends_on_attempt', 'friends_on_course',
        'friends_on_ratings', 'friends_on_unlink', 'get_profile', 'search_profiles', 'my_follows', 'get_feed',
        'compare_with', 'friends_leaderboard', 'get_privacy', 'my_blocks', 'notification_count', 'my_notifications',
        'mark_notifications_read', 'follow', 'unfollow', 'accept_follower', 'decline_follower', 'remove_follower',
        'block', 'unblock', 'set_privacy')
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end $$;

grant execute on function public.get_profile(text, text) to anon, authenticated;
grant execute on function public.search_profiles(text) to authenticated;
grant execute on function public.my_follows(text) to authenticated;
grant execute on function public.get_feed(timestamptz, int) to authenticated;
grant execute on function public.compare_with(text) to authenticated;
grant execute on function public.friends_leaderboard() to authenticated;
grant execute on function public.get_privacy() to authenticated;
grant execute on function public.my_blocks() to authenticated;
grant execute on function public.notification_count() to authenticated;
grant execute on function public.my_notifications() to authenticated;
grant execute on function public.mark_notifications_read() to authenticated;
grant execute on function public.follow(text) to authenticated;
grant execute on function public.unfollow(text) to authenticated;
grant execute on function public.accept_follower(text) to authenticated;
grant execute on function public.decline_follower(text) to authenticated;
grant execute on function public.remove_follower(text) to authenticated;
grant execute on function public.block(text) to authenticated;
grant execute on function public.unblock(text) to authenticated;
grant execute on function public.set_privacy(jsonb) to authenticated;
