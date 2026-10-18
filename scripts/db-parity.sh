#!/usr/bin/env bash
#
# Does a restored database hold the same data as the one it was dumped from?
#
#   scripts/db-parity.sh "<source conninfo>" "<restored conninfo>"
#   scripts/db-parity.sh "dbname=gharchive_ocpm_viz_wsl" \
#       "host=127.0.0.1 port=5433 user=postgres dbname=gharchive_ocpm_viz_wsl"
#
# Compares the row count of every table and materialized view in schemas public and fe,
# plus the TimeZone setting, and exits 1 on any difference. Read-only on both sides.
#
# Why "the restore succeeded" is not enough: a dump carries base-table rows, but the
# materialized views are re-computed on restore, from their definitions, in the restoring
# server's session. One such dependency already bit (docs/DOCKER.md, "TimeZone"): every
# base table matched and the container still computed 7,433 proximity links where the
# source had 1,457. Equal counts are necessary, not sufficient — but they caught that.
#
# For the container, export PGPASSWORD (POSTGRES_PASSWORD from .env) first. Expect
# minutes: event alone is ~4 M rows, counted on both sides.

set -euo pipefail

[ $# -eq 2 ] || { sed -n '3,7p' "$0" >&2; exit 2; }
SOURCE="$1"; RESTORED="$2"

# One `relation|count` line per table and matview, sorted, so the two sides line up.
# A function would be shorter, but this must not create anything in either database.
COUNTS_SQL="
DO \$\$
DECLARE r record; n bigint;
BEGIN
  RAISE NOTICE 'TimeZone|%', current_setting('TimeZone');
  FOR r IN
    SELECT c.oid::regclass AS rel
    FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace
    WHERE s.nspname IN ('public', 'fe') AND c.relkind IN ('r', 'm')
  LOOP
    EXECUTE format('SELECT count(*) FROM %s', r.rel) INTO n;
    RAISE NOTICE '%|%', r.rel, n;
  END LOOP;
END
\$\$;"

counts() {
  psql "$1" -v ON_ERROR_STOP=1 -qXc "$COUNTS_SQL" 2>&1 >/dev/null \
    | sed -n 's/^NOTICE: *//p' | LC_ALL=C sort
}

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
counts "$SOURCE"   >"$tmp/source"   &
counts "$RESTORED" >"$tmp/restored" &
wait

# Both sides must have produced something, or `join` compares two empty files and passes.
[ -s "$tmp/source" ] && [ -s "$tmp/restored" ] || { echo "could not read one of the databases" >&2; exit 1; }

printf '%-48s %12s %12s\n' relation source restored
LC_ALL=C join -t'|' -a1 -a2 -e '(missing)' -o 0,1.2,2.2 "$tmp/source" "$tmp/restored" \
  | awk -F'|' '
      { mark = ($2 == $3) ? "" : "   <-- differs"; if (mark) bad++
        printf "%-48s %12s %12s%s\n", $1, $2, $3, mark }
      END { if (bad) { printf "\n%d difference(s)\n", bad; exit 1 } else print "\nidentical" }'
