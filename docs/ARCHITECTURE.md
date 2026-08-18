# Architecture

Intent, boundaries and rationale. Not a walkthrough of the current code — for that see
`README.md`, which holds the orientation material, and the module tree below.
(`MOCKUP_OVERVIEW.md` describes the *superseded* mockup and is historical; do not read it as a
description of what runs today.)

## Layers

```
GH Archive dumps
      │  (ingest — shared infrastructure, not this project)
      ▼
  base tables  ──►  49 upstream views  ──►  adapter views  ──►  PostgREST ──►  D3
  actor/org/         payload extraction         OCEL-shaped        get_object_    browser
  repo/event         FROZEN, shared             MINE               graph

                    └──── owned by others ────┘  └──────── this thesis ────────┘
```

**Base tables + the upstream views — frozen.** Shared research infrastructure. Contract snapshot in
`DATA_CONTRACT.md`. Never modified, never refreshed from here, never extended. If a query is
awkward, solve it in the adapter layer.

Note the pattern: `event` is already the event-log skeleton (`id`, `type`, `actor_id`, `repo_id`,
`created_at`). The MVs supply the payload detail that refines each row into a specific activity. The
event stream is `event` **plus** MVs, not a UNION of six MVs.

**Adapter views — mine.** Object identity, event-object links, qualifiers, evidence, lifecycle
intervals. See `ADAPTER_AND_API.md`. Deliberately thin and isolated: it has a known expiry date when
the OCEL 2.0 tables land.

**`api` schema.** Exposes one RPC. No logic not derivable from the adapter layer.

**Frontend.** Data access, layout, rendering and stats stay separable.
`loadObjectGraph(query) -> ObjectGraph` is the only data entry point.

## Frontend module structure

Software engineering quality is graded and future students inherit this code, so structure is a
deliverable. Native ES modules, no bundler, no build step.

```
index.html
src/
  main.js              wiring only — no logic
  data/
    loadObjectGraph.js the sole data entry point
    fixtures.js        serve a {repo, seed} query from local JSON, via a catalogue
    api.js             load an ObjectGraph from PostgREST: the RPC, seed search, repo list
    source.js          ✚ fixtures vs database behind one shape, chosen by ?source= (63)
    seedQuery.js       ✚ parse and rank what is typed into "Start from" (64)
  model/
    objectGraph.js     shape validation, normalization, indexing
    activities.js      the closed activity vocabulary + landmark set
    evidence.js        validated / extracted classification
    graph.js           adjacency construction, focus BFS
    bursts.js          ✚ burst derivation from push_id
    commentBursts.js   ✚ runs of comments close together in time (decision 93)
    commitGroups.js    ✚ commits grouped by the PR they reach
  layout/
    engine.js          ✚ createLayout(): the ONE mode branch — temporal or structural (96)
    scales.js          the three temporal modes' x scale (real / highlights / ordinal)
    packing.js         row allocation (per-object sub-lanes: Task 2)
    lanes.js           lane geometry
    nodes.js           ✚ node model construction — which nodes exist, in what order
    anchors.js         ✚ where a link meets an object
    structural.js      ✚ off mode's node/edge model: one node per object, brush maths (95, 97)
    layered.js         ✚ off mode, Rows: Sugiyama layers, ordering, row compression (101, 109)
    cluster.js         ✚ off mode, Clusters: balloon seed + d3-force; the shared force
                         config, forceFootprint, createDragSimulation (101, 105, 106)
  render/
    timeline.js  nodes.js  links.js  axis.js  minimap.js  tooltip.js  legend.js
    structural.js      ✚ drawing off mode: edges, marks, hovercards, dragging (103)
    motion.js          ✚ settle + idle drift for off mode — presentation only (102)
    theme.js           ✚ colours, shapes, glyphs shared by every renderer
    format.js          ✚ the one place a timestamp becomes text
    message.js         ✚ a page's message surface: why it cannot draw (decision 87)
    sidebar.js         ✚ lane / relationship / burst / actor rows and the combos
    controls.js        ✚ preset panel and the always-visible hidden-state banner
    actorCard.js       ✚ the actor profile card
    stats.js           ✚ presentation for the statistics page
  state/
    state.js           the st object and the derived relationship toggles
    labels.js          ✚ type labels, so state derivation stays DOM-free
    presets.js         serialize, save, load, URL encode, built-in views
  stats/
    metrics.js         durations, counts, gaps — pure functions over an ObjectGraph
scripts/
  build-f1.mjs         ocel-data.json → tests/fixtures/F1.json
  build-synthetic-fixtures.mjs  F2–F13: one structural property each, never real data
  build-catalogue.mjs  which repos exist and which seeds can be served
  serve.mjs            zero-dependency static server (npm start), proxying /rpc/*
  rpc-check.mjs        acceptance gate: a real RPC payload through the real pipeline
  pull-sublog.mjs      snapshot RPC output to tests/fixtures/LIVE*.json — samples, not fixtures
  shot.mjs             headless screenshot of the running app, to .shots/
vendor/
  d3-force.js          d3-force 3.0.0, ISC, unmodified — vendored, not installed (104)
tests/
  fixtures/            F1 … F13
  *.test.js
```

✚ marks modules added beyond the structure settled in decision 16. Each exists because the
alternative was a module doing two jobs:

- `layout/nodes.js` — node *construction* is pure and must be testable without a DOM;
  `render/nodes.js` is the drawing. Splitting them is what keeps "how many nodes, in which lane,
  in what order" checkable in isolation.
- `layout/anchors.js` — an endpoint's position is arithmetic over rows and scales, and it decides
  where a line lands. It lived inside `render/timeline.js` and was therefore exercised only by
  looking at a picture, which is how it came to disagree with the lifecycle bar about which row an
  object occupies (decision 37). One formula, one file, asserted without a DOM.
- `model/bursts.js` — burst grouping is a data derivation, not layout.
- `render/format.js` — Task 5's UTC fix must be a one-file change, so every formatter lives here.
- `render/theme.js`, `sidebar.js`, `actorCard.js`, `stats.js` — otherwise `timeline.js` becomes the
  same god-module the rewrite was meant to break up.
- `render/legend.js` holds `LEGEND_SECTIONS` as **pure exported data**, not markup built inline,
  so "is every drawn mark explained?" is answerable without a DOM. Every mark carries a
  `data-legend` key and `tests/legend.test.js` fails in both directions — a mark with no row,
  or a row naming nothing drawn (decision 82). The legend had drifted to explaining six of a
  dozen marks precisely because nothing connected drawing one to explaining it.
  It renders from `redraw()` rather than on load, because it **dims** the rows whose marks are
  not on screen (decision 83) — dims, never removes, so "the data has none" and "you switched
  it off" stay distinguishable. Presence is read off the chart, not re-derived.
- `data/source.js` — the fixtures-or-database choice, absorbed in one place (decision 63). Its
  three operations are async in **both** implementations even where one has nothing to await,
  because differing shapes would push the branch up into `main.js`, which is what this module
  exists to prevent.
- `data/seedQuery.js` — parsing "pr #243221" and ranking the matches are pure functions, and
  they are shared by both sources deliberately (decision 64): a second parser in SQL would give
  the two searches something to disagree about with nothing to say which was right.
- `state/labels.js` — lets `state.js` derive toggle labels without importing a render module.
- `model/commitGroups.js` — grouping commits by the PR they reach is a data derivation, and the
  union visibility rule (decision 26) has to be testable on its own.
- `render/controls.js` — the preset panel and the hidden-state banner are two halves of one
  bargain (decision 27) and belong together, away from the per-lane sidebar rows.

The timeline draws into ordered layers, one of which — `preview` — exists for marks that
belong to a pointer rather than to state: an actor's trail while their sidebar row is
hovered (decision 84). It is written by `previewActor()` without a re-render, and cleared
by the next `render()` along with everything else, so a preview cannot outlast the
positions it was drawn against.

**Two layout engines behind one seam.** `layout/engine.js` is the one place that knows both
exist. `createLayout({mode, …})` returns the same shape from either — `nodes`, `nodeByObject`,
`anchors`, `width`, `height` and a `kind` of `'temporal'` or `'structural'` — so
`render/timeline.js` asks once and then draws, reading `kind` and never `mode`. The temporal
engine is the timeline as it always was (x from `scales.js`, y from `packing.js` + `lanes.js`);
the structural engine (`off` mode) is `structural.js` for the node model and `layered.js` or
`cluster.js` for the arrangement, and returns `edges`, `extent`, `waypoints`, `footprints` and
`anchorId` besides. The renderer's one look at the mode before the layout runs is `frame()`,
which decides how much surface each engine gets (decision 107). The structural renderer
(`render/structural.js`) is a second, small renderer rather than a pile of `if (mode === 'off')`
in the first, and `render/motion.js` animates *toward* computed positions without ever
feeding back into them. Field notes, known weak points and the traps this construction paid
for are in `OFF_MODE.md`; the decisions are 95–109.

**Where visibility is decided.** All of it lives in `state/state.js` as pure predicates —
`isObjectVisible`, `isNodeVisible`, `isLinkVisible`. `layout/` takes a predicate rather than the
state object, so it never learns about lanes, hidden objects or commit groups; `render/` calls the
predicates rather than re-deriving them. Adding a filter therefore means editing one file and its
tests, not hunting through the renderers.

**The test that the seams are right:** every module under `model/`, `layout/`, `stats/` must be
importable and exercised without rendering anything. If a function needs the DOM to be tested, it is
in the wrong folder.

This structure is **settled** — adopted as proposed by decision 16 (was open question O8).

Note that `render/` has no lane module for every object type: `actor` is an object without a lane
(decision 15), so it is rendered by the sidebar and the actor card, not by `layout/lanes.js`. It is
the only such type — `repo` was the other until decision 39 stopped treating it as an object at all.

## Object-centric implications for the renderer

Not single-case process mining, so the usual vocabulary does not transfer:

- No global directly-follows graph — DFGs are per object type.
- **Divergence and convergence** must be visible rather than silently flattened. One event touching
  several objects, and one object touching many events, are exactly what OCPM exists to show.
- Flattening to a classical log is a *labelled view*, not the data model.
- The sub-lane rule (decision 3) is the layout consequence: an object's identity must stay visually
  traceable across the whole timeline, and links must stay readable when N > 1 on both ends.

## Structural debt — resolved, retained as rationale

> **Historical as of Task 1 (2026-07-30).** The code described below no longer exists; the module
> tree above replaced it. Kept because it is the reason the tree looks the way it does.

The mockup was one ~1110-line `run(DATA)` closure: nothing was unit-testable in isolation,
`render()` tore down and rebuilt the entire SVG on every interaction, and state was one mutable
object written from ~30 sites.

**Restructuring was in scope** — modularity is graded and the tool will be maintained by others.
But correctness came first: a clean architecture that still assumes one issue is a failure. That
ordering still governs any remaining work; if the timebox forces a choice, ship correct behaviour
with honest notes on what was left coarse.

## Deliberately out of scope

Modifying or extending the shared MVs · bot/human classification · the real OCEL 2.0 tables · labels,
forks, reviews, review comments, branch/ref lifecycle · auth, rate limiting, XSS hardening · render
optimisation, virtualisation, canvas · bundler, framework, TypeScript · generalizing beyond the four object types · restyling away from Nocturne tokens.

Sub-logs are small. If a real one actually breaks the renderer, **report it** rather than
pre-optimising.

## Constraints

- Reproducible from a clean checkout against the pinned dataset.
- Record the MV refresh timestamp behind any figure used in the thesis.
- Query latency is the risk, not render latency.
