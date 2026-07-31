# Visualizing issue-to-merge processes with object-centric event logs

An interactive timeline for GitHub issue → pull request → commit workflows, built on
**object-centric process mining** (OCPM). A master's thesis prototype, and the
artifact its evaluation runs against.

Instead of flattening history into one case per issue, the tool shows objects —
issues, pull requests, commits — on their own lanes, with the links between them
graded by how much the evidence for each link is worth.

```
npm start        # then open http://localhost:8000
npm test         # 288 assertions, no browser needed
```

> Opening `index.html` from disk will not work. Browsers block both ES modules and
> `fetch()` on `file://` origins, so the app needs an http origin. `npm start` runs a
> ~40-line dependency-free server; nothing is bundled or compiled.

Requires Node 20+. There are **no dependencies** — no bundler, no framework, no
TypeScript, no test library. D3 is loaded from a CDN by `index.html`.

---

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
| `sql/` | Queries against the shared database (none run yet) |
| `docs/` | Design record — start with `DECISIONS.md` |
| `screenshots/` | Pre-change visual baseline. **Read-only** |
| `ocel-data.json` | The original data blob. **Never edit**; fixture F1 is built from it |
| `_ds/` | Nocturne design tokens. Consume via `var(--token)` |
| `OCEL Timeline.dc.html`, `support.js` | The superseded mockup, frozen for reference |

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
its labels, the object types it may attach to, and whether it is a milestone. The
vocabulary is closed: anything unmapped fails validation loudly rather than rendering
a raw enum. Changing it is a research decision, so record it in `DECISIONS.md`.

**Add a link detection method.** `src/model/evidence.js` — add it to `LINK_METHOD`,
then decide by the rule in `ADAPTER_AND_API.md` §3 whether the platform asserts it
(`validated`) or we parsed a convention (`extracted`), and add it to
`VALIDATED_METHODS` if so. Toggles and counts derive automatically.

**Add an object type.** `OBJECT_TYPES` in `src/model/activities.js`. Give it a lane
only if it has a lifecycle worth drawing — `actor` and `repo` are objects without
lanes (decision 15). A lane type also needs an entry in `render/theme.js`.

**Add a filter.** `src/state/state.js` only: extend `createState`, add the condition
to `isNodeVisible` or `isLinkVisible`, and report it in `summarizeHidden` so the
banner declares it. The renderers call those predicates rather than re-deriving
anything.

**Add a fixture.** `scripts/build-synthetic-fixtures.mjs`, then register it in
`src/data/fixtures.js` and add an assertion in `tests/sublanes.test.js` proving it
exhibits the property it claims. That assertion is not optional: a fixture that does
not exhibit its property passes every test while verifying nothing.

**Connect the real database.** Write `src/data/api.js` exporting a transport with the
same shape as `fixtureTransport`, and pass it to `loadObjectGraph`. The adapter views
and the RPC contract are specified in `docs/ADAPTER_AND_API.md`.

**Verify a rendering change.** `npm test` covers the maths; it cannot see the
picture. Render it and look — `?fixture=F13` selects a sub-log, `?page=stats` the
statistics page, `?preset=…` a saved configuration.

---

## Status

Work packages `tasks/00` through `tasks/06` are complete. What is **not** done:

- **No connection to the real database.** Every sub-log is a fixture. The adapter
  views, the `get_object_graph` RPC and `src/data/api.js` are all unwritten.
- **The RQ2 link-coverage figure is unmeasured.** The query is written
  (`sql/rq2_link_coverage.sql`) but has never been run.
- **Interaction has no automated coverage** — tooltips, minimap drag, legend hover.
- **Sizing has not been tuned** beyond 1920×1200.

`docs/VERIFICATION.md` states exactly what was checked and what was not.
