-- Fixes for new-generation Supabase projects + chosen usernames at signup.
--
-- 1. Table-level grants. New Supabase projects no longer ship permissive
--    default privileges on public tables, so RLS policies alone are not
--    enough — the roles also need base GRANTs. Row access is still enforced
--    by the policies from 0001.
-- 2. handle_new_user now honors a username chosen at signup (passed via
--    auth signUp options.data.username), falling back to a generated one.

-- ── grants ─────────────────────────────────────────────────────────────────
grant usage on schema public to anon, authenticated, service_role;

-- public reference data
grant select on public.theory_openings, public.theory_edges to anon, authenticated;

-- own-row reads (RLS policies restrict rows)
grant select on public.profiles to anon, authenticated;
grant select on public.srs_cards, public.quiz_challenges,
                public.quiz_attempts, public.opening_progress to authenticated;

-- username is the only client-writable profile column (rating etc. stay RPC-only)
grant update (username, updated_at) on public.profiles to authenticated;

-- the service role administers everything (seeding, dashboards)
grant all privileges on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role;

-- ── chosen usernames at signup ─────────────────────────────────────────────
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public, pg_temp
as $$
declare
  v_requested text;
  v_name text;
begin
  v_requested := nullif(trim(new.raw_user_meta_data ->> 'username'), '');
  if v_requested is not null and v_requested ~ '^[A-Za-z0-9_]{3,20}$' then
    begin
      insert into public.profiles (id, username) values (new.id, v_requested);
      return new;
    exception when unique_violation then
      -- requested name taken: fall through to a generated one
    end;
  end if;
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
