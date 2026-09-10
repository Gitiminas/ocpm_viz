# Architecture

The tool draws one sub-log — an `subLog` of issues, pull requests, commits and actors pulled
around a seed — as a timeline or as a relationship picture. This file covers the frontend: the
folders, the seams between them, how data moves, and the traps in the layout code. Everything
server-side is in `DATA_LAYER.md`.

## Stack and data path

Fixed stack: PostgreSQL → PostgREST → D3. No bundler, no framework, no TypeScript. Native ES
modules loaded straight from `index.html`; D3 7.8.5 from a CDN as the global `d3`; `d3-force`
3.0.0 vendored unmodified in `vendor/` because `layout/` must run in bare Node. `package.json`
has no dependencies at all. Tests are `node --test` (`npm test`), 894 tests over 35 files.

```
PostgreSQL  →  fe views  →  api.get_sublog  →  PostgREST  →  loadSubLog
                                                                        ↓
                                            model (index, bursts, groups) + state
                                                                        ↓
                                              layout (temporal | structural)
                                                                        ↓
                                                     render (SVG layers)
```

`loadSubLog(query) -> SubLog` is the sub-log data entry point, and
`loadDfg(query) -> DFG` (the whole-log directly-follows graph, for the Process page) is its one
sibling — nothing else above the data layer may fetch. Both take a transport, so the same code
path serves a local fixture and a live RPC; `data/source.js` picks which by `?source=`. Four
RPCs exist (`get_sublog`, `search_seeds`, `list_repos`, `get_dfg`); their shapes, the
`fe` views, the two admission rules and the evidence mapping are all in `DATA_LAYER.md`.

## Folder map

`model/`, `layout/`, `state/` and `stats/` are DOM-free. That is the seam that matters: every
function in them is importable and assertable in plain Node, so "how many nodes, in which lane,
in what order" is a test rather than a screenshot. If a function needs a DOM to be exercised, it
is in the wrong folder. `render/` is the only place that touches the document, and `main.js` is
wiring with no logic of its own. Exported names and signatures are in the modules themselves;
this table is the responsibility map.

| Module | Responsibility |
|---|---|
| `main.js` | Boot, control binding, `load` / `redraw` / `refreshStats`. Wiring only. |
| `data/loadSubLog.js` | The one entry point: transport → validate → normalize. Also `describeSubLog`, `summarizeSubLog`, `seedObjects`. |
| `data/api.js` | PostgREST transports: the RPC, seed search, repo list. `TRAVERSAL_DEGREE` 0–2, default 1. |
| `data/fixtures.js` | Serve a `{repo, seed}` query from `tests/fixtures/` via `catalogue.json`. |
| `data/source.js` | Fixtures or database behind one shape, chosen by `?source=`. Both async, so the branch never reaches `main.js`. |
| `data/seedQuery.js` | Parse and rank what is typed into "Start from". Shared by both sources, so the two searches cannot disagree. |
| `data/loadDfg.js` | The whole-log entry point: transport → `assertValidDfg` → `normalizeDfg`. No default transport — the source decides which. |
| `model/dfg.js` | DFG validation (closed vocabularies, nonnegative counts, `events ≤ occurrences`, per-type conservation in occurrences, no evidence on a succession), one-timestamp normalization, and the Process page's derivations: `deriveDfgToggles`, `filterDfg`, `dfgRangeScale`. |
| `layout/dfg.js` | The process map's arrangement: lane rows, lifecycle reading order, forward arcs above / rework below, loops, fanned cross bundles, `dfgEdgeWidth` (√, clamped, pinned to the unfiltered maximum via the `maxSuccessions` override). |
| `render/dfg.js` | The Process page's renderer: lane bands, activity marks, succession edges with widths and counts, hovercards (labels bound to the same card, hover targets in their own layer, thinnest topmost), focus dimming, and the notice carrying the filter's own arithmetic. |
| `model/subLog.js` | Shape validation (`findGraphProblems`), normalization, indexing. |
| `model/activities.js` | The closed vocabulary: 4 object types, 11 activities, 3 landmarks — plus `Push`, the process map's alone. |
| `model/evidence.js` | 17 link methods → `validated` / `extracted`. |
| `model/graph.js` | Adjacency and focus BFS (focus degree, max 2). |
| `model/bursts.js` | Commits grouped by `push_id`, size ≥ 2. |
| `model/commentBursts.js` | Runs of comments inside a window (default 1 day), fenced so a run never crosses a close or a reopen. |
| `model/commitGroups.js` | Commits grouped by the PR they reach; a commit is visible if any of its groups is. |
| `state/state.js` | The `st` object, the derived toggle vocabulary, and every visibility predicate. |
| `state/labels.js` | Type labels, so `state.js` derives toggle text without importing a renderer. |
| `state/presets.js` | Serialize, apply, encode, localStorage, built-in views. |
| `layout/engine.js` | `createLayout()` — the one place that knows two engines exist. |
| `layout/nodes.js` | Which nodes exist, in what order; rank assignment. |
| `layout/scales.js` | The temporal x scale, absolute and discrete; large-gap detection. |
| `layout/packing.js` | Bands and rows: which row an object occupies. |
| `layout/lanes.js` | Lane geometry from row counts. |
| `layout/anchors.js` | Where a link meets an object. One formula, one file. |
| `layout/structural.js` | Relationships mode's node and edge model, radii, arrow direction, brush maths. |
| `layout/layered.js` | Relationships mode, Rows: Sugiyama layers, barycentre ordering, row separation. |
| `layout/cluster.js` | Relationships mode, Clusters: balloon seed then d3-force; the shared force config, `forceFootprint`, `createDragSimulation`. |
| `render/timeline.js` | Owns the `<svg>`, its layers, `measure`/`render`, and `frame()`. |
| `render/nodes.js` | Lifecycle bars, sequence lines, marks, actor trails, burst handles. |
| `render/links.js` | Timeline links: gradients, evidence styles, fanning. |
| `render/structural.js` | The second, small renderer for relationships mode: edges, marks, hovercards, dragging. |
| `render/axis.js` | Ticks, UTC labels, gap annotations. Absolute mode anchors the left edge with the sub-log's start, since d3 ticks only inside the domain. The compressed-gap markings carry `data-tip="axis.gap"` plus a `data-tip-arg` (`gapTipArg`, pure) naming the exact span, so hovering one puts its story in the help strip. |
| `render/loading.js` | The loading overlay: what a page says while a sub-log is in flight. Waits before appearing, so a fast source never flashes one. |
| `render/minimap.js` `pan.js` `motion.js` | Overview and scroll; background pan when zoomed; settle and idle drift. |
| `render/legend.js` | `LEGEND_SECTIONS` as exported data, plus presence dimming. |
| `render/sidebar.js` `controls.js` `actorCard.js` `subLogCard.js` `stats.js` | The panels: lane and relationship rows, `renderDfgControls` (the Process page's masters, count range and activity rows), `renderDfgArtifacts` (the list a node card's tile fills: a sample of `total`, most recent first, each row a seed), presets and the hidden-state banner, actor profile, sub-log card, statistics page. |
| `render/theme.js` | Colours, shapes, glyphs, evidence styles. Every renderer reads them from here. |
| `render/format.js` | The one place a timestamp becomes text. All UTC. |
| `render/tooltip.js` `message.js` `helpStrip.js` | Tooltips, the "why it cannot draw" surface, the header help strip. |
| `help/tips.js` | Help texts as data: key → sentence. |
| `stats/metrics.js` | Durations, counts, gaps, outcomes. Pure functions over an `SubLog`. |

`render/` has no lane module for `actor`: an actor is an object without a lane, so it is drawn
by the sidebar, the actor card and its trail, never by `layout/lanes.js`. It is the only such
type: `repo` is not an object at all.

## Data flow

**Boot** (`main.js`, top level). Resolve elements by id. Mount the sub-log card, the help strip
and the two message surfaces. Build `createState()`, tooltip, actor card, minimap, timeline. Bind
the controls: degree stepper, zoom, brush, the facet/time/layout segments, wheel, scroll, section
headers, page tabs. Read the URL (`queryFromUrl()`) and apply `mode`, `layout`, `focus`,
`focusDegree` and `brush` *before* the first load. Create the source from `?source=`. Debounce
`resize` to `measure()` + `render()`. Then `listRepos()` → `reload(initialQuery)`.

**Load** (`load(query)`). `source.loadSubLog(query)` → `indexSubLog` → assign actor
colours → derive relationship groups, qualifiers, methods and commit groups → `resetToggles` →
apply `?preset` if present → clear focus, expanded bursts, nudges and brush (not on first load)
→ `timeline.setGraph` → render the sidebar → `measure()` → `redraw()` → `refreshStats()`.

**Render pipeline.** `render/timeline.js` calls `frame()` first — the one look at the mode before
layout, deciding how much surface the engine gets (temporal margin `{32,120,150,180}`, structural
margin 16 all round). Then `createLayout()` runs one of two engines and returns the same shape:
`nodes`, `nodeByObject`, `anchors`, `width`, `height`, and `kind` of `'temporal'` or
`'structural'`. Temporal: `buildNodes` → `filterNodes` → `assignRanks` → `createScales` → x →
`packRows` → `computeLaneGeometry` → y → `createAnchors`. Structural: `buildStructuralNodes` →
`filterNodes` → `buildStructuralEdges` over visible links → `layoutLayered` or `layoutCluster` →
apply nudges, returning `edges`, `extent`, `waypoints`, `footprints` and `anchorId` besides. The
renderers read `kind`, never `mode`.

**Visibility.** Decided in one file, `state/state.js`, as pure predicates: `isObjectVisible`
(lane on, not individually hidden), `isNodeVisible` (adds comment toggles and commit groups),
`isLinkVisible` (both endpoints visible, plus the relationship-pair, qualifier and method
toggles). `layout/` receives a predicate, not the state object, so it never learns about lanes
or hidden objects; `render/` calls the predicates rather than re-deriving them. `selectVisible`
applies the same rules to produce a filtered graph for the statistics page and the sub-log card;
`summaryForMode` beside it adjusts the card's summary to what is drawn: pinned actors, and in the
relationships mode one mark per object. `relControlAvailability` is the same predicates read the
other way: which relationship rows still govern a link that could be drawn. A row is inert (dimmed,
unclickable, skipped by its master) while nothing it governs would pass every *other* filter — a
pair under a hidden lane, a qualifier whose every link sits on a switched-off pair, a method no
visible link carries. Only the row's own bag is excluded, so a row switched off by hand can always
be switched back on. The Process page has the same rule in `dfgControlAvailability` over
`filterDfg`'s toggles. Adding a filter is an edit to one file and its tests.

## State

`createState()` (`src/state/state.js:35`) carries the full defaults.

| Key | What it holds |
|---|---|
| `k` | Horizontal zoom, 0.55–14 |
| `mode` | `absolute` / `discrete` / `relationships` |
| `structuralLayout` | `layered` / `cluster` |
| `timeBrush` | `[from, to]` as fractions of the extent, relationships mode |
| `nodeNudges` | Drag offsets, per arrangement: `Map<layout, Map<nodeId, {dx, dy}>>` |
| `focus`, `focusDegree` | Focused object and BFS hops (1–2) |
| `actors` | Pinned actor ids |
| `lanes`, `showComments`, `laneOpen` | Lane masters, comment visibility per lane, sidebar disclosure |
| `hiddenObjects`, `hiddenCommitGroups` | Per-object and per-group hiding |
| `relPairs`, `qualifiers`, `methods`, `relOpen` | Link toggles and their disclosure |
| `expandedBursts`, `expandedCommentBursts`, `commentWindowDays` | Folding |

**Presets.** `serializeState` writes a v2 snapshot of `mode`, `structuralLayout`, `lanes`,
`showComments`, `hiddenObjects`, `hiddenCommitGroups`, `relPairs`, `qualifiers`, `methods`. It
deliberately does not save zoom, scroll, focus, bursts, nudges or brush — those are where you
were looking, not what you were looking at. Snapshots live in localStorage under
`ocpm_viz.presets.v1`, and four built-ins ship: Everything, Validated links only, Lifecycle
without commits, Commit integration focus. `presetUrl` base64url-encodes a snapshot into `?preset`.

**URL parameters**, all for reproducibility: `source`, `repo`, `seed`, `fixture`, `degree`,
`preset`, `page`, `mode`, `layout`, `brush`, `focus`, `focusDegree`. `scripts/shot.mjs` has a
flag for each of the view ones.

## Layout

### Temporal modes

`absolute` spends x on real time, linear over the first and last instants. `discrete` spends it
on rank: `assignRanks` gives one mark per node plus one per extra commit observation, sorted by
time then lane then id, one rank per distinct instant (marks at the same second share a column;
the sort decides how they stack in it), and events without a rank interpolate between rank
times. Both share everything else.

y is object identity. The issue and PR lanes partition objects into **bands** by lifecycle
overlap (`assignSubLanes`, greedy, a band reused once the previous occupant has ended), then
bump within a band on collision (30 px, i.e. the glyphs would touch; lifecycle marks are packed
first and comment nodes start on the row below them all). Words do not move marks: a lifecycle label is drawn only when the next mark on its row is
100 px away (`labelledMarks`, `render/nodes.js`), and comes back as zoom widens the spacing. The
commit lane is collision-only at 24 px, plus one extra row when a commit is observed more than once.
`ROW_HEIGHT` is 36.

`anchors.js` decides where a link lands: commit links attach to the drawn commit node, issue and
PR links to the object's band row at `xAt(object, time)` — the exact node x if a node sits at
that instant, otherwise the scale — clamped to the lifecycle. `endpoints` fixes one end and slides
the other: a commit is fixed at its node, so a PR → commit link's PR end slides to the commit's
moment; otherwise the source is fixed at its opening and the target slides. The slide runs over
**every** interval of the object (since 2026-09-10): inside the interval that contains the other
end's moment, else to the nearest close or reopen, so a PR opened during an issue's reopen meets
the reopen bar and one opened after the final close meets the final close mark (vscode #188934;
F15). It is its own file so that the formula is asserted in tests rather than checked by eye: the
anchor and the lifecycle bar must agree on which row an object occupies. Gaps over 24 hours are annotated on the discrete axis
(`findLargeGaps`), adjacent labels merged as `≈ N (k gaps)`.

### The structural mode

`relationships` releases the time axis so position can encode relationship structure instead.
Time is demoted, not deleted: it survives on edge arrowheads (at the temporally later end), on a
time brush, and in the hovercard. One node per object — commits inside a folded burst collapse to
one burst node — radii 15 / 12 / 6.5, burst radius `6.5 + √size · 2.2`.

Two arrangements share that node model. **Rows** (`layered.js`) is Sugiyama: layers
`issue → pull_request → commit`, dummy nodes for row-skipping edges, barycentre ordering over 8
sweeps, 6 alignment passes, then row separation. Deterministic, no forces. **Clusters**
(`cluster.js`) seeds a balloon layout from the levels — parent is the first linked upper-level
node, ring radii from `measure`, multi-parent nodes at the circular midpoint — then relaxes it
with d3-force until `alpha < alphaMin`.

Dragging runs a live simulation (`createDragSimulation`) rather than re-solving on every pointer
event: a solve without velocity lurches and stops dead. Free marks get home springs back to
where they stood when the gesture began, except the marks linked to the one in hand, which
follow it. The layout's pinned root stays pinned so the picture cannot rotate as a body.
`velocityDecay` (0.55) is the feel dial. What a drag leaves behind is an **offset**, not a
position: `state.nodeNudges` keeps `{dx, dy}` per node per arrangement, and `engine.js` adds it
to the computed `layoutX`/`layoutY` after every layout, so nudges accumulate against the fresh
answer rather than replacing it.

Known weak points. Clusters on a mesh are busy where Rows is clear: cross-linked PRs put
co-parent issues inside each other's neighbourhoods. The clustered drawing is round and the box
is wide, so about half the width goes unused; a non-uniform stretch would distort distances,
which is the one thing the arrangement claims. Dragging a fan into another fan can move that fan
a long way (~330 px measured), which is `FOOTPRINT_STRENGTH` keeping its promise. Labels collide
where PRs sit close, and a 34-fan hub is unreadable by label in either arrangement, though the
shape still reads.

### Traps in the structural layout

Read these before touching `layout/cluster.js` or `layout/layered.js`.

1. **The fit scales positions but not radii.** Anything measured after `centreInBox` is in
   post-scale pixels. Compared straight against a configured distance it reports overlaps that the
   fit reintroduced and link lengths that appear to run past their rest lengths. Divide by the fit
   scale first. `layoutCluster` scales cluster footprints by the same factor for this reason.
2. **`forceLink` mutates the link array**, replacing ids with node references. Sharing one array
   across two simulations silently binds the second to the first's nodes, and the second then
   moves its neighbours a fraction of the right distance (18 px instead of 370, measured). Both
   callers — `layoutCluster` and `createDragSimulation`'s caller in `render/structural.js` — build
   links fresh.
3. **d3-force charges are negative** (`CHARGE` is −400 / −400 / −35). A hand-written repulsion
   multiplying `charge_i × charge_j` turns two negatives into a large positive: a 14,000× force
   that flings neighbours off screen.
4. **Barycentre ordering is not monotonic.** `orderLayers` keeps the best arrangement *seen*,
   not the last one swept.
5. **Angles wrap.** `circularMean` sums unit vectors, and returns `null` when they cancel rather
   than picking a coin-toss midpoint. A circular ordering is cut at its largest gap.
6. **A custom force gets its nodes from `initialize`, and pairs belong there.** `forceFootprint`
   computes its constrained pairs once there, from the links and lanes. Per tick it would be
   O(n²) for nothing; outside, the caller would need to know which nodes the simulation resolved.
7. **A forward chain only closes gaps that are too small.** `separateRow` in `layered.js` pushes
   right, which cannot narrow a gap alignment left too wide, so a row can measure 1400 px in a
   980 px box with every gap legal, and relationships mode does not scroll sideways, so the
   overflow is lost without a trace. A right-to-left compression pass from the box edge guards it,
   plus a mean-drift correction undoing the chain's rightward bias. The trigger is
   order-versus-alignment conflict: a test case needs a commit shared between the *second* and
   the last pull request, not the first and the last.
8. **The surface is measured when the layout runs, so the chrome must already be final.** Hide or
   show anything in the chart column after the layout has run — the minimap from `onRendered`, say
   — and nothing errors: the picture is simply half the size it has room for, and every Node-side
   measurement says it is fine. `markMode` runs first for that reason; keep it that way. The
   banner and the brush change the column's height too.
9. **Headless Edge lays out in a viewport ~90 px shorter than `--window-size`, then captures at
   the full size.** A real browser fires `resize` and re-renders; a screenshot does not, so a
   fitted drawing is ~10% smaller in a shot. Compare fill between shots, never against the box.

## Rendering

One `<svg>` in `#chart`, drawn into ordered layers: `bg, seq, link, halo, preview, node, label,
axis`. `preview` exists for marks that belong to a pointer rather than to state — an actor's
trail while their sidebar row is hovered. It is written without a re-render and cleared by the
next `render()`, so a preview cannot outlive the positions it was drawn against.

Encoding lives in `theme.js` and is explained by `legend.js`. In summary: issue is a circle, pull request a diamond, commit a square,
each in a per-object shade; comment marks are the same shape hollow; landmarks carry a ring
(solid for `IssueClosed` and `PullRequestMerged`, dotted in the extracted colour for the
heuristic `PullRequestMergedOffPlatform`, dashed grey for a closed-unmerged PR); validated links
are solid 2.6 px, extracted dashed 1.6 px at 0.7 opacity.

`legend.js` holds `LEGEND_SECTIONS` as exported data rather than markup, so "is every drawn mark
explained?" is answerable without a DOM. Every mark carries a `data-legend` key and
`tests/legend.test.js` fails in both directions: a mark with no row, or a row naming nothing
drawn. The legend renders from `redraw()` rather than on load, because it **dims** rows whose
marks are absent instead of removing them, so "the data has none" and "you switched it off"
stay distinguishable.

**Link fanning.** When two links would be drawn on top of each other, `computeLinkOffsets` in
`src/render/links.js` bundles them (shared endpoint at either end, the other end within 2 px) and spreads them
5 px apart. Without it, one commit belonging to two overlapping pull requests draws the nearer
link as a strict sub-segment of the further one, and the buried link — the **extracted** one,
dashed with its `?` badge — disappears under a solid stroke, so a viewer sees one confident
connection where there are two. Fixture F5 holds that shape. The offset grows linearly with
bundle size, so it also needs a cap: unbounded, a vscode PR with 35 commits pushed in an hour
smears its shared endpoint across 175 px and the picture implies 35 pull requests where the
caption says one. `MAX_FANNED_LINKS = 6` is the cap, and a larger bundle draws as one coincident
line carrying a `×N` badge (`data-legend="link-crowded"`). Nothing visible is lost: at 35 no
single line is distinguishable anyway, and every commit is drawn in the commit lane regardless.
Declaring the count follows the standing rule that anything hidden is declared. **Still
unresolved:** event glyphs stack without bound, and a kubernetes issue with 288 comments in a
short window allocates 52 bands and a 5,654 px SVG. That is crowding rather than deception; the
likely fix is the burst-collapse treatment commits already have.

## Statistics

Every metric is computed in JS over `selectVisible(graph, state, groupsByCommit)`, so hiding
comments changes the gap figures, and hiding a lane changes the counts.
`stats/metrics.js` is pure functions over an `SubLog`; `render/stats.js` only presents them.
SQL is reserved for figures spanning data that is *not* loaded, such as link coverage per
repository. Precomputing sub-log metrics server-side would answer "comments hidden → gaps
unchanged" silently, which is the failure the rule exists to prevent.

## Extending

**A lane.** Lanes are `LANE_TYPES` in `model/activities.js`, ordered `issue, pull_request,
commit`. A new one needs an entry there, a colour, shape and shade list in `render/theme.js`, a
legend row in `render/legend.js` (the test fails otherwise), defaults in `state.lanes` and
`state.laneOpen`, and a band rule in `layout/packing.js` if it should get sub-lanes rather than
collision-only rows. Object types are closed at four, so ask before starting.

**An activity.** Add a key to `ACTIVITIES` in `model/activities.js` with `label`, `short`,
`objectTypes` and `landmark`. Landmarks also need a ring style and a legend key. Activity
vocabulary is a modelling decision, not an implementation detail: ask first.

**A link method.** Add it to `LINK_METHOD` in `model/evidence.js` and classify it in
`classifyMethod` as `validated` or `extracted`. `deriveMethods` picks it up from the payload
automatically, so the sidebar toggle and `isLinkVisible` need no change. The method must also
exist upstream in the `fe` views — see `DATA_LAYER.md`.

**A tip.** Every control, row and mark carries a help text. Add `data-tip="<key>"` to the
control (marks use `data-legend`, which maps to `legend.<key>`) and the sentence to the table in
`src/help/tips.js`. `tests/tips.test.js` fails when a key has no text or a text has no key. No
browser `title=` attributes beside a tip.

**A page.** (Stats predates this entry; the Process page is what wrote it.) A page needs: a
`.pageTab` button with `data-page` and a `page.<name>` tip — inside `#pageGroup` if it shows the
loaded sub-log (Trace and Stats share one sliding indicator there, placed by `placePageThumb`),
or standalone with `.solo` under the "Whole log" caption if it does not (Process, whose
selection switches the group's indicator off); a `<main>` sibling of the others,
`position:relative`, holding its own loading overlay and a message surface that PRECEDES its
content root as a sibling (`tests/shell.test.js` pins the ordering); a sidebar block beside
`#timelineSidebarSections`; an entry in `main.js`'s `PAGES` map with an `onShow` that measures
only once the page is visible (trap #8); the `?page=` whitelist in `queryFromUrl`; and a branch
in the resize handler. `presetUrl` already writes any non-timeline page.

**A mode or arrangement.** A temporal mode is a new branch in `layout/scales.js` plus an entry
in `TEMPORAL_MODES`. A structural arrangement is a new module returning `{positions, waypoints,
…}`, an entry in `STRUCTURAL_LAYOUTS`, and a branch in `createLayout`. Either way the branch
belongs in `layout/engine.js` and nowhere else — the renderers read `layout.kind`, and adding a
second `if (mode === …)` to a renderer is how the seam gets lost.

## Out of scope

Bot and human classification, the `ocel_*` views, the real OCEL 2.0 tables, labels, forks,
reviews, review comments, branch and ref lifecycle. Modifying or extending the shared upstream
views (indexes on them belong to this project; see `DATA_LAYER.md`). Auth, rate limiting and XSS
hardening; render optimisation, virtualisation and canvas; a bundler, framework or TypeScript;
generalizing beyond the four object types; restyling away from the Nocturne tokens.

Sub-logs are small. If a real one breaks the renderer, report it rather than pre-optimising.
