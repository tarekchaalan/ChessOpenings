-- Checks for migration 0010 (ADR 0009, OAuth identities). Run by scripts/supabase/test-0010.sh
-- on a scratch LOCAL database with local-shim.sql + 0001–0010.
-- Every check raises on failure; the last line prints "0010: all checks passed".
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
  ('00000000-0000-0000-0000-00000000000b', 'lichess.bob@oauth.invalid', '{"username":"bob"}');

do $$
declare
  a uuid := '00000000-0000-0000-0000-00000000000a';
  b uuid := '00000000-0000-0000-0000-00000000000b';
begin
  -- the service role writes (as the /api/auth/oauth routes do)
  set local role service_role;
  insert into oauth_identities (provider, provider_user_id, user_id, username) values ('lichess', 'alice_l', a, 'Alice_L');
  insert into oauth_identities (provider, provider_user_id, user_id, username) values ('chesscom', '12345678', a, 'alice-c');
  insert into oauth_identities (provider, provider_user_id, user_id, username) values ('lichess', 'bob', b, 'Bob');

  -- one app account per provider account, one identity per provider per app account
  perform t_fails($q$insert into oauth_identities (provider, provider_user_id, user_id, username) values ('lichess', 'alice_l', '00000000-0000-0000-0000-00000000000b', 'x1')$q$, '23505');
  perform t_fails($q$insert into oauth_identities (provider, provider_user_id, user_id, username) values ('lichess', 'another', '00000000-0000-0000-0000-00000000000a', 'x2')$q$, '23505');
  -- shapes
  perform t_fails($q$insert into oauth_identities (provider, provider_user_id, user_id, username) values ('fide', 'z1', '00000000-0000-0000-0000-00000000000b', 'zz')$q$, '23514');
  perform t_fails($q$insert into oauth_identities (provider, provider_user_id, user_id, username) values ('chesscom', 'has space', '00000000-0000-0000-0000-00000000000b', 'zz')$q$, '23514');
  perform t_fails($q$insert into oauth_identities (provider, provider_user_id, user_id, username) values ('chesscom', 'z2', '00000000-0000-0000-0000-00000000000b', '-bad')$q$, '23514');
  -- a user without a profile can't hold one
  perform t_fails($q$insert into oauth_identities (provider, provider_user_id, user_id, username) values ('chesscom', 'z3', '00000000-0000-0000-0000-0000000000ff', 'zz')$q$, '23503');
  reset role;

  -- own rows only; no client writes
  perform t_as(a);
  perform t_check((select count(*) from oauth_identities) = 2, 'alice sees her two identities');
  perform t_check(not exists (select 1 from oauth_identities where user_id <> a), 'only her own');
  perform t_fails($q$update public.oauth_identities set user_id = '00000000-0000-0000-0000-00000000000b'$q$, '42501');
  perform t_fails($q$insert into public.oauth_identities (provider, provider_user_id, user_id, username) values ('chesscom', 'z4', '00000000-0000-0000-0000-00000000000a', 'zz')$q$, '42501');
  perform t_fails('delete from public.oauth_identities', '42501');
  perform t_fails('truncate public.oauth_identities', '42501');

  -- anonymous: nothing
  perform t_as(null);
  perform t_fails('select * from public.oauth_identities', '42501');
  perform t_reset();

  -- deletion cascades, the other player's rows stay
  delete from auth.users where id = a;
  perform t_check(not exists (select 1 from oauth_identities where user_id = a), 'deleted with the account');
  perform t_check(exists (select 1 from oauth_identities where user_id = b), 'bob kept');
end $$;

select '0010: all checks passed';
