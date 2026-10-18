#!/usr/bin/env bash
#
# End-to-end check of the running compose stack (docs/DOCKER.md).
#
#   docker compose up -d && scripts/docker-smoke.sh
#
# What tests/docker-config.test.js cannot know from the files alone: that the three
# containers are healthy, that a browser-shaped request travels web → api → db and back
# with data, and that the restored database passes the same acceptance gates as the host
# one (scripts/rpc-check.mjs, dfg-check.mjs), including their unauthenticated probe as
# web_anon. Read-only: it starts nothing, and changes nothing in the database.
#
# Needs on the host: docker, curl, node, psql (the gates shell out to it).

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
die()  { printf '\n  \033[31m✗ %s\033[0m\n\n' "$*" >&2; exit 1; }
section() { printf '\n\033[1m%s\033[0m\n' "$*"; }

[ -f .env ] || die ".env is missing — copy .env.example and fill it in"

# Read only the keys this script needs, rather than sourcing .env into the shell.
env_get() { sed -n "s/^$1=//p" .env | tail -1; }
DB_NAME="$(env_get OCPM_DB_NAME)";   DB_NAME="${DB_NAME:-gharchive_ocpm_viz_wsl}"
DB_PORT="$(env_get OCPM_DB_PORT)";   DB_PORT="${DB_PORT:-5433}"
API_PORT="$(env_get OCPM_API_PORT)"; API_PORT="${API_PORT:-3001}"
WEB_PORT="$(env_get OCPM_WEB_PORT)"; WEB_PORT="${WEB_PORT:-8000}"

section "Compose"
docker compose config -q || die "compose.yaml does not validate against .env"
ok "compose.yaml validates"

# Health, not just "running": db is healthy only once init finished (its marker), api
# once its schema cache loaded, web once it serves.
for service in db api web; do
  status="$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose ps -q "$service")" 2>/dev/null || true)"
  [ "$status" = "healthy" ] || die "$service is '${status:-not running}', not healthy — see: docker compose logs $service"
  ok "$service is healthy"
done

section "Web → api → db"
WEB="http://127.0.0.1:$WEB_PORT"
for path in / /src/main.js /tests/fixtures/catalogue.json; do
  code="$(curl -s -o /dev/null -w '%{http_code}' "$WEB$path")"
  [ "$code" = "200" ] || die "GET $path answered $code"
done
ok "the app's static files are served"

body="$(curl -sS --max-time 30 -w '\n%{http_code}' "$WEB/rpc/list_repos")"
code="$(tail -n1 <<<"$body")"; body="$(sed '$d' <<<"$body")"
[ "$code" = "200" ] || die "/rpc/list_repos answered $code: $(head -c 300 <<<"$body")"
repos="$(grep -o '"name"' <<<"$body" | wc -l)"
[ "$repos" -gt 0 ] || die "/rpc/list_repos returned no repositories"
ok "/rpc/list_repos through the web proxy: $repos repositories"

# The network split: web must not be able to open a connection to db at all. Probed with
# the image's own node rather than nc, so a missing tool cannot pass for a closed door.
probe="const s=require('net').connect(5432,'db');s.setTimeout(3000,()=>process.exit(1));
       s.on('connect',()=>process.exit(0));s.on('error',()=>process.exit(1));"
if docker compose exec -T web node -e "$probe" >/dev/null 2>&1; then
  die "web can reach db:5432 — the backend/frontend network split is broken"
fi
ok "web cannot reach db (network split holds)"

section "Acceptance gates against the container database"
# The gates connect with psql as the container's superuser, and probe PostgREST directly
# on its published port, unauthenticated, exactly as they do on the host.
export PGHOST=127.0.0.1 PGPORT="$DB_PORT" PGUSER=postgres PGDATABASE="$DB_NAME"
PGPASSWORD="$(env_get POSTGRES_PASSWORD)"; export PGPASSWORD
export PGRST_URL="http://127.0.0.1:$API_PORT"
node scripts/rpc-check.mjs || die "scripts/rpc-check.mjs failed"
node scripts/dfg-check.mjs || die "scripts/dfg-check.mjs failed"

section "Smoke test passed"
printf '  · app  %s/?source=database\n\n' "$WEB"
