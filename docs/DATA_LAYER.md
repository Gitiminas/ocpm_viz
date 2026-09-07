# The data layer

Everything between the shared upstream database and `loadSubLog()`. Two schemas in
PostgreSQL, four RPCs over PostgREST, and two client-side adapters. Upstream is read-only and
described in `DATA_CONTRACT.md`. The relation-by-relation inventory is `sql/fe_layer.sql` itself,
which this document explains rather than repeats.

## Schemas

`fe` holds the derivations: 19 views and materialized views, 8 diagnostic views, and five
functions (`utc` and the four refreshers). `api` holds four `SECURITY DEFINER` functions and nothing else. Both are owned by
`fe_owner`. PostgREST is configured with `db-schemas = "api"`, so `api` is the entire HTTP
surface and the frontend never reads a view directly.

Views are plain by default. The frontend asks for one sub-log at a time, so a
plain view lets the seed filter reach the underlying upstream MVs; the first lever for speed is
an index on those MVs, not a copy of them. `fe_layer.sql` §0 creates 19 such indexes and
`ANALYZE`s 13 of them, with the measurements that justified each. Three relations are
materialized, each with a measurement recorded beside it: `fe.link_mat`, `fe.seed_lookup` and
`fe.dfg_mat`.

### Applying it

```
psql -d gharchive_ocpm_viz_wsl -f sql/fe_layer.sql
psql -d gharchive_ocpm_viz_wsl -f sql/postgrest_setup.sql
SELECT fe.refresh_all();
```

That order is not negotiable. `fe_layer.sql` issues `CREATE OR REPLACE FUNCTION` on every `api`
function, and a replaced function reverts to `SECURITY INVOKER`: it then runs as `web_anon`,
which by design can read nothing in `fe`, and the app fails with *"permission denied for schema
fe"* while every local check still passes, because `scripts/rpc-check.mjs` reaches the database
as the owner and never travels the `web_anon` path that broke. `fe_layer.sql` ends in a `DO`
block that warns when any `api` function is `SECURITY INVOKER`.

Prefer `./ocpm.sh db` to running the files by hand. It applies both, runs
`fe.refresh_links()` and `fe.refresh_dfg()`, checks `fe.diag_sanity`, restarts PostgREST
(otherwise it serves the old schema from its cache) and then runs both acceptance gates.
`fe.seed_lookup` is rebuilt because re-applying the file recreates it. After an upstream refresh,
run `fe.refresh_all()` yourself.

### Refreshing

`fe.link_mat` is a copy of `fe.link`, kept because the traversal cannot filter it: to find what
a seed reaches you need the whole repository's adjacency, so there is no predicate that makes it
smaller and precomputation is the only lever left. It took the vscode degree-2 request from 4.3 s
to 1.7 s. `fe.seed_lookup` is the search index behind the seed box, 529,199 rows built in 4.2 s,
and it turns a 348 ms lookup into 1.2 ms.

Both go stale silently the moment any upstream MV is refreshed. A stale `link_mat` does not
error; it answers with last week's graph. A stale `seed_lookup` simply cannot find objects that
now exist.

| Function | Refreshes |
|---|---|
| `fe.refresh_links()` | `fe.link_mat` |
| `fe.refresh_search()` | `fe.seed_lookup` |
| `fe.refresh_dfg()` | `fe.dfg_mat` (after `fe.link_mat` — the cross-edge arm reads it) |
| `fe.refresh_all()` | all three, in dependency order |

`SELECT * FROM fe.diag_staleness` reports live rows, materialized rows and when each copy was
last written. Row counts alone cannot prove freshness, so the last-written column is the useful
one: compare it against the upstream refresh.

## The SubLog payload

One RPC returns one bundle. `meta.contract_version` is `2`; a consumer that does not understand
it should fail rather than render something subtly wrong.

```
meta:    { repo, repo_id, repo_ambiguous, contract_version: 2, seed: [{id, type}],
           traversal_degree, active_object_types, active_link_methods, generated_at,
           activity_scope, data_honesty: {…}, source: {rpc, layer, mv_refreshed} }
objects: [ { id, type, label, repo, time_semantics, vmap: {…}, intervals: [{start, end|null}] } ]
events:  [ { id, activity, time, object_id, actor_id|null, repo, comment, attrs: {…} } ]
links:   [ { source, target, qualifier, evidence, method, n_methods, link_methods: [] } ]
```

Objects come ordered by `(type, id)`, events by `(time, id)`. `meta` records the query that
produced the sub-log, for reproducibility. It is not an identity: there is no case notion, and
the same event may legitimately belong to many sub-logs.

**Ids are type-prefixed**. Objects: `issue:<issue_id>`, `pr:<pull_request_id>`,
`commit:<sha>`, `actor:<actor_id>`. Events: `issue_act:<event_id>`, `pr_act:<event_id>`,
`commit_obs:<event_id>:<commit_index>`. The prefix is load-bearing, not cosmetic: the bare
numeric ids collide. Measured 2026-08-04, 8 issue ids equal a pull request id, 11 equal an actor
id, and 76 pull request ids equal an actor id. The id carries the database id, never the display
number, so `issue:655615214` and not `issue:102358`.

**Time.** Every timestamp is UTC, rendered by `fe.utc()` as `+00:00` and not bare `+00`, which
`new Date()` rejects while this project's validator accepts. Upstream types are mixed and the
mixture is invisible, so every naive column is lifted with `AT TIME ZONE 'UTC'` where it is first
selected. `objects[].time_semantics` says what the object's start time means: `created_at(opened)`
when the opening event is in the window; `created_at(payload)` for an issue or pull request whose
opening the corpus lacks but whose later events carry its creation time (since 2026-09-07, via the
`issues_identity` / `prs_identity` fallbacks, `DATA_CONTRACT.md` §2 — the time is as exact as the
first, only the opening event is missing); `first_seen(activity)` when neither is available; `first_seen(push)`
for commits; `static` for actors. Commit time is first-seen-in-a-PushEvent, never the git author
time.

`intervals` is the only lifecycle mechanism; there is no `t_start`/`t_end` pair anywhere. A
commit gets exactly one point interval, `start = end`, from the object's own first-seen time and
not one per `CommitObserved` event. Actors get `[]`.

`meta.data_honesty` carries five strings: `commit_time`, `extracted_edges`, `validated_edges`,
`truncation`, `commit_authorship`. **Nothing under `src/` reads it.** The equivalent caveats are
in the UI as hardcoded English in the renderer, so a transport that dropped the field would look
identical. Keep it as a warning rather than a claim: a field whose removal is invisible is worse
than no field.

### What the client does with it

`loadSubLog(query, {transport})` is the only data entry point. It calls the transport,
validates the raw bundle with `findGraphProblems` (before normalising, so errors quote what
arrived), parses every timestamp into `Date` on a copy of the bundle, and adds `meta.query`. That
is all. The renderer cannot tell a fixture from a live payload.

The validator is strict about structure and silent about content. It checks: the four top-level
keys and that three of them are arrays; object `id` present and unique, `type` in the closed set
of four, `intervals` an array whose members have a `start`; event `id`, `time`, and an
`object_id` that resolves; activity known and allowed on that object type; both link endpoints
resolving to **objects**, with an event id rejected by name; `evidence` exactly
`validated` or `extracted`; `method` known if present. Everything else can be absent and will
degrade at render time instead.

Of the loosely-typed bags, the client reads little:

| Field | Read by |
|---|---|
| `vmap.commit_sha`, `.commit_message`, `.commit_author_name`, `.ref`, `.push_id` | commit tooltip, burst derivation, unique-author count |
| `vmap.login` | actor card, sidebar, actor trails |
| `vmap.in_burst` | not read; `bursts.js` derives bursts from `push_id` |
| `attrs.ref`, `attrs.push_id` | `layout/nodes.js`, for a repeatedly observed commit |
| `attrs.comment_excerpt`, `attrs.comment_truncated` | the comment card |
| `attrs.auto_closed` | one tooltip row; carried by F1, not emitted by the RPC |
| `attrs.commit_count`, `.distinct_commit_count`, `.truncated` | nothing today |

`meta.repo`, `meta.seed[]` and `meta.traversal_degree` are read; the rest of `meta` is not.

## The DFG payload

The second payload: one whole-log directly-follows graph per repository, from
`api.get_dfg(repo)` over `fe.dfg_mat` (`sql/fe_layer.sql` §12.0–§13, with the measurements).
`meta.dfg_contract_version` is `3` — its own counter, not the SubLog's `contract_version`,
so the two payloads version independently.

```
meta:        { repo, repo_id, repo_ambiguous, dfg_contract_version: 3, generated_at,
               activity_scope, data_honesty: {succession, cross_edges, commit_time, truncation},
               source: {rpc, layer, mv_refreshed} }
nodes:       [ { object_type, activity, events, occurrences, objects, starts, ends } ]
edges:       [ { object_type, from_activity, to_activity, successions, objects } ]
cross_edges: [ { from_type, from_activity, to_type, to_activity, successions, pairs,
                 link_qualifier, link_evidence, link_method } ]
```

Cross rows come one per (directed edge, link class), and the frontend aggregates them back to
ONE drawn arrow per edge (`aggregateCrossEdges`), keeping the classes as the hovercard's
breakdown and the sidebar's evidence/qualifier/method filters. The class fields are
**`link_`-prefixed** deliberately: a succession is an observation and carries no classification
of its own — the class belongs to the link it rides on, and the validator enforces the prefix
in both directions (bare `evidence`/`qualifier`/`method` refused on cross edges, `link_*`
refused on per-type edges). The attribution needs no rule: **no (source, target) pair in
`fe.link_mat` carries two links** (verified 2026-09-01; `scripts/dfg-check.mjs` asserts it on
every run, so the day an `fe.link` change breaks the fact, the gate says so before a payload
ships with silently mixed attributions).

### The E2O layer the map is counted over

The map is built over an OCEL 2.0 event-to-object relation of its own (§12.0), read by nothing
else: `fe.dfg_event` is one row per **real** event — the ten issue and pull-request activities
straight from `fe.event`, plus `Push`, one per PushEvent from `mv_push_activities` — and
`fe.dfg_e2o` is `(event_id, object_id, qualifier)`. `fe.event` carries one object per event and
therefore takes a push apart into one synthetic `CommitObserved` per commit (§4); the map puts it
back together, so a push of n commits is **one event with n occurrences**, one in each commit's
sequence. `Push` is the map's only private activity: Trace never emits it, the map never emits
`CommitObserved`, and `src/model/activities.js` carries both and says which page each belongs to.
Trace and the map therefore differ by name on purpose — "commit observed" there, "push" here —
and `scripts/dfg-check.mjs` asserts they differ by nothing else: the `Push` node's `occurrences`
must equal the repository's `CommitObserved` count in `fe.event`.

| qualifier | relates | to |
|---|---|---|
| `subject` | an issue or PR activity | the issue or pull request it is about |
| `pushed_commit` | a `Push` | each commit the push carried |
| `opener`, `closer`, `reopener`, `commenter`, `merger`, `pusher` | any event | its actor, under the role the activity gives them (`closer` for the off-platform merge, which is a close on GitHub) |

The actor rows are there because the relation is E2O; the map drops them, since `actor` has no
lane. `PullRequestMerged → merge commit` rows are deliberately absent: they would put a
pull-request activity on the commit lane, a separate modelling decision.

A **succession** is one occurrence directly followed by another within one object's own
sequence, ordered `(time, id)`; `starts`/`ends` count the objects whose sequence begins or ends
with the activity, so per type `Σ successions = Σ occurrences − Σ starts` and `Σ starts = Σ ends`
— the validator (`src/model/dfg.js`) enforces both, plus `events ≤ occurrences` per node, and
`scripts/dfg-check.mjs` the stricter per-node conservation. `events` is the distinct event count
and falls below `occurrences` only on `Push` (vscode: 88,913 pushes, 210,196 occurrences, the
same figure the `CommitObserved` lane had). **Cross edges** are counted in the interleaved
sequences of linked pairs, ties broken as the Trace page ranks marks (time, lane, id) so the two
pages agree on same-second order — which decides the direction of every closed-via-commit
succession, since the push and the close share a second — and are **floors**: they ride on the
admitted links, which the two admission rules narrow. There is no evidence field anywhere — a
succession is an observation, not a traceability claim — no actor partition, and no case
notion. Object types come from the object-id prefix, never `fe.activity_vocabulary`, because PR
comments sit on `pr:` objects under an issue-named activity.

Being computed server-side over data the client never loads, the DFG is the stated exception
to the metrics-in-JS rule — and therefore cannot follow the sidebar toggles, which the Process
page declares in a standing notice. `loadDfg` (`src/data/loadDfg.js`) is the client entry
point: validate raw, normalize (only `generated_at` becomes a `Date`), attach the query. The
page is database-only: the fixtures source declares `dfgAvailable: false` (the
`traversalEditable` capability pattern) and the pulled sample `tests/fixtures/DFG1.json`
is a test input for the validator, never served to the page.

## Objects, activities, intervals

Four object types, closed: `issue`, `pull_request`, `commit`, `actor`. `repo` is not one: a
partition key upstream, with no lifecycle and no link reaching it, so it is carried once as
`meta.repo`. Three get a lane; `actor` has no interval to draw and surfaces through the sidebar
and the actor card.

Eleven activities, closed, plus one the process map alone emits. The SQL vocabulary
(`fe.activity_vocabulary`) and the JS one (`src/model/activities.js`) agree row for row on the
eleven; `Push` is in the JS table for the map and never passes `fe.event`'s whitelist. Every
activity names the object type it belongs to.

| activity | object type | landmark | comment |
|---|---|---|---|
| `IssueOpened` | issue | | |
| `IssueClosed` | issue | yes | |
| `IssueReopened` | issue | | |
| `IssueCommented` | issue | | yes |
| `PullRequestOpened` | pull_request | | |
| `PullRequestCommented` | pull_request | | yes |
| `PullRequestMerged` | pull_request | yes | |
| `PullRequestMergedOffPlatform` | pull_request | yes, heuristic | |
| `PullRequestClosed` | pull_request | | |
| `PullRequestReopened` | pull_request | | |
| `CommitObserved` | commit | | |
| `Push` | commit | | DFG only (§12.0): one per PushEvent, one occurrence per commit it carried |

The two comment activities are the same act on GitHub, an `IssueCommentEvent`, and the tool
treats them alike wherever a comment is folded, counted or toggled; they are kept apart in
the vocabulary because the comment belongs to one object, and the activity names it.

Three upstream activities are dropped by design, and `fe.diag_dropped_activities` reports them:
`CommitsPushed` (144,556 rows on 2026-08-04, whose facts ride on each `CommitObserved` event's
`attrs` instead; the process map reads the same rows as `Push`, §12.0), `IssueComment_` (1) and
`IssueLabeled` (1). An unmapped activity throws in JS
rather than rendering a raw enum string.

Intervals come from the events, plus one opening the identity tables supply. `fe.interval_issue`
opens on `IssueOpened`/`IssueReopened` and closes on `IssueClosed`; `fe.interval_pull_request`
opens on the PR equivalents and closes on `PullRequestMerged`, `PullRequestMergedOffPlatform` or
`PullRequestClosed`. Since 2026-09-07 each view also takes the object's creation time from
`issues_identity` / `prs_identity` as an opening, sorted first at its instant: where the opening
event is in the log it is the same state at the same time and collapses into it, so no existing
interval changed; where the corpus lacks the opening, the object gets its interval from creation
to the first observed close instead of none. Before that, 22,529 issues and PRs with a close and
no open drew no lifecycle bar, and every link to them anchored at the left edge of the axis
(kubernetes #47532, PRs #65509 and #65539). Consecutive same-state events are collapsed. An
`end` of `null` means no close was observed — the object was still open as far as the log knows,
which now also covers an object whose only surviving events are comments.

## Links

`fe.link` is a `UNION ALL` of four branches. Both endpoints are always objects; there are no
actor links, because who performed an event is `event.actor_id` and nothing else.

| Branch | source → target | qualifier | method | Source |
|---|---|---|---|---|
| A | `pr:` → `issue:` | `resolves` | first present of `pr_body, pr_title, commit_message, issue_comment, branch_name, closed_via_commit, proximity` | `mv_issue_to_pr_validated_all` |
| A2 | `pr:` → `issue:` | `resolves` | the view's own `link_method` | `mv_issue_pr_links_extended_conventions`, only where branch A has no row for the pair |
| B | `pr:` → `commit:` | `merge_commit` if `merge_commit_sha` is among the methods, else `contains_commit` | first present of `merge_commit_sha, head_sha, push_order, ref_match` | `fe.commit_pr_link`, grouped by (repo, sha, PR) |
| D | `commit:` → `issue:` | `references_issue` | `commit_message` | `mv_commit_message_issue_links_all` where `ref_scope = 'same_repo'` |

Qualifiers emitted: `resolves`, `contains_commit`, `merge_commit`, `references_issue`. Evidence:
`validated`, `extracted`. Methods: the ten named above plus whatever
`mv_issue_pr_links_extended_conventions.link_method` carries. The JS enum in
`src/model/evidence.js` is the vocabulary and holds 17 values, four validated (`pr_body`,
`head_sha`, `merge_commit_sha`, `closed_via_commit`) and thirteen extracted. An unknown method
throws.

**The evidence rule.** A link is `validated` when the platform's own data asserts it: documented
GitHub syntax that GitHub acts on, or an exact identity match. It is `extracted` when it comes
from parsing a convention nobody enforces. `inferred` is retired vocabulary. The rule is applied
per link, not per method: a link is validated if **any** of its methods validates it, which is
what `classifyLink` does in JS and what branches A and B reproduce in SQL. Testing the primary
method alone draws well-evidenced links dashed.

`n_methods` and `link_methods` carry multi-method agreement to the tooltip. `link_methods` is a
real array in the payload; upstream stores it semicolon-joined.

Branch D deduplicates: `mv_commit_message_issue_links_all` holds one row per (commit, reference,
push), so a rebased commit produces several. Branch B aggregates rather than emitting one row per
upstream method row, for the same reason and because aggregating recovers the real `n_methods`.

### Two admission rules of this layer

Everything else in this layer inherits upstream's rules. These two do not, and both narrow.

**Commit → PR.** GitHub never states which commits belong to a pull request; GH
Archive's PR payload does not list them. The best available evidence is `ref_match`: this commit
was pushed to the PR's branch while the PR was open. That is noisy, because merging anything into
a long-lived branch re-enumerates every incoming commit and attributes all of them to the PR.
`fe.commit_pr_link` therefore admits an `mv_commit_pr_links` row only when the method
is `head_sha` or `merge_commit_sha` (identity matches, untouched), or `push_order` (anchored on
both of those SHAs, untouched — see below), **or** the commit was flagged
new by GitHub on that PR's own head branch — `fe.commit_born_ref` tested against
`fe.pr_head_ref`. On vscode PR #116416 it admits 36 of the 217 `ref_match` commits upstream: the
previous rule had already dropped 130 first seen on trunk, and this one drops 52 more that were
born on other people's branches.

**Issue ↔ PR.** `mv_issue_pr_links_commit_message` is itself derived from commit→PR
attribution, so it carries the wide attribution into the issue↔PR links. Branch A re-tests each
`commit_message` method against `fe.commit_pr_link` and strips it where no still-admitted commit
for that PR carries the mention; the primary method is recomputed from what survives, and a pair
left with no method disappears.
The test is deliberately conservative and removes only what it can positively disprove: the two
upstream views parse commit messages differently, so a `cm_mention` guard keeps a link the support
table cannot adjudicate rather than dropping it over a parser difference.

**Every commit-link and issue↔PR figure is therefore a floor.** A commit written on the PR's own
branch can still fail the test after a force-push, a rebase, or GH Archive's 20-commit truncation
of `PushEvent.commits`. Raw `ref_match` is the ceiling. Quote a range, and never compare raw link
counts between repositories: the removal rate differs sharply by branching practice, and
kubernetes pays the cost while gaining almost nothing because its contributors work from forks.
For vscode, 71,470 upstream pairs narrow to 20,846. The measured cost (2026-08-07) is 1,620 real
links for vscode, 272 for react, 56 for kubernetes.

`SELECT * FROM fe.diag_ref_match_narrowing` prints, per repository, the upstream pair count, what
was kept, what was dropped as born elsewhere, what was dropped though born here (the floor's
size), and what is kept only by `ref_match`. Run it rather than quoting the figures from memory.

**`push_order`, the fourth commit → PR method (2026-09-07).** `ref_match` cannot fire on a
fork-based PR at all, and the two SHA methods name only the branch tip and the merge commit, so
for most kubernetes PRs the commits *behind* the tip had no method — although the merge push to
the base branch lists them, oldest first, immediately before the tip. `push_order` reads that
enumeration: in a push where the PR's `head_sha` sits at index *h* and its `merge_commit_sha` at
*h+1*, every commit between the previous merge commit in that push and *h* is the PR's. It is
detected upstream, as a fourth branch of `mv_commit_pr_links` (the one place this project has
patched an upstream definition; its banner in `sql/matviews_scoped.sql` says why), so the
inherited `admitted` rule applies to it unchanged, and the two issue↔PR views that join
`mv_commit_pr_links` gain from it too. Evidence `extracted`: GitHub asserts the order and the two
SHAs, the attribution is our inference. Still a floor — squash merges, non-adjacent pairs and
20-commit truncation yield nothing. Measured on 2026-09-07 after the refresh: upstream admits
13,516 `push_order` rows for kubernetes (6,580 PRs), 9,994 for vscode (2,478), 417 for react
(101); `fe.link_mat` grew from 171,817 to 191,540 links, and issue↔PR `commit_message` links
rose too (vscode 2,293 → 2,874, kubernetes 3,053 → 3,078) because the mentions on the newly
attributed commits now reach a pull request. `fe.diag_link_methods` reports its per-repository
count as primary method (12,730 / 8,479 / 388 — lower than upstream where an earlier event's
`head_sha` also names the commit and wins the primary slot). In
`fe.diag_ref_match_narrowing`, a commit also named by `push_order` no longer counts as
`kept_only_by_ref_match` (vscode 16,124 → 13,660).

## The RPCs

All four are `POST /rpc/<name>` with a JSON body. The browser calls same-origin `/rpc/*`;
`scripts/serve.mjs` proxies to PostgREST so the two share an origin, and answers 502 when
PostgREST is unreachable.

**`api.get_sublog(repo text, seed text, traversal_degree int DEFAULT 1) RETURNS jsonb`.**
Returns the payload above. Raises on a degree outside 0..2, a repository name it cannot find, a
seed that is not an issue, pull request or commit in that repository, and a traversal that returns
nothing. The degree range mirrors `TRAVERSAL_DEGREE` in `src/data/api.js`; change them together.
Server-side `traversal_degree` and the client's `focusDegree` are different things and CLAUDE.md
names them as the pair never to conflate.

The traversal runs as its own statement and ends in typed key arrays. `WITH RECURSIVE` over
`fe.link_mat` for the repository, undirected (a link is a traceability edge for reachability even
though it keeps its direction in the payload), stopping at `hop < traversal_degree`, then
`min(hop)` per id. Objects are the ids reached; events are `fe.event` rows for those objects;
actors are pulled in by whichever events survive and are **not traversed**, because one maintainer
connects to thousands of objects at a single hop; links are `fe.link_mat` rows with **both**
endpoints in the sub-log, or the payload would carry a dangling reference. There is no row cap.

The seed's existence is checked before the traversal, against the natural key rather than the
derived id. It has to be: the traversal seeds itself with the literal string, so without the check
a nonexistent seed returns a structurally valid, completely empty payload that renders as "this
repository has no process".

**Repository resolution is by name**, and `repo.name` is not unique in this database:
`kubernetes/kubernetes` resolves to both 20580498 (2.4M events) and 40511817 (1 event). The tie
breaks on event count, then id, and `meta.repo_ambiguous` reports that the name was ambiguous
rather than hiding it. `api.search_seeds` resolves names the same way, and `api.list_repos`
returns one row per name by the same rule, so the picker offers what the RPC would pick.

**`api.search_seeds(repo, seed_type, number_query, sha_prefix, text_query, max_results)`** returns
`(id, type, label, number, sha, title)` from `fe.seed_lookup`, ordered `type, number DESC NULLS
LAST, id` and capped at `max_results` (1..200, default 20). It takes an **already-parsed**
reference. `parseSeedRef` in `src/data/seedQuery.js` turns "pr #243221" into `{type, number,
shaPrefix, text}`, and a second parser in SQL would give the two transports something to disagree
about. So: **SQL filters, JavaScript ranks.** The function returns a permissive superset;
`scoreSeedRef` applies exact-beats-prefix-beats-substring, the same ranker the fixture search
uses. The client asks for `min(200, limit × 5)` rows because trimming before ranking would discard
better matches than it keeps, and sends free text only when there is no number and no SHA.

⚠️ **An empty box is not a query, and the client does not send one.** With every filter NULL the
function is well-defined and answers with whatever its ordering puts first — commits by SHA
ascending — so the seed box used to open on `commit 0000a70, commit 0000f18, …`, a list that names
nothing anyone asked for and cost a 200-row round trip per focus. `searchSeeds` in
`src/data/api.js` returns `[]` when `parseSeedRef` names nothing, and the box says what it wants
instead. This deliberately does *not* mirror the fixture search, which enumerates its catalogue for
an empty query: 16 fixture seeds are a list worth showing and a repository is not. A type word
alone ("pr") is a filter rather than nothing, and still queries.

**`api.list_repos()`** returns `(name, repo_id, available, reason, seeds)`, one row per distinct
name, most seeds winning. `available` is computed from `fe.seed_lookup` rather than declared;
`reason` is `'No issues, pull requests or commits in the window.'` when it is false.

**`api.get_dfg(repo)`** returns the DFG payload above, read from `fe.dfg_mat` (0.5 s, 59 KB
for vscode on 2026-09-06). The same name resolution and ambiguity report as `get_sublog` —
the two resolvers must never disagree about which repository a name means. It raises only on an unknown
name; there is no seed to check and no degree to bound. Gate: `scripts/dfg-check.mjs`.

Client-side errors are in `src/data/api.js`. A network failure becomes an `Error` naming the
PostgREST URL, with `.unreachable = true`; a non-2xx becomes `body.message` plus `Hint:` and
`Details:` lines, with `.status`, `.code` and `.hint` attached. A missing `repo` or `seed`, or a
degree out of range, throws before anything is fetched.

## Roles

`authenticator` is the only role PostgREST connects as: LOGIN, NOINHERIT, member of `web_anon` and
nothing else, so a bug that skips the role switch fails closed. `web_anon` is what a request runs
as; its entire privilege set is USAGE on `api` and EXECUTE on the functions there. `fe_owner` owns
both schemas and is what an RPC runs as under `SECURITY DEFINER`, which is why `web_anon` never
needs SELECT on 14 GB of raw event data. `fe_owner` is deliberately not a superuser and every
function pins `search_path = fe, public, pg_temp`.

`postgrest_setup.sql` applies all of this by looping over the `api` schema, never by naming a
function, and ends in seven checks that must all read `ok`: role membership, EXECUTE,
`prosecdef`, `proconfig`, no superuser owner, `web_anon` cannot SELECT `public.event`, `web_anon`
has no USAGE on `fe`. Each check counts over all `api` functions with `count(*) FILTER`, because
`bool_and` over an empty schema would report `ok` on a broken deployment. The trap this guards is
the `SECURITY DEFINER` reset described under **Applying it** above.

## Fixtures

The other source. `src/data/source.js` is the seam: three operations (`listRepos`, `searchSeeds`,
`loadSubLog`), two implementations, one shape, selected by `?source=` and defaulting to fixtures
because a tool that fails to start when PostgREST is down would be worse than one that starts on
fixtures and says so. The fixture source has no traversal, so a seed resolves only where a sub-log
was pre-built, and it answers a `{fixture}` address as a direct reference for tests and written-down
links. The database source has no default seed: a seed is chosen by search, never from a list.
`tests/fixtures/README.md` lists F1–F14 and the two LIVE samples and what each exists to exhibit.

## Diagnostics

Every view in this layer that subtracts something is obliged to report it. Run these after any
upstream refresh.

| View | What it tells you |
|---|---|
| `fe.diag_staleness` | Live vs materialized rows and last-written time for `fe.link_mat`, `fe.seed_lookup` and `fe.dfg_mat` (whose live count is honestly NULL — recomputing it is the whole build) |
| `fe.diag_link_staleness` | Drift between `fe.link` and `fe.link_mat` alone |
| `fe.diag_sanity` | Six checks, each with its expected value: dangling event objects, issue/PR objects with no events, actors named by an event with no actor object, pairs linked twice by the same qualifier, link endpoints that are not objects, and that exactly 10 distinct activities occur |
| `fe.diag_dropped_activities` | What the vocabulary whitelist drops |
| `fe.diag_unresolvable_pr_comments` | PR comment events and PRs discarded because no numeric PR id exists for them |
| `fe.diag_time_semantics` | How many issue and PR objects needed the first-seen fallback, per repository |
| `fe.diag_link_methods` | Link counts grouped by `(repo, method, qualifier, evidence)`. Group by method **and** qualifier: `commit_message` is one technique covering two relationships |
| `fe.diag_ref_match_narrowing` | Per repository, what the commit→PR narrowing kept, what it removed, and what it cost |
