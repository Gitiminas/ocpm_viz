# Project instructions

Master's thesis prototype: **"Visualizing Issue-to-Merge Processes using Object-Centric Event
Logs."** Design Science Research.

- **RQ1** How can OCPM data from GitHub issue-to-merge workflows be visualized to improve
  traceability of related issues, pull requests, and commits?
- **RQ2** What workflow patterns and differences appear across selected repositories?

Evaluated by Cognitive Dimensions of Notations + a task-based evaluation against PM4Py / OC-PM,
using the WP1 task catalogue (Q1–Q10) and shortcomings (S1–S11).

What exists: a working D3 timeline rendering **one hardcoded sub-log** (vscode issue #242864 →
PR #243221 → its commits). It looks right but is structurally overfit. The job is to generalize it.

**Design philosophy:** a general, configurable tool, not one tuned to a fixed question list. Every
lane, object type, link type and relationship class independently toggleable; configurations
nameable and saveable. Q1–Q10 are a check on whether it works, not a spec.

**Software engineering quality is graded, and the tool will be maintained by others after this
thesis.** Modularity, clear seams, tests and readable structure are deliverables, not polish. The
file format is free — `.dc.html`, plain HTML, ES modules, whatever serves this best. The **stack is
fixed**: PostgreSQL → PostgREST → D3.js.

**I am not experienced with D3.js or API development.** Explain non-obvious choices briefly. I will
not catch a subtle rendering bug by reading a diff — verification matters more than usual.

**Timebox:** ~5–6 working days inside a 12-day window. Smallest correct, defensible change.

## Documents

| Doc | What it is | Authority |
|---|---|---|
| `docs/DECISIONS.md` | Settled decisions + open questions | **Binding.** Read first. |
| `docs/DATA_CONTRACT.md` | What exists upstream: 4 base tables + 49 views (22 in scope, 27 excluded) | **The authoritative *record* — the database itself is ground truth.** Check the snapshot date: the 2026-08-04 revision added 17 relations the previous one never named. |
| `docs/DATA_REQUIREMENTS.md` | Every field the visualization needs, by entity | Requirements side |
| `docs/ADAPTER_AND_API.md` | The layer I build; `ObjectGraph` contract; evidence mapping | Binding |
| `docs/ARCHITECTURE.md` | Layers, seams, OCPM implications for the renderer | Intent |
| `docs/MOCKUP_OVERVIEW.md` | The **superseded** mockup, described | **Historical.** Not maintained; describes deleted code |
| `docs/VERIFICATION.md` | What was checked, how, and what was not | Task 6 output; §3b covers the data layer. **Read §4 before trusting any figure** |
| `docs/LINK_FANNING.md` | Why link fanning exists, how it broke on real data, and what it does now | Worked example of a defect no test could catch |
| `docs/COMMIT_PR_NARROWING.md` | Which commits count as a pull request's, why the rule changed, and what it costs | Decision 80. Read before quoting any commit-link figure |
| `docs/RELATIONSHIPS_MODE.md` | The structural (`relationships`) time mode: how to see it, where it lives, known weak points, and the traps its construction paid for | Field notes. Decisions are 95–109 in `DECISIONS.md`; read §5 before touching `layout/cluster.js` or `layout/layered.js` |
| `README.md` | Human entry point: run, test, extend | Keep current |
| `docs/ONBOARDING.md` | Reading path: what to read, in what order, and what to skip | Orientation |
| ~~`tasks/*.md`~~ | Was one file per work package. **Deleted in `a1e2a9c` and staying deleted.** Work packages 00–06 are complete | Gone — do not restore |

## Repository map

| Path | What | Rules |
|---|---|---|
| `index.html` | The app shell: markup, CSS, and the one `<script type="module">` entry | **Work here** for anything structural in the page |
| `src/` | The application, as ES modules. Structure and rationale in `ARCHITECTURE.md` | **Work here.** Keep `model/`, `layout/` and `stats/` DOM-free |
| `sql/fe_layer.sql` | **The PostgREST data layer**: schema `fe` (8 views + 7 diagnostics) and `api.get_object_graph`. Idempotent — re-run it to apply changes | **Work here** for anything about what the payload contains. Read its header before editing: the load-bearing conventions are listed there, and each one is a defect someone already shipped |
| `scripts/rpc-check.mjs` | Acceptance gate: a real RPC payload through `loadObjectGraph`, then the real layout pipeline, then one unauthenticated HTTP call as `web_anon` | Run after any change to `sql/fe_layer.sql`. `findGraphProblems()` must return `[]`. The HTTP probe skips if PostgREST is down |
| `scripts/pull-sublog.mjs` | Snapshots RPC output to `tests/fixtures/LIVE*.json` so a real sub-log can be rendered | These are **samples, not fixtures** — nothing asserts against them |
| `scripts/shot.mjs` | Headless screenshot of the running app, via Edge over WSL interop. Flags for mode, layout, repo/seed/degree, width/height | Writes to `.shots/` (gitignored). **Never to `screenshots/`** — that baseline stays read-only. ⚠️ Headless lays out ~90px shorter than `--window-size`; compare fill between shots, not against the box |
| `vendor/d3-force.js` | d3-force 3.0.0, ISC, unmodified (decision 104) | Never edit; replace whole from the esm.sh bundled build, and re-read `vendor/README.md` |
| `scripts/build-f1.mjs` | Builds `tests/fixtures/F1.json` from `ocel-data.json` | Re-runnable. `--check` fails if the committed fixture is stale |
| `scripts/serve.mjs` | Zero-dependency static server (`npm start`) | Needed because ES modules and `fetch` are blocked on `file://` |
| `../ocpm.sh` | Outside the repo. Clean start (`./ocpm.sh`), and `./ocpm.sh db` to apply the data layer in the one order that works | Prefer `db` over running the SQL by hand — `fe_layer.sql` resets the api functions to `SECURITY INVOKER` and `fe.link_mat` goes stale silently |
| `tests/` | `node --test` suites plus `tests/fixtures/` | Run with `npm test`. See `tests/fixtures/README.md` |
| `_ds/nocturne-*/` | Design system CSS tokens | Consume via `var(--token)`. Don't restyle |
| `ocel-data.json` | The untouched original data blob (hyphen — confirmed in Task 0) | **Never edit.** F1 is built from it by script |
| `screenshots/` | Pre-change reference renders of the original app | **Visual regression baseline. Read-only — never regenerate or overwrite.** Inventory in `screenshots/README.md` |
| `.thumbnail` | Claude Design artifact | Ignore |

The superseded mockup (`OCEL Timeline.dc.html`) and its `support.js` runtime were deleted once
Task 6 signed off, as this table previously mandated. `docs/MOCKUP_OVERVIEW.md` remains as the
written record of what they contained; `screenshots/` remains as the visual baseline.

**Running it:** `npm start`, then open `http://localhost:8000`. Opening `index.html` from disk
does not work — browsers block both ES modules and `fetch` on `file://` origins.

## Hard rules

- **The database and the code are ground truth. The docs are a record of them, and records go
  stale.** This governs how to read every other rule here. When wiring the tool to the database —
  which views exist, what columns they have, what a module actually does — trust in this order:
  **(1) the database, when you have queried it; (2) the code, when you have read or run it;
  (3) the documentation.** A document that contradicts a verified fact is wrong. Correct the
  document, dated, with what you observed; never bend a query, a module or a payload to match
  prose. `DATA_CONTRACT.md` is the worked example: it called itself *the authoritative list of what
  exists* while omitting 17 relations — including two views that are probably derivations
  `ADAPTER_AND_API.md` instructed me to build from scratch.
  - **This licenses nothing.** "Reality wins" applies to what has been *observed* — a `\d+`, a
    `pg_views` row, a query that ran, a test that passed. It never applies to what would be
    convenient. Do not assume a view exists; go and look, then write down what you found. The rule
    against inventing data is unchanged and unconditional.
  - **A pointer to something that is gone is a stale pointer. Fix the pointer.** The working tree is
    the source of truth: if a file was deleted it is meant to be gone, and it is not to be restored,
    resurrected from history, or rewritten from the description that still refers to it —
    reconstructing content from a citation is fabrication wearing a citation. `sql/rq2_link_coverage.sql`
    and `tasks/*.md` were deleted in `a1e2a9c`; `docs/EXAMPLE.md` and `docs/DATABASE.md`, both cited
    by `ONBOARDING.md`, were never committed at all. Either way the action is the same and it is on
    the document, never on the tree. History is worth a look only to know *which* of those two cases
    you are in, so the correction can say so.

- **There is no "case".** OCPM removes the case notion; an event relates to several objects and none
  is privileged. Never use `case` in variable names, function names, comments, SQL or UI labels.
  The vocabulary is `objectGraph` / `subLog`. The RPC is `get_object_graph`, never `get_case`.
  The existing data blob and UI still say "case" — that is a defect to fix, not a precedent.
- **`docs/DATA_CONTRACT.md` is the written record of what exists**, subject to the precedence rule
  above. Do not invent views. Do not assume a view exists because it would be convenient. Where the
  database and the contract disagree, the database wins *and the contract gets fixed in the same
  breath* — a divergence noticed and left unrecorded is how it grew to 17 relations. Anything not
  upstream, I build in my own schema.
- **Never modify the shared upstream.** The base tables and every view are owned by other researchers
  (a PhD student is building real OCEL tables; another MSc student is building bot classification).
  Read-only. No `UPDATE`/`DELETE`/`DROP`/`TRUNCATE`, no refreshes, no altering their definitions.
  **This includes indexes.** `CREATE INDEX` requires ownership of the relation, so any index on an
  upstream view is a request to its owner, not a task — see `DATA_CONTRACT.md` §2 and open
  question O9.
- **Do not build other people's theses.** Bot/human classification, OCEL 2.0 tables, labels, forks,
  reviews, review comments, branch/ref lifecycle — all out of scope.
- **Never fabricate data.** No placeholder rows, no `Math.random()`, no mock UI. Fixtures live in
  `tests/fixtures/` and are labelled. If data is missing, say so and stop.
- **Never change event-log semantics without asking** — object types, activity vocabulary,
  qualifiers, evidence classification. These are research decisions, not implementation details.
- **The word is `extracted`, not `inferred`.** Two evidence classes only: `validated` and
  `extracted`. `inferred` is retired vocabulary — replace it in data, constants, comments and UI.
- **The word is `landmark`, not `milestone`** (decision 38). The emphasised terminal activities —
  `IssueClosed` and `PullRequestMerged` — are landmarks (decision 48 removed the third,
  `PullRequestMergedOffPlatform`; do not reintroduce it). `milestone` is
  GitHub's own feature and survives here **only** when quoting an upstream column
  (`milestone_id` / `milestone_number` / `milestone_title` on `mv_issues_full`). Never introduce it
  as our own term. Historical records — `screenshots/README.md`, `MOCKUP_OVERVIEW.md`, `tasks/*.md` —
  keep the old word on purpose, because they describe artifacts that say it.
- **All times UTC**, parsed and rendered, labelled as such.
- **Object types are closed at four:** `issue`, `pull_request`, `commit`, `actor` (decision 39).
  `repo` is **not** an object — it is the frame the sub-log is drawn inside, carried once as
  `meta.repo` / `meta.repo_id`. Upstream it is a partition key, never a participant: nothing
  attaches an activity to it and no link reaches it.

## Conventions

- **Metrics are computed in JS over the loaded sub-log** (decision 12) — durations, counts, gaps —
  so they respond to toggles. SQL is only for figures spanning data that is *not* loaded, such as
  per-repo link coverage for RQ2. Precomputing sub-log metrics in SQL would answer "comments hidden
  → gaps unchanged" silently, which is the failure decision 12 exists to prevent.
- My derived views live in **my own schema**, never in the shared namespace. Plain `VIEW` by default;
  `MATERIALIZED VIEW` only where a measured query justifies it (see `docs/ADAPTER_AND_API.md`).
  Built as `sql/fe_layer.sql`: schema `fe` for the views, `api` for the one RPC. Exactly one
  materialization, `fe.link_mat`, with its measurement beside it. **Re-run `SELECT fe.refresh_links()`
  after any upstream refresh** — it goes stale silently, and `fe.diag_link_staleness` is what tells you.
- **Two admission rules are ours, not upstream's** (decisions 62 and 80 — 80 replaced 61), and they are the only places
  this project diverges from the shared views. Both narrow `ref_match`. Every commit-link and
  issue↔PR figure is therefore a **floor**, never a point estimate — say so wherever one is quoted.
- Identity by numeric id, never by `login` or repo `name` — both are renameable. Object ids are
  **type-prefixed** (decision 51): `issue:<issue_id>`, `pr:<pull_request_id>`, `commit:<sha>`,
  `actor:<actor_id>`. The prefix is not decoration — the bare numbers collide across types.
  **Two exceptions remain, and they have shrunk (updated 2026-08-16):**
  - The query still addresses a **repo by name**, because `repo.name` is not unique in this
    database: it resolves deterministically to the id with the most events, carried as
    `meta.repo_id`, with a `meta.repo_ambiguous` flag when more than one row bore the name.
    (Decision 51 spells the flag `meta.repo_id`; the RPC emits both — `sql/fe_layer.sql:1337`.)
  - `actor:<login>` survives **in the fixtures only**. `ocel-data.json` — the frozen blob F1 is
    built from — carries no numeric actor id, so `build-f1.mjs` keys on the login and the
    synthetic fixtures follow it. The RPC has landed and `fe.object_actor` reads `actor.id` from
    the base table (decision 58), so the live payload is already `actor:<actor_id>`. This entry
    previously said both exceptions were "blocked on the RPC" and would expire when it landed;
    half of that has happened. A renamed account still splits into two actors across a
    re-extraction **of the fixtures**; note it if fixture actor counts are reported.
- **Modularity is a hard requirement.** Data access, layout, rendering and stats stay separable.
  `loadObjectGraph(query) -> ObjectGraph` is the only data entry point.
- No bundler, framework or TypeScript. A test runner is required; native ES modules need no build
  step, so neither is a bundler.
- **Tests run with `npm test`** (`node --test`, Node's built-in runner — no dependencies, no config,
  native ES modules). `npm run test:watch` for a watch loop. Test files are `tests/*.test.js`;
  discovery is automatic, so do not pass a path. Node is installed user-local at `~/.local/node`
  and is on `PATH` via `~/.bashrc` and `~/.profile`; `package.json` sets `"type": "module"`.
- Every module must be importable and testable in isolation. If a function can only be exercised by
  rendering the whole app, the seam is in the wrong place.
- Extend the existing `st` state object and the derived toggle vocabulary from
  `deriveRelGroups()` (`src/state/state.js`) rather than inventing parallel mechanisms. Do not
  reintroduce a hardcoded relationship-group enumeration — `deriveRelGroups` replaced one.
- **Every control, row and mark gets a help text.** Controls carry `data-tip="<key>"`
  (marks already carry `data-legend`, which maps to `legend.<key>`); the texts are the
  table in `src/help/tips.js`, written plainly, and `tests/tips.test.js` fails when a key
  has no text or a text has no key. No browser `title=` tooltips beside a tip (decision 122).
- Two distinct notions of degree — keep them named apart: **traversal degree** (server-side, what is
  *in* the sub-log) vs **focus degree** (client-side BFS, what is *highlighted*).

## Working style

- Work packages `tasks/00`–`06` are done and their files are no longer in the tree (see above).
  New work comes from `DECISIONS.md` §2 and from what I ask for — not from a task file.
- If a fixture reveals an ambiguity the settled decisions don't cover, **ask instead of guessing.**
  A wrong guess baked into layout is expensive to unwind and hard for me to detect.
- **Flag every place you guessed** rather than silently choosing.
- Extract modules deliberately — structure is graded and future students inherit this code. But
  correctness first: a clean architecture that still assumes one issue is a failure.
- Record any new design choice in `docs/DECISIONS.md` — it is thesis material, not bookkeeping.
