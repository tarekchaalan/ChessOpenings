#!/usr/bin/env bash
# Query plans for the Friends reads (ADR 0007 § Storage) on synthetic data at
# the ADR's planning sizes: 10,000 players, 50 follows each, 20 events each.
# LOCAL Postgres only; prints EXPLAIN (ANALYZE, BUFFERS) for each query.
#   DATABASE_URL=postgres://postgres@127.0.0.1:54329/postgres scripts/supabase/plans-0008.sh
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
BASE=${DATABASE_URL:?set DATABASE_URL to a LOCAL Postgres (scripts/supabase/local-pg.sh start)}
HOST=$(node -e 'console.log(new URL(process.argv[1]).hostname)' "$BASE")
case "$HOST" in localhost|127.0.0.1|::1|\[::1\]) ;; *) echo "plans-0008: refusing non-local host \"$HOST\"" >&2; exit 1 ;; esac
DB=cot_plans_0008
URL=$(node -e 'const u = new URL(process.argv[1]); u.pathname = "/" + process.argv[2]; console.log(u.toString())' "$BASE" "$DB")
PSQL=(psql -X -q -v ON_ERROR_STOP=1)

"${PSQL[@]}" "$BASE" -c "drop database if exists $DB" -c "create database $DB" >/dev/null
"${PSQL[@]}" "$URL" -f "$ROOT/scripts/supabase/local-shim.sql" >/dev/null
for f in "$ROOT"/supabase/migrations/000[1-8]_*.sql; do "${PSQL[@]}" "$URL" -f "$f" >/dev/null 2>&1; done
"${PSQL[@]}" "$URL" >/dev/null <<'SQL'
insert into auth.users (id, raw_user_meta_data)
select gen_random_uuid(), jsonb_build_object('username', 'player_' || lpad(g::text, 5, '0')) from generate_series(1, 10000) g;
insert into follows (follower_id, followee_id, status)
select a.id, b.id, 'active'
from (select id, row_number() over (order by id) as n from profiles) a
join lateral (select id from profiles p where p.id <> a.id order by md5(a.id::text || p.id::text) limit 50) b on true;
insert into privacy_settings (user_id, linked, learning, stats, activity)
select id, 'friends', 'friends', 'friends', 'followers' from profiles;
insert into activity_events (user_id, kind, dedupe_key, payload, created_at, updated_at)
select p.id, 'course', 'course:' || g, jsonb_build_object('course', 'hub/c' || g || '@white'),
       now() - (g || ' days')::interval, now() - (g || ' days')::interval
from profiles p, generate_series(1, 20) g;
analyze;
SQL
V=$("${PSQL[@]}" -A -t "$URL" -c "select id from profiles order by username limit 1")
echo "viewer: $V"
explain() { echo; echo "── $1"; "${PSQL[@]}" "$URL" -c "explain (analyze, buffers, costs off, summary on) $2" | sed 's/^/   /'; }

explain "feed (get_feed core)" "
select ev.id from follows f
join activity_events ev on ev.user_id = f.followee_id
where f.follower_id = '$V' and f.status = 'active' and ev.updated_at > now() - interval '30 days'
  and public.friends_reaches(public.friends_audience('$V', f.followee_id), public.friends_level(f.followee_id, 'activity'))
order by ev.updated_at desc, ev.id desc limit 30"
explain "profile follower count" "select count(*) from follows where followee_id = '$V' and status = 'active'"
explain "profile following count" "select count(*) from follows where follower_id = '$V' and status = 'active'"
explain "audience (block + both follow checks)" "select public.friends_audience('$V', (select followee_id from follows where follower_id = '$V' limit 1))"
explain "search prefix" "
select id, username from profiles where lower(username) like 'player\_012%' and id <> '$V'
  and not exists (select 1 from blocks where (blocker_id = '$V' and blocked_id = profiles.id) or (blocker_id = profiles.id and blocked_id = '$V'))
order by lower(username) limit 20"
explain "friends leaderboard" "
select p.username, rank() over (order by p.rating desc, p.attempts desc) from profiles p
where p.id in (select '$V'::uuid union select f.followee_id from follows f where f.follower_id = '$V' and f.status = 'active'
  and not exists (select 1 from blocks b where (b.blocker_id = '$V' and b.blocked_id = f.followee_id) or (b.blocker_id = f.followee_id and b.blocked_id = '$V')))"
explain "requests list" "select follower_id from follows where followee_id = '$V' and status = 'pending'"
"${PSQL[@]}" "$URL" -A -t -c "select 'rows: profiles ' || (select count(*) from profiles) || ', follows ' || (select count(*) from follows) || ', activity_events ' || (select count(*) from activity_events)"
"${PSQL[@]}" "$BASE" -c "drop database $DB" >/dev/null
