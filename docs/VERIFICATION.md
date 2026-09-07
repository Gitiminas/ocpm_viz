# Verification

What was checked, how, and what was not.

D3 correctness cannot be established by reading a diff. Every claim below is backed by an assertion
that runs in `npm test`, by a check that ran against the database, or by a render someone looked at.
Where none of the three was possible, §5 says so rather than implying coverage that does not exist.

**824 tests in 34 files, 0 failures, ~1 s — run 2026-09-02.** None needs a browser, a network or a
database.

---

## 1. What the assertions cover

`npm test`. Everything under `src/model/`, `src/layout/`, `src/state/` and `src/stats/` runs without
a browser; the covered DOM-facing modules (`pan`, `minimap`, `helpStrip`, `message`, `motion`) run
against stub objects instead of one.

| Property | Suite | Scope |
|---|---|---|
| Bundle shape; unknown activity, object type, evidence class or method rejected; the seventeen `link.method` values (43) | `model` | F1 + synthetic |
| Four object types, three of which get lanes; a repo-typed object rejected (39); both link endpoints are objects (49) | `model`, `verification` | synthetic; F1–F14 |
| Evidence classification follows the platform-asserts-it rule (7) | `model` | rule + F1's 3 / 31 split |
| Bursts derive from `push_id`; size is the member count | `model` | F1, F7, F10 |
| Focus BFS depth, cap, burst folding, no actor in the adjacency | `model` | F1 |
| Attribution survives the actor-link deletion: 42 events, 4 actors, all resolvable (41) | `model` | F1 |
| Both scales agree on the plot edges; the removed compressed axis stays removed (112) | `layout` | F1 + degenerate |
| Ordering monotonic; lanes stack without collision; every drawn link resolves to drawn endpoints | `verification` | F1–F14 × 2 modes |
| No two nodes overlap in a row; a sub-lane only on temporal overlap; a reopened object gets several bars; coinciding links fan apart (3, 25) | `sublanes` | F1–F13 × 2 |
| A link meets an object at the row that object is drawn at; bands anchor apart (37) | `anchors` | F1–F14 × 2 |
| The extracted pipeline lays out identically to the pre-extraction one | `engine` | F1–F14 × 2 |
| Relationships mode: one mark per object, folding moves the links, arrowheads read time; both arrangements finite, ordered and inside the box | `structural`, `layered`, `cluster` | F1, F10, F13 + synthetic |
| The four issue↔PR method toggles work independently; multi-method agreement; mixed evidence on one pair | `verification` | F11, F12 |
| Filters independent and ANDed; commit-group union; everything hidden is reported and restorable; presets round-trip (26, 27, 28) | `toggles` | F1, F3, F13 |
| Metrics respond to toggles; folding is not filtering (29) | `stats-table` | F1, F3, F13 |
| Every drawn mark has a legend row and every row names something drawn (82); every control and mark has a help text, and every text a user (122) | `legend`, `tips` | F1; key table |
| All times render UTC, labelled (9); every qualifier the live samples carry has a colour; an off-platform merge is its own outcome (123) | `timezone`, `qualifier-colour`, `offplatform` | F1; LIVE1/2; F14 |
| The absolute axis anchors its left edge, so no mark sits left of every tick; no round label claims a day boundary its tick is not on; a gap marking's help-strip text states the exact span it hides, in UTC, with the length in parentheses; a multi-year span carries the year on the first tick and on each tick that begins a new year, in both modes | `axis` | k8s #118316 ticks + synthetic |
| A comment run never crosses a close or a reopen (interval end inclusive, a null end open); the folded mark carries its span end in absolute mode only | `nodes`, `engine` | synthetic; F1 |
| The DFG validator enforces the closed vocabularies, nonnegative counts, `events ≤ occurrences` per node, cross-type-only cross edges, the link_-prefix rule in both directions (a succession carries no bare evidence, a per-type edge no link class), and per-type conservation in occurrences (a push of several commits is one event, several occurrences); link classes filter before aggregation, arrows sum their members deterministically, and the count range judges aggregates, with the shown + hidden = total invariant in drawn-arrow units; the arrangement is finite, boxed, deterministic, lane-ordered, forward arcs above and rework below, shared-pair cross bundles fanned; widths √-monotone, clamped, and stable under filtering via the unfiltered-maximum override; filterDfg's toggles and inclusive count range obey shown + hidden = total with a double failure counted once; the toggle vocabulary and log count scale round-trip (39) | `dfg`, `dfg-layout`, `api` | hand-built bundle; DFG1 shape only |
| Fixtures are byte-reproducible from their build scripts; a `{repo, seed}` query resolves or fails loudly; seed search parses and ranks | `fixtures`, `selection` | `--check`; catalogue |
| The seed box searches the text it is showing; an empty reference never becomes a database request, while a type word alone still does | `searchCombo` | stubs + fake transport |
| A load under the delay is never announced; a slow one blurs the stale picture and blocks it; a failed load still restores it; no timer outlives the load | `loading` | stubs + fake clock |

Each synthesized fixture also asserts that it exhibits its own property (`sublanes`, first block).
Without that, an "overlapping PRs" fixture whose PRs do not overlap would pass every layout test
while verifying nothing. The UTC formatters are hand-written so nothing in `render/format.js` can
reach a local-time API; independence from `TZ` was checked by hand under UTC+9, UTC−8
and UTC+14.

---

## 2. The baseline comparison

The baseline is 11 pre-change renders, captured 2026-07-30 against the hardcoded vscode sub-log.
They are kept outside the repository and are read-only.

**It is not a pixel comparison and cannot be.** The baseline came from Firefox at a scale where the
sidebar occupies ~367 px; the verification renders come from headless Edge at 1:1, where it is
300 px, so everything is displaced horizontally for reasons unrelated to correctness. What was
compared instead is what *is* comparable: tick labels, tick count, node labels, lane composition,
glyph placement relative to the axis. Byte-identical comparison is used only between two renders
from the same browser.

Differences 1–6 were compared against the baseline and accounted for. Differences 7–12 postdate
that comparison and were never re-compared, the baseline being read-only. Anyone re-running the
comparison must expect all twelve.

| # | Difference |
|---|---|
| 1 | 29 links moved solid → dashed |
| 2 | Every timestamp −1 hour, labelled UTC |
| 3 | Burst badge `21` → `20`, the count now derived from `push_id` |
| 4 | `OCEL CASE` → `Sub-log`; `Case statistics` → `Per-object statistics` |
| 5 | Links coloured by the object they reach |
| 6 | The Highlights mode is gone, with its ticks |
| 7 | Activity labels are verbs: `opened/closed/merged` → `open/close/merge` |
| 8 | Commit↔PR links reversed to PR → commit, so their gradients run the other way |
| 9 | A pull request closed without merging carries a dashed ring |
| 10 | The `?` badge on extracted links is gone — 31 of them in F1 |
| 11 | Comments within a day of each other fold into one mark with a count |
| 12 | The legend is four sections and dims what is absent; sidebar renamed *Lanes* / *Folding* |

The strongest single piece of evidence was the discrete axis: every tick label exactly −1 h from the
baseline, at the same count and positions (`Mar 07 06:15 → 05:15`, … `Mar 19 15:08 → 14:08`). Tick
*selection* unchanged while only the zone moved exercises the scale, ranking, tick-selection,
label-merge and stagger logic end to end.

Dropping F1's 42 event→actor links adds no thirteenth difference: nothing ever drew them. Checked rather than assumed — the node list feeding every
trail is byte-identical before and after in both temporal modes, and F1, F13 and the stats page were
re-rendered headlessly and compared.

---

## 3. The fixture corpus

F1–F14 plus two live samples. `tests/fixtures/README.md` carries the per-fixture table — what each
one exists to exhibit — and is the place to change it. What bears on verification is this.

**F1 is the only fixture built from real GitHub data**: the vscode sub-log, 1 issue, 1 PR, 32
commits, 4 actors, one folded burst of 20, 3 validated and 31 extracted links. F2–F14 are synthetic
structures built to exercise layout and toggle behaviour. Their counts are properties of those
constructions, not observations about real workflows, and none may be cited as a finding — F10
(3 PRs, 300 commits) and F11 (four PRs, one per detection method) most of all, being the numbers
that most invite being quoted by mistake.

**LIVE1 and LIVE2 are real RPC payloads**, pulled 2026-08-04 from vscode `pr:448781946` (13 objects,
28 events, 7 links) and `pr:571599565` (147 objects, 575 events, 236 links). They are samples rather
than fixtures: only `qualifier-colour` and `selection` assert anything about them, and neither
asserts a count.

---

## 4. The data-layer gate

`scripts/rpc-check.mjs` is the acceptance check for `sql/fe_layer.sql`; run it after any change
there. It pulls one real payload with `psql -Atc "SELECT api.get_sublog(repo, seed, degree)"`,
then asserts in order:

- `findGraphProblems()` returns `[]` — the same validator every fixture passes.
- The contract facts it has no opinion on: `contract_version === 2`; every event time and interval
  bound parseable by `Date.parse`; activities inside the closed vocabulary; qualifiers among the closed four; `link_methods` an array containing `method`; no `repo`-typed object; no
  `is_bot`; no `CommitsPushed` event.
- The same payload through `loadSubLog`, so the loader is exercised and not only the validator.
- Both temporal modes through the real layout pipeline: finite x and y, every issue and PR in a band
  resolving to a finite y, one interval per commit, forward-going lifecycle extents, every link
  endpoint anchoring to finite coordinates.
- Both structural arrangements through `createLayout`: finite positions, every mark inside the box,
  no two marks overlapping, every edge end resolving to a drawn mark, a finite time extent. Cluster
  also names an anchor and honours its footprint claims — under ¾ of a claim fails, ¾ to 1 is a soft
  shortfall.
- One unauthenticated HTTP call to `api.list_repos` as `web_anon`. Everything above runs as the
  database owner and so cannot see a permissions regression; this can. Unreachable PostgREST is a
  **skip**, not a failure (`PGRST_URL`, `PGRST_SKIP`).

`scripts/dfg-check.mjs` is the sibling gate for the DFG half (§12–§13), run by `./ocpm.sh db`
beside the sub-log gate. It pulls `api.get_dfg` through psql and asserts: no `fe.link_mat`
(source, target) pair carries two links — the fact the cross-edge class attribution leans on;
`findDfgProblems()` returns `[]`; per-node conservation (each node's occurrences = starts + inbound
successions = ends + outbound, per-type edges only — a cross succession is not part of either
object's own sequence arithmetic) and `events ≤ occurrences`; the commit lane's `Push`
occurrences equal the repository's `CommitObserved` count in `fe.event`, so Trace and the map
differ by name only; no `case` or `evidence` key anywhere in the raw text; the payload through
`loadDfg` and `layoutDfg` with every coordinate finite, in-box and non-coincident; and one
unauthenticated `web_anon` POST to `/rpc/get_dfg` — the only probe that catches the `SECURITY
INVOKER` reset on the new function. PASS on microsoft/vscode and facebook/react, 2026-09-02. The
§12 measurement block in `sql/fe_layer.sql` carries the build figures (attrs-subquery pruning
verified by EXPLAIN through the E2O views, 45 s build, 637 rows, conservation on all nine
partitions). The v3 payload was diffed against the v2 sample field by field: zero differences
modulo the `CommitObserved` → `Push` rename, once the cross pass's tie order was stated
explicitly — left to the id prefixes it had flipped 11,625 of vscode's 132,050 cross successions.

The SQL's own diagnostics are separate and queried by hand: `fe.diag_sanity` (six checks — five must
be 0, the sixth exactly 11 distinct activities), `fe.diag_link_staleness`,
`fe.diag_ref_match_narrowing`, `fe.diag_link_methods`. See `DATA_LAYER.md`.

### The seed box, driven in a browser, 2026-09-01 — not re-run since

The one pointer interaction that has been checked by something other than the eye. Focus was
dispatched and the resulting DOM read back, for three cases:

| Case | Box after focus | Dropdown |
|---|---|---|
| Database, `issue:829212149` loaded | `issue #100138`, fully selected | one row, that issue |
| Fixtures, `LIVE1` loaded | `pull request #102479`, fully selected | one row, that pull request |
| Database, no seed | empty | `Type an issue or PR number, or a commit SHA.` |

**How, because the obvious route does not work here.** Headless Edge binds its CDP port to the
*Windows* loopback, which WSL2 cannot reach, so `--remote-debugging-port` is a dead end from this
shell. What does work is a same-origin page served by `scripts/serve.mjs`: it holds the app in an
iframe, so it can focus a control and read `getComputedStyle`, `selectionStart` and the dropdown's
rows straight out of the live DOM, and `--headless=new --dump-dom --virtual-time-budget` prints the
result. Two gotchas cost most of the time: Edge ignores every debugging flag if a Windows instance
is already running, unless given its own `--user-data-dir`; and `&` in a `sed` replacement means
"the whole match", which silently rewrote a query string and produced a confidently wrong reading.
The probe was scaffolding and is deleted; this paragraph is what survives of it.

### Against the live database, 2026-08-04 — not re-run since

`gharchive_ocpm_viz_wsl`, MVs last refreshed 2026-08-02 19:32–19:45 UTC. All six `fe.diag_sanity`
checks passed: no dangling event objects, no issue or PR object without events, every actor named by
an event has an actor object, no pair linked twice by one qualifier, both link endpoints objects,
distinct activities exactly 10. `fe.diag_link_staleness` reported drift 0. The gate passed on ten
real sub-logs across all three repositories and all three seed types, at degrees 0–3 (the cap is now 2), from 5 to 404 objects. The
34-pull-request hub kubernetes #68026 reported 30 soft footprint shortfalls and no failure. Latency
1.7–3.4 s per sub-log end to end, from 19.4 s before indexing and tuning (`sql/fe_layer.sql` §0.1);
`fe.refresh_links()` is ~6 s.

**Defects this found**, each caught by a check rather than by reading: duplicate links from two
branches (16,040 + 5,111 surplus rows), 3,359 objects with no events, 2 objects with a NULL id, a
nonexistent seed returning an empty payload instead of erroring, four point-intervals on one commit,
and — after the fix — the `ref_match` narrowing reaching only one of the two link families.

### The `push_order` method, 2026-09-07

The fourth commit→PR method (`DATA_LAYER.md`, "Two admission rules") was applied to
`gharchive_ocpm_viz_wsl` by recreating `mv_commit_pr_links` and its five dependent matviews in one
transaction (the refresh took 26 minutes, 21 of them `mv_commit_pr_links`), then `./ocpm.sh db`.
Checked afterwards: all six `fe.diag_sanity` checks at expected; `scripts/rpc-check.mjs` and
`scripts/dfg-check.mjs` pass (the `Push` node still equals the `CommitObserved` count, since the
method adds links and no events); `npm test` 825 / 0. The motivating sub-log, kubernetes #41633
(`issue:208391990`) at degree 2, went from 4 commits to 5: commit c669ce44, the first of PR #59542's
two commits, is now attached with `push_order` / `contains_commit` / `extracted`, beside the head
(`head_sha`) and the merge commit (`merge_commit_sha`) that were already there. Not verified: the
rule's precision on batched merge pushes was checked by construction (the previous-`Merge` bound)
and on this example, not by sampling; the count is a floor either way.

### The `prs_identity` fallback, 2026-09-07

`prs_identity` was rebuilt over all `PullRequestEvent` actions (`DATA_CONTRACT.md` §2) and its
nine dependent matviews recreated and refreshed in one transaction (6 minutes), then
`./ocpm.sh db`. Checked first, read-only: the new definition leaves every existing row unchanged
(`EXCEPT` over the old rows: 0) and adds 7,235 fallback rows, none with a NULL time. Checked
afterwards: all six `fe.diag_sanity` checks at expected; both gates pass; `npm test` 825 / 0;
`fe.diag_time_semantics` shows every pull request that used to be `first_seen(activity)` as
`created_at(payload)` (react 762, kubernetes 4,556, vscode 1,863) and none left on the fallback.
The motivating case, facebook/react #27024 (`pr:1413026032`), now starts on 2023-06-29 09:37 UTC
instead of at its close on 2023-09-29, and carries its title and refs. Not verified: which of the
two plausibility tests each of the 21 links that left `mv_issue_to_pr_validated_all` failed —
the link views keep only rows that pass, so the rejected rows are not inspectable after the fact.

### The `issues_identity` fallback, 2026-09-07

The same rebuild for issues (`DATA_CONTRACT.md` §2), over all `IssuesEvent` actions and the
non-PR `IssueCommentEvent` rows, with the same nine dependents recreated and refreshed in one
transaction (6 minutes), then `./ocpm.sh db`. Checked first, read-only: existing rows unchanged
(`EXCEPT`: 0), fallback rows react 1,684 / kubernetes 5,700 / vscode 15,023 — exactly the set
`fe.diag_time_semantics` had been reporting as `first_seen(activity)` — none with a NULL time.
Checked afterwards: all six sanity checks at expected, both gates pass, `npm test` 825 / 0, no
issue left on `first_seen(activity)`. The effect on links is far larger than for pull requests:
`mv_issue_to_pr_validated_all` 19,238 → 21,863, because every link view resolves the issue
through this relation and had been dropping links to unknown issues as `missing_issue`.

### Lifecycle intervals from the creation time, 2026-09-07

Both interval views take the identity tables' creation time as an opening (`DATA_LAYER.md`,
"Objects, activities, intervals"). Checked before: 28,472 issue and PR objects had no interval
(22,529 with a close but no open, 5,943 with no lifecycle event at all). Checked after
`./ocpm.sh db`: 0 objects without an interval; intervals 186,549 → 208,698 (issues) and
94,497 → 105,186 (PRs); all six sanity checks at expected; both gates pass; `npm test` 825 / 0.
The motivating sub-log, kubernetes #47532 at degree 2, now gives PR #65509 the interval
2018-06-27 00:25 → 2018-07-24 23:10 and PR #65539 2018-06-27 17:27 → 2018-06-28 02:00, both
previously empty, so their commit links meet the bar. Not verified: that no existing interval
moved — asserted by construction (the synthetic opening sorts first at the same instant as the
observed one and is the same state), not by diffing the two views row for row.

### Derived openings, 2026-09-07

`fe.event` branches 4 and 5 (`DATA_LAYER.md`, "Derived openings"). The first draft looked up
the source event per object with a `LATERAL` join and had no (repo, issue) index on the
2.3M-row comment MV to lean on: `fe.dfg_mat` ran over ten minutes and was cancelled. The
shipped form aggregates each source MV once and hash-joins it to the fallback identity rows
(standalone: 131 ms for PRs, 652 ms for issues); the full `./ocpm.sh db` takes 2 m 45 s. The
first application then failed the sanity check "actors named by an event with no actor object"
with 3,749, because 3,764 opener accounts named only in payloads performed no event and have no
`actor` row; the branches now name an actor only when that table has it and carry the login in
`attrs.opened_by` otherwise, and the check is back at 0. Checked after: all six sanity checks at
expected; `dfg-check` passes with `Push` still equal to `CommitObserved`; `rpc-check` passes;
`npm test` 832 / 0, six of them new in `tests/derived-opening.test.js` (the flag on timeline and
structural nodes, an actor-less event through the loader and index, the handoff rule, the
legend key). Counts: `IssueOpened` 176,362 → 198,769 (22,407 derived, 9,577 without an actor
of which 3,672 name one in attrs), `PullRequestOpened` 90,262 → 97,441 (7,179 derived, 275
without an actor, all named). Kubernetes #47532 at degree 2 now has an opening for all 8 of its
pull requests, previously 6. Not verified in a browser: the dotted ring and the hovercard rows
are asserted through the node flag and the legend key, not a screenshot.

### Creation time from the payload for every identity row, 2026-09-07

Both identity views now take `created_at` from the payload for every row (`DATA_CONTRACT.md` §2).
Checked first, read-only: no key or creation-event id changes (`EXCEPT` on the key columns: 0);
75,350 PR and 113,414 issue rows move in time, 156 and 707 of them by more than a minute; no NULL
time. Applied by dropping both views CASCADE and recreating the eleven affected matviews in one
transaction (5 m 47 s), then `./ocpm.sh db`. Checked after: all six sanity checks at expected,
both gates pass, `npm test` 832 / 0; `mv_issue_to_pr_validated_all` 21,863 → 21,866, `fe.link_mat`
193,245 → 193,248; intervals 208,698 → 208,723 (issues) and 105,186 → 105,188 (PRs). Spot checks:
vscode #235853 now starts 2018-11-29 (was the transfer's `opened` on 2024-12-11); vscode #79901 now
has [2019-08-27 11:35 → 11:57 UTC] and, because the archive stamped its `opened` event at 19:35 that
day, a second open-ended interval from there — the archive's event order is kept on purpose, and
that is the residual for the 26 late-stamped objects of 2019-08-27..29. Not verified: which of the
three new validated links owe their admission to the time shift.

---

## 5. Not verified

Stated plainly rather than left to inference. Each item re-checked 2026-08-23.

- **Pull requests known only from their comments are not drawn** (2026-09-07). 1,961 of them across
  the three repositories have no `PullRequestEvent` in the corpus, so no PR-side id and no object;
  `fe.diag_unresolvable_pr_comments` counts their 17,737 comments. Left as a floor on purpose: the
  fix is a second PR key scheme for objects no link could reach. See `DATA_LAYER.md`, Diagnostics.

- ⚠️ **There is no automated check that the picture is correct, and this is the largest gap in the
  project.** Every layout assertion checks that positions are finite, banded and anchored, never
  that the drawing means what it claims. Five defects were found by looking at the screen and by
  none of the tests: commits wrongly excluded from merged pull requests, a dead app when no seed was
  given, isolated objects indistinguishable from failures, one pull request drawn as ~30, the
  seed prompt detaching the timeline's `<svg>` so every later render drew into a node outside the
  document, and (2026-09-01) an absolute axis whose leftmost tick sat *right* of the earliest
  marks — d3 ticks only inside the domain — so a mark at 13:38 on the 29th read as the 28th.
  Each left every check passing. The sixth is the one that now *has* a check
  (`tests/axis.test.js`), because it lived in two pure functions that had no suite at all; the
  other five did not. The fifth could not have been caught even
  in principle — the others were wrong pictures, this was *no* picture, and no DOM-free assertion
  reaches a defect whose entire content is which element is attached to what. It was verified by
  driving the app headlessly and reading `#chart` out of the live DOM at each step, with the fix
  reverted as a control; that probe was scaffolding and was deleted. `scripts/shot.mjs` makes
  looking cheap, not automatic, and no baseline is compared. One narrow thing is machine-checked
  (`tests/legend.test.js`): completeness of the key, not correctness of the picture.
- **Most pointer interaction has no assertion behind it.** Tooltips and pin-to-copy, the minimap's
  drag-to-zoom grips, legend hover, the degree stepper and the actor card are exercised only by
  looking at them. Five narrower things are checked against stubs — canvas pan and zoom-about-anchor
  (`pan`), minimap dot placement (`minimap`), help-strip resolution (`helpStrip`), the two message
  surfaces (`message`), and which text the seed box hands to its search (`searchCombo`) — but the
  widgets need a DOM and a pointer, and a browser-driver suite is out of scope. The seed box's row
  *rendering* is not covered by any of them: the stub says what is searched, not what is drawn.
  It was driven in a real browser once, by hand, on 2026-09-01 (below); nothing re-runs that.
- ⚠️ **The loading overlay's wiring has not been driven in a browser, only its logic and its
  appearance.** `tests/loading.test.js` decides the timing rules against a fake clock, and the card
  was rendered from the real module through the real stylesheet and looked at
  (`.shots/loading-overlay.png`, not kept). What is unchecked is the three lines in `reload()` that
  call `show`/`hide` around the load. It resisted three routes: headless Edge binds its CDP port to
  the *Windows* loopback, which WSL2 cannot reach; `--remote-debugging-pipe` needs file descriptors
  3 and 4, which WSL interop does not pass to a Windows binary; and under
  `--virtual-time-budget` the clock **pauses while a fetch is pending**, so the overlay's own
  200 ms delay can never elapse during the request it exists to report. The same-origin iframe probe
  confirmed the reload fires (a second `get_sublog` in the resource timings) but could not see
  the overlay for that last reason. Verify by hand, or from a browser on the Windows side.
- ⚠️ **Seed symmetry is checked for one triple, and only by URL.** `facebook/react` commit
  `0005d1e`, PR #14576 and issue #14578 were loaded at degree 2 by all three routes — direct RPC,
  direct URL, in-session seed switching — and returned identical payloads (6 objects, 8 events,
  2 links) and identical renders. The asymmetry originally reported was real but lived elsewhere:
  stacked combo listeners changed the *repository* mid-query. The traversal is
  symmetric by construction — `adj` unions both link directions and `reached` takes `min(hop)` — but
  that is an argument, not a measurement, and **no test asserts that two seeds in one component give
  the same sub-log at a degree that spans them.**
- **The Stats page has never been opened against real data.** Durations, gaps, handoffs and the
  per-object tables are computed in JS over the loaded sub-log and have only run over fixtures.
  Real sub-logs are larger, sparser, and hold shapes fixtures do not, such as a commit belonging to
  several PRs. Unchecked, not known-broken. The page reports *that* a render failed; nothing
  asserts the numbers.
- **Rendering performance** is covered only by a 3-second tripwire on F10's layout, not by
  measurement. Sub-logs are small; if a real one is slow, report it.
- **No aspect-ratio pass has been done.** Renders have only been looked at near 1920×1200 (the
  baseline) and 1700×1400 (`shot.mjs`'s default). Deliberate: sizing is deferred.
- **One dataset, one snapshot, three repositories.** Every figure here comes from materialized views
  last refreshed 2026-08-02. Nothing establishes that the layer holds on a different extraction, a
  re-refresh, or a repository with other conventions.
- **The commit→PR admission rule has been wrong twice**, the first version discarding merged pull
  requests' own commits. It is right as far as can be measured now, but it has the worst track record in the layer, and every figure resting on it
  deserves more scepticism than its precision suggests.
- **The `commit_distinct` floor is measured and is still a floor** (2026-08-07). Real links lost —
  born on the PR's own branch but with no `commit_distinct` push there, so a force-push, a rebase or
  GH Archive's 20-commit truncation: **vscode 1,620, react 272, kubernetes 56**. Cross-branch
  pass-throughs correctly removed: **49,004 / 2,319 / 858**. `fe.diag_ref_match_narrowing` reports
  both columns per repo, so the cost is visible beside the benefit. ⚠️ Kubernetes pays and gains
  nothing — 56 real links lost, 0 pass-throughs removed — because its contributors work from forks.
  The removal rate differs by repository (vscode 71%, react 66%, kubernetes 32% of upstream
  `ref_match`), and that spread is real branching practice rather than a filter artifact. It is why
  raw link counts must never be compared across repositories as though they measured the same thing.

- **The cross-edge undercount is unmeasured.** DFG cross successions ride on the admitted
  links, so they are floors — but by how much is not known: measuring it would mean re-running
  the pair interleaving over raw `ref_match`, which has not been done. Quote them as floors,
  never as point estimates, and never compare them across repositories.
- **DFG1 is a sample with two staleness axes.** Pulled 2026-09-02 against MVs refreshed
  2026-08-02 and a `fe.dfg_mat` built the same day; its own `meta.source.pulled_at` and the
  payload's `mv_refreshed` are the record. Nothing asserts a count against it, and nothing
  re-pulls it automatically.
- **The process map's rendering has no automated look.** Its layout is asserted DOM-free
  (finite, boxed, ordered) and it was rendered and looked at against the live database and the
  sample on 2026-09-01; like the rest of the tool, no check says the picture means what it
  claims. Its pointer surfaces — count-label and thin-edge hovercards, click-to-focus dimming
  with the geometry pinned, the dual-handle count range, the lane/pair/activity toggles and the
  readout they drive — were each driven once in a live browser via the iframe probe
  (2026-09-01); nothing re-runs that. A consistency sweep against the Trace page (2026-09-01)
  fixed the gaps it found (scoped legends, the focus pill, edge strip labels and lane-coloured
  cross edges, collapsible sections, the currently-displayed card, database-only sourcing, the
  notice's refresh date) and left two facts as findings rather than defects: an empty artifact
  (a repository with no rows) renders an empty box with a zero readout, and the DFG focus is
  page-local — switching pages neither carries nor clears the other page's focus, matching how
  Trace's own focus survives a trip to Stats.

Checked since, one line each: a real sub-log renders and the PostgREST → `fetch()` → browser path
works (2026-08-05); `rpc-check.mjs` probes the `web_anon` path, for one function only (2026-08-07);
the `repo` type needs no fixture, not being an object; `PullRequestMergedOffPlatform` has F14 and
`tests/offplatform.test.js`; the fixture corpus sits on the four qualifiers, and rebuilding it onto them found a live defect in the link fan (2026-08-09); the
traversal was exercised at degrees 0–3 (2026-08-04); the Stats page owns an error surface
(2026-08-08).

---

## 6. Per-repo link coverage: measurable, not measured here

Comparing repositories needs per-repo issue↔PR link counts broken down by detection method. If
detection is systematically weaker on kubernetes and react than on vscode, apparent
cross-repository process differences may be artifacts of coverage rather than real behaviour.

The non-standard forms are detected: `gh-N`, `bug #N` and `For #N` are common in kubernetes and
react, and `mv_issue_pr_links_extended_conventions` detects exactly those. But *detection exists*
and *coverage is comparable across repositories* are different claims, and the second is not
measured. See `DATA_CONTRACT.md` §3.

**The figure is measurable.** `fe.diag_link_methods` in `sql/fe_layer.sql` returns
`(repo_id, method, qualifier, evidence, links)` over `fe.link` — per repository, per method, grouped
by qualifier as the per-method rule requires, with `proximity` a row of its own so its share can be reported
separately. It is not run here and no number from it is published in this document.

Until it is run, state the limitation qualitatively and say the number is not measured. **Do not
estimate it.** An invented coverage figure would undermine the very limitation it documents.
