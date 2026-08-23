# The data layer

Everything between the shared upstream database and `loadObjectGraph()`. Two schemas in
PostgreSQL, three RPCs over PostgREST, and one client-side adapter. Upstream is read-only and
described in `DATA_CONTRACT.md`; the exact relation-by-relation inventory of this layer is in
`_ground_truth.md` §3, which this document explains rather than repeats.

## Schemas

`fe` holds the derivations: 15 views and materialized views, 8 diagnostic views, and five
functions (`remap_activity`, `utc`, and the three refreshers). `api` holds three `SECURITY DEFINER` functions and nothing else. Both are owned by
`fe_owner`. PostgREST is configured with `db-schemas = "api"`, so `api` is the entire HTTP
surface and the frontend never reads a view directly.

Views are plain by default (decision 10). The frontend asks for one sub-log at a time, so a
plain view lets the seed filter reach the underlying upstream MVs; the first lever for speed is
an index on those MVs, not a copy of them. `fe_layer.sql` §0 creates 19 such indexes and
`ANALYZE`s 13 of them, with the measurements that justified each. Two relations are
materialized, both with a measurement recorded beside them: `fe.link_mat` and `fe.seed_lookup`.

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

Prefer `../ocpm.sh db` to running the files by hand. It applies both, runs
`fe.refresh_links()`, checks `fe.diag_sanity`, restarts PostgREST (otherwise it serves the old
schema from its cache) and then runs the acceptance gate. Note that it refreshes only
`fe.link_mat`; after an upstream refresh, run `fe.refresh_all()` yourself.

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
| `fe.refresh_all()` | both, in dependency order |

`SELECT * FROM fe.diag_staleness` reports live rows, materialized rows and when each copy was
last written. Row counts alone cannot prove freshness, so the last-written column is the useful
one: compare it against the upstream refresh.

## The ObjectGraph payload

One RPC returns one bundle. `meta.contract_version` is `2`; a consumer that does not understand
it should fail rather than render something subtly wrong (decision 45).

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
the same event may legitimately belong to many sub-logs (decision 1).

**Ids are type-prefixed** (decision 51). Objects: `issue:<issue_id>`, `pr:<pull_request_id>`,
`commit:<sha>`, `actor:<actor_id>`. Events: `issue_act:<event_id>`, `pr_act:<event_id>`,
`commit_obs:<event_id>:<commit_index>`. The prefix is load-bearing, not cosmetic: the bare
numeric ids collide. Measured 2026-08-04, 8 issue ids equal a pull request id, 11 equal an actor
id, and 76 pull request ids equal an actor id. The id carries the database id, never the display
number, so `issue:655615214` and not `issue:102358`.

**Time.** Every timestamp is UTC, rendered by `fe.utc()` as `+00:00` and not bare `+00`, which
`new Date()` rejects while this project's validator accepts. Upstream types are mixed and the
mixture is invisible, so every naive column is lifted with `AT TIME ZONE 'UTC'` where it is first
selected. `objects[].time_semantics` says what the object's start time means: `created_at(opened)`
when the opening event is in the window, `first_seen(activity)` when it is not, `first_seen(push)`
for commits, `static` for actors. Commit time is first-seen-in-a-PushEvent, never the git author
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

`loadObjectGraph(query, {transport})` is the only data entry point. It calls the transport,
validates the raw bundle with `findGraphProblems` (before normalising, so errors quote what
arrived), parses every timestamp into `Date` on a copy of the bundle, and adds `meta.query`. That
is all. The renderer cannot tell a fixture from a live payload.

The validator is strict about structure and silent about content. It checks: the four top-level
keys and that three of them are arrays; object `id` present and unique, `type` in the closed set
of four, `intervals` an array whose members have a `start`; event `id`, `time`, and an
`object_id` that resolves; activity known and allowed on that object type; both link endpoints
resolving to **objects**, with an event id rejected by name (decision 49); `evidence` exactly
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

## Objects, activities, intervals

Four object types, closed: `issue`, `pull_request`, `commit`, `actor`. `repo` is not one
(decision 39) — it is a partition key upstream, has no lifecycle and no link reaches it, so it is
carried once as `meta.repo`. Three get a lane; `actor` has no interval to draw and surfaces
through the sidebar and the actor card (decision 15).

Ten activities, closed. The SQL vocabulary (`fe.activity_vocabulary`) and the JS one
(`src/model/activities.js`) agree row for row.

| activity | object type | landmark | comment |
|---|---|---|---|
| `IssueOpened` | issue | | |
| `IssueClosed` | issue | yes | |
| `IssueReopened` | issue | | |
| `IssueCommented` | issue (JS: also pull_request) | | yes |
| `PullRequestOpened` | pull_request | | |
| `PullRequestMerged` | pull_request | yes | |
| `PullRequestMergedOffPlatform` | pull_request | yes, heuristic | |
| `PullRequestClosed` | pull_request | | |
| `PullRequestReopened` | pull_request | | |
| `CommitObserved` | commit | | |

`IssueCommented` is the one activity valid on two object types. GitHub models PR comments as
issue comments, so `fe.remap_activity` turns `PullRequestCommented` into `IssueCommented` before
the vocabulary whitelist runs. **Remap first, whitelist second.** Reversed, all 1,343,232 PR
comments are dropped as unknown and nothing says so.

Three upstream activities are dropped by design, and `fe.diag_dropped_activities` reports them:
`CommitsPushed` (144,556 rows on 2026-08-04, whose facts ride on each `CommitObserved` event's
`attrs` instead), `IssueComment_` (1) and `IssueLabeled` (1). An unmapped activity throws in JS
rather than rendering a raw enum string.

Intervals come from the events. `fe.interval_issue` opens on `IssueOpened`/`IssueReopened` and
closes on `IssueClosed`; `fe.interval_pull_request` opens on the PR equivalents and closes on
`PullRequestMerged`, `PullRequestMergedOffPlatform` or `PullRequestClosed`. Consecutive
same-state events are collapsed. An `end` of `null` means still open.

## Links

`fe.link` is a `UNION ALL` of four branches. Both endpoints are always objects; there are no
actor links (decision 41), because who performed an event is `event.actor_id` and nothing else.

| Branch | source → target | qualifier | method | Source |
|---|---|---|---|---|
| A | `pr:` → `issue:` | `resolves` | first present of `pr_body, pr_title, commit_message, issue_comment, branch_name, closed_via_commit, proximity` | `mv_issue_to_pr_validated_all` |
| A2 | `pr:` → `issue:` | `resolves` | the view's own `link_method` | `mv_issue_pr_links_extended_conventions`, only where branch A has no row for the pair |
| B | `pr:` → `commit:` | `merge_commit` if `merge_commit_sha` is among the methods, else `contains_commit` | first present of `merge_commit_sha, head_sha, ref_match` | `fe.commit_pr_link`, grouped by (repo, sha, PR) |
| D | `commit:` → `issue:` | `references_issue` | `commit_message` | `mv_commit_message_issue_links_all` where `ref_scope = 'same_repo'` |

Qualifiers emitted: `resolves`, `contains_commit`, `merge_commit`, `references_issue`. Evidence:
`validated`, `extracted`. Methods: the ten named above plus whatever
`mv_issue_pr_links_extended_conventions.link_method` carries. The JS enum in
`src/model/evidence.js` is the vocabulary and holds 16 values, four validated (`pr_body`,
`head_sha`, `merge_commit_sha`, `closed_via_commit`) and twelve extracted. An unknown method
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

**Commit → PR (decision 80).** GitHub never states which commits belong to a pull request; GH
Archive's PR payload does not list them. The best available evidence is `ref_match`: this commit
was pushed to the PR's branch while the PR was open. That is noisy, because merging anything into
a long-lived branch re-enumerates every incoming commit and attributes all of them to the PR.
`fe.commit_pr_link` therefore admits an `mv_commit_pr_links` row only when the method
is `head_sha` or `merge_commit_sha` (identity matches, untouched) **or** the commit was flagged
new by GitHub on that PR's own head branch — `fe.commit_born_ref` tested against
`fe.pr_head_ref`. On vscode PR #116416 it admits 36 of the 217 `ref_match` commits upstream; the
rest were born on other branches.

**Issue ↔ PR (decision 62).** `mv_issue_pr_links_commit_message` is itself derived from commit→PR
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
size), and what is kept only by `ref_match`. Run it rather than quoting the figures from memory:
`sql/fe_layer.sql` and `DECISIONS.md` do not agree on them.

## The RPCs

All three are `POST /rpc/<name>` with a JSON body. The browser calls same-origin `/rpc/*`;
`scripts/serve.mjs` proxies to PostgREST so the two share an origin, and answers 502 when
PostgREST is unreachable.

**`api.get_object_graph(repo text, seed text, traversal_degree int DEFAULT 1) RETURNS jsonb`.**
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

**`api.list_repos()`** returns `(name, repo_id, available, reason, seeds)`, one row per distinct
name, most seeds winning. `available` is computed from `fe.seed_lookup` rather than declared;
`reason` is `'No issues, pull requests or commits in the window.'` when it is false.

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
function (decision 71), and ends in seven checks that must all read `ok`: role membership, EXECUTE,
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
links. The database source has no default seed, because decision 34 forbids the list one would have
to be picked from. `tests/fixtures/README.md` lists F1–F14 and the two LIVE samples and what each
exists to exhibit.

## Diagnostics

Every view in this layer that subtracts something is obliged to report it. Run these after any
upstream refresh.

| View | What it tells you |
|---|---|
| `fe.diag_staleness` | Live vs materialized rows and last-written time for `fe.link_mat` and `fe.seed_lookup` |
| `fe.diag_link_staleness` | Drift between `fe.link` and `fe.link_mat` alone |
| `fe.diag_sanity` | Six checks, each with its expected value: dangling event objects, issue/PR objects with no events, actors named by an event with no actor object, pairs linked twice by the same qualifier, link endpoints that are not objects, and that exactly 10 distinct activities occur |
| `fe.diag_dropped_activities` | What the vocabulary whitelist drops, with the remap already applied |
| `fe.diag_unresolvable_pr_comments` | PR comment events and PRs discarded because no numeric PR id exists for them |
| `fe.diag_time_semantics` | How many issue and PR objects needed the first-seen fallback, per repository |
| `fe.diag_link_methods` | Link counts grouped by `(repo, method, qualifier, evidence)`. Group by method **and** qualifier: `commit_message` is one technique covering two relationships |
| `fe.diag_ref_match_narrowing` | Per repository, what the commit→PR narrowing kept, what it removed, and what it cost |
