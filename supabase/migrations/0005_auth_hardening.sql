-- Auth hardening: usernames and profiles.
--
-- 1. Usernames are unique ignoring case ("Tarek" and "tarek" can't both
--    exist). Existing case-duplicates (newest first) get a suffix so the
--    index can be built.
-- 2. username_available(name): a pre-check for the sign-up form, so a taken
--    name is reported before the account is created instead of being
--    silently replaced.
-- 3. handle_new_user: trims the requested name; when it's taken (a race
--    after the pre-check) it keeps the name with a numeric suffix rather
--    than falling back to "player_…".
-- 4. ensure_profile(): creates the caller's profile when it's missing
--    (accounts created before the trigger existed, or a failed trigger), so
--    username changes and grading don't fail on a missing row.
--
-- Account deletion needs no SQL: /api/account deletes the auth user with the
-- service role and every user table cascades from profiles → auth.users.
-- Idempotent: safe to re-run.

-- ── 1. case-insensitive uniqueness ─────────────────────────────────────────
do $$
declare
  r record;
  v_name text;
begin
  for r in
    select id, username
    from (
      select id, username, row_number() over (partition by lower(username) order by created_at, id) as n
      from public.profiles
    ) d
    where n > 1
  loop
    loop
      v_name := left(r.username, 15) || '_' || lpad((floor(random() * 10000))::int::text, 4, '0');
      exit when not exists (select 1 from public.profiles where lower(username) = lower(v_name));
    end loop;
    update public.profiles set username = v_name, updated_at = now() where id = r.id;
  end loop;
end;
$$;

create unique index if not exists profiles_username_lower_key on public.profiles (lower(username));

-- ── 2. availability pre-check ──────────────────────────────────────────────
-- Usernames are public (leaderboard), so this reveals nothing new.
create or replace function public.username_available(p_name text)
returns boolean
language sql
stable
security definer set search_path = public, pg_temp
as $$
  select trim(p_name) ~ '^[A-Za-z0-9_]{3,20}$'
     and not exists (
       select 1 from public.profiles
       where lower(username) = lower(trim(p_name))
         and id is distinct from auth.uid()
     );
$$;

revoke all on function public.username_available(text) from public;
grant execute on function public.username_available(text) to anon, authenticated;

-- ── 3. sign-up trigger ─────────────────────────────────────────────────────
-- The allocation lives in profile_for_user(), so the trigger and
-- ensure_profile() can't drift apart.
create or replace function public.profile_for_user(p_user auth.users)
returns void
language plpgsql
security definer set search_path = public, pg_temp
as $$
declare
  v_requested text;
  v_name text;
begin
  if exists (select 1 from public.profiles where id = p_user.id) then
    return;
  end if;
  v_requested := nullif(trim(p_user.raw_user_meta_data ->> 'username'), '');
  if v_requested is not null and v_requested ~ '^[A-Za-z0-9_]{3,20}$' then
    begin
      insert into public.profiles (id, username) values (p_user.id, v_requested);
      return;
    exception when unique_violation then
      -- taken since the form checked: keep the name, add a suffix
    end;
    for i in 1..10 loop
      v_name := left(v_requested, 15) || '_' || lpad((floor(random() * 10000))::int::text, 4, '0');
      begin
        insert into public.profiles (id, username) values (p_user.id, v_name);
        return;
      exception when unique_violation then
        -- collision: try another suffix
      end;
    end loop;
  end if;
  for i in 1..10 loop
    v_name := 'player_' || substr(md5(p_user.id::text || clock_timestamp()::text || i::text), 1, 8);
    begin
      insert into public.profiles (id, username) values (p_user.id, v_name);
      return;
    exception when unique_violation then
      -- collision: retry with a fresh suffix
    end;
  end loop;
  raise exception 'could not allocate username';
end;
$$;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public, pg_temp
as $$
begin
  perform public.profile_for_user(new);
  return new;
end;
$$;

-- re-created in case an older project lost it
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ── 4. self-healing profile ────────────────────────────────────────────────
create or replace function public.ensure_profile()
returns text
language plpgsql
security definer set search_path = public, pg_temp
as $$
declare
  v_user auth.users%rowtype;
  v_name text;
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  select * into v_user from auth.users where id = auth.uid();
  if not found then
    raise exception 'no such user' using errcode = '42501';
  end if;
  perform public.profile_for_user(v_user);
  select username into v_name from public.profiles where id = v_user.id;
  return v_name;
end;
$$;

revoke all on function public.profile_for_user(auth.users) from public, anon, authenticated;
revoke all on function public.ensure_profile() from public, anon;
grant execute on function public.ensure_profile() to authenticated;
