-- Checks for migration 0006 (ADR 0006). Run by scripts/supabase/test-0006.sh on
-- a scratch LOCAL database that already has local-shim.sql + 0001–0006.
-- Every check raises on failure; the last line prints "0006: all checks passed".
\set ON_ERROR_STOP 1

-- two users (handle_new_user creates their profiles)
insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-0000-0000-00000000000a', 'a@example.com', '{"username":"alice"}'),
  ('00000000-0000-0000-0000-00000000000b', 'b@example.com', '{"username":"bob"}');

-- service role writes (the /api/insights routes)
insert into public.linked_accounts (user_id, platform, username, ratings) values
  ('00000000-0000-0000-0000-00000000000a', 'lichess',  'Zhigalko_Sergei', '{"blitz":{"rating":2849,"games":31000,"provisional":false}}'),
  ('00000000-0000-0000-0000-00000000000a', 'chesscom', 'hikaru', '{}'),
  -- unverified names aren't unique: bob may type the same public username
  ('00000000-0000-0000-0000-00000000000b', 'chesscom', 'hikaru', '{}');

insert into public.game_summaries
  (user_id, platform, game_id, color, time_class, played_at, result, my_rating, opp_rating, eco, opening_name,
   opening_plies, book_ply, deviated_by, deviation_epd, played_san, book_sans, eval_before, eval_after, dataset_hash)
values
  ('00000000-0000-0000-0000-00000000000a', 'lichess', 'BCi6IZfn', 'white', 'blitz', now() - interval '2 days', 'loss', 2849, 2790, 'D02',
   'Queen''s Pawn Game: Anti-Torre', array['d4','d5','Nf3','Bg4','c4','dxc4','Nc3'], 6, 'me',
   'rn1qkbnr/ppp1pppp/8/8/2pP2b1/5N2/PP2PPPP/RNBQKB1R w KQkq -', 'Nc3', array['e3','e4'], 25, 0, 'test-hash'),
  ('00000000-0000-0000-0000-00000000000a', 'chesscom', 'live/183193101523', 'black', 'blitz', now() - interval '1 day', 'win', 3370, 2709, 'B22',
   null, array['e4','c5','c3','Qa5'], 3, 'me', 'rnbqkbnr/pp1ppppp/8/2p5/4P3/2P5/PP1P1PPP/RNBQKBNR b KQkq -', 'Qa5', array['d5','Nf6'], null, null, 'test-hash'),
  ('00000000-0000-0000-0000-00000000000b', 'chesscom', 'live/183193101523', 'black', 'blitz', now() - interval '1 day', 'win', 3370, 2709, 'B22',
   null, array['e4','c5','c3','Qa5'], 3, 'me', 'rnbqkbnr/pp1ppppp/8/2p5/4P3/2P5/PP1P1PPP/RNBQKBNR b KQkq -', 'Qa5', array['d5','Nf6'], null, null, 'test-hash');

do $$
begin
  -- idempotent import: the same game for the same user is rejected (routes upsert)
  begin
    insert into public.game_summaries (user_id, platform, game_id, color, time_class, played_at, result, opening_plies, book_ply, deviated_by, dataset_hash)
    values ('00000000-0000-0000-0000-00000000000a', 'lichess', 'BCi6IZfn', 'white', 'blitz', now(), 'win', array['e4'], 1, 'none', 'h');
    raise exception 'duplicate game accepted';
  exception when unique_violation then null;
  end;
  -- a summary needs its linked account
  begin
    insert into public.game_summaries (user_id, platform, game_id, color, time_class, played_at, result, opening_plies, book_ply, deviated_by, dataset_hash)
    values ('00000000-0000-0000-0000-00000000000b', 'lichess', 'x1', 'white', 'blitz', now(), 'win', array['e4'], 1, 'none', 'h');
    raise exception 'summary without a linked account accepted';
  exception when foreign_key_violation then null;
  end;
  -- shape checks
  begin
    insert into public.game_summaries (user_id, platform, game_id, color, time_class, played_at, result, opening_plies, book_ply, deviated_by, dataset_hash)
    values ('00000000-0000-0000-0000-00000000000a', 'lichess', 'x2', 'white', 'blitz', now(), 'win', array['e4'], 1, 'me', 'h');
    raise exception 'deviation without an EPD accepted';
  exception when check_violation then null;
  end;
  begin
    insert into public.game_summaries (user_id, platform, game_id, color, time_class, played_at, result, opening_plies, book_ply, deviated_by, dataset_hash)
    values ('00000000-0000-0000-0000-00000000000a', 'lichess', 'x3', 'white', 'correspondence', now(), 'win', array['e4'], 1, 'none', 'h');
    raise exception 'correspondence time class accepted';
  exception when check_violation then null;
  end;
  begin
    insert into public.game_summaries (user_id, platform, game_id, color, time_class, played_at, result, opening_plies, book_ply, deviated_by, dataset_hash)
    values ('00000000-0000-0000-0000-00000000000a', 'lichess', 'x4', 'white', 'blitz', now(), 'win', array_fill('e4'::text, array[41]), 0, 'none', 'h');
    raise exception '41 opening plies accepted';
  exception when check_violation then null;
  end;
  begin
    insert into public.linked_accounts (user_id, platform, username) values ('00000000-0000-0000-0000-00000000000b', 'lichess', 'bad name');
    raise exception 'invalid username accepted';
  exception when check_violation then null;
  end;
  begin
    insert into public.linked_accounts (user_id, platform, username) values ('00000000-0000-0000-0000-00000000000b', 'fics', 'bob');
    raise exception 'unknown platform accepted';
  exception when check_violation then null;
  end;
end $$;

-- ── as alice (authenticated): own rows only, read-only ─────────────────────
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
do $$
declare n int;
begin
  select count(*) into n from public.linked_accounts;
  if n <> 2 then raise exception 'alice sees % linked accounts, expected 2', n; end if;
  select count(*) into n from public.game_summaries;
  if n <> 2 then raise exception 'alice sees % summaries, expected 2', n; end if;
  select count(*) into n from public.game_summaries where user_id <> auth.uid();
  if n <> 0 then raise exception 'alice sees another user''s summaries'; end if;
  begin
    insert into public.linked_accounts (user_id, platform, username) values (auth.uid(), 'lichess', 'someone');
    raise exception 'client insert into linked_accounts allowed';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.game_summaries set result = 'win';
    raise exception 'client update of game_summaries allowed';
  exception when insufficient_privilege then null;
  end;
  begin
    delete from public.game_summaries;
    raise exception 'client delete of game_summaries allowed';
  exception when insufficient_privilege then null;
  end;
  begin
    truncate public.game_summaries;
    raise exception 'client truncate of game_summaries allowed';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

-- ── anon: nothing ──────────────────────────────────────────────────────────
set role anon;
do $$
begin
  perform 1 from public.game_summaries;
  raise exception 'anon can read game_summaries';
exception when insufficient_privilege then null;
end $$;
reset role;

-- ── unlink deletes that platform's summaries only ──────────────────────────
delete from public.linked_accounts where user_id = '00000000-0000-0000-0000-00000000000a' and platform = 'lichess';
do $$
declare n int;
begin
  select count(*) into n from public.game_summaries where user_id = '00000000-0000-0000-0000-00000000000a' and platform = 'lichess';
  if n <> 0 then raise exception 'unlink left % lichess summaries', n; end if;
  select count(*) into n from public.game_summaries where user_id = '00000000-0000-0000-0000-00000000000a' and platform = 'chesscom';
  if n <> 1 then raise exception 'unlink removed the other platform''s summaries'; end if;
end $$;

-- ── account deletion (auth.users row, as /api/account does) removes everything ─
delete from auth.users where id = '00000000-0000-0000-0000-00000000000a';
do $$
declare n int;
begin
  select count(*) into n from public.linked_accounts where user_id = '00000000-0000-0000-0000-00000000000a';
  if n <> 0 then raise exception 'account deletion left % linked accounts', n; end if;
  select count(*) into n from public.game_summaries where user_id = '00000000-0000-0000-0000-00000000000a';
  if n <> 0 then raise exception 'account deletion left % summaries', n; end if;
  -- bob's copy of the same game is untouched
  select count(*) into n from public.game_summaries where user_id = '00000000-0000-0000-0000-00000000000b';
  if n <> 1 then raise exception 'another user''s summaries were deleted'; end if;
end $$;

select '0006: all checks passed';
