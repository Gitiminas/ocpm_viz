#!/usr/bin/env bash
#
# Clean start for the OCPM visualization tool.
#
#   ./ocpm.sh            stop whatever is running, then start it fresh
#   ./ocpm.sh stop       stop only
#   ./ocpm.sh status     what is running, and is it healthy
#   ./ocpm.sh db         apply the data layer, restart, and run the acceptance gate
#
# Two processes are involved and they are easy to confuse:
#
#   PostgREST      serves api.get_object_graph over HTTP   (port from postgrest.conf)
#   serve.mjs      serves the app AND proxies /rpc/* to PostgREST   (port 8000)
#
# The app talks only to serve.mjs; serve.mjs forwards to PostgREST so the two share an
# origin (decision 73). So PostgREST must be up first, and "the app loads but every query
# fails" is what a half-start looks like.
#
# Ports are the source of truth for what is running, not process names: a stale PostgREST
# holding port 3000 is the problem whatever it is called, and killing by name would also
# reach a second copy that is none of our business.

set -euo pipefail

# This script lives in the repository root, so the project is wherever it is, not a path
# anyone has to edit. Overriding OCPM_DIR is for calling it from somewhere else entirely.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PROJECT="${OCPM_DIR:-$SCRIPT_DIR}"
POSTGREST_BIN="${POSTGREST_BIN:-$HOME/.local/bin/postgrest}"
APP_PORT="${OCPM_APP_PORT:-8000}"
LOG_DIR="${OCPM_LOG_DIR:-$PROJECT/.ocpm-logs}"

# Node is installed user-local and is on PATH only via an interactive shell profile, so a
# script run from cron or an editor would otherwise fail with "node: not found".
command -v node >/dev/null 2>&1 || export PATH="$HOME/.local/node/bin:$PATH"

ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
info() { printf '  · %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '\n  \033[31m✗ %s\033[0m\n\n' "$*" >&2; exit 1; }
section() { printf '\n\033[1m%s\033[0m\n' "$*"; }

[ -d "$PROJECT" ] || die "No project at $PROJECT (override with OCPM_DIR=...)"
cd "$PROJECT"

# The API port is declared in postgrest.conf, so read it rather than assume it. The config
# is gitignored (it holds a password), which is also the most likely thing to be missing.
if [ -f postgrest.conf ]; then
  API_PORT="$(sed -n 's/^[[:space:]]*server-port[[:space:]]*=[[:space:]]*\([0-9]\+\).*/\1/p' postgrest.conf | head -1)"
fi
API_PORT="${API_PORT:-3000}"

# The database name, read from the same config, so the remedy printed by the health check
# names the right one. Global on purpose: `status` runs the health check without ever
# entering do_start, and a remedy quoting an empty database name is worse than none.
DB_NAME="gharchive_ocpm_viz_wsl"
if [ -f postgrest.conf ]; then
  DB_NAME="$(grep '^db-uri' postgrest.conf | sed -n 's|.*/\([A-Za-z0-9_]*\)".*|\1|p')"
  DB_NAME="${DB_NAME:-gharchive_ocpm_viz_wsl}"
fi

# ---------------------------------------------------------------------------------------
# stopping
# ---------------------------------------------------------------------------------------

pids_on_port() {
  local port="$1"
  if command -v ss >/dev/null 2>&1; then
    ss -ltnpH "sport = :$port" 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u
  elif command -v lsof >/dev/null 2>&1; then
    lsof -ti "tcp:$port" -s TCP:LISTEN 2>/dev/null | sort -u
  fi
}

stop_port() {
  local port="$1" label="$2" pids original
  pids="$(pids_on_port "$port" || true)"
  if [ -z "$pids" ]; then
    info "$label — nothing on port $port"
    return
  fi
  # Remember who we are killing: by the time we report, the port is empty by design.
  original="$(echo $pids | tr '\n' ' ')"

  # Ask first. A SIGKILL to PostgREST mid-query leaves the connection pool to time out on
  # the database side, which shows up later as a slow first request rather than an error.
  kill $pids 2>/dev/null || true
  for _ in $(seq 1 20); do
    sleep 0.25
    [ -z "$(pids_on_port "$port" || true)" ] && break
  done

  pids="$(pids_on_port "$port" || true)"
  if [ -n "$pids" ]; then
    warn "$label did not stop on SIGTERM — forcing"
    kill -9 $pids 2>/dev/null || true
    sleep 0.5
  fi
  ok "$label stopped (was pid ${original% })"
}

do_stop() {
  section "Stopping"
  stop_port "$APP_PORT" "app server"
  stop_port "$API_PORT" "PostgREST"
}

# ---------------------------------------------------------------------------------------
# starting
# ---------------------------------------------------------------------------------------

wait_for() {
  local url="$1" label="$2" tries="${3:-40}"
  for _ in $(seq 1 "$tries"); do
    if curl -fsS -o /dev/null --max-time 2 "$url" 2>/dev/null; then ok "$label is up"; return 0; fi
    sleep 0.5
  done
  return 1
}

do_start() {
  section "Checks"
  [ -x "$POSTGREST_BIN" ] || die "PostgREST not found at $POSTGREST_BIN (override with POSTGREST_BIN=...)"
  [ -f postgrest.conf ] || die "postgrest.conf is missing. Copy postgrest.conf.example and fill in the password — it is gitignored because it holds one."
  command -v node >/dev/null 2>&1 || die "node is not on PATH"

  if command -v pg_isready >/dev/null 2>&1; then
    pg_isready -q 2>/dev/null && ok "PostgreSQL is accepting connections" \
      || die "PostgreSQL is not accepting connections — start it before this script"
  fi
  ok "config reads database '$DB_NAME', API port $API_PORT"

  mkdir -p "$LOG_DIR"

  section "Starting"
  # setsid so the servers survive this script and the shell that ran it. Without it,
  # closing the terminal takes the tool down and the next run reports "nothing running"
  # for reasons that have nothing to do with the tool.
  setsid "$POSTGREST_BIN" postgrest.conf >"$LOG_DIR/postgrest.log" 2>&1 < /dev/null &
  wait_for "http://localhost:$API_PORT/" "PostgREST (port $API_PORT)" \
    || die "PostgREST did not come up. Last lines of $LOG_DIR/postgrest.log:
$(tail -n 15 "$LOG_DIR/postgrest.log" 2>/dev/null | sed 's/^/      /')"

  setsid node scripts/serve.mjs "$APP_PORT" >"$LOG_DIR/app.log" 2>&1 < /dev/null &
  wait_for "http://localhost:$APP_PORT/" "app server (port $APP_PORT)" \
    || die "The app server did not come up. Last lines of $LOG_DIR/app.log:
$(tail -n 15 "$LOG_DIR/app.log" 2>/dev/null | sed 's/^/      /')"
}

# ---------------------------------------------------------------------------------------
# health — the end-to-end path, which is the only one that proves anything
# ---------------------------------------------------------------------------------------

do_health() {
  section "Health"
  local body status
  body="$(curl -sS --max-time 15 -w '\n%{http_code}' "http://localhost:$APP_PORT/rpc/list_repos" 2>/dev/null || true)"
  status="$(tail -n1 <<<"$body")"
  body="$(sed '$d' <<<"$body")"

  # curl reports 000 when it could not connect at all. That is "nothing is listening",
  # not "the RPC refused you", and saying the latter sends you to debug the database when
  # the answer is that the server is down.
  if [ "$status" = "000" ] || [ -z "$status" ]; then
    warn "nothing answered on port $APP_PORT — the app server is not running"
    info "start it with:  $(basename "$0") start"
    exit 1
  fi

  if [ "$status" = "200" ]; then
    ok "app → PostgREST → database: $(grep -o '"name"' <<<"$body" | wc -l) repositories"
    return
  fi

  # ⚠️ This exact failure has happened. Re-running sql/fe_layer.sql issues CREATE OR
  # REPLACE on every api function, which resets it to SECURITY INVOKER — so it runs as
  # web_anon, which by design can read nothing in the fe schema. Both servers are then
  # perfectly healthy and every query fails, which is a maddening thing to debug from the
  # browser. Name it here, with the fix.
  warn "the RPC answered $status, so the app will load but every query will fail"
  printf '      %s\n' "$(head -c 300 <<<"$body")"
  if grep -qi 'permission denied' <<<"$body"; then
    printf '\n      This is the SECURITY INVOKER regression: sql/fe_layer.sql replaced the\n'
    printf '      api functions and reset them. Fix:\n\n'
    printf '          psql -d %s -f sql/postgrest_setup.sql\n\n' "$DB_NAME"
  elif grep -qiE 'schema cache|PGRST20' <<<"$body"; then
    printf '\n      PostgREST is holding a stale schema cache. This script restarts it, so\n'
    printf '      if you are seeing this after a restart the function really is missing.\n\n'
  fi
  exit 1
}

# ---------------------------------------------------------------------------------------
# applying the data layer — three files in one order, because the order is load-bearing
# ---------------------------------------------------------------------------------------

psql_run() {
  # ⚠️ ON_ERROR_STOP, always. Without it psql exits 0 after a failed statement, so a
  # broken migration reports success and the damage is only found later, in the browser.
  #
  # NOTICEs are suppressed but WARNINGs are not, deliberately: re-running idempotent DDL
  # emits dozens of "already exists, skipping" lines that bury the one message that
  # matters — fe_layer.sql's warning that the api functions need re-securing.
  PGOPTIONS='-c client_min_messages=warning' psql -v ON_ERROR_STOP=1 -d "$DB_NAME" "$@"
}

do_db() {
  section "Applying the data layer"
  [ -f sql/fe_layer.sql ] || die "sql/fe_layer.sql is missing — is $PROJECT the right directory?"
  [ -f sql/postgrest_setup.sql ] || die "sql/postgrest_setup.sql is missing"

  # 1. the views and the RPC.
  psql_run -q -f sql/fe_layer.sql >/dev/null || die "sql/fe_layer.sql failed"
  ok "fe_layer.sql applied"

  # 2. ⚠️ NOT OPTIONAL. Step 1 issues CREATE OR REPLACE on every api function, which
  #    resets it to SECURITY INVOKER — so it runs as web_anon, which by design can read
  #    nothing in fe, and the app dies with "permission denied for schema fe" while every
  #    local check still passes. This step is why the command exists at all.
  psql_run -q -f sql/postgrest_setup.sql >/dev/null || die "sql/postgrest_setup.sql failed"
  ok "postgrest_setup.sql applied — api functions are SECURITY DEFINER again"

  # 3. the one materialization. It goes stale silently; nothing else will tell you.
  psql_run -qtAc "SELECT fe.refresh_links()" >/dev/null || die "fe.refresh_links() failed"
  ok "fe.link_mat refreshed"

  # 4. does the layer agree with itself?
  local bad
  bad="$(psql_run -qtAc "SELECT count(*) FROM fe.diag_sanity WHERE n IS DISTINCT FROM expected")"
  [ "$bad" = "0" ] || die "fe.diag_sanity reports $bad failing check(s):
$(psql_run -c 'SELECT * FROM fe.diag_sanity' 2>/dev/null | sed 's/^/      /')"
  ok "fe.diag_sanity — every check at its expected value"
}

do_status() {
  section "Status"
  local p
  p="$(pids_on_port "$API_PORT" || true)"
  [ -n "$p" ] && ok "PostgREST running on $API_PORT (pid $(echo $p | tr '\n' ' '))" \
               || warn "PostgREST is not running (port $API_PORT)"
  p="$(pids_on_port "$APP_PORT" || true)"
  [ -n "$p" ] && ok "app server running on $APP_PORT (pid $(echo $p | tr '\n' ' '))" \
               || warn "app server is not running (port $APP_PORT)"
}

case "${1:-restart}" in
  stop)             do_stop ;;
  status)           do_status; do_health ;;
  # Applying the layer changes the api functions, so PostgREST must be restarted or it
  # serves them from a stale schema cache — which fails in a way that looks nothing like
  # the cause. Restarting is part of applying, not a separate thing to remember.
  db)               do_db; do_stop; do_start; do_health
                    section "Acceptance gate"
                    node scripts/rpc-check.mjs || die "scripts/rpc-check.mjs failed"
                    section "Ready"
                    info "app        http://localhost:$APP_PORT"
                    echo ;;
  start|restart|"") do_stop; do_start; do_health
                    section "Ready"
                    info "app        http://localhost:$APP_PORT"
                    info "database   http://localhost:$APP_PORT/?source=database"
                    info "logs       $LOG_DIR/{postgrest,app}.log"
                    echo ;;
  *) die "Unknown command '${1}'. Use: start | stop | restart | status | db" ;;
esac
