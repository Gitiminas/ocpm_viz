#!/usr/bin/env bash
#
# Step 1 of 3 of the db container's first start: create the three roles.
#
# The postgres image runs /docker-entrypoint-initdb.d/* in name order, once, and only
# while the data volume is empty. This file runs before 20-restore.sh because the dump's
# GRANTs name `fe_owner` and `web_anon`, and roles are cluster-wide objects that pg_dump
# never includes — a restore into a cluster without them fails on the first ACL entry.
#
# The roles and their meaning are defined in sql/postgrest_setup.sql §1; this repeats
# only the CREATEs (same IF NOT EXISTS guards, so 30-secure.sh re-running §1 is a no-op)
# and adds the one thing that file deliberately leaves out: authenticator's password,
# which here comes from the environment instead of being set by hand.

set -euo pipefail

: "${AUTHENTICATOR_PASSWORD:?AUTHENTICATOR_PASSWORD is not set — copy .env.example to .env and fill it in}"

# `:'pw'` is psql's quoted-literal interpolation, so the password never needs escaping
# here. It cannot be used inside a DO block (psql does not interpolate there), which is
# why the ALTER ROLE stands on its own after it.
psql -v ON_ERROR_STOP=1 -q \
     --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
     -v pw="$AUTHENTICATOR_PASSWORD" <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fe_owner') THEN
    CREATE ROLE fe_owner NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'web_anon') THEN
    CREATE ROLE web_anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticator') THEN
    CREATE ROLE authenticator NOINHERIT LOGIN;
  END IF;
END
$$;
ALTER ROLE authenticator PASSWORD :'pw';
SQL

echo "ocpm-init: roles fe_owner, web_anon, authenticator are present"
