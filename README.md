# Visualizing issue-to-merge processes with object-centric event logs

An interactive timeline for GitHub issue → pull request → commit workflows, built on
**object-centric process mining** (OCPM). A master's thesis prototype, and the
artifact its evaluation runs against.

Instead of flattening history into one case per issue, the tool shows objects —
issues, pull requests, commits — on their own lanes, with the links between them
graded by how much the evidence for each link is worth.

```
npm start        # then open http://localhost:8000
npm test         # 377 assertions, no browser needed
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

The sub-log on screen is what a traversal outwards from that seed returns, and the breadcrumb
states the query that produced it — `microsoft/vscode · from issue #242864 · degree 2 · …`.
There is deliberately no "case": the same event may belong to many sub-logs.

`?repo=&seed=` reproduces a selection by link; add `?preset=` to carry the filters too.

⚠️ Until the `get_object_graph` RPC exists there is no traversal, so **only seeds with a
pre-built sub-log are offered**. `facebook/react` and `kubernetes/kubernetes` appear in the
repo list, disabled, because their absence is itself the RQ2 finding.

## What you are looking at

- **Three lanes** — issue, pull request, commit — each object keeping its own row.
  Two objects share a row when they run one after the other, and split into
  sub-lanes only when they overlap in time.
- **Three time modes.** *Real* is linear. *Highlights* compresses idle stretches so
  activity stays legible. *Ordinal* spaces events evenly and annotates the long gaps
  with their true duration.
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
| `scripts/` | Fixture builders, the dev server, and the RPC tooling |
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
real layout pipeline in all three time modes.

⚠️ **After any upstream materialized-view refresh, run `SELECT fe.refresh_links();`**
(~6 s). `fe.link_mat` is the one materialized relation in the layer and it goes stale
silently otherwise. `fe.diag_link_staleness` reports the drift.

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

- **The app still loads fixtures**, even though everything under it is live. PostgREST
  serves the RPC and `src/data/api.js` is a working transport, verified end to end over
  HTTP — but `src/main.js` still calls `fixtureTransport`. What is missing is not the
  transport, it is **seed resolution**: the RPC keys on database ids
  (`pr:448781946`) while the UI's search box takes display numbers (`#102479`), and
  nothing bridges the two yet. `fe.seed_lookup` plus `resolveSeed()` in `api.js` is the
  next piece; both are stubbed with the shape they need.
- **`scripts/build-catalogue.mjs` still lists react and kubernetes as "unavailable —
  needs the `get_object_graph` RPC".** The RPC exists and serves both. That claim is
  decision 34's documented behaviour, so it retires with the seed-search work rather
  than piecemeal.
- **The RQ2 link-coverage figure is now measurable but unpublished.**
  `fe.diag_link_methods` produces it, grouped by `(method, qualifier)` as decision 50
  requires. It has not been written up, and two caveats must travel with it: the
  `ref_match` narrowing (decisions 61–62) makes every commit-link count a **floor**, and
  the per-repo spread is a fork-vs-branch contribution artifact, not a process difference.
- **Layout does not cope with dense real sub-logs** — see open question O12.
- **Interaction has no automated coverage** — tooltips, minimap drag, legend hover.
- **Sizing has not been tuned** beyond 1920×1200.

`docs/VERIFICATION.md` states exactly what was checked and what was not.
