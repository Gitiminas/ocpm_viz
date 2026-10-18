#!/usr/bin/env bash
#
# Step 2 of 3 of the db container's first start: restore the dump mounted at /dump.
#
# The dump is a directory-format `pg_dump -Fd` of the host database (docs/DOCKER.md says
# how to make one). It holds the base tables' data and every view and function; the 31
# materialized views are stored as definitions and REFRESHed here, which is most of the
# time this step takes.
#
# Two filters, both because the host's owning role (`minas` today) does not exist here:
#
#   --no-owner        objects are owned by the restoring superuser instead. ⚠️ That
#                     includes the api functions, which are SECURITY DEFINER — a
#                     superuser-owned SECURITY DEFINER function is exactly what
#                     sql/postgrest_setup.sql exists to prevent, and 30-secure.sh re-runs it
#                     to hand everything back to fe_owner. Never ship step 2 without step 3.
#   no DEFAULT ACL    `--no-owner` does not touch `ALTER DEFAULT PRIVILEGES FOR ROLE minas`,
#                     which fails outright. Those entries are dropped from the restore list;
#                     postgrest_setup.sql §2 and §5 issue the equivalent defaults.

set -euo pipefail

DUMP=/dump
JOBS="${OCPM_RESTORE_JOBS:-4}"

# Fail with the remedy, not with pg_restore's "could not open input file". The two
# likeliest first-run mistakes, each told apart from the other:
#
#   unreadable   `pg_dump -Fd` creates its directory 0700, owned by whoever ran it; this
#                script runs as the image's postgres user, which cannot list it.
#   missing      OCPM_DUMP_DIR unset, so the empty ./dump was mounted instead.
if [ -d "$DUMP" ] && ! [ -r "$DUMP" -a -x "$DUMP" ]; then
  cat >&2 <<EOF
ocpm-init: the dump at $DUMP exists but is not readable by $(id -un) (uid $(id -u)).
           pg_dump -Fd creates its directory 0700. On the host:
             chmod a+rx <dump dir> && chmod a+r <dump dir>/*
           then:  docker compose down -v && docker compose up -d
EOF
  exit 1
fi
if [ ! -f "$DUMP/toc.dat" ]; then
  cat >&2 <<EOF
ocpm-init: no directory-format dump at $DUMP (toc.dat missing).
           Set OCPM_DUMP_DIR in .env to a 'pg_dump -Fd' directory, then:
             docker compose down -v && docker compose up -d
EOF
  exit 1
fi

list="$(mktemp)"
trap 'rm -f "$list"' EXIT
pg_restore -l "$DUMP" | grep -v ' DEFAULT ACL ' >"$list"

echo "ocpm-init: restoring $DUMP into $POSTGRES_DB with $JOBS jobs (refreshes 31 matviews; slow)"
start=$SECONDS
# --exit-on-error: a partial restore must not be followed by step 3 and look healthy.
pg_restore --no-owner --exit-on-error --jobs "$JOBS" --use-list "$list" \
           --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" "$DUMP"
echo "ocpm-init: restore finished in $((SECONDS - start))s"
