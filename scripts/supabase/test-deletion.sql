-- Account deletion wipes the player from every table (DELETE /api/account deletes
-- auth.users; everything cascades). Run by scripts/supabase/test-deletion.sh on a
-- scratch LOCAL database with local-shim.sql + every migration.
--
-- Two players get rows in every user table; deleting one must leave no uuid
-- column anywhere in the public schema holding their id, and must keep every
-- row of the other. The scan is generic, so a future table without the cascade
-- fails here. Prints "deletion: all checks passed".
\set ON_ERROR_STOP 1

insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-0000-0000-0000000000aa', 'gone@example.com', '{"username":"gone"}'),
  ('00000000-0000-0000-0000-0000000000bb', 'kept@example.com', '{"username":"kept"}');

do $$
declare
  u uuid;
  other uuid;
  ch uuid;
  tch uuid;
begin
  foreach u in array array['00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-0000000000bb']::uuid[] loop
    other := case when u = '00000000-0000-0000-0000-0000000000aa' then '00000000-0000-0000-0000-0000000000bb'::uuid else '00000000-0000-0000-0000-0000000000aa'::uuid end;
    -- training
    insert into theory_openings (id, eco, name, line_san, final_epd) values (1, 'C60', 'Ruy Lopez', array['e4'], 'x') on conflict do nothing;
    insert into srs_cards_v2 (user_id, side, epd, answer_san) values (u, 'white', 'x', 'e4');
    insert into course_progress (user_id, course_id) values (u, 'ruy-lopez/main@white');
    insert into train_challenges (user_id, course_id, side, sans, epd, expected) values (u, 'ruy-lopez/main@white', 'white', '{}', 'x', 'e4') returning id into tch;
    insert into quiz_challenges (user_id, opening_id, side, line_san, epd, expected) values (u, 1, 'white', '{}', 'x', array['e4']) returning id into ch;
    insert into quiz_attempts (user_id, challenge_id, train_challenge_id, epd, san, correct, ms, rating_before, rating_after, course_id, line_id)
      values (u, ch, tch, 'x', 'e4', true, 1000, 800, 801, 'ruy-lopez/main@white', 'l1');
    insert into srs_cards (user_id, opening_id, epd, line_san) values (u, 1, 'x', '{}');
    insert into opening_progress (user_id, opening_id) values (u, 1);
    -- insights
    insert into linked_accounts (user_id, platform, username, ratings) values (u, 'lichess', 'someone', '{"blitz":{"rating":1500,"games":30,"provisional":false}}');
    insert into game_summaries (user_id, platform, game_id, color, time_class, played_at, result, opening_plies, book_ply, deviated_by, dataset_hash)
      values (u, 'lichess', 'ABCDEFGH', 'white', 'blitz', now(), 'win', array['e4'], 1, 'none', 'h');
    -- friends: both directions between the two players
    insert into follows (follower_id, followee_id, status) values (u, other, 'active') on conflict do nothing;
    insert into notifications (user_id, actor_id, kind) values (other, u, 'new_follower') on conflict do nothing;
    insert into privacy_settings (user_id) values (u);
    insert into activity_events (user_id, kind, dedupe_key) values (u, 'course', 'manual');
    insert into rate_limits (user_id, bucket, calls) values (u, 'follow', 1);
    -- setup
    insert into player_setup (user_id, completed_at, estimated_elo) values (u, now(), 1500);
  end loop;
  insert into blocks (blocker_id, blocked_id) values ('00000000-0000-0000-0000-0000000000bb', '00000000-0000-0000-0000-0000000000aa');
end $$;

-- every uuid column in public, with how many rows hold each player's id
create temp table t_before as
select table_name, column_name, 0::bigint as gone, 0::bigint as kept
from information_schema.columns
where table_schema = 'public' and data_type = 'uuid';

do $$
declare r record;
begin
  for r in select * from t_before loop
    execute format('update t_before set gone = (select count(*) from public.%I where %I = %L), kept = (select count(*) from public.%I where %I = %L) where table_name = %L and column_name = %L',
      r.table_name, r.column_name, '00000000-0000-0000-0000-0000000000aa', r.table_name, r.column_name, '00000000-0000-0000-0000-0000000000bb', r.table_name, r.column_name);
  end loop;
end $$;

-- the fixture must actually reach every user table, or the scan proves nothing
do $$
declare missing text;
begin
  select string_agg(table_name, ', ') into missing
  from (select distinct table_name from information_schema.columns where table_schema = 'public' and data_type = 'uuid') t
  where not exists (select 1 from t_before b where b.table_name = t.table_name and b.gone > 0);
  if missing is not null then raise exception 'fixture misses user rows in: %', missing; end if;
end $$;

-- what a real deletion does: DELETE /api/account → auth.admin.deleteUser
delete from auth.users where id = '00000000-0000-0000-0000-0000000000aa';

do $$
declare
  r record;
  n bigint;
  k bigint;
  left_over text := '';
begin
  for r in select * from t_before loop
    execute format('select count(*) from public.%I where %I = %L', r.table_name, r.column_name, '00000000-0000-0000-0000-0000000000aa') into n;
    if n > 0 then left_over := left_over || format(' %s.%s=%s', r.table_name, r.column_name, n); end if;
  end loop;
  if left_over <> '' then raise exception 'rows still hold the deleted player:%', left_over; end if;
  -- also in text columns (usernames as actors, ids copied into text)
  for r in select table_name, column_name from information_schema.columns where table_schema = 'public' and data_type in ('text', 'jsonb') loop
    execute format('select count(*) from public.%I where %I::text like %L', r.table_name, r.column_name, '%00000000-0000-0000-0000-0000000000aa%') into n;
    if n > 0 then left_over := left_over || format(' %s.%s=%s', r.table_name, r.column_name, n); end if;
  end loop;
  if left_over <> '' then raise exception 'text still holds the deleted player''s id:%', left_over; end if;
  if exists (select 1 from profiles where username = 'gone') then raise exception 'profile kept'; end if;

  -- the other player keeps their own rows (relationship rows with the deleted player go with it)
  for r in select * from t_before where kept > 0 and table_name not in ('follows', 'blocks', 'notifications') loop
    execute format('select count(*) from public.%I where %I = %L', r.table_name, r.column_name, '00000000-0000-0000-0000-0000000000bb') into k;
    if k <> r.kept then raise exception 'kept player lost rows in %.% (% → %)', r.table_name, r.column_name, r.kept, k; end if;
  end loop;
  if (select count(*) from follows) + (select count(*) from blocks) + (select count(*) from notifications) <> 0 then
    raise exception 'relationship rows with the deleted player remain';
  end if;
end $$;

select format('%s uuid columns scanned in %s tables', count(*), count(distinct table_name)) from t_before;
select 'deletion: all checks passed';
