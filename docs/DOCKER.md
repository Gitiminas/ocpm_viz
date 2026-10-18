# Running the tool with Docker

The same stack `./ocpm.sh` starts on the host — PostgreSQL → PostgREST → the app server —
as three compose services, with the data supplied separately as a database dump. Nothing
here replaces the host workflow; both run side by side on different ports.

```
cp .env.example .env              # fill in two passwords and OCPM_DUMP_DIR
docker compose up -d              # the first start restores the dump (slow, once)
docker compose logs -f db         # watch the restore; "ocpm-init: done" ends it
scripts/docker-smoke.sh           # end-to-end check, including the acceptance gates
```

Then open `http://localhost:8000/?source=database`.

## The four parts

| Part | What | Where it is defined |
|---|---|---|
| `db` | `postgres:18`. Restores the dump on first start, then serves it | `compose.yaml`, `docker/db/initdb/` |
| `api` | `postgrest/postgrest:v14.16`, serving schema `api` as `web_anon` | `compose.yaml` |
| `web` | The app's static files and the `/rpc/*` proxy, `scripts/serve.mjs` on `node:24-alpine` | `docker/web/Dockerfile` |
| the data | A directory-format `pg_dump`, mounted read-only into `db` at `/dump`. Not in git | `OCPM_DUMP_DIR` in `.env` |

The database lives in the named volume `ocpm-viz_pgdata`. `docker compose down` keeps it;
`docker compose down -v` deletes it, and the next `up` restores from the dump again.

Two networks keep the layers apart: `backend` holds `db` and `api`, `frontend` holds `api` and
`web`. The web container cannot open a connection to the database — the network-level twin of
the role design in `sql/postgrest_setup.sql`, and `scripts/docker-smoke.sh` checks it holds.

Every port is published on `127.0.0.1` only:

| Port (default) | Service | Why it is published |
|---|---|---|
| `8000` | web | The app |
| `3001` | api | The acceptance gates' unauthenticated probe. 3001 so a host PostgREST can keep 3000 |
| `5433` | db | `psql` for the gates and for inspection. 5433 so a host PostgreSQL can keep 5432 |

## The data: making and supplying a dump

The corpus is not part of the repository. A dump of a database that has the upstream tables
and views and the `fe`/`api` layer applied (`./ocpm.sh db` on the host) is made with:

```
pg_dump -d gharchive_ocpm_viz_wsl -Fd -j 4 -f <dir>
chmod a+rx <dir> && chmod a+r <dir>/*
```

`-Fd` (directory format) is what `20-restore.sh` expects, and what lets both sides run in
parallel. The `chmod` matters: `pg_dump -Fd` creates the directory `0700`, and the container's
`postgres` user cannot read it — the restore then stops with that remedy.

Point `OCPM_DUMP_DIR` in `.env` at the directory, or put it at `./dump` (gitignored).

## First start: the three init steps

The postgres image runs `docker/db/initdb/*` in name order, once, on an empty volume.

1. **`10-roles.sh`** creates `fe_owner`, `web_anon` and `authenticator` and sets
   authenticator's password from `.env`. Roles are cluster-wide, so `pg_dump` never includes
   them, and the dump's `GRANT`s fail without them.
2. **`20-restore.sh`** runs `pg_restore --no-owner` with `OCPM_RESTORE_JOBS` jobs. The data
   loads, then the 31 materialized views are refreshed; that is most of the time. Measured
   2026-10-18 with 8 jobs on a 16-thread WSL machine: 46 and 90 minutes on two runs. Later
   starts reuse the volume and are healthy in under 20 s.
3. **`30-secure.sh`** re-runs `sql/postgrest_setup.sql`, fails on any `FAIL` row of its §6
   checks, requires `fe.diag_sanity` to be clean, and writes the completion marker.

Two traps, each handled in the scripts and explained in their headers:

- ⚠️ **`--no-owner` makes the superuser own the `api` functions**, which are `SECURITY
  DEFINER` — exactly what `postgrest_setup.sql` exists to prevent. Step 3 hands them back to
  `fe_owner`. The restore also drops the dump's two `ALTER DEFAULT PRIVILEGES FOR ROLE <host
  owner>` entries, which `--no-owner` does not touch and which fail outright; step 3 issues the
  equivalent defaults.
- ⚠️ **A failed init leaves a non-empty volume, and the next start skips init.** Postgres
  would then come up "ready" over half a database. The db healthcheck therefore requires the
  marker step 3 writes last (`$PGDATA/ocpm-init.done`) as well as `pg_isready` — over TCP,
  because during init the entrypoint's temporary server listens on its socket only. A failed
  init stays `unhealthy`, `api` and `web` never start, and the fix is to read
  `docker compose logs db`, correct the cause, and `docker compose down -v && docker compose up -d`.

## TimeZone

⚠️ **The restored copy only matches its source when both servers have the same `TimeZone`.**
Observed 2026-10-18: the first container restore ran in the image's default `Etc/UTC` against
a dump of a host cluster set to `Europe/Berlin`. Every base table matched row for row, and six
upstream materialized views did not — `mv_issue_pr_links_proximity` held 7,433 rows against
the host's 1,457, and `fe.link_mat` 81,810 against 193,248. The cause is in the upstream view
definitions: they cast naive `timestamp` columns with `::timestamp with time zone`, which reads
the session `TimeZone`, so the refresh during the restore computes different time windows.
Evaluating the proximity definition in the container under each setting reproduced both counts
exactly (UTC 7,433, Europe/Berlin 1,457).

So `compose.yaml` passes `-c timezone=${OCPM_DB_TIMEZONE}` to the server, defaulting to the
source cluster's `Europe/Berlin`. It applies to the restore and to every request afterwards —
unmaterialized `fe` views run the same casts at request time. With a dump from another cluster,
set it to that cluster's `SHOW timezone` *before* the first start; changing it later needs a
re-restore (`down -v`), because the materialized views keep what they were refreshed with.

This records how the upstream behaves; it does not say which setting is semantically right for
timestamps that are UTC (`CLAUDE.md`: all times UTC). That is an upstream-definition question,
and those definitions are not changed from here.

`scripts/db-parity.sh` is the check that catches this class of problem: it compares the row
count of every table and materialized view in `public` and `fe`, and the `TimeZone`, between
the source database and the restored one.

```
PGPASSWORD=<POSTGRES_PASSWORD> scripts/db-parity.sh "dbname=gharchive_ocpm_viz_wsl" \
    "host=127.0.0.1 port=5433 user=postgres dbname=gharchive_ocpm_viz_wsl"
```

What parity does **not** promise: array order inside a payload. After the timezone fix, the
container's `api.list_repos` and `api.get_sublog` output was byte-identical to the host's, and
`api.get_dfg('microsoft/vscode')` was equal once arrays were compared as sets — same nodes,
edges and figures (`dfg-check.mjs`: 11 nodes, 38+217 edges on both), different element order.
The function's aggregates do not specify an order, and a restore lays rows out afresh.

## Startup order

`api` starts when `db` is healthy, `web` when `api` is (PostgREST's own `--ready` check,
against its unpublished admin port 3002). So the app is never served over a database that is
still restoring.

## Checking it

| Check | Needs | What it proves |
|---|---|---|
| `npm test` → `tests/docker-config.test.js` | Nothing but node | The files agree: every `${VAR}` compose reads is in `.env.example` and nothing stale is, no literal password, ports on `127.0.0.1` only, `.env` and `dump/` ignored, init steps ordered and executable, the healthcheck's marker is the one step 3 writes, every `COPY` source exists and is admitted by `.dockerignore` |
| `scripts/docker-smoke.sh` | A running stack; `curl`, `node` and `psql` on the host | All three services healthy, static files served, `/rpc/list_repos` through the proxy returns repositories, web cannot reach db, and `rpc-check.mjs` and `dfg-check.mjs` pass against the container database |
| `scripts/db-parity.sh` | The source database too | The restore reproduced the source: equal row counts for every table and materialized view in `public` and `fe`, and equal `TimeZone`. The smoke test cannot see this — it passed on the UTC restore above |

## Changing things

- **After changing `sql/fe_layer.sql`**: the container database is a restored copy, so apply
  it there as `./ocpm.sh db` does on the host — `fe_layer.sql`, then `postgrest_setup.sql`,
  then the refreshes — with `psql -h 127.0.0.1 -p 5433 -U postgres -d gharchive_ocpm_viz_wsl`,
  then `docker compose restart api` (PostgREST caches the schema). Or make a new dump and
  restore from scratch.
- **After changing the app** (`index.html`, `src/`, …): `docker compose up -d --build web`. The
  image holds a copy of the files; there is no live mount.
- **A file the app newly needs at runtime** goes into both `.dockerignore` (`!path`) and
  `docker/web/Dockerfile` (`COPY`); the config test fails on a `COPY` the allowlist does not
  admit, which would otherwise surface only as a build error.
