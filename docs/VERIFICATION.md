# Verification

What was checked, how, and what remains unverified. Task 6.

The premise is that D3 correctness cannot be established by reading a diff, so
every claim here is backed either by an assertion that runs in `npm test` or by a
render that was looked at. Where neither was possible, this document says so
rather than implying coverage that does not exist.

**478 assertions, all DOM-free**, over 13 fixtures × 3 time modes. ⚠️ The count moves with every
session; what does not move is that they run with no browser, no network and no database.

---

## 1. What the assertions cover

Run with `npm test`. Every module under `model/`, `layout/`, `state/` and `stats/`
is exercised without a browser.

| Property | Where | Scope |
|---|---|---|
| Bundle shape; unknown activity, object type or evidence class rejected | `model.test.js` | all 13 fixtures |
| A repo-typed object is rejected; object types are four, of which three get lanes (decision 39) | `model.test.js` | synthetic bundle |
| A link endpoint naming an event is rejected, and says so (decision 49) | `model.test.js` | synthetic bundles |
| Every link joins two objects — no attribution link, no event endpoint | `verification.test.js` | all 13 |
| Evidence classification follows the platform-asserts-it rule | `model.test.js` | rule + F1's 3/31 split |
| Bursts derive from `push_id`; size is the member count; N or zero | `model.test.js` | F1, F7, F10 |
| Focus BFS depth, cap, burst folding, no actor in the adjacency | `model.test.js` | F1 |
| Attribution survives the actor-link deletion: 42 events, 4 actors, all resolvable | `model.test.js` | F1 |
| Compression maths match the reference formula | `layout.test.js` | synthetic + F1 |
| Ordering monotonic in **every mode, every fixture** | `verification.test.js` | 13 × 3 |
| No two nodes overlap within a row | `sublanes.test.js` | 13 × 3 |
| Sub-lane allocated **only** on temporal overlap | `sublanes.test.js` | F1–F4 |
| Reopened object yields multiple bars on one row | `sublanes.test.js` | F9 |
| Every drawn link resolves to endpoints that are drawn | `verification.test.js` | all 13 |
| Every link meets its object at the row that object is drawn at | `anchors.test.js` | 13 × 3 |
| Sub-lane bands are anchored apart; a commit reaches the PR it names | `anchors.test.js` | F10 |
| Commits still anchor to their node, and folded ones to their burst | `anchors.test.js` | F1 |
| Lane geometry stacks without collision | `verification.test.js` | all 13 |
| Each of the four issue↔PR method toggles works independently | `verification.test.js` | F11 |
| Multi-method agreement and mixed evidence on one pair | `verification.test.js` | F12 |
| Filters are independent and ANDed | `toggles.test.js` | F1, F3, F13 |
| Commit-group union rule | `toggles.test.js` | F13 |
| Everything hidden is reported and individually restorable | `toggles.test.js` | F1, F3, F13 |
| Presets round-trip through storage and URL | `toggles.test.js` | F1, F13 |
| Metrics respond to toggles; folding is not filtering | `stats-table.test.js` | F1, F3, F13 |
| All times UTC under any `TZ` | `timezone.test.js` | verified under UTC+9, −8, +14 |
| Fixtures are byte-reproducible from their build scripts | `fixtures.test.js` | F1–F13 |
| A `{repo, seed}` query resolves to the sub-log it names | `selection.test.js` | catalogue |
| A query that cannot be honoured fails loudly, and says why | `selection.test.js` | catalogue |
| The catalogue matches the fixtures and cannot drift | `selection.test.js` | all seeds |
| Seed search parses numbers, SHAs, type words and titles | `selection.test.js` | catalogue |
| Search ranks exact over prefix over substring | `selection.test.js` | F1 |

Each synthesized fixture additionally **asserts that it exhibits its own property**
(`sublanes.test.js`, first block). Without that, an "overlapping PRs" fixture whose
PRs do not overlap would pass every layout test while verifying nothing — a failure
mode that is completely invisible.

---

## 2. The baseline comparison

`screenshots/` holds 11 pre-change renders (inventory in `screenshots/README.md`).

### ⚠️ It is not a pixel comparison, and cannot be

The baseline was captured in Firefox at an effective scale where the sidebar
occupies ~367px; the verification renders come from headless Edge at 1:1, where it
is 300px. **Everything is displaced horizontally for reasons unrelated to
correctness.** No pixel-diff of the baseline is meaningful, and the thesis must not
claim one. What was done instead is a structured comparison of the things that
*are* comparable — tick labels, tick count, node labels, lane composition, glyph
placement relative to the axis — plus the assertion suite above, which is where the
evidentiary weight actually sits.

Byte-identical comparison *is* used, but only between two renders from the same
browser: that is how Task 2 was shown not to disturb F1.

### Result: six differences, all accounted for

| # | Difference | Status |
|---|---|---|
| 1 | 29 links moved solid → dashed | **Mandated** — decision 7 |
| 2 | Every timestamp −1 hour, labelled UTC | **Mandated** — decision 9 |
| 3 | Burst badge `21` → `20` | **Mandated** — the count is now derived |
| 4 | `OCEL CASE` → `Sub-log`; `Case statistics` → `Per-object statistics` | **Mandated** — decision 1 |
| 5 | Links coloured by the object they reach | **Mandated** — decision 24 |
| 6 | Highlights tick `22:47:51` → `21:47:49` | **Closed 2026-08-19** — the Highlights mode was removed (decision 112, retiring decision 21), and its ticks with it |

**Decision 41 adds no seventh difference.** Deleting F1's 42 event→actor links changes nothing on
screen, because nothing ever drew them: `isLinkVisible` returned false for the class
unconditionally, and actor trails are built from `event.actor_id` by way of `node.actorId`. Checked
rather than assumed, in the two ways available — the node list feeding every trail is byte-identical
before and after in all three time modes, and F1, F13 and the stats page were re-rendered in
headless Edge and compared. The links were data the renderer carried and never used.

⚠️ **"Six differences" describes the state at Task 6 and has not held since 2026-08-08.**
This session changed what F1 draws in six further ways, every one of them mandated and
recorded, and none of them re-compared against `screenshots/` because that baseline is
read-only and the comparison above was already not a pixel diff:

| # | Further difference | Decision |
|---|---|---|
| 7 | Activity labels are verbs: `opened/closed/merged` → `open/close/merge` | 89 |
| 8 | Commit↔PR links reversed to PR → commit, so their gradients run the other way | 92 |
| 9 | A pull request closed without merging carries a dashed ring | 81 |
| 10 | The `?` badge on extracted links is gone — 31 of them in F1 | — |
| 11 | Comments within a day of each other fold into one mark with a count | 93 |
| 12 | The legend is four sections and dims what is absent; sidebar renamed *Lanes* / *Folding* | 82, 83, 90, 94 |

**Anyone re-running the baseline comparison must expect these**, and the list is why the
old "nothing else differs" line below is scoped to Task 6 rather than to today.

**Nothing else differed at Task 6.** The strongest single piece of evidence is the discrete
axis: every tick label is exactly −1h from the baseline, at the *same count and the
same positions* — `Mar 07 06:15 → 05:15`, `Mar 09 20:23 → 19:23`, … `Mar 19 15:08 →
14:08`. That the tick *selection* is unchanged while only the zone moved exercises
the scale, ranking, tick-selection, label-merge and stagger logic end to end.

Difference 6 is the one genuine open question. F1's PR closes two seconds after it
merges. The mockup ticked the last of {merged, closed}; the rewrite ticks the
lifecycle interval boundary, which is the merge. The new rule generalizes to N
objects and to reopens and matches the bar that is actually drawn, but it drops the
close tick. Ticking both is a two-line change if preferred.

---

## 3. What each fixture renders

> **F1 is the only fixture built from real GitHub data.** F2–F13 are synthetic structures built to
> exercise layout and toggle behaviour; the counts below are properties of those constructions, not
> observations about real workflows, and none of them may be cited as a finding. See
> `tests/fixtures/README.md`.

| ID | Renders | Verified by |
|---|---|---|
| F1 | The vscode sub-log: 1 issue, 1 PR, 32 commits, one folded burst of 20 | assertions + all three modes rendered and compared |
| F2 | Two sequential PRs sharing one band | assertion; band count = 1 |
| F3 | Two concurrent PRs in two bands | assertion + render |
| F4 | Two concurrent issues in two bands, one PR | assertion + render |
| F5 | One commit, two PRs, two fanned links | assertion + render |
| F6 | Issue and PR only; commit lane present but empty | assertion |
| F7 | Two burst nodes of 8, two loose commits | assertion |
| F8 | A single PR, no issue lane content | assertion |
| F9 | One issue, two lifecycle bars on one row | assertion |
| F10 | 3 PRs, 300 commits; folds to ~33 drawn commit nodes | assertion incl. a 3s layout tripwire |
| F11 | Four PRs, one per detection method | assertion, each toggle independently |
| F12 | Multi-method link (n=3) and both evidence classes on one pair | assertion |
| F13 | Two concurrent PRs, 4 commits each, one shared | assertion + render |

---

## 3b. The data layer — verified 2026-08-04

`sql/fe_layer.sql` and `api.get_object_graph` were built and checked against the live
database (`gharchive_ocpm_viz_wsl`, MVs last refreshed 2026-08-02 19:32–19:45 UTC).

**What was checked, and how.**

| Check | Mechanism | Result |
|---|---|---|
| No dangling event objects | `fe.diag_sanity` | 0 |
| No issue or PR object with zero events | `fe.diag_sanity` | 0 |
| Every actor named by an event has an actor object | `fe.diag_sanity` | 0 |
| No pair linked twice by the same qualifier | `fe.diag_sanity` | 0 |
| Both link endpoints are objects (decision 49) | `fe.diag_sanity` | 0 |
| Exactly 9 distinct activities (decision 40) | `fe.diag_sanity` | 9 |
| `fe.link_mat` matches its live definition | `fe.diag_link_staleness` | drift 0 |
| Payload satisfies the frontend contract | `scripts/rpc-check.mjs` → `findGraphProblems()` | `[]` |
| Contract facts the validator has no opinion on | `rpc-check.mjs`: `contract_version`, parseable timestamps, the 4 qualifiers, `link_methods` an array containing `method`, no `repo` type, no `is_bot`, no `CommitsPushed` | pass |
| Real layout pipeline, all 3 timeline modes | `rpc-check.mjs`: finite x/y, every issue and PR banded, one interval per commit, forward-going extents, every link endpoint anchored | pass |
| Relationships mode, both arrangements (added 2026-08-18) | `rpc-check.mjs` through `createLayout`: finite positions, every mark inside the box, no two marks overlapping, every edge end resolving to a drawn mark, finite time extent; clusters additionally name an anchor and honour their footprint claims (soft shortfalls reported; under ¾ of a claim fails) | pass on ten real sub-logs — vscode, kubernetes, react; degrees 1–3; 5–46 marks; the 34-pull-request hub kubernetes #68026 reports 30 soft shortfalls and no failure |
| `npm test` unaffected | 377 tests | pass |

**Coverage of that gate:** six sub-logs — all three repositories, all three seed types
(issue, pull request, commit), traversal degrees 0–3, sizes from 5 to 404 objects.

**Latency:** 1.7–3.4 s per sub-log end to end, from 19.4 s before indexing and tuning.
Step-by-step measurements are in `sql/fe_layer.sql` §0.1. `fe.refresh_links()` is ~6 s.

**Defects this found**, each caught by a check rather than by reading: duplicate links
from two branches (16,040 + 5,111 surplus rows), 3,359 objects with no events, 2 objects
with a NULL id, a nonexistent seed returning an empty payload instead of erroring, four
point-intervals on one commit, and — after the fix — the decision-61 narrowing reaching
only one of the two link families (decision 62).

**A visual check was also made** (see §4): the app was rendered headlessly through
Microsoft Edge over WSL interop and the resulting PNGs inspected.

---

## 4. Not verified

Stated plainly rather than left to inference.

- ~~**No real sub-log has been rendered.**~~ **No longer a gap, 2026-08-04.** Real RPC
  payloads have been rendered and looked at, both by the author in a browser and headlessly
  via `msedge.exe --headless=new --screenshot` over WSL interop. What has *not* run end to
  end is the **PostgREST → `fetch()` → browser** path: the samples reach the app as
  `tests/fixtures/LIVE*.json`. **Also closed, 2026-08-05:** `src/data/api.js` exists, the dev
  server proxies `/rpc/*`, and the app renders live payloads fetched over HTTP — verified in
  the browser against all three repositories.
- ~~**Nothing automated exercises the `web_anon` path, and it broke once.**~~ **Closed
  2026-08-07, the same day it opened.** `fe.diag_sanity` and the rest of `rpc-check.mjs`
  reach the database through `psql` as the *owner*, so a PostgREST permissions regression
  was invisible to them: re-running `fe_layer.sql` reverted all three `api` functions to
  `SECURITY INVOKER`, the app died with *"permission denied for schema fe"*, and the gate
  reported **PASS**. `rpc-check.mjs` now ends with one unauthenticated HTTP call to
  `api.list_repos` — which reads `fe.seed_lookup`, so it exercises exactly what breaks.
  Unreachable PostgREST is a **skip**, not a failure, so the gate still works on a machine
  with only a database (`PGRST_URL`, `PGRST_SKIP` override it).
  - Verified by regression rather than by reasoning: with
    `ALTER FUNCTION api.list_repos() SECURITY INVOKER` applied, every earlier gate still
    passed and this one failed with the app's own error and the `postgrest_setup.sql`
    remedy. It also detects a stale PostgREST schema cache, which presents differently and
    needs a different fix.
  - ⚠️ It probes **one** function. A regression confined to `get_object_graph` or
    `search_seeds` would still pass, since the failure mode this guards against is
    schema-wide by construction. Narrow, and deliberately so.
- **Interaction is untested by assertion.** Tooltips, pin-to-copy, minimap
  drag-to-zoom, legend hover, the degree stepper and the actor card are exercised
  only by looking at them. They have no automated coverage, because they need a DOM
  and a pointer; a browser-driver test suite was out of scope.
- ~~**The `repo` object type is unexercised.** No fixture contains repo objects.~~
  **No longer a gap:** decision 39 removed `repo` from the closed set, so there is
  nothing to exercise. That no fixture ever contained one is the evidence for the
  decision rather than a hole in the coverage. `tests/model.test.js` now asserts a
  repo-typed object is *rejected*. Closed by deletion, like
  `PullRequestMergedOffPlatform` above.
- ~~**`PullRequestMergedOffPlatform`** is in the vocabulary and mapped, but no fixture
  produces one.~~ **No longer a gap:** decision 48 removed the activity outright, so there
  is nothing left to exercise. `tests/model.test.js` now asserts that the name hits the
  closed-vocabulary throw. The gap was closed by deletion, not by coverage.
- **Rendering performance** is covered only by a 3-second tripwire on F10's layout,
  not by measurement. Sub-logs are small; if a real one is slow, report it.
- **No screen size other than 1920×1200** has been checked, deliberately: sizing is
  deferred until the aspect-ratio pass.
- ~~**No traversal has ever been performed.**~~ **No longer a gap, 2026-08-04.** The
  recursive traversal in `api.get_object_graph` runs and was exercised at degrees 0–3; the
  degree sweep on vscode PR #116416 (1 → 39 → 42 → 291 objects) is what exposed how sharply
  a sub-log grows with degree. **Also closed, 2026-08-05:** the app's picker searches the
  database through `api.search_seeds` when the Data source is set to Database; only the
  fixture source is still limited to pre-built seeds, which is inherent to fixtures.
- ⚠️ **There is no automated check that the picture is correct, and this is the largest
  gap in the whole project.** Every layout assertion checks that positions are *finite,
  banded and anchored* — never that the drawing means what it claims. **Five defects have
  now been found by looking at the screen and by none of the 401 tests**: commits
  wrongly excluded from merged pull requests, a dead app when no seed was given, isolated
  objects indistinguishable from failures, one pull request drawn as ~30, and — added
  2026-08-07 — the seed prompt detaching the timeline's `<svg>` so that every subsequent
  render drew into a node outside the document (decision 74). Each left
  every check passing. `scripts/shot.mjs` makes looking cheap; it does not make it
  automatic, and no baseline is compared.
  - **One narrow thing is now machine-checked**, added 2026-08-08: that every mark the
    renderers draw has a legend row explaining it, and every row names something drawn
    (`tests/legend.test.js`, decision 82). That is *completeness of the key*, not
    correctness of the picture — it cannot tell you a glyph is in the wrong place, only
    that nothing is drawn without a name. The larger gap above is unchanged.
  - ⚠️ **The fifth is the sharpest statement of this gap so far, because the tests could
    not have caught it even in principle.** The other four were wrong pictures; this was
    *no* picture, produced by a DOM mutation two modules away from anything under test.
    Every module under `model/`, `layout/` and `stats/` stayed correct throughout — the
    node positions computed on each render were right, and were written to an element no
    longer in the document. **No DOM-free assertion can reach a defect whose entire
    content is which element is attached to what.** Verified instead by driving the real
    app headlessly — open `?source=database`, choose a seed, switch repository, choose
    another — and reading `#chart` back out of the live DOM at each step, with the fix
    reverted as a control to confirm the probe detects the defect. That probe was
    scaffolding and was deleted; if this class recurs, a browser-driver suite is the
    honest answer, and it remains out of scope.
- ⚠️ **Seed symmetry is checked for exactly one triple, and only by URL.** Added 2026-08-07,
  prompted by a report that seeding from a commit, its pull request and its issue gave
  different sub-logs. `facebook/react` commit `0005d1e`, PR #14576 and issue #14578 were
  loaded at degree 2 by all three routes — direct RPC, direct URL, and in-session seed
  switching — and returned **identical payloads (6 objects, 8 events, 2 links) and identical
  renders** every time. The asymmetry was real but not in the lookup: stacked combo listeners
  were changing the *repository* mid-query (decision 75). The traversal is symmetric by
  construction — `adj` unions both link directions and `reached` takes `min(hop)` — but
  "symmetric by construction" is an argument, not a measurement, and **no test asserts that
  two seeds in one component yield the same sub-log at a degree that spans them.** One triple
  in one repository is thin evidence; a sweep over many triples is unwritten work.
- ~~**The Stats page has no error surface of its own.**~~ **Closed 2026-08-08**, the same
  day it opened. `refreshStats` ran inside the startup chain ending in `.catch(showFatal)`,
  and `showFatal` wrote into `#chartMessage` — an element belonging to the *timeline* page
  and not on screen while the stats page is open. An exception in `renderStats` therefore
  rendered as an empty dashboard with no error visible anywhere, which is how decision 86's
  own defect presented; it was found by reading `#chartMessage` out of the DOM, not by
  looking at the page. Each page now owns a message surface (decision 87) and both render
  paths are guarded. Verified by throwing on purpose inside `buildTable`: the page reports
  *"Could not compute these statistics"* with the exception text escaped, instead of
  rendering blank.
  - ⚠️ It reports **that** a render failed, not that the numbers are right. The Stats page
    still has no assertion behind its figures against real data (below).
- ~~**The fixture corpus speaks a retired qualifier vocabulary.**~~ **Closed 2026-08-09.**
  F1–F13 carried `related_issue`, `referenced_pull_request` and `referenced_issue`, which
  the RPC can never produce, so every qualifier-shaped assertion exercised names that do
  not occur. The corpus was rebuilt onto decision 43's four (decision 92). ⚠️ The rebuild
  **found a live defect**: with `contains_commit` stored PR → commit as the database
  stores it, F5's two-PRs-one-commit case shares its *target* rather than its source, and
  the link fan keyed on the source alone — so the buried link that decision 25 exists to
  prevent was buried again. Fixed and pinned.
- **The Stats page has never been opened against real data.** All of its figures —
  durations, gaps, handoffs, per-object tables — are computed in JS over the loaded
  sub-log (decision 12) and have only ever been exercised on fixtures. Real sub-logs are
  larger, sparser and contain shapes fixtures do not (a commit in 7,231 cases belonging to
  several PRs). Unchecked, not known-broken.
- **One dataset, one snapshot, three repositories.** Everything measured here comes from
  materialized views last refreshed 2026-08-02. Nothing establishes that the layer holds
  on a different extraction, a re-refresh, or a repository with different conventions.
- **The commit→PR admission rule has been wrong twice.** Decision 61 was corrected by 65
  after it was found to discard merged pull requests' own commits. It is right as far as
  can be measured now, but it has the worst track record of anything in the layer, and
  every figure resting on it deserves more scepticism than its precision suggests.
- ~~**The `commit_distinct` floor is unquantified.**~~ **Measured, 2026-08-07.** Decision 80
  narrowed the rule to "flagged new on the pull request's *own* head branch" and the floor is
  now countable, because the commits it drops can be sorted by where they *were* born. Real
  links lost — born on the PR's own branch, but with no `commit_distinct` push there, so a
  force-push, a rebase, or GH Archive's 20-commit truncation: **vscode 1,620, react 272,
  kubernetes 56.** Cross-branch pass-throughs correctly removed: **49,004 / 2,319 / 858**.
  `fe.diag_ref_match_narrowing` reports both columns per repo, so the cost is visible beside
  the benefit rather than inferred. Figures are still a floor and still must be quoted as a
  range — upstream raw, and the narrowed count — never as one number.
  - ⚠️ **Kubernetes pays and gains nothing:** 56 real links lost, 0 pass-throughs removed,
    because its contributors work from forks where this failure mode barely occurs. The
    removal rate differs sharply by repository (vscode 71%, react 66%, kubernetes 32% of
    upstream `ref_match`), and that spread is **real branching practice, not a filter
    artifact** — but it is exactly why raw link counts must never be compared across
    repositories as though they measured the same thing. See §5.

---

## 5. RQ2: per-repo link coverage — **blocked, not skipped**

`tasks/06` asks for per-repo issue↔PR link counts broken down by detection method,
to quantify a threat to RQ2: if detection is systematically weaker on kubernetes and
react than on vscode, apparent cross-repository process differences may be artifacts
of detection coverage rather than real behaviour.

⚠️ **The threat narrowed on 2026-08-04 and did not close.** It was stated as "the four
available methods key on GitHub's standard conventions, while `gh-N`, `bug #N` and
`For #N` are common in kubernetes and react". The contract snapshot now records seven
method views plus `mv_issue_pr_links_extended_conventions`, which detects exactly those
forms. *Detection exists* and *coverage is comparable across repositories* are
different claims, though, and only the second bears on RQ2 — neither has been measured.
The breakdown must now cover all seven methods plus the extended set, and report the
`proximity` share separately, since it matches on timing alone. See `DATA_CONTRACT.md` §4.

**This figure cannot be produced yet.** It spans data that is not loaded, so by
decision 12 it belongs in SQL — and there is no database connection from this
project. A query for it once existed at `sql/rq2_link_coverage.sql`; that directory
was deleted in `a1e2a9c` and is staying deleted, so the query has to be written
again. Write it against the current contract, not the old one: the breakdown now
covers seven detection methods plus the extended-convention set, and must report
the `proximity` share separately.

Until it is run, the thesis must state the limitation qualitatively and say the
number is not yet measured. **Do not estimate it.** An invented coverage figure
would undermine the very limitation it is meant to document.
