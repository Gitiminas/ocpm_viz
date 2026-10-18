#!/usr/bin/env bash
#
# Step 3 of 3 of the db container's first start: re-secure the HTTP surface, then check
# the data layer agrees with itself.
#
# sql/postgrest_setup.sql (mounted at /sql) hands schemas fe and api back to fe_owner,
# makes every api function SECURITY DEFINER with a pinned search_path, and grants
# web_anon exactly EXECUTE on api. After 20-restore.sh's --no-owner this is not optional;
# see that file's header.
#
# The file's own §6 only *prints* its checks. Here a FAIL row stops the container, so a
# deployment that would let web_anon read raw events never reports healthy.

set -euo pipefail

psql_run() {
  # ON_ERROR_STOP, always: without it psql exits 0 after a failed statement.
  PGOPTIONS='-c client_min_messages=warning' \
    psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" "$@"
}

report="$(psql_run -qAt -F ' | ' -f /sql/postgrest_setup.sql)"
echo "$report" | sed 's/^/ocpm-init:   /'
if grep -q '| FAIL$' <<<"$report"; then
  echo "ocpm-init: postgrest_setup.sql §6 reports a FAIL — refusing to finish init" >&2
  exit 1
fi
echo "ocpm-init: api is SECURITY DEFINER, owned by fe_owner, reachable by web_anon only"

# The same gate `./ocpm.sh db` applies: every diagnostic at its expected value.
bad="$(psql_run -qtAc "SELECT count(*) FROM fe.diag_sanity WHERE n IS DISTINCT FROM expected")"
if [ "$bad" != "0" ]; then
  echo "ocpm-init: fe.diag_sanity reports $bad failing check(s):" >&2
  psql_run -c 'SELECT * FROM fe.diag_sanity' >&2
  exit 1
fi
echo "ocpm-init: fe.diag_sanity clean"

# ⚠️ The marker the healthcheck requires (compose.yaml). The image runs init only on an
# empty volume, and a failed init still leaves the volume non-empty: on the restart that
# follows, Postgres skips init and comes up "ready" over half a database. Written last,
# so it exists only if every step above succeeded.
touch "$PGDATA/ocpm-init.done"
echo "ocpm-init: done"
