# Project instructions

The tool draws a GitHub repository's issue → pull request → commit history as an object-centric
sub-log: issues, pull requests, commits and actors keep their own identity, and every link carries
the evidence behind it.

It is a general, configurable tool, not one tuned to a fixed question list. Every lane, object
type, link type and relationship class toggles independently; configurations are nameable and
saveable. **The stack is fixed:** PostgreSQL → PostgREST → D3.

Others maintain this code. Modularity, clear seams, tests and readable structure are requirements,
not polish. Explain non-obvious choices briefly; a subtle rendering bug is not caught by reading a
diff, so verification matters more than usual.

## Documents

| Doc | What it is |
|---|---|
| `README.md` | Human entry point: run it, test it, extend it. Keep current |
| `docs/ARCHITECTURE.md` | The frontend: folders, seams, data flow, layout traps |
| `docs/DATA_LAYER.md` | Schemas `fe` and `api`, the four RPCs, the `ObjectGraph` and DFG payloads, the adapters |
| `docs/DATA_CONTRACT.md` | The written record of what exists upstream. The database itself is ground truth |
| `docs/VERIFICATION.md` | What was checked and how. §5 is the not-verified list — read it before trusting a figure |

## Repository map

| Path | What | Rules |
|---|---|---|
| `index.html` | App shell: markup, CSS, the one `<script type="module">` entry | Work here for anything structural in the page |
| `src/` | The application, as ES modules | Work here. Keep `model/`, `layout/`, `state/` and `stats/` DOM-free |
| `sql/fe_layer.sql` | The data layer: schema `fe` (19 views/MVs + 8 diagnostics) and the four `api` RPCs. Idempotent | Work here for anything about payload content. Read its header first — every convention listed there is a defect someone already shipped. `sql/postgrest_setup.sql` (roles, grants, verification query) is applied after it, never before |
| `scripts/rpc-check.mjs`, `dfg-check.mjs` | Acceptance gates: a real payload through the real loader and layout, then one unauthenticated call as `web_anon` | Run both after any change to `sql/`. The validators must return `[]`. The HTTP probes skip if PostgREST is down |
| `scripts/pull-sublog.mjs`, `pull-dfg.mjs` | Snapshot RPC output to `tests/fixtures/LIVE*.json` / `DFG1.json` | Samples, not fixtures — no test asserts a count against them |
| `scripts/shot.mjs` | Headless screenshot of the running app | Writes to `.shots/`, gitignored. Headless lays out ~90px shorter than `--window-size`: compare fill between shots, not against the box |
| `scripts/build-f1.mjs`, `build-synthetic-fixtures.mjs`, `build-catalogue.mjs` | Build the fixtures and the seed catalogue | Re-runnable. `--check` fails when a committed file is stale |
| `scripts/serve.mjs` | Zero-dependency static server and `/rpc/*` proxy (`npm start`) | Needed: ES modules and `fetch` are blocked on `file://` |
| `vendor/d3-force.js` | d3-force 3.0.0, ISC, unmodified | Never edit. Replace whole from the esm.sh bundled build, and re-read `vendor/README.md` |
| `tests/` | `node --test` suites plus `tests/fixtures/` | `npm test`. See `tests/fixtures/README.md` |
| `./ocpm.sh` | Clean start, and `./ocpm.sh db` to apply the data layer | Prefer `db` over running the SQL by hand: `fe_layer.sql` resets the `api` functions to `SECURITY INVOKER`, and the materializations go stale silently |
| `_ds/nocturne-*/` | Design system CSS tokens | Consume via `var(--token)`. Do not restyle |
| `ocel-data.json` | The untouched original data blob | **Never edit.** F1 is built from it by script |

**Running it:** `npm start`, then `http://localhost:8000`.

## Hard rules

- **The database and the code are ground truth; the docs are a record, and records go stale.**
  Trust the database when you have queried it, then the code when you have read or run it, then the
  documentation. A document that contradicts a verified fact is wrong: correct the document, dated,
  with what you observed. Never bend a query, a module or a payload to fit prose.
  - **This licenses nothing.** "Reality wins" applies to what has been *observed* — a `\d+`, a
    `pg_views` row, a query that ran, a test that passed — never to what would be convenient. The
    rule against inventing data is unconditional.
  - **A pointer to something gone is a stale pointer. Fix the pointer.** The working tree is the
    source of truth: a deleted file is meant to be gone, so never restore it, resurrect it from
    history, or rewrite it from a description that still cites it. The fix is on the document.
- **There is no "case".** OCPM removes the case notion: an event relates to several objects, none
  privileged. Never use `case` in names, comments, SQL or UI labels; the vocabulary is
  `objectGraph` / `subLog` and the RPC is `get_object_graph`.
- **Never modify the shared upstream's data or definitions.** No `UPDATE`, `DELETE`, `DROP`,
  `TRUNCATE`, no refreshes, no altering a view. The relations are shared and read-only. Indexes on
  them are the exception: they belong to this project, and `sql/fe_layer.sql` §0 creates 19 with
  measurements. Announce an index rather than adding it quietly, and check `pg_class.reltuples` is
  not `-1`: a non-owner `ANALYZE` reports success while skipping.
- **Out of scope, do not wire them in.** The `ocel_*` views, bot classification, OCEL 2.0 tables,
  labels, forks, reviews, review comments, and branch and ref lifecycle.
- **Never fabricate data.** No placeholder rows, no `Math.random()`, no mock UI. Fixtures live in
  `tests/fixtures/` and are labelled. If data is missing, say so and stop.
- **Never change event-log semantics without asking**: object types, activity vocabulary,
  qualifiers and evidence classification are modelling decisions, not implementation details.
- **The word is `extracted`, never `inferred`.** Two evidence classes: `validated`, `extracted`.
- **The word is `landmark`, never `milestone`.** Three landmarks: `IssueClosed`,
  `PullRequestMerged`, and `PullRequestMergedOffPlatform`, which is *heuristic*: labelled "Merge (off-platform)", its own PR outcome rather than an unmerged close, with a dotted
  ring in the extracted colour. `milestone` survives only when quoting an upstream column.
- **All times UTC**, parsed, rendered and labelled as such.
- **Object types are closed at four:** `issue`, `pull_request`, `commit`, `actor`.
  `repo` is **not** an object — a partition key upstream, carried once as `meta.repo`/`meta.repo_id`.

## Conventions

- **Metrics are computed in JS over `selectVisible(...)`** so they follow the toggles.
  SQL is only for figures spanning data that is not loaded, such as link coverage per repository.
  Precomputing them there would silently answer "comments hidden → gaps unchanged".
- Derived relations live in **this project's own schemas**, never the shared namespace: `fe` for
  the views, `api` for the RPCs. Plain `VIEW` by default; three materializations, each with its
  measurement beside it — `fe.link_mat`, because the traversal needs a whole repository's adjacency,
  `fe.seed_lookup` behind the seed box, and `fe.dfg_mat`, the whole-log process map. **All three
  go stale silently: run `SELECT fe.refresh_all()` after any upstream refresh**, and read
  `fe.diag_staleness` for last-written times.
- **Two admission rules belong to this project, not upstream**; both narrow `ref_match`.
  Every commit-link and issue↔PR figure is therefore a **floor**, never a point
  estimate. Say so.
- Identity is by numeric id, never `login` or repo `name` — both are renameable. Object ids are
  **type-prefixed**: `issue:<issue_id>`, `pr:<pull_request_id>`, `commit:<sha>`,
  `actor:<actor_id>`; the bare numbers collide across types. Two exceptions remain. A repo is
  addressed by **name**, because `repo.name` is not unique here: it resolves to the id with the most
  events, carried as `meta.repo_id`, with `meta.repo_ambiguous` when more than one row bore it. And
  `actor:<login>` survives **in the fixtures only**: `ocel-data.json` has no numeric actor id, while
  the live payload is already `actor:<actor_id>`.
- **Modularity is a hard requirement.** Data access, layout, rendering and stats stay separable.
  `loadObjectGraph(query) -> ObjectGraph` and `loadDfg(query) -> DFG` are the only data entry points.
- No bundler, framework or TypeScript. Native ES modules need no build step.
- **Tests run with `npm test`** (`node --test`); `npm run test:watch` to watch. Files are
  `tests/*.test.js` and discovery is automatic, so do not pass a path.
- Every module must be importable and testable in isolation. If a function can only be exercised by
  rendering the whole app, the seam is wrong.
- Extend `st` and the toggle vocabulary from `deriveRelGroups()` (`src/state/state.js`) rather than
  inventing parallel mechanisms. Never reintroduce a hardcoded relationship-group enumeration.
- **Every control, row and mark gets a help text.** Controls carry `data-tip="<key>"`,
  marks carry `data-legend` mapping to `legend.<key>`; the texts are the table in `src/help/tips.js`,
  and `tests/tips.test.js` fails when a key has no text or a text has no key. No `title=` tooltips,
  except the two native ones that say why a row is inert (a dimmed legend row, a disabled repository).
- Two notions of degree, kept named apart: **traversal degree** (server-side, what is *in* the
  sub-log) and **focus degree** (client-side BFS, what is *highlighted*).

## Working style

- New work comes from what is asked for.
- If something is ambiguous and the docs do not cover it, **ask instead of guessing.**
  A wrong guess baked into layout is expensive to unwind and hard to detect by reading a diff.
- **Flag every place you guessed** rather than silently choosing.
- Record any new design choice in the doc that owns the area (ARCHITECTURE, DATA_LAYER or
  DATA_CONTRACT).
