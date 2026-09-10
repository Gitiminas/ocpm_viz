# Visualizing issue-to-merge processes using object-centric event logs

Draws a GitHub repository's issue → pull request → commit history as an **object-centric
sub-log**: issues, pull requests, commits and actors keep their own identity instead of being
flattened into one case per issue, and every link carries the evidence behind it. A link is
`validated` when the platform asserted it, `extracted` when it comes from parsing a convention
nobody enforces. The stack is PostgreSQL → PostgREST → D3, with no dependencies at all: no
bundler, no framework, no TypeScript, no test library. D3 7.8.5 comes from a CDN;
`vendor/d3-force.js` is the only vendored code. Node 20+ is the whole toolchain.

## Running it

```
npm start                 # then open http://localhost:8000
```

Opening `index.html` from disk does not work. Browsers block both `<script type="module">` and
`fetch()` on `file://` origins, so the app needs an HTTP origin. `scripts/serve.mjs` is a
zero-dependency server that provides one, and also proxies `/rpc/*` to PostgREST so the app and
the API share an origin (it answers 502 when PostgREST is down). Nothing is bundled or compiled.

**Fixtures need no database.** The app starts on the fixture source, which serves 16 pre-built
sub-logs under one repository, `synthetic/fixture` — F1 is a real vscode sub-log, F2–F15 are
synthetic shapes, LIVE1 and LIVE2 are snapshots of real RPC output. That is enough to see the
tool work.

**The database source needs PostgREST running**, and a database to point it at. The upstream
corpus is not part of this repository: it lives on the project's server, and `sql/matviews_scoped.sql`
is the definition of the 23 views it was set up with — the 14 that `sql/fe_layer.sql` reads, plus
the rest of that dependency-ordered set. It is a record of how the server was built, applied once
and not re-runnable against a database that already has them. `docs/DATA_CONTRACT.md` describes
what those relations contain.

Copy the config, point `db-uri` at the database, and fill in the password:

```
cp postgrest.conf.example postgrest.conf     # gitignored; it holds the password
```

Then start both servers, and apply the data layer once:

```
./ocpm.sh          # stop, start PostgREST + the app server, health-check the whole path
./ocpm.sh db       # apply the data layer, restart, run the acceptance gate
./ocpm.sh status   # what is running, and is it healthy
```

Prefer `ocpm.sh db` to running the SQL by hand; it applies both files and refreshes
`fe.link_mat`, so run `fe.refresh_all()` yourself after an upstream refresh. The order is
`sql/fe_layer.sql`, then `sql/postgrest_setup.sql`, then `SELECT fe.refresh_all()`, and it is not
negotiable:
`fe_layer.sql` issues `CREATE OR REPLACE` on every `api` function, which silently resets it to
`SECURITY INVOKER`, and the app then fails with *"permission denied for schema fe"* while every
local check still passes. `fe.link_mat` and `fe.seed_lookup` also go stale silently after any
upstream refresh — `fe.refresh_all()` is what fixes that, and `fe.diag_staleness` is what tells
you. `docs/DATA_LAYER.md` has the rest.

Switch source in the sidebar, or by URL: `http://localhost:8000/?source=database&repo=microsoft/vscode&seed=pr:448781946`.

## Using it

**The query is a repository plus a seed object.** Pick the repository, then search for something
to start from in *Start from*: type a number, `#243221`, `pr 243221`, a commit SHA prefix, or
free text. It is a search rather than a list because a repository holds hundreds of thousands of
objects, and nothing about what a seed yields can be known before traversing from it. Any object
type is a valid seed; no type is privileged. Seed ids are type-prefixed database ids —
`issue:<issue_id>`, `pr:<pull_request_id>`, `commit:<sha>`.

**Traversal degree** (0, 1 or 2; default 1) says how far the server walks outwards from the seed.
It decides what is *in* the sub-log. On the fixture source there is no traversal, so the control
reads "fixed by the query". Do not confuse it with **focus degree**: clicking a mark focuses that
object and dims everything more than one hop away, with a floating stepper to reach two. Focus
changes what is *highlighted*, never what is loaded.

A sub-log arrives in one query and that query is slow — 3.5 s to 3.9 s warm against the live
database on 2026-09-06, 2.4 s to 3.3 s a month earlier, 7.4 s cold — so changing the repository,
the seed or the degree blurs the picture behind a loading card naming what is being fetched, and the stale picture stops taking clicks until the
new one arrives. Nothing appears for loads under 200 ms, which is every load on the fixture source.

The sub-log card under the query states what is on screen: counts per object type, links, events
and the time span, shown as `n / total` whenever a toggle has hidden something. An actor
counts only once its trail is pinned, and in the relationships view an artifact is one issue, PR
or commit mark. There is no
"case" anywhere — the same event may belong to many sub-logs.

**Three pages.** *Trace* is the drawing. *Stats* is a table of one row per object (open for, events,
comments, actors, links, longest gap, handoffs, outcome) with per-type aggregates, plus cards for
link evidence, PR outcomes, commits, actors, lead times, idle gaps and landmarks. Every figure is
computed in JavaScript over the visible sub-log, so it follows the toggles. *Process* is the
object-centric directly-follows graph over the repository's **whole log**: one activity node per
object type and activity, succession edges whose width grows (√) with how often one activity
directly follows another within one object's events, and dashed cross-type edges counted through
the links — floors, and labelled as such. On the commit lane the activity is *push*: one event
per push and one occurrence per commit it carried, where the Trace page draws each commit
observation on its own. It is pre-computed server-side (`fe.dfg_mat`,
`api.get_dfg`), so the sub-log sidebar's toggles do not apply — the page carries its own:
per-lane and per-type-pair succession masters, link evidence, qualifier and detection-method filters (cross arrows thin rather than multiply, and their hovercards break the count down by link class), per-activity hides, a logarithmic min–max count
range that opens with the rarest tenth of edges hidden, and click-to-focus on an activity. The
notice always states the filter's arithmetic ("Showing 86 of 94 succession arrows"), so nothing
disappears quietly; there is no seed on this page, the repository is the whole query. The page
needs the database source: fixtures hold sub-logs, not a whole log, so on fixtures it says so and
links to `?source=database&page=dfg`. The pulled sample `DFG1` is used only by the tests.

**Modes** are a two-level control:

| Facet | Arrangement | Position means |
|---|---|---|
| Time | Absolute | linear in real time |
| Time | Discrete | one step per event, with the long gaps annotated with their true duration (hovering a gap marking puts its exact span in the help strip) |
| Relationships | Rows | layered by type: issues, then pull requests, then commits |
| Relationships | Clusters | each pull request a hub with its commits fanned around it |

Relationships mode releases the time axis so position can carry structure; time survives on the
arrowheads (which point at the later end), on a time brush, and in the hovercard. Its marks can be
dragged, and a drag is stored as an offset, so it survives a relayout.

Zoom is Ctrl+wheel in the time modes, plain wheel and drag-to-pan in relationships mode. The
minimap, in the time modes only, gives a draggable viewport and two drag-to-zoom grips. All
times are UTC, labelled.

**The sidebar** holds six collapsed sections:

| Section | What it does |
|---|---|
| Views | Four built-in configurations, saved views (rename, delete), *Save current view*, *Copy link* |
| Lanes | Lane masters, per-lane comments, per-object hide, commit groups by pull request |
| Relationships | Validated and Extracted masters with type-pair children, qualifiers, detection methods, with counts |
| Folding | Push folding (fixed, by `push_id`) and a comment-folding window of 0–30 days |
| Actors | One row per actor with colour, login and event count; hover previews the trail, click pins it |
| Legend | Eighteen rows in five sections, dimmed when absent from the current render; hover highlights every matching mark |

Commits pushed together fold into one bulk-push mark, and runs of comments inside the folding
window fold into one comment burst — though a run never crosses a close or a reopen, so a
late comment cannot masquerade as in-life traffic; a dashed underline shows the folded run's
true span. Click either mark to expand, and the `−` handle to fold it back.
Where more than six links land on the same point they stop fanning apart and declare a `×N`
badge instead, because at 35 commits the fan draws one pull request as a cascade of diamonds.

**Nothing disappears quietly.** Anything a toggle hides is named in a banner across the top of the
chart, one chip per hidden item, each restoring on click. The header's help strip says in a
sentence what the pointer is on. Hovering a mark shows a tooltip; right-click pins it, Esc
unpins, and clicking a row copies it. An actor's profile button opens a card with their activity,
where hovering a row rings the corresponding mark.

**URL parameters** reproduce a picture. *Copy link* writes all of them:

| Parameter | Value |
|---|---|
| `source` | `fixtures` (default) or `database` |
| `repo` | repository name |
| `seed` | seed object id, e.g. `pr:448781946` |
| `fixture` | direct fixture address, e.g. `F13` — instead of `repo` + `seed` |
| `degree` | traversal degree, 0–2 |
| `preset` | a whole configuration, base64url |
| `page` | `stats` or `dfg` |
| `mode` | `absolute`, `discrete` or `relationships` |
| `layout` | `layered` or `cluster` |
| `brush` | two fractions of the time extent, e.g. `0.6,1` |
| `focus` | focused object id |
| `focusDegree` | 1 or 2 |

## Testing

```
npm test                  # 885 tests over 35 files, ~1 s, no browser
npm run test:watch
```

`node --test` discovers `tests/*.test.js` on its own, so do not pass a path. Everything under
`model/`, `layout/`, `state/` and `stats/` is DOM-free and asserted directly.

```
npm run build:fixtures    # rebuild F1, F2–F15 and the catalogue
node scripts/build-f1.mjs --check          # fails if the committed fixture is stale
node scripts/rpc-check.mjs                 # the sub-log data-layer gate
node scripts/dfg-check.mjs                 # the DFG data-layer gate
node scripts/shot.mjs LIVE1                # headless screenshot → .shots/
```

Each build script takes `--check`, which rebuilds nothing and fails when the committed output no
longer matches. `tests/fixtures.test.js` runs the F1 and synthetic builders that way, so a stale
fixture fails `npm test`.

`scripts/rpc-check.mjs` is the gate to run after any change to `sql/fe_layer.sql`. It pulls a real
payload, requires `findGraphProblems()` to return `[]`, checks the contract version, the activity
and qualifier vocabulary and the absence of retired shapes, then lays the payload out in both
temporal modes and both structural arrangements and asserts the results are finite, in-box and
non-overlapping. It ends with one unauthenticated HTTP call as `web_anon`, which is the only step
that travels the path the `SECURITY INVOKER` reset breaks.

`scripts/shot.mjs` renders the running app headlessly and writes a PNG to `.shots/`, which is
gitignored. Headless lays out about 90 px shorter than the window size it captures at, so
compare fill between shots and never against the box.

## Repository map

| Path | What |
|---|---|
| `index.html` | The app shell: markup, CSS, one `<script type="module">` |
| `src/data/` | `loadSubLog`, the two transports, source selection, seed parsing |
| `src/model/` | Object graph validation and indexing, the closed vocabulary, evidence, bursts, groups |
| `src/state/` | The `st` object, every visibility predicate, presets |
| `src/layout/` | Scales, packing, lanes, anchors; the two structural arrangements. DOM-free |
| `src/render/` | The SVG renderers, sidebar, tooltips, stats page, theme |
| `src/stats/metrics.js` | Durations, counts, gaps, outcomes as pure functions |
| `src/help/tips.js` | Help texts as data: key → sentence |
| `sql/` | `fe_layer.sql` (schema `fe` and the five RPCs), `postgrest_setup.sql` (roles and grants), and `matviews_scoped.sql` (the 23 upstream views, 14 of which the layer reads) |
| `scripts/` | The dev server, fixture builders, the two gates (`rpc-check.mjs`, `dfg-check.mjs`), the two pullers (`pull-sublog.mjs`, `pull-dfg.mjs`), `shot.mjs` |
| `tests/` | `node --test` suites and `tests/fixtures/` (F1–F14, LIVE1–LIVE2, `catalogue.json`) |
| `vendor/` | d3-force 3.0.0, unmodified, because there is no bundler to resolve a bare import |
| `_ds/` | Nocturne design tokens. Consume via `var(--token)`; do not restyle |
| `ocel-data.json` | The original data blob. Never edit — F1 is built from it by script |
| `docs/` | The written record. See below |
| `./ocpm.sh` | Starts both servers and applies the data layer in the one order that works |

## Documents

| Document | What it is |
|---|---|
| `CLAUDE.md` | Project rules: vocabulary, hard constraints, what is out of scope |
| `docs/ARCHITECTURE.md` | The frontend: folders, seams, data flow, layout, and the traps in the layout code |
| `docs/DATA_LAYER.md` | Everything server-side: schemas, the payload, links, the RPCs, roles, diagnostics |
| `docs/DATA_CONTRACT.md` | What exists upstream. A record of a read-only database that is itself the truth |
| `docs/VERIFICATION.md` | What was checked, how, and what was not. §5 is the not-verified list; read it before quoting a figure |

## Known limits

- **Event glyphs stack without bound.** A kubernetes issue with 288
  comments in a short window allocates 52 bands and an SVG 5,654 px tall. Crowding rather than
  deception, but it is worst on the busiest issues.
- **How to draw a dense sub-log's links is unresolved.** Two measurements constrain any fix. On
  kubernetes #47532, collapsing links by shared source folds nothing: no source has more than one
  link, while two targets have 6 and 7. And bundling cannot subsume the fan, because links may
  share a target while differing in evidence class.
- **Events carry one object id, not many.** OCEL 2.0's event-to-object relation is
  many-valued; convergence here is expressed through links between objects instead.
- **Every link figure is a floor, never a point estimate.** Two admission rules added by this
  project narrow `ref_match`, so commit-link and issue↔PR counts undercount by an unmeasured
  amount. Say so wherever one is quoted.
- **Clusters overprint on a large sub-log.** Labels collide where pull requests sit close, and a
  34-pull-request hub is unreadable by label in either arrangement, though the shape still reads.
- **Fixtures key actors by `actor:<login>`**, because `ocel-data.json` carries no numeric actor
  id. The live payload uses `actor:<actor_id>`. A renamed account splits into two actors in the
  fixtures only; note it if fixture actor counts are reported.
- **Nothing is deployed beyond localhost**, and most interaction has no automated coverage:
  drag-to-pan and minimap placement are unit-tested against stubs, while tooltips, the minimap's
  zoom grips, hover paths and the actor card were checked by eye.
