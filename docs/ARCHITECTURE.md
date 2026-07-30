# Architecture

Intent, boundaries and rationale. Not a description of the current code — for that see
`MOCKUP_OVERVIEW.md`.

## Layers

```
GH Archive dumps
      │  (ingest — shared infrastructure, not this project)
      ▼
  base tables  ──►  17 materialized views  ──►  adapter views  ──►  PostgREST ──►  D3
  actor/org/         payload extraction         OCEL-shaped        get_object_    browser
  repo/event         FROZEN, shared             MINE               graph

                    └──── owned by others ────┘  └──────── this thesis ────────┘
```

**Base tables + 17 MVs — frozen.** Shared research infrastructure. Contract snapshot in
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
    fixtures.js        load an ObjectGraph from a local file
    api.js             load an ObjectGraph from PostgREST (added later)
  model/
    objectGraph.js     shape validation; fail loudly on a malformed bundle
    activities.js      the closed activity vocabulary + milestone set
    evidence.js        validated / extracted classification
    graph.js           crossAdj construction, focus BFS
  layout/
    scales.js          the three time modes and the coordinate dispatcher
    packing.js         per-object row and sub-lane allocation
    lanes.js           lane geometry
  render/
    timeline.js  nodes.js  links.js  axis.js  minimap.js  tooltip.js  legend.js
  state/
    state.js           the st object
    presets.js         serialize, save, load, URL encode
  stats/
    metrics.js         durations, counts, gaps — pure functions over an ObjectGraph
tests/
  fixtures/            F1 … F10
  *.test.js
```

**The test that the seams are right:** every module under `model/`, `layout/`, `stats/` must be
importable and exercised without rendering anything. If a function needs the DOM to be tested, it is
in the wrong folder.

This structure is a proposal, not settled — see open question O8.

## Object-centric implications for the renderer

Not single-case process mining, so the usual vocabulary does not transfer:

- No global directly-follows graph — DFGs are per object type.
- **Divergence and convergence** must be visible rather than silently flattened. One event touching
  several objects, and one object touching many events, are exactly what OCPM exists to show.
- Flattening to a classical log is a *labelled view*, not the data model.
- The sub-lane rule (decision 3) is the layout consequence: an object's identity must stay visually
  traceable across the whole timeline, and links must stay readable when N > 1 on both ends.

## Known structural debt in the current app

One ~1110-line `run(DATA)` closure: nothing is unit-testable in isolation, `render()` tears down and
rebuilds the entire SVG on every interaction, and state is one mutable
object written from ~30 sites.

**Restructuring is in scope** — modularity is graded and the tool will be maintained by others. But
correctness comes first: a clean architecture that still assumes one issue is a failure. If the
timebox forces a choice, ship correct behaviour with honest notes on what was left coarse.

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
