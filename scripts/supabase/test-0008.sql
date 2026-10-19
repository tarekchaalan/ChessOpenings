-- Checks for migration 0008 (ADR 0007, Friends). Run by scripts/supabase/test-0008.sh
-- on a scratch LOCAL database with local-shim.sql + 0001–0008, and the shared
-- visibility matrix in :matrix (src/lib/friends/__tests__/visibility-matrix.json).
-- Every check raises on failure; the output lists counts and ends with
-- "0008: all checks passed".
\set ON_ERROR_STOP 1
select set_config('test.matrix', :'matrix', false) \g /dev/null

-- ── helpers ───────────────────────────────────────────────────────────────
-- act as a signed-in user (p_user) or an anonymous visitor (null), like PostgREST
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
-- p_sql must fail with an error whose SQLSTATE or message matches p_like
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
create function t_id(p_name text) returns uuid language sql as $$
  select id from public.profiles where username = p_name
$$;
create table t_counts (name text primary key, n int not null default 0);
create function t_count(p_name text) returns void language sql as $$
  insert into t_counts values (p_name, 1) on conflict (name) do update set n = t_counts.n + 1
$$;
grant all on t_counts to anon, authenticated;

-- ── players ───────────────────────────────────────────────────────────────
-- olga: the owner. fred: her friend. fiona: a follower. sam: a stranger.
-- bart: blocked by olga. bea: blocked olga. pete: a pending follower. ol_x: search escaping.
insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-0000-0000-000000000001', 'o@example.com', '{"username":"olga"}'),
  ('00000000-0000-0000-0000-000000000002', 'f@example.com', '{"username":"fred"}'),
  ('00000000-0000-0000-0000-000000000003', 'fi@example.com', '{"username":"fiona"}'),
  ('00000000-0000-0000-0000-000000000004', 's@example.com', '{"username":"sam"}'),
  ('00000000-0000-0000-0000-000000000005', 'b@example.com', '{"username":"bart"}'),
  ('00000000-0000-0000-0000-000000000006', 'be@example.com', '{"username":"bea"}'),
  ('00000000-0000-0000-0000-000000000007', 'p@example.com', '{"username":"pete"}'),
  ('00000000-0000-0000-0000-000000000008', 'x@example.com', '{"username":"ol_x"}');

-- ── relationships, through the RPCs ───────────────────────────────────────
do $$
begin
  perform t_as(t_id('fred'));  perform t_check(public.follow('olga') ->> 'status' = 'active', 'fred follows olga');
  perform t_as(t_id('olga'));  perform t_check(public.follow('FRED') ->> 'status' = 'active', 'olga follows fred (case-insensitive)');
  perform t_as(t_id('fiona')); perform public.follow('olga');
  perform t_as(t_id('bart'));  perform public.follow('olga');
  perform t_as(t_id('bea'));   perform public.follow('olga');
  -- a repeat follow is a no-op that reports the current status
  perform t_as(t_id('fred'));  perform t_check(public.follow('olga') ->> 'status' = 'active', 'repeat follow');
  perform t_as(t_id('olga'));  perform public.set_privacy('{"approve_followers": true}');
  perform t_as(t_id('pete'));  perform t_check(public.follow('olga') ->> 'status' = 'pending', 'pete requests');
  perform t_as(t_id('olga'));  perform public.block('bart');
  perform t_as(t_id('bea'));   perform public.block('olga');
  perform t_reset();

  perform t_check((select count(*) from follows where followee_id = t_id('olga') and status = 'active') = 2, 'olga has fred + fiona as active followers');
  perform t_check(not exists (select 1 from follows where t_id('bart') in (follower_id, followee_id)), 'block removed bart''s follow');
  perform t_check(not exists (select 1 from follows where t_id('bea') in (follower_id, followee_id)), 'block removed bea''s follow');
  perform t_check(not exists (select 1 from notifications where t_id('bart') in (user_id, actor_id)), 'block removed notifications');
  perform t_check((select status from follows where follower_id = t_id('pete') and followee_id = t_id('olga')) = 'pending', 'pete pending');
  perform t_check(public.friends_audience(t_id('fred'), t_id('olga')) = 'friend', 'audience friend');
  perform t_check(public.friends_audience(t_id('fiona'), t_id('olga')) = 'follower', 'audience follower');
  perform t_check(public.friends_audience(t_id('pete'), t_id('olga')) = 'stranger', 'pending follower is a stranger');
  perform t_check(public.friends_audience(t_id('bart'), t_id('olga')) = 'blocked', 'blocked (by owner)');
  perform t_check(public.friends_audience(t_id('bea'), t_id('olga')) = 'blocked', 'blocked (by viewer)');
  perform t_check(public.friends_audience(t_id('olga'), t_id('bea')) = 'blocked', 'blocked both ways');
  perform t_check(public.friends_audience(null, t_id('olga')) = 'anonymous', 'anonymous');
end $$;

-- ── olga's data (as the service role / train_commit would write it) ──────
insert into public.linked_accounts (user_id, platform, username, ratings) values
  (t_id('olga'), 'lichess', 'olga_l', '{"blitz":{"rating":1800,"games":100,"provisional":false}}'),
  (t_id('olga'), 'chesscom', 'olga_c', '{"rapid":{"rating":1500,"games":10,"provisional":false}}'),
  (t_id('fred'), 'lichess', 'fred_l', '{"blitz":{"rating":1700,"games":50,"provisional":false}}');
insert into public.game_summaries (user_id, platform, game_id, color, time_class, played_at, result, eco, opening_name, opening_plies, book_ply, deviated_by, dataset_hash)
values (t_id('olga'), 'lichess', 'AAAAAAAA', 'white', 'blitz', now(), 'win', 'C50', 'Italian Game', array['e4','e5','Nf3','Nc6','Bc4'], 5, 'none', 'h');
insert into public.course_progress (user_id, course_id, seen, correct, mastery) values (t_id('olga'), 'italian-game/main@white', 12, 10, 0.4);

-- a 7-day streak: one answer per day for the 6 previous UTC days, then today's lines
insert into public.quiz_attempts (user_id, epd, san, correct, ms, rating_before, rating_after, created_at)
select t_id('olga'), 'x', 'e4', true, 1000, 800, 801, ((now() at time zone 'UTC')::date - d)::timestamp at time zone 'UTC' + interval '12 hours'
from generate_series(6, 1, -1) d;
-- ten new lines in one sitting (a minute apart), today, starting at 00:05 UTC
insert into public.quiz_attempts (user_id, epd, san, correct, ms, rating_before, rating_after, course_id, line_id, created_at)
select t_id('olga'), 'x', 'e4', true, 1000, 800, 801, 'italian-game/main@white', 'L' || i,
       ((now() at time zone 'UTC')::date)::timestamp at time zone 'UTC' + interval '5 minutes' + i * interval '1 minute'
from generate_series(1, 10) i;

-- ── 1. the visibility matrix: 24 rows × 4 sections ────────────────────────
do $$
declare
  m record;
  v record;
  s text;
  p jsonb;
  f jsonb;
  v_exp boolean;
  v_in_feed boolean;
begin
  -- truth table through friends_can_view for every audience the fixtures cover
  for m in select * from jsonb_to_recordset(current_setting('test.matrix')::jsonb) as x(audience text, level text, visible boolean) loop
    update privacy_settings set linked = m.level, learning = m.level, stats = m.level, activity = m.level where user_id = t_id('olga');
    for v in select * from (values
        (t_id('olga'), 'owner'), (t_id('fred'), 'friend'), (t_id('fiona'), 'follower'), (t_id('sam'), 'stranger'),
        (t_id('pete'), 'stranger'), (null::uuid, 'anonymous'), (t_id('bart'), 'blocked'), (t_id('bea'), 'blocked')) x(id, aud)
      where x.aud = m.audience
    loop
      -- the function
      foreach s in array array['linked', 'learning', 'stats', 'activity'] loop
        perform t_check(public.friends_can_view(v.id, t_id('olga'), s) = m.visible,
          format('can_view %s %s %s', m.audience, m.level, s));
        perform t_count('matrix: friends_can_view');
      end loop;

      -- the client path: get_profile as that viewer
      perform t_as(v.id);
      p := public.get_profile('olga');
      perform t_reset();
      if m.audience = 'blocked' then
        perform t_check(p is null, format('blocked viewer %s gets no profile', v.id));
        perform t_count('matrix: get_profile (blocked → null)');
      else
        foreach s in array array['linked', 'learning', 'stats'] loop
          perform t_check((jsonb_typeof(p -> s) <> 'null') = m.visible, format('get_profile %s %s %s', m.audience, m.level, s));
          perform t_count('matrix: get_profile section');
        end loop;
        perform t_check((jsonb_typeof(p -> 'played') <> 'null') = m.visible, format('played follows linked: %s %s', m.audience, m.level));
        perform t_check((p ->> 'some_private')::boolean = not m.visible, format('some_private %s %s', m.audience, m.level));
      end if;

      -- activity through the feed: only people who follow olga (active) have her in it
      if v.id is not null then
        perform t_as(v.id);
        f := public.get_feed();
        perform t_reset();
        v_in_feed := exists (select 1 from jsonb_array_elements(f) e where e ->> 'username' = 'olga');
        v_exp := m.visible and m.audience in ('friend', 'follower');
        perform t_check(v_in_feed = v_exp, format('feed %s %s (got %s)', m.audience, m.level, v_in_feed));
        perform t_count('matrix: get_feed (activity)');
      end if;
    end loop;
  end loop;
end $$;

-- ── 2. view-as preview, challenge targets ─────────────────────────────────
do $$
declare
  p jsonb;
begin
  update privacy_settings set learning = 'everyone', stats = 'followers', linked = 'friends', activity = 'only_me' where user_id = t_id('olga');
  perform t_as(t_id('olga'));
  p := public.get_profile('olga', 'everyone');
  perform t_check(jsonb_typeof(p -> 'learning') = 'array' and jsonb_typeof(p -> 'stats') = 'null' and jsonb_typeof(p -> 'linked') = 'null', 'view as everyone');
  perform t_check((p ->> 'preview')::boolean and jsonb_typeof(p -> 'relationship') = 'null', 'preview hides the relationship');
  p := public.get_profile('olga', 'follower');
  perform t_check(jsonb_typeof(p -> 'stats') = 'object' and jsonb_typeof(p -> 'linked') = 'null', 'view as follower');
  p := public.get_profile('olga', 'friend');
  perform t_check(jsonb_typeof(p -> 'linked') = 'array', 'view as friend');
  p := public.get_profile('olga');
  perform t_check(not (p ->> 'some_private')::boolean and (p -> 'relationship' ->> 'self')::boolean, 'owner sees everything');
  -- someone else can't use view-as to see more
  perform t_as(t_id('sam'));
  p := public.get_profile('olga', 'friend');
  perform t_check(jsonb_typeof(p -> 'linked') = 'null' and not (p ->> 'preview')::boolean, 'view-as ignored for non-owners');

  -- challenge: lichess only (fred has no chess.com), only for viewers who see `linked`
  perform t_as(t_id('fred'));
  p := public.get_profile('olga');
  perform t_check(jsonb_array_length(p -> 'challenge') = 1 and p -> 'challenge' -> 0 ->> 'platform' = 'lichess'
    and p -> 'challenge' -> 0 ->> 'their_username' = 'olga_l' and p -> 'challenge' -> 0 ->> 'my_username' = 'fred_l', 'friend challenge targets');
  perform t_reset();
  update privacy_settings set linked = 'only_me' where user_id = t_id('olga');
  perform t_as(t_id('fred'));
  perform t_check(jsonb_array_length(public.get_profile('olga') -> 'challenge') = 0, 'no challenge when linked is hidden');
  perform t_check(jsonb_array_length((public.my_follows('following') -> 0) -> 'challenge') = 0, 'following list hides it too');
  perform t_reset();
  update privacy_settings set linked = 'friends' where user_id = t_id('olga');
  perform t_as(t_id('fred'));
  perform t_check(jsonb_array_length((public.my_follows('following') -> 0) -> 'challenge') = 1, 'following list challenge');
  perform t_as(t_id('fiona'));
  perform t_check(jsonb_array_length(public.get_profile('olga') -> 'challenge') = 0, 'a follower without a link gets none');
  perform t_reset();
  perform t_count('view-as, challenge');
end $$;

-- ── 3. blocks hide both players everywhere; refused follows ──────────────
do $$
declare
  r jsonb;
begin
  perform t_as(t_id('sam'));
  perform t_check(exists (select 1 from jsonb_array_elements(public.search_profiles('OL')) e where e ->> 'username' = 'olga'), 'sam finds olga');
  -- '_' is literal, not a wildcard
  r := public.search_profiles('ol_');
  perform t_check(jsonb_array_length(r) = 1 and r -> 0 ->> 'username' = 'ol_x', 'underscore escaped');
  perform t_as(t_id('bart'));
  perform t_check(not exists (select 1 from jsonb_array_elements(public.search_profiles('ol')) e where e ->> 'username' = 'olga'), 'blocked: no search');
  perform t_check(not exists (select 1 from jsonb_array_elements(public.get_feed()) e where e ->> 'username' = 'olga'), 'blocked: no feed');
  perform t_check(public.compare_with('olga') is null, 'blocked: no compare');
  perform t_fails($q$select public.follow('olga')$q$, 'no such player');
  perform t_as(t_id('bea'));
  perform t_check(not exists (select 1 from jsonb_array_elements(public.search_profiles('ol')) e where e ->> 'username' = 'olga'), 'blocker: no search');
  perform t_fails($q$select public.follow('olga')$q$, 'no such player');
  perform t_as(t_id('olga'));
  perform t_check(public.get_profile('bart') is null and public.get_profile('bea') is null, 'owner can''t see either');
  perform t_check(jsonb_array_length(public.search_profiles('ba')) = 0 and jsonb_array_length(public.search_profiles('be')) = 0, 'owner search hides both');
  perform t_fails($q$select public.follow('bart')$q$, 'no such player');
  perform t_fails($q$select public.follow('bea')$q$, 'no such player');
  perform t_fails($q$select public.follow('nobody')$q$, 'no such player');
  perform t_fails($q$select public.follow('olga')$q$, 'no such player');
  perform t_check(not exists (select 1 from jsonb_array_elements(public.friends_leaderboard()) e where e ->> 'username' in ('bart', 'bea')), 'board hides both');
  perform t_check((select count(*) from jsonb_array_elements(public.friends_leaderboard())) = 2, 'olga board = olga + fred');
  perform t_check(jsonb_array_length(public.my_blocks()) = 1 and public.my_blocks() -> 0 ->> 'username' = 'bart', 'my_blocks');
  perform t_as(t_id('sam'));
  perform t_check(jsonb_array_length(public.friends_leaderboard()) = 1, 'sam board = sam');
  perform t_reset();
  perform t_count('blocks everywhere');
end $$;

-- ── 4. state transitions ──────────────────────────────────────────────────
do $$
begin
  -- accept: the request turns active, the requester is told
  perform t_as(t_id('olga'));
  perform t_check(jsonb_array_length(public.my_follows('requests')) = 1, 'one request');
  perform public.accept_follower('pete');
  perform t_reset();
  perform t_check((select status from follows where follower_id = t_id('pete') and followee_id = t_id('olga')) = 'active', 'accepted');
  perform t_check(exists (select 1 from notifications where user_id = t_id('pete') and actor_id = t_id('olga') and kind = 'request_accepted'), 'accepted notification');
  perform t_check(not exists (select 1 from notifications where user_id = t_id('olga') and actor_id = t_id('pete') and kind = 'follow_request'), 'request notification cleared');

  -- decline
  perform t_as(t_id('sam')); perform public.follow('olga');
  perform t_as(t_id('olga')); perform public.decline_follower('sam');
  perform t_fails($q$select public.decline_follower('sam')$q$, 'no such request');
  perform t_reset();
  perform t_check(not exists (select 1 from follows where follower_id = t_id('sam') and followee_id = t_id('olga')), 'declined');

  -- remove follower: no block, they may request again (approval is on)
  perform t_as(t_id('olga')); perform public.remove_follower('fiona');
  perform t_as(t_id('fiona'));
  perform t_check(public.get_profile('olga') is not null, 'removed, not blocked');
  perform t_check(public.follow('olga') ->> 'status' = 'pending', 're-request after removal');
  perform t_as(t_id('olga')); perform public.accept_follower('fiona');

  -- unfollow ends the friendship one way
  perform t_as(t_id('fred')); perform public.unfollow('olga');
  perform t_reset();
  perform t_check(public.friends_audience(t_id('fred'), t_id('olga')) = 'stranger', 'unfollowed');
  perform t_check(public.friends_audience(t_id('olga'), t_id('fred')) = 'follower', 'olga still follows fred');
  perform t_as(t_id('fred')); perform public.follow('olga');
  perform t_as(t_id('olga')); perform public.accept_follower('fred');
  perform t_reset();
  perform t_check(public.friends_audience(t_id('fred'), t_id('olga')) = 'friend', 'friends again');

  -- turning approval off leaves pending requests pending
  perform t_as(t_id('sam')); perform public.follow('olga');
  perform t_as(t_id('olga')); perform public.set_privacy('{"approve_followers": false}');
  perform t_reset();
  perform t_check((select status from follows where follower_id = t_id('sam') and followee_id = t_id('olga')) = 'pending', 'still pending');
  perform t_as(t_id('sam')); perform public.unfollow('olga');  -- cancels the request
  perform t_reset();
  perform t_check(not exists (select 1 from follows where follower_id = t_id('sam') and followee_id = t_id('olga')), 'request cancelled');
  perform t_check(not exists (select 1 from notifications where user_id = t_id('olga') and actor_id = t_id('sam') and read_at is null), 'cancel clears the badge');

  -- notifications: count, list, mark read
  -- (olga's own were all cleared above by unfollow / remove / accept)
  perform t_as(t_id('olga'));
  perform t_check(public.notification_count() = 0, 'olga''s handled notifications are gone');
  perform t_as(t_id('pete'));
  perform t_check(public.notification_count() = 1, 'pete has one');
  perform t_check(public.my_notifications() -> 0 ->> 'kind' = 'request_accepted', 'pete''s list');
  perform t_check(public.mark_notifications_read() = 1, 'mark read');
  perform t_check(public.notification_count() = 0, 'read ones don''t count');

  -- unblock: visible again, follows don't come back
  perform t_as(t_id('olga')); perform public.unblock('bart');
  perform t_as(t_id('bart'));
  perform t_check(public.get_profile('olga') is not null, 'unblocked');
  perform t_reset();
  perform t_check(not exists (select 1 from follows where follower_id = t_id('bart')), 'follows not restored');

  -- settings validation
  perform t_as(t_id('olga'));
  perform t_fails($q$select public.set_privacy('{"linked": "public"}')$q$, 'bad level for linked');
  perform t_fails($q$select public.set_privacy('{"email": "everyone"}')$q$, 'unknown setting email');
  perform t_fails($q$select public.set_privacy('{"approve_followers": "yes"}')$q$, 'bad value for approve_followers');
  perform t_check(public.set_privacy('{"stats": "friends"}') ->> 'stats' = 'friends', 'set_privacy');
  perform t_fails($q$select public.search_profiles('%')$q$, 'bad prefix');
  perform t_fails($q$select public.search_profiles('a')$q$, 'bad prefix');
  perform t_reset();
  perform t_count('transitions');
end $$;

-- ── 5. direct table access is denied ──────────────────────────────────────
do $$
begin
  perform t_as(t_id('sam'));
  perform t_fails('select * from public.follows', '42501');
  perform t_fails('select * from public.activity_events', '42501');
  perform t_fails('select * from public.rate_limits', '42501');
  perform t_fails($q$insert into public.blocks values ('00000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000001')$q$, '42501');
  perform t_fails($q$insert into public.follows values ('00000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000001', 'active')$q$, '42501');
  perform t_fails($q$update public.privacy_settings set linked = 'everyone'$q$, '42501');
  perform t_fails($q$insert into public.activity_events (user_id, kind, dedupe_key) values ('00000000-0000-0000-0000-000000000004', 'streak', 'x')$q$, '42501');
  perform t_fails('delete from public.notifications', '42501');
  perform t_fails('truncate public.follows', '42501');
  perform t_fails('truncate public.blocks', '42501');
  perform t_fails($q$select public.friends_audience('00000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000001')$q$, '42501');
  perform t_fails($q$select public.friends_can_view('00000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000001', 'stats')$q$, '42501');
  perform t_fails($q$select public.friends_stats('00000000-0000-0000-0000-000000000001')$q$, '42501');
  perform t_fails($q$select public.friends_claim('00000000-0000-0000-0000-000000000004', 'follow', 1, '1 hour')$q$, '42501');
  -- own rows only
  perform t_check((select count(*) from public.privacy_settings) = 0, 'sam sees no one''s settings');
  perform t_check((select count(*) from public.blocks) = 0, 'sam sees no blocks');
  perform t_as(t_id('bea'));
  perform t_check((select count(*) from public.blocks) = 1, 'bea sees her own block');
  perform t_as(t_id('olga'));
  perform t_check((select count(*) from public.blocks) = 0, 'olga can''t see bea''s block on her');
  -- anonymous: profiles only
  perform t_as(null);
  perform t_check(public.get_profile('olga') is not null, 'anon profile');
  perform t_fails($q$select public.search_profiles('ol')$q$, '42501');
  perform t_fails('select public.get_feed()', '42501');
  perform t_fails('select public.friends_leaderboard()', '42501');
  perform t_fails($q$select public.follow('olga')$q$, '42501');
  perform t_fails('select * from public.privacy_settings', '42501');
  perform t_fails('select * from public.notifications', '42501');
  perform t_reset();
  perform t_count('access denied');
end $$;

-- ── 6. activity events: bursts, idempotence, kinds, retention ─────────────
do $$
declare
  e jsonb;
begin
  -- ten lines in one sitting = one event
  perform t_check((select count(*) from activity_events where user_id = t_id('olga') and kind = 'lines') = 1, 'one lines event');
  perform t_check((select (payload ->> 'count')::int from activity_events where user_id = t_id('olga') and kind = 'lines') = 10, 'count 10');
  -- the same lines again (and a wrong answer) change nothing
  insert into quiz_attempts (user_id, epd, san, correct, ms, rating_before, rating_after, course_id, line_id, created_at)
  select t_id('olga'), 'x', 'e4', i <= 3, 1000, 800, 801, 'italian-game/main@white', 'L' || case when i <= 3 then i else 11 end,
         ((now() at time zone 'UTC')::date)::timestamp at time zone 'UTC' + interval '17 minutes' + i * interval '10 seconds'
  from generate_series(1, 4) i;
  perform t_check((select (payload ->> 'count')::int from activity_events where user_id = t_id('olga') and kind = 'lines') = 10, 'idempotent');
  -- a new line 45 minutes later opens a new session
  insert into quiz_attempts (user_id, epd, san, correct, ms, rating_before, rating_after, course_id, line_id, created_at)
  values (t_id('olga'), 'x', 'e4', true, 1000, 800, 801, 'italian-game/main@white', 'L12',
          ((now() at time zone 'UTC')::date)::timestamp at time zone 'UTC' + interval '62 minutes');
  perform t_check((select count(*) from activity_events where user_id = t_id('olga') and kind = 'lines') = 2, 'new session');

  -- streak: exactly one 7-day milestone
  perform t_check((select count(*) from activity_events where user_id = t_id('olga') and kind = 'streak') = 1, 'one streak event');
  perform t_check((select (payload ->> 'days')::int from activity_events where user_id = t_id('olga') and kind = 'streak') = 7, '7 days');
  e := public.friends_stats(t_id('olga'));
  perform t_check((e ->> 'streak')::int = 7 and (e ->> 'lines_trained')::int = 11, format('stats %s', e));
  perform t_check((e ->> 'moves_this_week')::int >= 15, format('moves this week %s', e));

  -- course: one per course ever
  insert into course_progress (user_id, course_id) values (t_id('olga'), 'italian-game/main@white') on conflict do nothing;
  perform t_check((select count(*) from activity_events where user_id = t_id('olga') and kind = 'course') = 1, 'one course event');

  -- rating: from is kept, to follows the sync; a re-sync with the same numbers changes nothing
  update linked_accounts set ratings = '{"blitz":{"rating":1840,"games":101,"provisional":false}}' where user_id = t_id('olga') and platform = 'lichess';
  update linked_accounts set ratings = '{"blitz":{"rating":1840,"games":101,"provisional":false}}' where user_id = t_id('olga') and platform = 'lichess';
  perform t_check((select count(*) from activity_events where user_id = t_id('olga') and kind = 'rating') = 1, 'one rating event');
  update linked_accounts set ratings = '{"blitz":{"rating":1860,"games":102,"provisional":false}}' where user_id = t_id('olga') and platform = 'lichess';
  perform t_check((select payload from activity_events where user_id = t_id('olga') and kind = 'rating') @> '{"from":1800,"to":1860}', 'from 1800 to 1860');

  -- fred (a friend, every section visible to friends) sees all four kinds
  update privacy_settings set linked = 'friends', learning = 'friends', stats = 'friends', activity = 'friends' where user_id = t_id('olga');
  perform t_as(t_id('fred'));
  e := public.get_feed();
  perform t_reset();
  perform t_check((select count(distinct x ->> 'kind') from jsonb_array_elements(e) x where x ->> 'username' = 'olga') = 4, format('fred sees 4 kinds: %s', e));
  -- a hidden underlying section hides the item even with activity visible
  update privacy_settings set linked = 'only_me' where user_id = t_id('olga');
  perform t_as(t_id('fred'));
  e := public.get_feed();
  perform t_reset();
  perform t_check(not exists (select 1 from jsonb_array_elements(e) x where x ->> 'kind' = 'rating'), 'rating item needs linked');

  -- unlinking takes its rating events
  delete from linked_accounts where user_id = t_id('olga') and platform = 'lichess';
  perform t_check(not exists (select 1 from activity_events where user_id = t_id('olga') and kind = 'rating'), 'unlink removes rating events');

  -- retention: a first answer of the day prunes events older than 90 days
  insert into activity_events (user_id, kind, dedupe_key, created_at, updated_at) values (t_id('sam'), 'course', 'old', now() - interval '100 days', now() - interval '100 days');
  insert into quiz_attempts (user_id, epd, san, correct, ms, rating_before, rating_after) values (t_id('sam'), 'x', 'e4', false, 1000, 800, 790);
  perform t_check(not exists (select 1 from activity_events where user_id = t_id('sam') and dedupe_key = 'old'), 'retention');
  perform t_count('activity');
end $$;

-- ── 7. rate limits ────────────────────────────────────────────────────────
do $$
declare
  i int;
  v_detail text;
begin
  delete from rate_limits where user_id = t_id('sam');
  perform t_as(t_id('sam'));
  for i in 1..30 loop perform public.search_profiles('ol'); end loop;
  begin
    perform public.search_profiles('ol');
    raise exception 'search limit not enforced';
  exception when others then
    get stacked diagnostics v_detail = pg_exception_detail;
    perform t_check(sqlerrm = 'rate_limited' and v_detail::int between 1 and 60, format('search limited (%s, %s)', sqlerrm, v_detail));
  end;
  perform t_reset();
  insert into auth.users (id, email, raw_user_meta_data)
  select gen_random_uuid(), 'u' || g || '@example.com', jsonb_build_object('username', 'user_' || g) from generate_series(1, 31) g;
  perform t_as(t_id('sam'));
  for i in 1..30 loop perform public.follow('user_' || i); end loop;
  perform t_fails($q$select public.follow('user_31')$q$, 'rate_limited');
  -- unfollow is free; a repeat follow costs nothing
  perform public.unfollow('user_1');
  perform t_check(public.follow('user_2') ->> 'status' = 'active', 'repeat follow free');
  perform t_reset();
  perform t_count('rate limits');
end $$;

-- ── 8. deletion removes every row about the account, both directions ─────
do $$
declare
  v_olga uuid := t_id('olga');
begin
  perform t_as(t_id('fiona')); perform public.follow('fred');
  perform t_as(t_id('olga')); perform public.block('sam');
  perform t_reset();
  perform t_check(exists (select 1 from rate_limits where user_id = v_olga), 'olga has rate-limit rows');
  delete from auth.users where id = v_olga;
  perform t_check(not exists (select 1 from follows where v_olga in (follower_id, followee_id)), 'follows gone');
  perform t_check(not exists (select 1 from blocks where v_olga in (blocker_id, blocked_id)), 'blocks gone (both directions)');
  perform t_check(not exists (select 1 from privacy_settings where user_id = v_olga), 'settings gone');
  perform t_check(not exists (select 1 from activity_events where user_id = v_olga), 'events gone');
  perform t_check(not exists (select 1 from notifications where v_olga in (user_id, actor_id)), 'notifications gone');
  perform t_check(not exists (select 1 from rate_limits where user_id = v_olga), 'rate limits gone');
  perform t_check(exists (select 1 from follows where follower_id = t_id('fiona') and followee_id = t_id('fred')), 'other users kept');
  perform t_count('deletion');
end $$;

select name || ': ' || n from t_counts order by name;
select (select sum(n) from t_counts where name like 'matrix:%') || ' matrix checks';
select '0008: all checks passed';
