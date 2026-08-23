> # ⚠️ HISTORICAL — describes code that no longer exists
>
> This document dissects the original `run(DATA)` closure in `OCEL Timeline.dc.html`,
> the pre-generalization mockup. That app has been superseded by `index.html` plus the
> ES modules under `src/`, and every line number below refers to a file that is kept
> only as a frozen reference.
>
> **It is not maintained and must not be read as current.** For the code as it is now,
> see `ARCHITECTURE.md` and the modules themselves.
>
> It is kept because it is thesis material rather than documentation: it is the record
> of the starting point, and §10 — the overfit inventory — is the problem statement the
> generalization work was measured against. Every item in that inventory has since been addressed.

# The hardcoded mockup — architecture overview (historical)

Reference description of `OCEL Timeline.dc.html` as it exists today: what it renders, how it is
built, what every function does, and which parts are real versus mocked.

> ⚠️ **Snapshot, not a contract.** Line numbers are accurate as of commit `<sha>` and go stale the
> moment Task 1 starts editing. Read this once for orientation; do not load it into every session,
> and do not trust a line number without checking. §10 (overfit inventory) and §11 (what is worth
> keeping) are judgments rather than descriptions, and survive the code changes — those are the
> parts worth keeping current.

**One-line summary:** a single-file D3 timeline that renders one hardcoded OCEL sub-log
(vscode issue #242864 → PR #243221 → 32 commits) as three horizontal type lanes with cross-lane
relationship edges, three switchable time scales, focus/degree exploration, and a secondary
statistics page.

---

## 1. Files and runtime

| File | Role |
|---|---|
| `OCEL Timeline.dc.html` | 1317 lines. Markup + CSS + the entire app. Contains the inlined data blob. |
| `support.js` | 1841 lines. **Generated** `dc-runtime` bundle — a small React-based harness that parses `.dc.html` files. Header says "do not edit". Not application code. |
| `_ds/nocturne-*/styles.css` | "Nocturne" design system: CSS custom properties for colour, spacing, radius, shadow, type. |
| `ocel_data.json` | 36 KB. Standalone copy of the same data that is inlined in the HTML. |
| `.thumbnail` | Claude Design artifact. Not application code. |
| `screenshots/` | Reference renders of the app before any generalization work. The regression baseline for fixture F1. |

There is **no** second copy of the application. An earlier `new_code.html` was input to Claude
Design during mockup creation, not part of the project.

**External dependencies:** D3 v7.8.5 (CDN), JetBrains Mono + Inter (Google Fonts). No build step, no
bundler, no package manager.

### Execution path

```
support.js  (dc-runtime)
   ↓ parses
<x-dc>  …markup…  </x-dc>
<script type="text/x-dc" data-dc-script>
   class Component extends DCLogic {
     componentDidMount() { initOcel(); }     ← single entry point
     renderVals() { return {}; }
   }
   function initOcel() {
     var OCEL_DATA = { …36 KB inlined… };    ← L199, one line
     run(OCEL_DATA);
   }
   function run(DATA) { …~1110 lines, the whole app… }
```

`run(DATA)` is one closure containing state, helpers, data derivation, layout maths, SVG rendering,
interaction wiring and the statistics view. It ends by calling `go()` → `measure()` → `render()`.

---

## 2. The data

### Shape

```
OCEL_DATA = {
  meta:    { title, repo, repo_id, case, orientation, activity_scope,
             object_types[4], qualifiers[7],
             data_honesty{ commit_time, inferred_edges, validated_edges, author_note },
             burst{ id, push_id, n_commits, note } },
  objects: [ { id, type, label, repo, t_start, t_end, time_semantics, vmap{…} } ],
  events:  [ { id, activity, time, object_id, actor_id, repo, comment, attrs{…} } ],
  links:   [ { source, target, qualifier, evidence, method } ]
}
```

`vmap` is a per-type attribute bag:

| Type | `vmap` keys |
|---|---|
| `issue` | `issue_number`, `issue_id`, `title`, `note_id` |
| `pull_request` | `pr_number`, `pull_request_id`, `title`, `head_sha_open`, `head_sha_merge` |
| `commit` | `commit_sha`, `push_id`, `commit_message`, `commit_author_name`, `ref`, `in_burst`, `burst_id` |
| `actor` | `login` |

### Contents of this particular example

| | Count |
|---|---|
| Objects | **38** — 1 issue, 1 PR, 32 commits, 4 actors |
| Events | **42** — 4 issue, 6 PR, 32 commit |
| Links | **76** — 42 event→actor, 34 object→object |
| Time span | 2025-03-07 05:15 → 2025-03-19 14:08 UTC (~12 days) |
| Actors | `connor4312` (nearly everything), `Tiberriver256`, `johnib`, `iwangbowen` |

**Activities present:** `IssueOpened`, `IssueCommented`, `IssueClosed`, `PullRequestOpened`,
`PullRequestMerged`, `PullRequestClosed`, `CommitObserved`.
**Mapped in code but absent from the data:** `IssueReopened`, `PullRequestReopened`.

**Object→object link breakdown:**

| Qualifier | Evidence | Count | Method |
|---|---|---|---|
| `related_issue` | validated | 1 | PR body "Closes #242864" |
| `referenced_pull_request` | validated | 29 | `ref_match` (branch ref) |
| `referenced_pull_request` | validated | 2 | PR head-SHA appears in PushEvent |
| `referenced_pull_request` | inferred | 1 | merge commit message |
| `referenced_issue` | inferred | 1 | commit message "Refs #242864" |

> ⚠️ **Data inconsistency worth checking:** `meta.burst.n_commits` is **21**, but only **20** commit
> objects carry `in_burst: true`. The burst glyph displays the metadata figure (21) while folding 20
> members.

> The `data_honesty` block is a genuinely good feature of this data: it records that commit times are
> *first-seen-in-PushEvent* rather than real git timestamps, that message-inferred edges are ~9.38%
> reliable, and that the commit author was taken from the branch ref owner. These caveats surface in
> tooltips.

---

## 3. Function map

Line numbers approximate. Grouped by responsibility rather than file order.

### Entry & data derivation (L198–262)

| Function / block | Does |
|---|---|
| `initOcel()` | Declares the inlined blob, calls `run()` |
| `run(DATA)` | The entire application closure |
| — L203 | Clears `#chart`, `#actors`, `#legend`, `#tracks`, `#relationships` |
| — L204–211 | Colour constants (`ISSUE_C`, `PR_C`, `COMMIT_C`, `INFER_C`), `TYPE` map (colour/label/shape per type), `QUAL` map (colour/label per qualifier), `ACTPAL` (6-colour actor palette) |
| — L215–216 | Parses `t_start`/`t_end` into `o.ts`/`o.te`; `e.time` into `e.tt`. Builds `byId` index |
| — L218–229 | Derives `evByObj`, **`issueObj`/`prObj` (the `[0]` singletons)**, `commitObjs`, `nonBurst`, `burstMembers`, `commitActor`, `actors` with colour + event count, `actColor` |
| — L231–245 | Builds `crossAdj` (undirected object adjacency from non-actor links), then folds burst-member edges onto the synthetic burst id so focusing either lights up the other |
| `linkPairKey(l)` | `evidence + '_' + sorted(types)` → the relationship-toggle key |
| `activeLanes()` | `ALL_LANES` filtered by `st.tracks` |
| `buildPosMap(arr)` | `{id: {x,y}}` snapshot, used for position tweening |

### Search combos (L265–299)

| Function | Does |
|---|---|
| `setupCombo(input, dropdown, options, initialLabel, onSelect)` | Generic filterable dropdown: renders matches on focus/input, hides on blur, supports `disabled` rows with a "no data" pill |

Called twice. **Neither call passes `onSelect`, so both are inert.** The repo combo lists
`microsoft/vscode` (active) plus `facebook/react` and `kubernetes/kubernetes` marked disabled. The
object combo lists the issue, the PR and all 32 commits.

### Time scales (L301–343)

| Function | Does |
|---|---|
| — L302–308 | Collects all event + object timestamps into `uniq` (sorted, deduped); precomputes `cpos`, the cumulative compressed-position array: each gap contributes `BASE (9 min) + min(gap, CAP (3 h))` |
| `plotW()` | `basePlotW * st.k` |
| `xReal(t)` | Linear real-time scale |
| `xComp(t)` | Compressed scale — interpolates within `cpos`, so long idle gaps shrink to a fixed maximum |
| `xOrdinalTime(t)` | Maps a timestamp onto rank positions via `d3.bisectLeft` (for elements without a rank) |
| `X(t, node)` | **Mode dispatcher** — `real` → `xReal`, `highlights` → `xComp`, `ordinal` → rank position or `xOrdinalTime` |
| `humanDur(ms)` | "≈ 3 days" style approximate duration (used for gap annotations) |
| `fmtDuration(ms)` | "2d 4h" style exact duration (used for stats) |

### Lane geometry (L346–356)

| Function | Does |
|---|---|
| `layout(maxRow, lanes)` | Stacks lanes vertically; sets `laneTop`, `contentTop`, `laneH` per lane; returns total height. `ROWH 36`, `PADTOP 40`, `PADBOT 32` |
| `anchorY(o)` | Y coordinate for an object's link endpoint |

Margins: `{top:32, right:120, bottom:150, left:180}`, `basePlotW` 1100 or measured.

### Node construction (L360–404)

| Function | Does |
|---|---|
| `buildNodes()` | Produces the node array. **Separate hardcoded branches** for `issueObj` events, `prObj` events, and commits. Swaps burst members for one synthetic burst node when `st.collapsed`. In `highlights` mode, additionally runs the *run-grouping* pass below |
| — `flushRun()` | Inside `buildNodes`: collapses consecutive non-anchor commits into a single group node (`isGroup`, `groupCount`, `members`). Anchors are the first, last, burst and in-burst commits. Expanded groups (`st.expandedGroups`) render members individually with a dashed bounding box |
| `actTitle(e)` | Activity → long label ("Issue opened") |
| `shortTitle(e)` | Activity → short label ("opened") |
| `login(aid)` | Actor id → login string |

### Tooltip system (L406–485)

| Function | Does |
|---|---|
| `unpinTip()` | Unpins and hides |
| `pinOpen(ev, builder)` | Right-click handler — pins the tooltip, makes it interactive |
| `posTip(ev)` / `posTipIfFree(ev)` | Cursor-relative placement with viewport-edge flipping; the latter is a no-op while pinned |
| `copyToClipboard(text, el)` | Writes to clipboard and shows a transient "Copied" toast |
| `attachCopyHandlers()` | Wires close button, title-click-to-copy and row-click-to-copy (pinned only) |
| `card(o, ev)` | **The tooltip renderer.** Builds accent bar / kicker+glyph / title / key-value rows / optional footnote / pin hint |
| `hideTip()` | Hides after a 150 ms delay unless pinned |
| `esc(s)` | HTML escaping |
| `gly(shape, colour)` | Returns a small inline SVG glyph string (circle / diamond / square / line) for HTML contexts |
| `fmt(d)` | "Mar 07, 2025 · 05:15:54" |
| `symbol(g, shape, s, fill, stroke, sw)` | Appends a real SVG shape to a D3 selection (chart contexts) |

### Focus (L492–496)

| Function | Does |
|---|---|
| `focusSet()` | **BFS over `crossAdj`** from `st.focus` out to `st.focusDegree` (max 2). Returns a `{objectId: depth}` map. This is the mechanism that should be promoted to *sub-log selection* |
| `objDim(objId, fs)` | Returns opacity `0.15` for objects outside the focus set, else `1` |

### Main render (L498–801)

`measure()` reads the scroll container width. `render()` then executes in this order:

1. Build nodes, filter by lane toggles and comment toggles
2. Assign `rank` by sorting on time (drives ordinal mode); store `rankOrder`, `rankMax`, `rankTimes`
3. Compute `n.x` via `X()`
4. **Row packing** — per lane, greedily bump `n.row` while any placed node in that row is within
   the collision threshold (`24 px` commits, `100 px` issue/PR). Comments start at row 1
5. `layout()` → `n.y`; rebuild `nodeByObj`
6. Size the SVG; compute `focusSet()`; clear all layers
7. Build a `<linearGradient>` in `<defs>` **per link** (`grad_<source>_<target>`)
8. Lane backgrounds, separators, sticky lane labels with type glyph and sub-label
9. Dashed bounding boxes around expanded highlight groups
10. **Axis** — tick generation per mode, label formatting, collision merge, stagger, and (ordinal
    only) shaded gap bands annotated with `humanDur` where a gap exceeds 24 h
11. Issue/PR lifecycle bars (`t_start` → `t_end` rounded rects); ordinal mode adds a duration label
12. Per-lane sequence curves connecting consecutive nodes (dotted where a comment is involved)
13. **Relationship edges** — filtered by lane and `st.relPairs`; while collapsed, burst-member links
    are deduplicated onto the burst node (`burstAggSeen`); inferred edges are dashed with a "?"
    badge at the midpoint; a wide invisible hit-path carries hover/right-click
14. Actor halos and trails for actors selected in `st.actors`
15. Sparse commit labels (`showLbl` — only if >64 px from the previous label)
16. **Nodes** — group / burst / event glyphs, milestone rings, labels; click, hover and contextmenu
    handlers; optional 450 ms position tween from `pendingTweenFrom`
17. Burst collapse handle (the "−" control) when expanded
18. Zoom button disabled states, `syncLaneSticky()`, `renderMinimap()`

**SVG layer order** (z-order, back to front): `gBG`, `gSeq`, `gLink`, `gHalo`, `gNode`, `gLbl`, `gAxis`.

Every `render()` clears and rebuilds all layers (`selectAll('*').remove()`).

| Helper inside `render` | Does |
|---|---|
| `exactNodeX(objId, t)` | Finds the x of the node matching an object and exact timestamp |
| `anchorX(o, t)` | Link endpoint x — node position for commits, exact node for issue/PR, else `X(t)` |
| `pushT(t)` | Collects highlight-mode tick candidates |

### Post-render & interaction (L802–1225)

| Function / block | Does |
|---|---|
| `syncLaneSticky()` | Translates lane labels by `scrollLeft` so they stay pinned; thins the accent bar once scrolled |
| `nodeTip(ev, n)` | Builds the right tooltip per node kind (group / burst / commit / event) |
| `update()` | Updates the focus readout, then `render()` |
| `showDegreeStepper(x,y)` / `hideDegreeStepper()` / `updateDegreeStepper()` | The floating "Deg 1/2" pill shown next to a focused node |
| — L844–868 | Actor sidebar rows: colour dot, login, event count, profile button; click toggles the actor trail; plus a search filter |
| `actorActivity(a)` | Assembles that actor's events + commits into a sorted list |
| `openActorCard(a, anchorEl)` | Actor profile popover — header with GitHub link, then a **blurred fake list** with a "Look up user activity" prompt; clicking shows a 650 ms fake spinner before rendering the real list |
| `legendHighlight(key, on, col)` | Hovering a legend row finds all `[data-legend="key"]` elements, applies drop-shadow glow, thickens strokes and stashes original attributes in `dataset` for restore |
| — L955–972 | Builds the 6 legend rows (issue / PR / commit / validated link / extracted link / comments) |
| `renderMinimap()` | Draws all nodes as dots on a 40 px strip, plus a draggable viewport rect and two drag-to-zoom edge handles |
| `invertPx(px)` | Pixel → timestamp (mode-aware); used to keep an anchor point fixed while handle-zooming |
| `apply/move/end` | Inside the handle-drag: rAF-throttled resize that recomputes `st.k` and `scrollLeft` to preserve the anchor edge |
| — L1060–1078 | Scroll listener: re-syncs sticky labels and the minimap viewport without a full re-render |
| — L1081–1125 | Track rows: per-lane checkbox, chevron, and a nested "Comments" sub-toggle for issue/PR |
| — L1129–1180 | Relationship rows: two groups (validated / extracted), each with a master checkbox supporting **indeterminate** state and per-object-pair sub-toggles that auto-disable when a required lane is off. `relSyncFns` keeps them in sync with lane toggles |
| — L1183–1191 | Generic collapsible sidebar sections |
| `setK(v)` | Clamped zoom setter (`MINK 0.55`, `MAXK 14`); wired to the +/−/reset buttons and Ctrl+wheel |
| — L1198–1207 | Mode segmented control; captures a position map first so the switch animates |
| — L1211–1225 | Page tabs — swaps `#timelinePage`/`#statsPage` and the matching sidebar section |

### Statistics page (L1227–1305)

| Function / block | Does |
|---|---|
| `renderStats()` | Computes 9 metric cards and a 6-item milestone list, all assuming exactly one issue and one PR |
| — L1283–1300 | Dashboard visibility checkboxes, a disabled "Activity heatmap · Soon" row, and a "•••" more indicator |
| — L1301–1305 | **`fakeHeatmap`** — 130 divs filled with `Math.random()` colours, rendered blurred behind an "In progress" overlay |

**The 9 metrics:** issue open→close · PR open→merge · issue→first commit · issue→PR opened ·
PR merge→issue close · commit count + unique authors · comment counts (issue vs PR) · actor count ·
link counts (validated vs extracted).

**The 6 milestones:** issue opened, first commit, PR opened, last commit, PR merged, issue closed.

### Lifecycle (L1307–1312)

`go()` = `measure()` + `render()`. A debounced (150 ms) resize listener calls it.

---

## 4. State model

One mutable object, `st` (L251–254), mutated from roughly 30 call sites:

| Key | Values | Meaning |
|---|---|---|
| `k` | 0.55 – 14 | Horizontal zoom multiplier |
| `mode` | `real` \| `highlights` \| `ordinal` | Time scale |
| `collapsed` | bool | Burst folded? |
| `focus` | object id \| null | Focused object |
| `focusDegree` | 1 – 2 | BFS depth from focus |
| `actors` | `Set` | Actors whose trails are shown |
| `tracks` | `{issue, pull_request, commit}` | Lane visibility |
| `showComments` | `{issue, pull_request}` | Comment visibility per lane |
| `trackOpen` | `{issue, pull_request, commit}` | Sidebar sub-row expansion |
| `relPairs` | 4 keys | Per evidence×type-pair link visibility |
| `relOpen` | `{validated, inferred}` | Sidebar group expansion |
| `expandedGroups` | `Set` | Which highlight-mode commit groups are expanded |

Module-level companions: `lastNodes`, `nodeByObj`, `rankOrder`/`rankMax`/`rankTimes`,
`pendingTweenFrom`, `pinnedTip`, `mmDrag`/`mmResizing`, `relSyncFns`.

---

## 5. Visual encoding

| Channel | Encoding |
|---|---|
| Lane (y) | Object type — issue, pull request, commit |
| Position (x) | Time, under the active scale |
| Shape | circle = issue · diamond = pull request · square = commit |
| Colour | issue = `--color-accent` (blurple) · PR = orange `oklch(78% 0.11 68)` · commit = cyan `oklch(76% 0.09 205)` · inferred = `oklch(78% 0.13 45)` |
| Size | Comments render smaller (r 6) and hollow; events larger (r 8) and filled |
| Ring | Milestone events (`IssueClosed`, `PullRequestMerged`) get a halo ring |
| **Line style** | **solid = validated link · dashed + "?" badge = inferred link** · dotted = comment sequence |
| Stroke width | validated 2.6 · inferred 1.6 |
| Link colour | Gradient from source type colour → qualifier colour |
| Opacity | 0.15 when outside the focus set |
| Actor | One of 6 palette colours, as a ring + dashed trail |

---

## 6. The three time modes

| Mode | Scale | Ticks |
|---|---|---|
| **Real** | Linear in real time | `d3.scaleTime().ticks()`, count scaled by zoom (6·k, capped 3–200) |
| **Highlights** | Compressed — each inter-event gap contributes `9 min + min(gap, 3 h)`, so idle periods shrink | Only at milestones: open/close per lane, out-of-span comments, first/last commit, burst |
| **Ordinal** | Equal spacing by event rank; real durations discarded | ≤9 evenly spaced; gaps >24 h drawn as shaded bands labelled with the true duration |

Highlights mode additionally applies the **run-grouping** pass, folding consecutive unremarkable
commits into count badges.

---

## 7. Two aggregation mechanisms

**Burst (bulk push).** Data-driven from `meta.burst`. When `st.collapsed`, the 20 in-burst commits are
replaced by one synthetic node labelled with `n_commits`; their links are deduplicated onto it via
`burstAggSeen`; `crossAdj` was pre-folded so focus propagates correctly. Expanding reveals members
plus a "−" handle to re-collapse. **Hardcoded to exactly one burst, with a literal timestamp
(`BURST_T`, L214).**

**Highlight groups.** Computed, not data-driven. Only in highlights mode. Consecutive commits that
are not anchors (first, last, burst, in-burst) collapse into a dashed count badge, expandable per
group.

Both use `pendingTweenFrom` + `buildPosMap()` for a 450 ms FLIP-style position transition.

---

## 8. Mocked or incomplete

| Element | Status |
|---|---|
| Repo selector | `microsoft/vscode` active; `facebook/react` and `kubernetes/kubernetes` present but disabled with a "no data" pill |
| Repo & object selectors | Populated and filterable, but **no `onSelect` is passed** — selecting does nothing |
| Actor profile card | Blurred fake rows + "Look up user activity" prompt; a 650 ms fake spinner precedes the real list |
| Activity heatmap card | `Math.random()` grid, blurred, with an "In progress / This dashboard isn't built yet" overlay |
| Dashboards sidebar | Real toggles for 2 cards; a disabled "Activity heatmap · Soon" row; a "•••" placeholder |
| Focus degree | Capped at 2 |

---

## 9. Notable implementation details

- **Remount guards.** Four `window.__ocel*Wired` flags (`Tip`, `Resize`, `ActorCard`, `Scroll`)
  prevent duplicate global listeners, because `componentDidMount` may fire more than once.
- **Tick label collision handling.** Labels within 14 px merge (sharing a date prefix where
  possible); labels closer than 110 px in non-real modes stagger between two rows; seconds appear
  only where a minute-level label would collide.
- **Sticky lane labels** are translated by `scrollLeft` rather than using CSS sticky, since they live
  inside the SVG.
- **One gradient per link** is created in `<defs>` on every render.
- **Right-click pins tooltips**, making rows clickable to copy — a genuinely useful affordance.
- **Legend hover highlighting** works by tagging rendered elements with `data-legend` and stashing
  original stroke attributes in `dataset` so they can be restored.
- **Minimap handle-drag zoom** keeps the opposite edge time-anchored by inverting pixels back to
  timestamps (`invertPx`) and recomputing `scrollLeft` — the most intricate interaction in the file.

---

## 10. Overfit inventory

Everything that assumes *this* sub-log. This is the work list for generalization.

| # | Site | Problem |
|---|---|---|
| 1 | L219–220 | `issueObj`/`prObj` take `filter(...)[0]` — **first** issue and PR; all others silently dropped. Threaded through `buildNodes`, highlights ticks (L584–611), lane sub-labels (L559), `renderStats` |
| 2 | L214 | `BURST_T = parse('2025-03-10T18:32:11Z')` — a literal timestamp in source |
| 3 | L213, 237–245, 683–700, 780–794 | Single-burst assumption throughout |
| 4 | L399–403 | Hardcoded activity→label maps; unmapped activities render as raw enum strings |
| 5 | L363, 365 | Milestone detection by literal compare (`activity==='IssueClosed'`, `'PullRequestMerged'`) |
| 6 | L261 | `ALL_LANES` fixed (acceptable — the four object types genuinely are closed) |
| 7 | L247–250 | `REL_GROUPS` enumerates exactly 4 evidence×type-pair combinations |
| 8 | L290–298 | Selector options hardcoded; no `onSelect` |
| 9 | L1227–1281 | `renderStats()` entirely single-issue/single-PR |
| 10 | L1301–1305 | `Math.random()` heatmap |
| 11 | L215, 662 | One `t_start`/`t_end` pair per object — cannot represent a reopened issue |
| 12 | throughout | Timestamps parsed as UTC but rendered in **local** time, so displayed durations shift per viewer |
| 13 | L199 | 36 KB data blob inlined in source; `ocel-data.json` is a second copy that can drift |

**Structural, beyond the data:** the whole app is one ~1110-line closure, so nothing can be unit
tested in isolation; `render()` tears down and rebuilds the entire SVG on every interaction; state is
one mutable object written from ~30 sites.

---

## 11. What is worth keeping

The drawing and interaction core is good and should survive generalization:

- the three time scales, including the compression maths (`xComp` / `cpos`) and the gap annotation
- the row-packing collision loop — already the seed of per-object sub-lane allocation
- `focusSet()` — a BFS to degree N over the object graph, currently used only for dimming, but it is
  exactly the sub-log selection primitive
- the tooltip system, including pin-to-copy
- the minimap with drag-to-zoom
- solid-vs-dashed evidence rendering and the "?" badge — the visual answer to shortcoming S8
- burst and group folding as a density-reduction strategy
- position tweening across mode changes
- the sidebar toggle architecture (master + indeterminate + dependency-aware sub-toggles), which is
  the right foundation for "everything toggleable"

---

## 12. Riskiest logic to port faithfully

Beyond the overfit list, three pieces carry disproportionate risk because a subtle break in them
will not be visible in a diff:

1. **The coordinate function.** Mode-switching lives in exactly one place. This document names it
   `X(t, node)`; an earlier feature inventory called it `place(time/rank, lane)`. That inventory
   described a pre-mockup variant, so `X(t, node)` is expected to be correct — confirm with a grep
   rather than assuming.
2. **Rank computation for ordinal mode**, recomputed on every burst expand/collapse.
3. **The relationship-availability graph (`crossAdj`)**, which drives both focus-degree BFS and the
   track/relationship enable-disable states — one structure with two consumers.
