#!/usr/bin/env bash
# Tests migration 0008 (ADR 0007, Friends) on a scratch database of a LOCAL Postgres:
# local-shim.sql + migrations 0001–0008, 0008 applied twice (idempotence), then
# scripts/supabase/test-0008.sql with the shared visibility matrix. Refuses non-local hosts.
#   scripts/supabase/local-pg.sh start
#   DATABASE_URL=postgres://postgres@127.0.0.1:54329/postgres scripts/supabase/test-0008.sh
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
BASE=${DATABASE_URL:?set DATABASE_URL to a LOCAL Postgres (scripts/supabase/local-pg.sh start)}
HOST=$(node -e 'console.log(new URL(process.argv[1]).hostname)' "$BASE")
case "$HOST" in localhost|127.0.0.1|::1|\[::1\]) ;; *) echo "test-0008: refusing non-local host \"$HOST\"" >&2; exit 1 ;; esac
DB=cot_test_0008
URL=$(node -e 'const u = new URL(process.argv[1]); u.pathname = "/" + process.argv[2]; console.log(u.toString())' "$BASE" "$DB")
PSQL=(psql -X -q -v ON_ERROR_STOP=1)

"${PSQL[@]}" "$BASE" -c "drop database if exists $DB" -c "create database $DB" >/dev/null
"${PSQL[@]}" "$URL" -f "$ROOT/scripts/supabase/local-shim.sql" >/dev/null
for f in "$ROOT"/supabase/migrations/000[1-8]_*.sql; do
  "${PSQL[@]}" "$URL" -f "$f" >/dev/null 2>&1 || { echo "test-0008: $f failed" >&2; "${PSQL[@]}" "$URL" -f "$f" >/dev/null; exit 1; }
done
"${PSQL[@]}" "$URL" -f "$ROOT/supabase/migrations/0008_friends.sql" >/dev/null 2>&1 || { echo "test-0008: re-applying 0008 failed" >&2; exit 1; }
MATRIX=$(node -e 'process.stdout.write(JSON.stringify(require(process.argv[1]).rows))' "$ROOT/src/lib/friends/__tests__/visibility-matrix.json")
"${PSQL[@]}" -A -t "$URL" -v matrix="$MATRIX" -f "$ROOT/scripts/supabase/test-0008.sql"
"${PSQL[@]}" "$BASE" -c "drop database $DB" >/dev/null
