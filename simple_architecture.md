# Architecture

A one-page map of the whole tool: what each file is, in one line, and how data reaches the screen.
For *why* the boundaries fall where they do, see `docs/ARCHITECTURE.md`; for the settled design
choices, `docs/DECISIONS.md`.

The tool renders **one sub-log at a time** — a seed object (issue, PR or commit) and the objects
reached by traversing outwards from it — as an object-centric timeline plus a statistics page.
There is no case notion anywhere: the vocabulary is `objectGraph` / `subLog`.

## The pipeline, end to end

```
GH Archive dumps → base tables + 49 upstream views   owned by other researchers, read-only
                            ↓
                   sql/fe_layer.sql                  schema fe (views) + api (one RPC) — mine
                            ↓  api.get_object_graph(repo, seed, traversal_degree)
                   PostgREST  ──(proxied by scripts/serve.mjs at /rpc/*)──►
                            ↓
                   src/data/loadObjectGraph.js       the single data entry point; validates
                            ↓                        and normalizes into an ObjectGraph
                   model → layout → render           DOM-free derivation, then D3 drawing
```

The same `ObjectGraph` shape arrives from local JSON fixtures, so everything above `data/`
cannot tell a fixture from a live payload. That seam is what makes the transport swappable.

## Repository

```
.
├── index.html                   # App shell: markup, CSS, d3 from CDN, one <script type="module">
├── src/                         # The application, as native ES modules (no bundler, no build)
├── sql/fe_layer.sql             # The PostgREST data layer: schema fe + api.get_object_graph
├── scripts/                     # Dev server, fixture builders, acceptance gate, screenshotter
├── tests/                       # node --test suites and tests/fixtures/ (F1–F13, LIVE*)
├── docs/                        # Decisions, data contract, adapter/API spec, verification, OFF_MODE
├── vendor/                      # d3-force 3.0.0, vendored unmodified (no bundler to resolve it)
├── _ds/nocturne-<id>/           # Nocturne design-system CSS tokens — consumed, never restyled
├── screenshots/                 # Read-only visual regression baseline of the superseded mockup
├── ocel-data.json               # The untouched original data blob; F1 is built from it by script
└── package.json                 # start / test / test:watch / build:fixtures — no dependencies
```

## Architecture

```
src/
├── main.js                      # Wiring only: resolve DOM, build collaborators, bind events
├── data/                        # Everything that fetches or reshapes; nothing above it may
│   ├── loadObjectGraph.js       # The sole data entry point — load, validate, normalize
│   ├── source.js                # Fixtures vs database, chosen by ?source=; one shape for both
│   ├── api.js                   # PostgREST transport: the RPC, seed search, repo listing
│   ├── fixtures.js              # Fixture transport: serves a {repo, seed} query from local JSON
│   └── seedQuery.js             # Parses what is typed into "Start from" (#242864, pr #1, a SHA)
├── model/                       # DOM-free derivations over a loaded sub-log
│   ├── objectGraph.js           # Shape validation, normalization, indexing (byId, by object, …)
│   ├── activities.js            # The closed activity vocabulary, object types, lane types
│   ├── evidence.js              # validated / extracted classification and the 16 link methods
│   ├── graph.js                 # Object adjacency and the client-side focus BFS (capped at 2)
│   ├── bursts.js                # Commit bursts, derived from push_id — N of them, or none
│   ├── commentBursts.js         # Runs of comments close together in time; window is a control
│   └── commitGroups.js          # Commits grouped by the PR they reach; membership is a union
├── layout/                      # Pure arithmetic — checkable without a browser
│   ├── engine.js                # createLayout(): THE mode branch — temporal or structural
│   ├── scales.js                # The three timeline modes (real / highlights / ordinal) and x()
│   ├── nodes.js                 # Which nodes exist, in which lane, in what order
│   ├── packing.js               # Sub-lanes for overlapping objects, then glyph collision rows
│   ├── lanes.js                 # Lane geometry: tops, heights, row y — computed after packing
│   ├── anchors.js               # Where a link meets an object it connects to
│   ├── structural.js            # Off mode's model: one node per object, edges, brush maths
│   ├── layered.js               # Off mode, Rows: layers by type, ordered to reduce crossings
│   └── cluster.js               # Off mode, Clusters: balloon seed + d3-force; drag simulation
├── render/                      # D3 and DOM; the only layer allowed to touch either
│   ├── timeline.js              # The render pass: layout (one call) → draw by layout.kind
│   ├── structural.js            # Drawing off mode: edges, marks, hovercards, dragging
│   ├── motion.js                # Off mode's settle + idle drift — presentation, never position
│   ├── nodes.js                 # Lifecycle bars (one per interval), sequence lines, node glyphs
│   ├── links.js                 # Traceability edges; evidence encoded in the stroke
│   ├── axis.js                  # Ticks per mode, collision-aware labels, large-gap annotation
│   ├── minimap.js               # Overview strip: draggable viewport, drag-the-handle to zoom
│   ├── sidebar.js               # Every control that subtracts: lanes, objects, links, actors
│   ├── controls.js              # Preset panel and the non-dismissible hidden-state banner
│   ├── stats.js                 # The statistics page: per-object table, aggregated on demand
│   ├── legend.js                # Legend rows as exported data; dims marks not currently drawn
│   ├── tooltip.js               # Hover cards, right-click to pin, click a row to copy
│   ├── actorCard.js             # Actor profile card: everything one actor did in the sub-log
│   ├── theme.js                 # Colours, shapes and glyphs shared by every renderer
│   ├── format.js                # The one place a timestamp becomes text — all UTC
│   └── message.js               # A page's message surface: why it could not draw anything
├── state/                       # What is visible, and the saved views that configure it
│   ├── state.js                 # The st object plus pure, independent, ANDed visibility predicates
│   ├── presets.js               # Serialize / save / rename / delete / URL-encode a whole view
│   └── labels.js                # Type labels, so state derivation need not import a renderer
└── stats/
    └── metrics.js               # Durations, counts, gaps — pure functions over the visible sub-log
```

## The data layer (`sql/fe_layer.sql`)

Idempotent; re-run it to apply changes (prefer `../ocpm.sh db`, which applies it in the one
order that works).

```
§0  schema fe + api, indexes on the underlying MVs, and their measurements
§1  activity vocabulary and the remap (9 activities)
§2  objects        fe.object_{issue,pull_request,commit,actor}   ids are type-prefixed
§3  intervals      fe.interval_{issue,pull_request}              one row per open period
§4  events         fe.event                                      remap first, whitelist second
§5  links          fe.link  (+ fe.link_mat, the one materialization)
§6  the RPC        api.get_object_graph(repo, seed, traversal_degree)
                   api.search_seeds(), api.list_repos()          what the seed box calls
§7  diagnostics    fe.diag_*  — the drop counts and staleness these views are obliged to report
```

`fe.link_mat` and `fe.seed_lookup` go stale silently after an upstream refresh: run
`SELECT fe.refresh_all()` and check `fe.diag_staleness`.

---

# Data flow

One RPC call builds one sub-log as a single JSON blob; the frontend validates it and draws it.
Nothing is fetched piecemeal.

```
seed (issue/PR/commit) → traverse links N hops → collect objects
                       → attach their events, intervals, links → one JSON → D3
```

## Issues

| step | source | what it gives |
|---|---|---|
| identity | `issues_identity` | `issue_id`, `issue_number`, `issue_created_at` |
| fallback | `mv_issue_and_issuecomment_activities_full` | `min(issue_number)`, `min(activity_timestamp)` grouped by `(repo_id, issue_id)` — for issues opened *before* the data window (11.3% of them) |
| intervals | same activities MV | `IssueOpened` / `IssueReopened` / `IssueClosed` paired into open→close spans (a list, so a reopen is representable) |
| events | same activities MV | every row with an `issue_id` — opens, closes, reopens, comments |

→ `{id: "issue:655615214", type: "issue", label: "#242864", vmap: {issue_number, issue_id}}`

**No title.** Issues carry only the number in the payload; `mv_issues_full` is read solely to
build the seed-search index (`fe.seed_lookup`), not the object.

## Pull requests

| step | source | what it gives |
|---|---|---|
| gate | `mv_pull_request_and_comment_activities_full` | the `(repo_id, pr_number)` pairs that actually have events — stops 3,357 empty lifecycle bars |
| identity | `prs_identity` | `pull_request_id`, `pr_number`, `pr_created_at` |
| fallback | `mv_pull_request_events_full` | `min(event_created_at)` for pre-window PRs |
| attributes | `mv_pull_request_events_full` where `action = 'opened'` | `pr_title`, `head_ref`, `base_ref` |
| intervals | the activities MV | `Opened`/`Reopened` vs `Merged`/`Closed` |
| events | the activities MV, joined on **`(repo_id, pr_number)`** | lifecycle + comments |

→ `{id: "pr:448781946", label: "PR #243221", vmap: {pr_number, pull_request_id, title, head_ref, base_ref}}`

The odd join is a workaround: on comment rows the upstream `pull_request_id` column actually holds
the *issue* id, so joining on it loses 99.99% of comments. Joining on the number loses 6.5%.

## Commits

Only one source: `mv_push_commits_full`.

| step | what it gives |
|---|---|
| identity | one object per distinct `commit_sha`; `min(created_at)` = the first push that carried it |
| attributes | `commit_message`, `commit_author_name`, `commit_author_email`, `ref`, `push_id`, `commit_index` (from that first push's row) |
| events | a synthetic `CommitObserved`, one per commit, plus push facts from `mv_push_activities` — `commit_count`, `distinct_commit_count`, `truncated`, `ref` |
| intervals | none — a commit is an instant, not a span |

→ `{id: "commit:dcc7479…", label: "dcc7479", vmap: {…}}`

**`created_at` is push time, not git author time** — the MV has no author date at all. The
`push_id` is what the frontend groups bursts by.

## Actors

Straight from the `actor` base table (`id`, `login`) — no MV involved. Actors are **not
traversed**; they arrive because some surviving event names them.

## Links (this is what traversal walks)

| branch | source | edge |
|---|---|---|
| A | `mv_issue_to_pr_validated_all` | PR *resolves* issue |
| A2 | `mv_issue_pr_links_extended_conventions` | same, extra parsed conventions |
| B | `mv_commit_pr_links`, narrowed by `fe.commit_pr_link` | PR *contains_commit* / *merge_commit* |
| D | `mv_commit_message_issue_links_all` | commit *references_issue* |

Each link carries `evidence`: **validated** (GitHub asserts it — a SHA match, a `Fixes #N` in the
PR body) or **extracted** (we parsed a convention nothing enforces). Branches B and A2 are where
this project's two admission rules narrow the upstream relation (decisions 62 and 80), which is
why every commit-link and issue↔PR figure is a floor rather than a point estimate.

## The RPC call itself

1. Resolve repo by name → `repo_id`.
2. Check the seed object exists — else raise, rather than returning an empty picture.
3. Walk `fe.link` outward from the seed, `traversal_degree` hops (default 2), treating links as
   undirected → a set of object ids.
4. Pull only those objects, their intervals, their events, and links whose *both* endpoints are
   in the set.
5. Return `{meta, objects[], events[], links[]}`.

## Where it lands on screen

| payload | drawn as |
|---|---|
| object (issue / PR) | a lane row |
| its `intervals` | the lifecycle bar(s) on that row |
| event | a glyph on that row at its timestamp |
| link | an edge between two objects — solid if validated, dashed if extracted |
| `vmap` | tooltip contents |
| actor | sidebar row, actor card, hover trail |

## Scripts

```
scripts/
├── serve.mjs                    # npm start — static server on :8000, proxies /rpc/* to PostgREST
├── rpc-check.mjs                # Acceptance gate: a real RPC payload through the real pipeline
├── pull-sublog.mjs              # Snapshots RPC output to tests/fixtures/LIVE*.json — samples
├── build-f1.mjs                 # ocel-data.json → F1, the regression baseline. --check for drift
├── build-synthetic-fixtures.mjs # F2–F9: one structural property each, never real data
├── build-catalogue.mjs          # Which repos exist and which seeds the fixtures can serve
└── shot.mjs                     # Headless screenshot of the running app, via Edge over WSL
```

## Tests

`npm test` (`node --test`, no config, no dependencies). Suites are per seam and importable in
isolation: `model`, `layout`, `sublanes`, `anchors`, `nodes`, `toggles`, `selection`, `metrics`,
`stats-table`, `legend`, `minimap`, `message`, `timezone`, `api`, `fixtures`, `shell`, and
`verification` — the last stating the thesis's claims as properties over *every* fixture rather
than as spot checks.

Fixtures are `tests/fixtures/F1`–`F13` (labelled, asserted against); `LIVE*.json` are real
snapshots kept only so a real sub-log can be looked at, and nothing asserts on them.
