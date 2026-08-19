# Visualizing issue-to-merge processes with object-centric event logs

An interactive timeline for GitHub issue → pull request → commit workflows, built on
**object-centric process mining** (OCPM). A master's thesis prototype, and the
artifact its evaluation runs against.

Instead of flattening history into one case per issue, the tool shows objects —
issues, pull requests, commits — on their own lanes, with the links between them
graded by how much the evidence for each link is worth.

```
npm start        # then open http://localhost:8000
npm test         # 478 assertions, no browser needed
```

> Opening `index.html` from disk will not work. Browsers block both ES modules and
> `fetch()` on `file://` origins, so the app needs an http origin. `npm start` runs a
> ~40-line dependency-free server; nothing is bundled or compiled.

Requires Node 20+. There are **no dependencies** — no bundler, no framework, no
TypeScript, no test library. D3 is loaded from a CDN by `index.html`.

---

## How you select what to look at

Two fields, in this order:

1. **Repo** — the repository to work in.
2. **Start from** — search for the object to seed from. Type `242864`, `#242864`,
   `issue 242864`, `PR #243221`, a commit SHA prefix like `dcc7479`, or just `pr` to narrow
   by type. A commit, a PR, an issue: any object type is a valid starting point, because no
   type is privileged.

   It is a *search*, not a list, and that is structural: a repository holds hundreds of
   thousands of objects, and nothing about what a seed *yields* can be shown before loading
   it — that would mean running the traversal for every candidate.

The sub-log on screen is what a traversal outwards from that seed returns. The sidebar
states the query — repository, seed, traversal degree — and, in a small card beneath the
degree, what is currently displayed: counts by object type, links, events and the span of
time they cover — against the payload's totals wherever a toggle has hidden something.
There is deliberately no "case": the same event may belong to many sub-logs.

`?repo=&seed=` reproduces a selection by link; add `?preset=` to carry the filters too.

⚠️ **On the fixture source** there is no traversal, so only seeds with a pre-built sub-log
are offered, and `facebook/react` and `kubernetes/kubernetes` appear in the repo list
disabled — "no fixture built for this repository". The database source traverses for real
and serves all three. Corrected 2026-08-16: this paragraph said the two repositories were
unavailable *until the `get_object_graph` RPC exists* and that their absence was itself the
RQ2 finding. The RPC exists, both repositories have data, and
`scripts/build-catalogue.mjs` already retracts that claim in place — it was a statement
about which fixtures had been built, not about the world.

## What you are looking at

- **Three lanes** — issue, pull request, commit — each object keeping its own row.
  Two objects share a row when they run one after the other, and split into
  sub-lanes only when they overlap in time.
- **Three time modes, under a two-level control.** *Time* keeps the timeline: **Absolute**
  is linear in real time; **Discrete** spaces events evenly by order and annotates the
  long gaps with their true duration. *Relationships* releases the time axis altogether: position encodes
  relationship structure instead — related objects sit near each other, and a hub, a
  chain or a mesh is recognisable at a glance — while time survives on the arrowheads,
  a time brush, and the hovercard. Relationships mode has two arrangements, **Rows** (issues, then
  pull requests, then commits) and **Clusters** (each pull request a hub with its
  commits fanned around it), and its marks can be dragged. See `docs/RELATIONSHIPS_MODE.md`.
- **Solid vs dashed links.** Solid means the platform itself asserts the link — a
  closing keyword GitHub acts on, or an exact SHA match. Dashed, with a `?`, means we
  parsed a convention nobody enforces. Most links in the example data are dashed.
  That is the honest result, not a defect.
- **A hidden-state banner.** Anything you filter out is named at the top of the
  screen with one-click restore, because a sparse timeline otherwise reads as "few
  links" when the truth is "links switched off".

All times are **UTC**, labelled.

---

## Repository map

| Path | What |
|---|---|
| `index.html` | The app shell: markup, CSS, one `<script type="module">` |
| `src/` | The application, as ES modules — see below |
| `tests/` | `node --test` suites and `tests/fixtures/` |
| `sql/` | **The PostgREST data layer** — `fe_layer.sql` builds schema `fe` (views) and `api.get_object_graph` |
| `scripts/` | Fixture builders, the dev server, the RPC tooling, and `shot.mjs` for headless screenshots |
| `vendor/` | `d3-force` 3.0.0, vendored unmodified because there is no bundler to resolve a bare import (decision 104) |
| `docs/` | Design record — start with `DECISIONS.md` |
| `screenshots/` | Pre-change visual baseline. **Read-only** |
| `ocel-data.json` | The original data blob. **Never edit**; fixture F1 is built from it |
| `_ds/` | Nocturne design tokens. Consume via `var(--token)` |

### Where to start reading

1. **`docs/DECISIONS.md`** — every settled decision and why. Binding, and the single
   most useful file in the repository.
2. **`docs/ARCHITECTURE.md`** — the layers and the module tree.
3. **`src/model/objectGraph.js`** — the data contract, and what a malformed bundle
   looks like.
4. **`src/render/timeline.js`** — one render pass, top to bottom. The comment at the
   top explains why the order of operations is what it is.
5. **`src/layout/engine.js`** — `createLayout()`, the one place that knows there are two
   layout engines (the timeline and the structural relationships mode), and the seam that keeps the
   drawing code from learning which is active.

The code carries its reasoning in comments, deliberately: much of what matters here
is *why* something is the way it is, and that does not survive in a diff.

---

## How the pieces fit

```
ocel-data.json ──build-f1.mjs──► tests/fixtures/F1.json
                                        │
                                 loadObjectGraph()          ← the only data entry point
                                        │
                              validate → normalize → index
                                        │
        ┌───────────────────────────────┼───────────────────────────────┐
     model/                          layout/                          render/
  what things are               where they go                     drawing them
  (DOM-free, tested)          (DOM-free, tested)                  (needs a browser)
                                        │
                                     state/     ← what is visible; pure predicates
```

`loadObjectGraph(query)` is the only way data enters. Swapping the fixture transport
for the PostgREST RPC is a one-function change; nothing above the data layer moves.

**The test of the structure:** everything under `model/`, `layout/`, `state/` and
`stats/` must be exercisable without rendering anything. If a function needs a DOM to
be tested, it is in the wrong folder.

---

## Common tasks

**Add an activity to the vocabulary.** `src/model/activities.js` — add an entry with
its labels, the object types it may attach to, and whether it is a landmark. The
vocabulary is closed: anything unmapped fails validation loudly rather than rendering
a raw enum. Changing it is a research decision, so record it in `DECISIONS.md`.

**Add a link detection method.** `src/model/evidence.js` — add it to `LINK_METHOD`,
then decide by the rule in `ADAPTER_AND_API.md` §3 whether the platform asserts it
(`validated`) or we parsed a convention (`extracted`), and add it to
`VALIDATED_METHODS` if so. Toggles and counts derive automatically.

**Add an object type.** `OBJECT_TYPES` in `src/model/activities.js`, plus a label in
`src/state/labels.js`. Give it a lane only if it has a lifecycle worth drawing —
`actor` is an object without a lane (decision 15). A lane type also needs an entry in
`render/theme.js`. Add one only if something in the data is genuinely a participant:
`repo` was an object type until decision 39 found it was a partition key with a
permanently empty branch.

**Add a filter.** `src/state/state.js` only: extend `createState`, add the condition
to `isNodeVisible` or `isLinkVisible`, and report it in `summarizeHidden` so the
banner declares it. The renderers call those predicates rather than re-deriving
anything.

**Add a fixture.** `scripts/build-synthetic-fixtures.mjs`, then `npm run build:fixtures`.
The catalogue that populates the pickers is generated from the fixtures, so it cannot drift
from what is actually servable. Add an assertion in `tests/sublanes.test.js` proving the
fixture exhibits the property it claims — that is not optional: a fixture that does not
exhibit its property passes every test while verifying nothing.

**Connect the real database.** Write `src/data/api.js` exporting a transport with the
same shape as `fixtureTransport`, and pass it to `loadObjectGraph`. The adapter views
and the RPC contract are specified in `docs/ADAPTER_AND_API.md`.

**Verify a rendering change.** `npm test` covers the maths; it cannot see the
picture. Render it and look — `?repo=…&seed=…` selects a sub-log (`?fixture=F13` still works
as a direct address), `?page=stats` the statistics page, `?preset=…` a saved configuration.

---

## Live data, or fixtures

The **Data source** control at the top of the sidebar says which one is live and switches
between them. The app reads **fixtures by default**; `?source=` sets it directly:

```
http://localhost:8000/                                              fixtures
http://localhost:8000/?source=database&repo=microsoft/vscode&seed=pr:448781946
```

Both stay (decision 63). The fixtures are the test corpus and the visual baseline and
they exercise shapes real data does not conveniently contain; the database is what the
tool is for. `src/data/source.js` is the seam — `listRepos` / `searchSeeds` /
`loadSubLog`, implemented twice — so nothing above it branches on which is in use.

⚠️ The database source needs **both** servers up: `npm start` for the app and
`postgrest postgrest.conf` for the API. `npm start` proxies `/rpc/*` to PostgREST so the
two share an origin and no CORS is involved; if the API is down you get a 502 saying so.

---

## Serving it over HTTP

PostgREST is installed user-local at `~/.local/bin/postgrest` (v14.16, static binary — no
sudo, same pattern as Node). Two SQL files, in this order, then run it:

```bash
psql -d gharchive_ocpm_viz_wsl -f sql/fe_layer.sql        # the data layer
psql -d gharchive_ocpm_viz_wsl -f sql/postgrest_setup.sql # roles, grants, isolation
cp postgrest.conf.example postgrest.conf                  # then set the password
postgrest postgrest.conf                                  # listens on :3000
```

```bash
curl -s -X POST http://localhost:3000/rpc/get_object_graph   -H 'Content-Type: application/json'   -d '{"repo":"microsoft/vscode","seed":"pr:448781946","traversal_degree":2}'
```

**Three roles, and the third is the point** (`sql/postgrest_setup.sql` explains at length):
`authenticator` connects, `web_anon` is what a request runs as, and `fe_owner` owns the
layer and is what the RPC runs as via `SECURITY DEFINER`. Without that third role
`web_anon` would need SELECT on 14 GB of raw event data; with it, `web_anon`'s entire
privilege set is USAGE on schema `api` and EXECUTE on one function. `fe_owner` is
deliberately **not** a superuser — a superuser-owned `SECURITY DEFINER` function reachable
over HTTP is a privilege-escalation surface. The file ends in seven assertions that all
have to read `ok`.

⚠️ `postgrest.conf` holds the database password and is **gitignored**. Commit
`postgrest.conf.example` instead.

---

## The data layer

`sql/fe_layer.sql` is the whole of it. Run it, then query the RPC:

```bash
psql -d gharchive_ocpm_viz_wsl -f sql/fe_layer.sql        # idempotent, ~15 s
psql -d gharchive_ocpm_viz_wsl -Atc \
  "SELECT api.get_object_graph('microsoft/vscode','pr:448781946',2)"
```

Seeds are **type-prefixed database ids**, not display numbers (decision 51):
`issue:<issue_id>`, `pr:<pull_request_id>`, `commit:<sha>`. To resolve a number:

```sql
SELECT id FROM fe.object_issue WHERE repo_id = 41881900 AND issue_number = 242864;
```

**Checking it:**

```bash
node scripts/rpc-check.mjs                    # full acceptance gate on a real payload
psql -d ... -c "SELECT * FROM fe.diag_sanity" # 6 checks, every one must read 0
```

`scripts/rpc-check.mjs` feeds a live payload through `loadObjectGraph()` and requires
`findGraphProblems()` to return `[]` — the same gate the 13 fixtures pass — then runs the
real layout pipeline in every time mode, relationships mode in both of its arrangements.

⚠️ **After any upstream materialized-view refresh:**

```sql
SELECT fe.refresh_all();          -- ~11 s; refreshes both materialized relations
SELECT * FROM fe.diag_staleness;  -- row counts and when each was last written
```

Two relations here are materialized — `fe.link_mat` (decision 57) and `fe.seed_lookup`
(the seed search index) — and both go stale **silently**. A stale link table does not
error, it answers with last week's graph; a stale search index cannot find objects that
now exist.

**Looking at it without a browser** — `node scripts/shot.mjs LIVE1` renders the running
app headlessly and writes a PNG to `.shots/` (gitignored; it never touches the read-only
`screenshots/` baseline). Uses Microsoft Edge over WSL interop, or any Chrome/Chromium via
`BROWSER=`. It answers "did this draw at all", not "is this right".

**Looking at a real sub-log** — `scripts/pull-sublog.mjs` snapshots RPC output into
`tests/fixtures/LIVE*.json` so the app can render it before it is wired to PostgREST.
Those are **samples, not fixtures**: nothing asserts against them, and the `LIVE*` name
keeps them out of the `^F\d+$` test globs.

---

## Status

Work packages `tasks/00` through `tasks/06` are complete, and the data layer is built.
What is **not** done:

- **The renderer still crowds on dense real sub-logs — open question O12(b).** Event
  glyphs stack without bound: kubernetes issue #260 has 288 comment events in a short
  window, so the collision loop allocates 52 bands for one issue and the SVG reaches
  5,654 px. Crowding rather than deception, but it is worst on the busiest issues.
  ⚠️ **O12(a) is closed** — the misleading half, where a 37-commit pull request drew ~30
  diamonds because the link fan spread coincident endpoints. Decision 68 caps the fan at
  `MAX_FANNED_LINKS = 6` (`src/render/links.js`) and declares a `×N` count beyond that.
  This bullet claimed both halves were open; corrected 2026-08-16.
- **How to draw a dense sub-log's links is unresolved — open question O13.** Bundling
  links that share an endpoint into one trunk was built and reverted on 2026-08-09.
  Decisions 25 and 68 survive whatever replaces it.
- **No deployment story beyond localhost.** The dev server's `/rpc/*` proxy is the same
  shape nginx would take, but nothing is packaged or documented for a real host.
- **Refresh is manual.** `fe.refresh_all()` does both materialized relations in one
  call, but nothing triggers it when upstream refreshes.
- **The RQ2 link-coverage figure is now measurable but unpublished.**
  `fe.diag_link_methods` produces it, grouped by `(method, qualifier)` as decision 50
  requires. It has not been written up, and two caveats must travel with it: the
  `ref_match` narrowing (decisions 80 and 62 — 80 replaced 61) makes every commit-link
  count a **floor**, and
  the per-repo spread is a fork-vs-branch contribution artifact, not a process difference.
- **Interaction has no automated coverage** — tooltips, minimap drag, legend hover, and
  the relationships mode's drag, whose feel was tuned by hand and measured in Node (decision 106).
- **Sizing has not been tuned** beyond 1920×1200.
- **The mode-to-mode tween is deferred** (decision 108): switching between a timeline
  and relationships mode cuts. Relationships mode's own known weak points — label collisions on a large hub
  above all — are listed in `docs/RELATIONSHIPS_MODE.md`.

`docs/VERIFICATION.md` states exactly what was checked and what was not.
