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
| `scripts/` | Fixture builders and the dev server |
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

## Status

Work packages `tasks/00` through `tasks/06` are complete. What is **not** done:

- **No connection to the real database.** Every sub-log is a fixture. The adapter
  views, the `get_object_graph` RPC and `src/data/api.js` are all unwritten.
- **The RQ2 link-coverage figure is unmeasured**, and the query that would produce
  it is no longer in the tree — `sql/` was deleted in `a1e2a9c`. It has to be
  written again against the refreshed contract, which now lists seven issue↔PR
  detection methods rather than four.
- **Interaction has no automated coverage** — tooltips, minimap drag, legend hover.
- **Sizing has not been tuned** beyond 1920×1200.

`docs/VERIFICATION.md` states exactly what was checked and what was not.
