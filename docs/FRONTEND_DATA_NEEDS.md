# Frontend data needs — extracted from the code

What the visualization actually reads, derived **only** by reading `index.html` and every module
under `src/`. No database, no materialized views, no other document informed this. Where this
disagrees with a specification, the code is what is running.

Every claim is traceable to a `file:line`. "Consumed" means a property is dereferenced somewhere in
a code path that runs; a field mentioned only in a comment is listed as **not** consumed and called
out separately, because the distinction matters — one of them is deliberately ignored.

Method: `loadObjectGraph()` is the only entry point (`src/data/loadObjectGraph.js:30`), so the union
of everything below is the complete data requirement of the frontend. Anything not in it can be
dropped from the payload without changing a pixel.

---

## 1. The consumed contract, in one place

Four top-level sections. This is the whole surface.

```
ObjectGraph = {
  meta:    { repo, seed:[{id,type}], traversal_degree },
  objects: [ { id, type, label, intervals:[{start,end}], vmap:{…} } ],
  events:  [ { id, activity, time, object_id, actor_id, comment, attrs:{auto_closed} } ],
  links:   [ { source, target, qualifier, evidence, method, n_methods } ]
gi```

### `objects[]`

| Field | Shape | Required | Consumed by |
|---|---|---|---|
| `id` | string, unique | **yes** — validator rejects a missing id | everything; `objectGraph.js:40` |
| `type` | one of `issue`, `pull_request`, `commit`, `actor`, `repo` | **yes** — closed set, validator rejects others | `objectGraph.js:47`, lanes, colours, grouping |
| `label` | string | effectively — falls back to `id` | node titles, sidebar, tooltips, metrics, `commitGroups.js:64` |
| `intervals` | `[{start, end}]`, ISO strings in, `Date`s out | **yes** — array must exist; `[]` is valid | `objectGraph.js:53`, layout spans, axis, `metrics.js:23` |
| `intervals[].start` | ISO 8601 UTC | **yes** per interval | validator `objectGraph.js:59`; commit x-position |
| `intervals[].end` | ISO 8601 UTC or null | no — null means "still open" | lifetime completeness `metrics.js:25` |
| `vmap.push_id` | string/number | commits only | burst derivation `bursts.js:41`; commit tooltip `nodes.js:484` |
| `vmap.commit_sha` | string | commits only | commit tooltip title `nodes.js:479` |
| `vmap.commit_message` | string | commits only | commit tooltip `nodes.js:474` |
| `vmap.commit_author_name` | string | commits only | tooltip `nodes.js:482`; unique-author count `metrics.js:69` |
| `vmap.ref` | string | commits only | commit tooltip `nodes.js:483` |
| `vmap.login` | string | actors only | actor card `actorCard.js:62`, sidebar `sidebar.js:415,423`, trails `timeline.js:277` |

`intervals` is the only lifecycle mechanism — there is no `t_start`/`t_end` pair anywhere. Commit
position comes from `intervals[0].start` (`layout/nodes.js:136`), so a commit needs exactly one
interval to be placed at all.

### `events[]`

| Field | Shape | Required | Consumed by |
|---|---|---|---|
| `id` | string, unique | **yes** | validator `objectGraph.js:67`; node ids |
| `time` | ISO 8601 UTC → `Date` | **yes** | validator `objectGraph.js:68`; x-position everywhere |
| `object_id` | string, must resolve to an object | **yes** — validator rejects dangling | `objectGraph.js:69`; lane assignment |
| `activity` | one of the 10 closed vocabulary values | **yes** — throws on unknown | `activities.js:121`; glyph, label, landmark |
| `actor_id` | string or null | no | actor trails, handoff detection `metrics.js:181` |
| `comment` | truthy = this event is a comment | no | comment toggle `state.js:273`, second row, `axis.js:54` |
| `attrs.auto_closed` | string | no | the only `attrs` key read anywhere — `nodes.js:497` |

**One object per event.** `object_id` is singular and every consumer assumes it; there is no code
path that reads a list.

### `links[]`

| Field | Shape | Required | Consumed by |
|---|---|---|---|
| `source` / `target` | object id **or event id** | **yes** — validator accepts either | `objectGraph.js:79`; endpoints |
| `qualifier` | string; `actor` is special-cased everywhere | **yes** in practice | filters, colour, adjacency `graph.js:36` |
| `evidence` | exactly `validated` or `extracted` | **yes** — validator rejects anything else | `objectGraph.js:83`; solid vs dashed `links.js:171` |
| `method` | a `LINK_METHOD` value | no, but validated if present | per-method toggle `state.js:238`; tooltip `links.js:226` |
| `n_methods` | integer | no | tooltip only, and only when `> 1` — `links.js:227` |

`qualifier === 'actor'` is load-bearing: those links are excluded from adjacency, from every
toggle-derivation, from link counts, and from `isLinkVisible`, but kept in `selectVisible` when
their target is visible (`state.js:278`).

### `meta`

| Field | Consumed by |
|---|---|
| `repo` | breadcrumb, repo selector, preset URL — `loadObjectGraph.js:61`, `main.js:228,289` |
| `seed[].id`, `seed[].type` | breadcrumb label, seed selector, preset URL — `loadObjectGraph.js:55`, `main.js:228` |
| `traversal_degree` | breadcrumb + the read-only traversal note — `main.js:594` |
| `query` | written by the loader itself (`loadObjectGraph.js:36`), not supplied |

---

## 2. Component → fields → params → shape

### Data layer

| Component | Fields consumed | Filters / params | Expected shape |
|---|---|---|---|
| `data/loadObjectGraph.js` | whole bundle; `meta.repo`, `meta.seed[].id/.type`, `meta.traversal_degree` | `query`, injectable `transport` | `Promise<ObjectGraph>`; validated pre-normalization, then timestamps → `Date` |
| `data/fixtures.js` | catalogue: `repos[].name/.available/.synthetic/.reason/.seeds[]` | `{repo, seed}` or `{fixture}`; `searchSeeds(limit=20)` | catalogue JSON + one fixture JSON per seed |
| `data/seedQuery.js` | seed catalogue entries: `type`, `label`, `id`, `title` | free text | `{raw, type, number, shaPrefix, text}` or `null` |

### Model

| Component | Fields consumed | Filters / params | Expected shape |
|---|---|---|---|
| `model/objectGraph.js` | every required field above | — | `{byId, objectsByType, eventsByObject, pusherByCommit, eventCountByActor}` |
| `model/activities.js` | `event.activity`, `object.type` | — | closed 10-value vocabulary; **throws** on unknown |
| `model/evidence.js` | `link.method` | — | closed 10-value method set → `validated`/`extracted`; **throws** on unknown |
| `model/bursts.js` | `object.vmap.push_id`, `object.intervals[0].start` | `threshold` (default 5) | `[{id, pushId, time, size, commits, commitIds}]` |
| `model/commitGroups.js` | `link.source/.target/.qualifier`, `object.type`, `object.label` | `hiddenCommitGroups` | `{groups, groupsByCommit}`; **not a partition** — union rule |
| `model/graph.js` | `link.source/.target/.qualifier` | `focusDegree`, capped at 2 | `Map<objectId, hopDistance>` |

### State

| Component | Fields consumed | Filters / params | Expected shape |
|---|---|---|---|
| `state/state.js` | `object.type/.id`, `event.object_id/.comment`, `link.*` | all 15 state keys below | pure predicates + `selectVisible` → filtered `ObjectGraph` |
| `state/presets.js` | — (serializes state only) | `repo`, `seed`, `fixture`, `preset` | base64url JSON; `localStorage` |

The filter vocabulary is **derived from the loaded sub-log**, never enumerated
(`deriveRelGroups`/`deriveQualifiers`/`deriveMethods`, `state.js:99–162`). State keys:

`k` · `mode` (`real`/`highlights`/`ordinal`) · `focus` · `focusDegree` · `actors` · `tracks` ·
`showComments` · `trackOpen` · `hiddenObjects` · `hiddenCommitGroups` · `relPairs` · `qualifiers` ·
`methods` · `relOpen` · `expandedBursts` · `expandedGroups` · `burstThreshold`

### Layout

| Component | Fields consumed | Filters / params | Expected shape |
|---|---|---|---|
| `layout/nodes.js` | `event.id/.time/.actor_id/.activity/.comment`; `object.id/.label/.intervals[0].start`, `vmap.push_id` via bursts | `mode`, `laneTypes`, `expandedBursts`, `expandedGroups` | `[{id, lane, objectId, object, event, t, actorId, title, short, isComment, landmark}]` plus synthetic burst/group nodes |
| `layout/scales.js`, `packing.js` | `object.intervals` | `mode`, zoom `k` | x-scales; sub-lane packing |
| `layout/anchors.js` | `object.type`, `object.intervals[0].start/.end` | drawn nodes, `objectRow`, lane geometry | the point a link meets: the object's packed row, the glyph at that instant |

### Render — timeline page

| Component | Fields consumed | Filters / params | Expected shape |
|---|---|---|---|
| `render/timeline.js` | `object.type/.id/.intervals`, `vmap.login` | `state.tracks`, `mode`, `k`, `focus` | orchestrates; emits `objectColors` |
| `render/nodes.js` | `vmap.commit_sha/.commit_message/.commit_author_name/.ref/.push_id`; `event.attrs.auto_closed`; `node.t/.title/.actorId` | `focus`, burst/group expansion | glyphs + tooltip specs |
| `render/links.js` | `link.source/.target/.qualifier/.evidence/.method/.n_methods`; `object.label/.type` | `isLinkVisible` (6 ANDed conditions) | curved paths; dashed + "?" badge when `extracted` |
| `render/axis.js` | `object.intervals[].start/.end`; `event.time/.comment` | `mode` | tick marks |
| `render/minimap.js`, `legend.js` | node positions only | zoom bounds | overview + key |

### Render — sidebar

| Component | Fields consumed | Filters / params | Expected shape |
|---|---|---|---|
| `render/sidebar.js` — tracks | `object.id/.label`; `group.key/.label/.prId/.commitIds` | `tracks`, `hiddenObjects`, `hiddenCommitGroups` | per-lane rows + per-object children |
| `render/sidebar.js` — relationships | derived groups: `pair.key/.label/.evidence` | `relPairs`, `qualifiers`, `methods` | tri-state parent/child checkboxes |
| `render/sidebar.js` — actors | `actor.id`, `vmap.login`, `label`, runtime `eventCount` | `state.actors`, search text | colour-swatched rows |
| `render/sidebar.js` — bursts | `burst.id/.size/.pushId` | `burstThreshold` | expand/collapse controls |
| `render/controls.js` | `summarizeHidden()` items | — | non-dismissible hidden banner + preset panel |

### Render — stats page

| Component | Fields consumed | Filters / params | Expected shape |
|---|---|---|---|
| `render/stats.js` | rows from `perObjectMetrics` | operates on `selectVisible(...)`, so **every toggle applies** | per-object table + aggregates + landmarks |
| `stats/metrics.js` | `object.intervals/.type/.label`, `vmap.commit_author_name`; `event.time/.activity/.object_id/.actor_id/.comment`; `link.qualifier/.evidence/.source/.target` | the visible sub-log | 14 metrics; medians + ranges, never means |

### Actor card

| Component | Fields consumed | Filters / params | Expected shape |
|---|---|---|---|
| `render/actorCard.js` | `event.actor_id/.time/.comment/.activity`; `object.type/.label`; `vmap.login`; `pusherByCommit` | one actor | chronological activity list, sub-log scoped |

---

## 3. Query and parameter surface

Everything that can be asked for, from `main.js:508`:

| Param | Source | Effect |
|---|---|---|
| `?repo=` | URL | selects repository |
| `?seed=` | URL | selects seed object |
| `?fixture=` | URL | direct fixture address — transport-specific escape hatch |
| `?preset=` | URL | base64url-encoded toggle snapshot |
| `?page=stats` | URL | opens the stats page |

The `query` object handed to the transport is `{repo, seed, fixture, preset, page}`. Only `repo`,
`seed` and `fixture` reach `fixtures.js`; `preset` and `page` are consumed in `main.js`.

**Catalogue** (`tests/fixtures/catalogue.json`) — a separate fetch, and its own contract:

```
{ repos: [ { name, repo_id, available, synthetic, reason?,
             seeds: [ { id, type, label, title, fixture } ] } ] }
```

Consumed: `name`, `available`, `synthetic`, `reason`, and all five seed keys. `repo_id`,
`generated_at`, `built_by` and `note` are **not** read.

---

## 4. Declared but never consumed

Present in the fixtures, never dereferenced by any module. Verified by grepping the whole of `src/`
and `index.html`:

| Field | Where it exists | Status |
|---|---|---|
| `meta.repo_id` | every fixture | unread — the app addresses repos by `name` throughout |
| `meta.active_object_types` | every fixture | unread |
| `meta.active_link_methods` | every fixture | unread |
| `meta.generated_at` | every fixture | unread |
| `meta.activity_scope` | every fixture | unread |
| `meta.data_honesty` | every fixture | **unread** — see below |
| `meta.source` | fixtures | unread |
| `objects[].time_semantics` | every object | unread |
| `objects[].repo` | objects | unread |
| `links[].link_methods` | links | unread — only the scalar `n_methods` is used |
| `vmap.in_burst` | commit objects | **deliberately** unread — `bursts.js:87` says trusting it would reintroduce the metadata dependence that produced a wrong count. Bursts are derived from `push_id` instead. |
| catalogue `repo_id`, `generated_at`, `built_by`, `note` | catalogue.json | unread |

Two of these are worth separating from the rest.

**`data_honesty` is carried and never rendered.** Nothing in `src/` references it — not the sidebar,
not the legend, not the tooltip. The equivalent caveats *are* shown, but as hardcoded English
strings at `nodes.js:468` ("First-seen in a PushEvent, not real commit times"), `nodes.js:487`,
`links.js:18` and `actorCard.js:97`. So the disclosure exists in the UI while the data field
intended to drive it does not reach it — a payload that dropped `data_honesty` entirely would look
identical.

**`vmap.in_burst` is the one field ignored on purpose**, with a stated reason. It should not be
mistaken for dead weight of the same kind as the rest.

---

## 5. Consumed but not validated

Fields the renderer reads that `findGraphProblems` does not check. A payload missing any of these
passes validation and then degrades at render time:

| Field | Failure mode if absent |
|---|---|
| `object.label` | falls back to `id` in most places; commit tooltip falls back to `vmap.commit_sha` |
| `vmap.push_id` | commit never joins a burst (`bursts.js:44` — explicitly not an error) |
| `vmap.commit_sha/.commit_message/.commit_author_name/.ref` | tooltip rows render `—`; author count undercounts silently |
| `vmap.login` | actor rows fall back to `label` |
| `event.actor_id` | actor trails and handoff counts silently omit the event |
| `link.method` | per-method toggle cannot filter it; tooltip shows `—` |
| `link.n_methods` | agreement row is omitted |

The validator is strict about **structure** (ids, types, intervals, activity vocabulary, evidence
class, link endpoints) and silent about **content**. That split is consistent — the strict half is
everything whose absence would produce a wrong picture rather than an empty cell.

---

## 6. Observations

1. **The consumed surface is small.** 12 object fields, 7 event fields, 6 link fields, 3 `meta`
   fields. A transport supplying exactly those would drive the entire app.
2. **`vmap` is an untyped bag with a per-type schema in practice** — commit keys, actor keys, and
   nothing else. Five commit keys and one actor key are read; no other `vmap` key is touched.
3. **`attrs` is nearly unused** — exactly one key, `auto_closed`, at one call site.
4. **Ten of the declared fields are dead.** Roughly a third of `meta` and two per-object fields are
   carried by every fixture and read by nothing.
5. **Two closed vocabularies throw rather than degrade** — activities (`activities.js:121`) and link
   methods (`evidence.js:86`). A payload with an unmapped value fails loudly and takes the render
   with it. This is deliberate and is the strongest constraint any data source must satisfy.
6. **Time is `Date`-parsed once**, at `objectGraph.js:118`, from ISO strings. Nothing downstream
   parses a timestamp, so anything not parseable by `new Date()` fails there.
7. **The only many-valued relation is `links`.** `event.object_id` is singular at every one of its
   call sites, so expressing one event touching several objects would require a change to the shape,
   not just to the data.

---

# Addendum — the closed vocabularies, enumerated

Every literal string a data source must emit verbatim. Copied from source, not paraphrased.

## A1. `event.activity` — 10 values

From the `ACTIVITIES` object literal, `src/model/activities.js:34–89`. `objectTypes` and `landmark`
are copied from each entry's own fields.

| `activity` | `objectTypes` | `landmark` | Defined at |
|---|---|---|---|
| `IssueOpened` | `['issue']` | `false` | `activities.js:35` |
| `IssueClosed` | `['issue']` | **`true`** | `activities.js:41` |
| `IssueReopened` | `['issue']` | `false` | `activities.js:47` |
| `IssueCommented` | `['issue', 'pull_request']` | `false` | `activities.js:53` |
| `PullRequestOpened` | `['pull_request']` | `false` | `activities.js:59` |
| `PullRequestMerged` | `['pull_request']` | **`true`** | `activities.js:65` |
| `PullRequestClosed` | `['pull_request']` | `false` | `activities.js:71` |
| `PullRequestReopened` | `['pull_request']` | `false` | `activities.js:77` |
| `CommitObserved` | `['commit']` | `false` | `activities.js:83` |

`LANDMARK_ACTIVITIES` is derived, not written down — `activities.js:101` filters the table above,
yielding exactly `IssueClosed` and `PullRequestMerged`. It yielded a third,
`PullRequestMergedOffPlatform`, until decision 48 removed that activity from the vocabulary.

`IssueCommented` is the only activity valid on two object types, and the only one whose name does not
match its second type. `activities.js:26–32` states this is intentional: GitHub models PR comments as
issue comments, and splitting it would be an event-log semantics change.

**Enforcement.** Unknown activity → `throw` at `activities.js:120`, reached via `activityLabel`,
`activityShortLabel` and `isLandmark`. An activity attached to an object type outside its
`objectTypes` list is reported by `findActivityProblems` (`activities.js:162`) and becomes a
validation failure through `objectGraph.js:74`.

Related closed sets in the same file: `OBJECT_TYPES` = `['issue', 'pull_request', 'commit', 'actor',
'repo']` (`activities.js:9`); `LANE_TYPES` = `['issue', 'pull_request', 'commit']`
(`activities.js:19`).

## A2. `link.method` — 16 values, plus `event_actor_id`

From the `LINK_METHOD` object literal, `src/model/evidence.js:36–90`. The evidence column is
membership in `VALIDATED_METHODS` (`evidence.js:105–111`); everything not in that set is `extracted`
by `classifyMethod` (`evidence.js:149`).

Decision 42 fixes `link.method` — how one object came to be linked to another — at **16** values.
`event_actor_id` is a seventeenth key in the same enum, but it is actor *attribution*, not
traceability; it is listed separately below and must not be counted among the 16.

| `method` | Constant | Evidence | Defined at |
|---|---|---|---|
| `pr_body` | `PR_BODY` | **`validated`** | `evidence.js:40` |
| `head_sha` | `HEAD_SHA` | **`validated`** | `evidence.js:42` |
| `merge_commit_sha` | `MERGE_COMMIT_SHA` | **`validated`** | `evidence.js:44` |
| `closed_via_commit` | `CLOSED_VIA_COMMIT` | **`validated`** | `evidence.js:46` |
| `pr_title` | `PR_TITLE` | `extracted` | `evidence.js:51` |
| `commit_message` | `COMMIT_MESSAGE` | `extracted` | `evidence.js:53` |
| `issue_comment` | `ISSUE_COMMENT` | `extracted` | `evidence.js:55` |
| `branch_name` | `BRANCH_NAME` | `extracted` | `evidence.js:57` |
| `proximity` | `PROXIMITY` | `extracted` | `evidence.js:59` |
| `ref_match` | `REF_MATCH` | `extracted` | `evidence.js:61` |
| `pr_title_gh` | `PR_TITLE_GH` | `extracted` | `evidence.js:74` |
| `pr_title_symfony` | `PR_TITLE_SYMFONY` | `extracted` | `evidence.js:76` |
| `pr_title_for` | `PR_TITLE_FOR` | `extracted` | `evidence.js:78` |
| `pr_body_gh` | `PR_BODY_GH` | `extracted` | `evidence.js:80` |
| `pr_body_fixed_tickets` | `PR_BODY_FIXED_TICKETS` | `extracted` | `evidence.js:82` |
| `pr_body_refs` | `PR_BODY_REFS` | `extracted` | `evidence.js:84` |

Four validated, twelve extracted.

| Not a link method | Constant | Evidence | Defined at |
|---|---|---|---|
| `event_actor_id` | `EVENT_ACTOR_ID` | **`validated`** | `evidence.js:89` |

`merge_commit_message` was the tenth value here until decision 42 deleted it: no upstream view emits
it. The one F1 link that carried it is now `commit_message` — same evidence class, so the 3/31 split
is unchanged. `tests/model.test.js` asserts the name now throws.

Two subsets are derived from this table:

| Subset | Members | Defined at |
|---|---|---|
| `ISSUE_PR_METHODS` | `pr_body`, `branch_name`, `pr_title`, `issue_comment` — the four with their own upstream view | `evidence.js:125–130` |
| `TOGGLEABLE_METHODS` | all 17 keys **except** `event_actor_id`, i.e. the 16 link methods | `state.js:33–35` |

`ISSUE_PR_METHODS` is seeded into the method counts at `state.js:154` so all four toggles exist even
when the loaded sub-log uses none of them. `event_actor_id` is excluded from the toggles because
`state.js:31–32` states it is how every event reaches its actor, not a traceability method.

**Enforcement.** Unknown method → `throw` at `evidence.js:86` via `classifyMethod`/`classifyLink`.
The validator also rejects it earlier and more gently: `objectGraph.js:89` calls `isKnownMethod` and
records a problem. `classifyLink` additionally throws on an empty method list (`evidence.js:104`).

`link.evidence` itself is a closed two-value set — `'validated'` and `'extracted'`
(`evidence.js:15–18`) — and is the one field the validator checks by literal comparison rather than
by lookup (`objectGraph.js:83`).

## A3. `link.qualifier` — 4 values

No enumeration of qualifiers exists in `src/`. These are every distinct value across all 13 fixtures
plus every qualifier literal appearing in code.

| `qualifier` | Links in fixtures | Appears in | Colour mapped |
|---|---|---|---|
| `referenced_pull_request` | 346 | F1, F5, F10, F12, F13 | yes — `theme.js:33` |
| `actor` | 42 | F1 | **no** |
| `related_issue` | 18 | F1, F2, F3, F4, F6, F10, F11, F12, F13 | yes — `theme.js:32` |
| `referenced_issue` | 1 | F1 | yes — `theme.js:34` |

### `actor` is special-cased at ten sites

Every one is an exclusion, and each was written separately:

| Behaviour | Site |
|---|---|
| excluded from object adjacency / focus BFS | `graph.js:36` |
| excluded from commit-group derivation | `commitGroups.js:35` |
| excluded from `deriveRelGroups` | `state.js:103` |
| excluded from `deriveQualifiers` | `state.js:135` |
| excluded from `deriveMethods` | `state.js:156` |
| always invisible via `isLinkVisible` | `state.js:223` |
| kept in `selectVisible` when its **target** is visible | `state.js:278` |
| excluded from link counts | `metrics.js:100` |
| excluded from per-object link counts | `metrics.js:220` |
| laneless object types skipped | `metrics.js:142`, `metrics.js:227`, `metrics.js:370` |

Because `isLinkVisible` returns `false` for it unconditionally, an `actor` link is never drawn — which
is why `theme.js:31–35` maps only the other three. It survives in `selectVisible` so the stats page
can still see actor attribution.

### Qualifiers are **not** enforced

This is the one place where the "unknown values throw" rule does not hold, and the asymmetry is worth
stating plainly:

- The validator never inspects `link.qualifier` — there is no qualifier check anywhere in
  `objectGraph.js`.
- `qualifierColor` falls back to `'var(--color-neutral-400)'` for anything unmapped
  (`theme.js:118`).
- `deriveQualifiers` (`state.js:132`) builds the toggle list from whatever values are present, so a
  new qualifier automatically gets a working toggle.

So a novel qualifier renders in neutral grey with a functioning filter and no error, whereas a novel
activity or link method takes the render down. Qualifiers are open by construction; activities and
methods are closed by enforcement.
