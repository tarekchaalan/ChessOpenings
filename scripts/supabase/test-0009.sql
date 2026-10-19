-- Checks for migration 0009 (ADR 0008, player setup). Run by scripts/supabase/test-0009.sh
-- on a scratch LOCAL database with local-shim.sql + 0001–0009.
-- Every check raises on failure; the last line prints "0009: all checks passed".
\set ON_ERROR_STOP 1

create function t_as(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_user::text, ''), false);
  perform set_config('role', case when p_user is null then 'anon' else 'authenticated' end, false);
end $$;
create function t_reset() returns void language plpgsql as $$
begin
  perform set_config('role', 'none', false);
  perform set_config('request.jwt.claim.sub', '', false);
end $$;
create function t_fails(p_sql text, p_like text) returns void language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    if sqlstate = p_like or sqlerrm like p_like then return; end if;
    raise exception 'expected "%" from [%], got % %', p_like, p_sql, sqlstate, sqlerrm;
  end;
  raise exception 'expected failure "%" from [%]', p_like, p_sql;
end $$;
create function t_check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if p_ok is not true then raise exception 'check failed: %', p_what; end if;
end $$;

insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-0000-0000-00000000000a', 'a@example.com', '{"username":"alice"}'),
  ('00000000-0000-0000-0000-00000000000b', 'b@example.com', '{"username":"bob"}');

do $$
declare
  a uuid := '00000000-0000-0000-0000-00000000000a';
  b uuid := '00000000-0000-0000-0000-00000000000b';
  s jsonb;
begin
  -- before setup: null (the modal shows)
  perform t_as(a);
  perform t_check(public.get_setup() is null, 'no setup yet');

  -- completing stores the answers once
  s := public.save_setup('{"complete": true, "self_level": null, "estimated_elo": 1450, "estimate": {"confidence": "high", "low": 1300, "high": 1600, "source": "ratings", "basis": []}}');
  perform t_check(s ->> 'completed_at' is not null and (s ->> 'estimated_elo')::int = 1450 and not (s ->> 'skipped')::boolean, format('completed %s', s));
  perform t_check(s -> 'estimate' ->> 'confidence' = 'high', 'estimate kept');
  perform t_check(not s ? 'user_id', 'no user id in the answer');

  -- later saves update the estimate but keep completed_at
  perform t_reset();
  update player_setup set completed_at = completed_at - interval '1 day' where user_id = a;
  perform t_as(a);
  s := public.save_setup('{"estimated_elo": 1520, "complete": true}');
  perform t_check((s ->> 'estimated_elo')::int = 1520, 'estimate updated');
  perform t_check((select completed_at from player_setup where user_id = a) < now() - interval '23 hours', 'completed_at kept');

  -- skipping marks the row done too
  perform t_as(b);
  s := public.save_setup('{"skipped": true}');
  perform t_check((s ->> 'skipped')::boolean and s ->> 'completed_at' is not null and s ->> 'estimated_elo' is null, 'skipped');
  s := public.save_setup('{"self_level": "club", "estimated_elo": 1600, "complete": true}');
  perform t_check(s ->> 'self_level' = 'club', 'self level after a skip');
  s := public.save_setup('{"self_level": null}');
  perform t_check(s ->> 'self_level' is null, 'self level cleared');

  -- validation
  perform t_fails($q$select public.save_setup('{"estimated_elo": 99}')$q$, 'bad value for estimated_elo');
  perform t_fails($q$select public.save_setup('{"estimated_elo": 3600}')$q$, 'bad value for estimated_elo');
  perform t_fails($q$select public.save_setup('{"estimated_elo": "1500"}')$q$, 'bad value for estimated_elo');
  perform t_fails($q$select public.save_setup('{"self_level": "grandmaster"}')$q$, 'bad value for self_level');
  perform t_fails($q$select public.save_setup('{"complete": "yes"}')$q$, 'bad value for complete');
  perform t_fails($q$select public.save_setup('{"estimate": []}')$q$, 'bad value for estimate');
  perform t_fails(format($q$select public.save_setup('{"estimate": {"x": "%s"}}')$q$, repeat('a', 5000)), 'bad value for estimate');
  perform t_fails($q$select public.save_setup('{"rating": 2800}')$q$, 'unknown setup key rating');
  perform t_fails($q$select public.save_setup('[]')$q$, 'bad setup');

  -- the leaderboard rating is untouched by setup
  perform t_reset();
  perform t_check((select rating from profiles where id = a) = 800, 'profiles.rating unchanged');

  -- own row only; no client writes
  perform t_as(a);
  perform t_check((select count(*) from player_setup) = 1, 'alice sees one row');
  perform t_check((select user_id from player_setup) = a, 'her own');
  perform t_fails($q$update public.player_setup set estimated_elo = 2800$q$, '42501');
  perform t_fails($q$insert into public.player_setup (user_id) values ('00000000-0000-0000-0000-00000000000b')$q$, '42501');
  perform t_fails('delete from public.player_setup', '42501');
  perform t_fails('truncate public.player_setup', '42501');

  -- anonymous: nothing
  perform t_as(null);
  perform t_fails('select public.get_setup()', '42501');
  perform t_fails($q$select public.save_setup('{"complete": true}')$q$, '42501');
  perform t_fails('select * from public.player_setup', '42501');
  perform t_reset();

  -- deletion cascades, the other player's row stays
  delete from auth.users where id = a;
  perform t_check(not exists (select 1 from player_setup where user_id = a), 'deleted with the account');
  perform t_check(exists (select 1 from player_setup where user_id = b), 'bob kept');
end $$;

select '0009: all checks passed';
