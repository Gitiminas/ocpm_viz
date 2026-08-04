-- =====================================================================================
-- postgrest_setup.sql — roles, grants and isolation for the HTTP surface
--
-- Run AFTER sql/fe_layer.sql:
--   psql -d gharchive_ocpm_viz_wsl -f sql/fe_layer.sql
--   psql -d gharchive_ocpm_viz_wsl -f sql/postgrest_setup.sql
--
-- Kept separate on purpose. `fe_layer.sql` is the data layer and must stay runnable on
-- its own during development; this file is deployment, and it is the only place that
-- creates roles or hands out privileges. Both are idempotent.
--
-- -------------------------------------------------------------------------------------
-- The three roles, and why there are three rather than two.
--
--   authenticator   LOGIN, NOINHERIT. The only role PostgREST connects as. NOINHERIT is
--                   load-bearing: it means authenticator holds no privilege of its own
--                   and must explicitly SET ROLE to something, so a bug that skips the
--                   role switch fails closed instead of running with everything.
--   web_anon        NOLOGIN. What an unauthenticated request runs as. Its entire
--                   privilege set is: USAGE on schema `api`, EXECUTE on one function.
--   fe_owner        NOLOGIN. Owns schemas `fe` and `api` and everything in them, and is
--                   what the RPC runs as via SECURITY DEFINER.
--
-- The third role is the point of the design. `api.get_object_graph` reads the `fe` views,
-- which read 14 GB of raw event data in `public`. Without SECURITY DEFINER the function
-- executes as the caller, so `web_anon` would need SELECT on all of it — and then the
-- API role can read every raw payload in the database, which is exactly what schema
-- isolation exists to prevent (PostgREST docs, "Schema Isolation" and "Security definer").
--
-- ⚠️ **`fe_owner` is deliberately NOT a superuser and not `minas`.** A SECURITY DEFINER
-- function owned by a superuser and reachable over HTTP is a privilege-escalation surface
-- — any flaw in it executes with full rights. `fe_owner` can read what the layer needs
-- and nothing else, so the blast radius of the RPC is bounded by construction. This is
-- also why `search_path` is pinned on the function below: an unpinned SECURITY DEFINER
-- function can be hijacked by a caller-controlled `search_path`.
-- =====================================================================================

\set ON_ERROR_STOP on

-- -------------------------------------------------------------------------------------
-- §1 — Roles. Created only if absent, so re-running never disturbs a set password.
-- -------------------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fe_owner') THEN
    CREATE ROLE fe_owner NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'web_anon') THEN
    CREATE ROLE web_anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticator') THEN
    -- No password here. `pg_hba` on this machine is peer for local sockets and
    -- scram-sha-256 for 127.0.0.1, and `authenticator` has no OS user — so it must
    -- connect over TCP with a password, which is set out of band and never committed:
    --   ALTER ROLE authenticator LOGIN PASSWORD '<from postgrest.conf>';
    CREATE ROLE authenticator NOINHERIT LOGIN;
  END IF;
END
$$;

-- authenticator can become web_anon, and nothing else.
GRANT web_anon TO authenticator;

-- -------------------------------------------------------------------------------------
-- §2 — What fe_owner may read.
--
-- The `fe` views read the upstream MVs and the `repo` / `actor` base tables. A view's
-- underlying access is checked as the VIEW OWNER, so fe_owner needs SELECT on them —
-- read-only, and nothing else. `CLAUDE.md`'s never-modify-the-upstream rule is untouched:
-- these are grants, which add nothing to what the relations contain.
-- -------------------------------------------------------------------------------------
GRANT USAGE ON SCHEMA public TO fe_owner;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO fe_owner;
-- Covers MVs added by a future upstream refresh without a re-run of this file.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO fe_owner;

-- -------------------------------------------------------------------------------------
-- §3 — fe_owner owns the layer.
--
-- A loop rather than a list of ALTERs, so a view added to `fe_layer.sql` tomorrow is
-- picked up by re-running this file instead of being silently left owned by `minas` —
-- which would quietly re-introduce the superuser-owned SECURITY DEFINER this design
-- exists to avoid.
-- -------------------------------------------------------------------------------------
ALTER SCHEMA fe  OWNER TO fe_owner;
ALTER SCHEMA api OWNER TO fe_owner;

DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.oid::regclass AS rel, c.relkind
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname IN ('fe','api') AND c.relkind IN ('v','m')
  LOOP
    IF r.relkind = 'm' THEN
      EXECUTE format('ALTER MATERIALIZED VIEW %s OWNER TO fe_owner', r.rel);
    ELSE
      EXECUTE format('ALTER VIEW %s OWNER TO fe_owner', r.rel);
    END IF;
  END LOOP;

  FOR r IN
    SELECT p.oid::regprocedure AS fn
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname IN ('fe','api')
  LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO fe_owner', r.fn);
  END LOOP;
END
$$;

-- -------------------------------------------------------------------------------------
-- §4 — The RPC becomes SECURITY DEFINER, with a pinned search_path.
--
-- `SET search_path` is not decoration on a SECURITY DEFINER function: without it a caller
-- can prepend a schema of their own and have the function resolve `repo` or `event` to a
-- table they control. Pinned to exactly the two schemas the body names, plus pg_temp last
-- so a temp table cannot shadow anything.
-- -------------------------------------------------------------------------------------
ALTER FUNCTION api.get_object_graph(text, text, integer)
  SECURITY DEFINER
  SET search_path = fe, public, pg_temp;

-- -------------------------------------------------------------------------------------
-- §5 — What web_anon may do. This is the entire HTTP attack surface.
--
-- PostgreSQL grants EXECUTE on new functions to PUBLIC by default, so the REVOKE is what
-- actually closes the door; the GRANT that follows is what opens it, once, deliberately.
-- -------------------------------------------------------------------------------------
REVOKE ALL ON FUNCTION api.get_object_graph(text, text, integer) FROM PUBLIC;

GRANT USAGE ON SCHEMA api TO web_anon;
GRANT EXECUTE ON FUNCTION api.get_object_graph(text, text, integer) TO web_anon;

-- Belt and braces: web_anon has no reason to reach `fe` or `public` directly, and
-- PostgREST is configured to expose only `api`. Stated rather than assumed.
REVOKE ALL ON SCHEMA fe FROM web_anon, PUBLIC;

-- -------------------------------------------------------------------------------------
-- §6 — Verify, rather than trust. Every row must read `ok`.
-- -------------------------------------------------------------------------------------
SELECT 'authenticator can become web_anon' AS check,
       CASE WHEN pg_has_role('authenticator','web_anon','MEMBER') THEN 'ok' ELSE 'FAIL' END AS result
UNION ALL
SELECT 'web_anon may execute the RPC',
       CASE WHEN has_function_privilege('web_anon','api.get_object_graph(text,text,integer)','EXECUTE')
            THEN 'ok' ELSE 'FAIL' END
UNION ALL
SELECT 'RPC is SECURITY DEFINER',
       CASE WHEN (SELECT prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                  WHERE n.nspname='api' AND p.proname='get_object_graph') THEN 'ok' ELSE 'FAIL' END
UNION ALL
SELECT 'RPC search_path is pinned',
       CASE WHEN (SELECT proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                  WHERE n.nspname='api' AND p.proname='get_object_graph') IS NOT NULL
            THEN 'ok' ELSE 'FAIL' END
UNION ALL
SELECT 'RPC owner is not a superuser',
       CASE WHEN NOT (SELECT r.rolsuper FROM pg_proc p
                      JOIN pg_namespace n ON n.oid=p.pronamespace
                      JOIN pg_roles r ON r.oid=p.proowner
                      WHERE n.nspname='api' AND p.proname='get_object_graph')
            THEN 'ok' ELSE 'FAIL' END
UNION ALL
SELECT 'web_anon cannot read raw events',
       CASE WHEN NOT has_table_privilege('web_anon','public.event','SELECT')
            THEN 'ok' ELSE 'FAIL' END
UNION ALL
SELECT 'web_anon cannot reach the fe schema',
       CASE WHEN NOT has_schema_privilege('web_anon','fe','USAGE') THEN 'ok' ELSE 'FAIL' END;
