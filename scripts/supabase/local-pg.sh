#!/usr/bin/env bash
# A throwaway local Postgres 16 for scripts/supabase/dry-run-v2.ts when the
# Supabase CLI / Docker isn't available. Listens on 127.0.0.1 only.
#   scripts/supabase/local-pg.sh start [dir]   → prints DATABASE_URL
#   scripts/supabase/local-pg.sh stop  [dir]
set -euo pipefail
BIN=${PG_BIN:-/usr/lib/postgresql/16/bin}
DIR=${2:-${TMPDIR:-/tmp}/cot-pg}
PORT=${PG_PORT:-54329}
RUN_AS=()
[ "$(id -u)" = "0" ] && RUN_AS=(runuser -u postgres --)
case "${1:-}" in
  start)
    if [ ! -f "$DIR/PG_VERSION" ]; then
      mkdir -p "$DIR" && chown -R postgres "$DIR" 2>/dev/null || true
      "${RUN_AS[@]}" "$BIN/initdb" -D "$DIR" -U postgres --auth=trust -E UTF8 >/dev/null
    fi
    "${RUN_AS[@]}" "$BIN/pg_ctl" -D "$DIR" -l "$DIR/server.log" -o "-c listen_addresses=127.0.0.1 -p $PORT -k $DIR" -w start >/dev/null
    echo "DATABASE_URL=postgres://postgres@127.0.0.1:$PORT/postgres"
    ;;
  stop)
    "${RUN_AS[@]}" "$BIN/pg_ctl" -D "$DIR" -m fast stop >/dev/null && echo stopped
    ;;
  *) echo "usage: $0 start|stop [dir]" >&2; exit 2 ;;
esac
