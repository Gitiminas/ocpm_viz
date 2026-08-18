# How the data reaches the screen

Plain-language walkthrough of the whole pipeline, from one database call to the drawn timeline.

Running example: `tests/fixtures/LIVE1.json` — a real payload pulled from the database, starting
at vscode PR #102479. It came back with **13 objects (1 issue, 1 pull request, 4 commits,
7 actors), 28 events, 7 links**.

---

## 1. The database call

Everything arrives in one call. There is no second request, and nothing is fetched piece by piece.

**What it does, in general**

1. Look up the repository by name in `repo`, get its `repo_id`.
2. Check the `seed` object really exists in that repository. If it doesn't, raise an error rather
   than return an empty payload.
3. Walk `fe.link_mat` outward from the seed, up to `traversal_degree` hops, treating each link as
   undirected. This produces a set of object ids.
4. Decode that set into three typed arrays: `_issue_ids`, `_pr_ids`, `_shas`.
5. Fetch only those objects, their lifecycle intervals, their events, and every link whose **both**
   endpoints are in the set.
6. Return one JSON payload: `{meta, objects[], events[], links[]}`.

**What it did here**

```sql
SELECT api.get_object_graph('microsoft/vscode', 'pr:448781946', 2);
```

1. `repo.name = 'microsoft/vscode'` → `repo_id = 41881900`. `repo.name` is not unique in this
   database, so ties break on event volume and the ambiguity is reported in `meta.repo_ambiguous`.
2. The seed matches `^pr:[0-9]+$`, so it checks `fe.object_pull_request` for
   `pull_request_id = 448781946`. It strips the `pr:` prefix and searches on the numeric column —
   searching on the full `'pr:448781946'` string is ~300× slower, because an index can't answer a
   query about a stitched-together string (measured: 1.5 ms vs ~500 ms).
3. Starting from the pull request, hop 1 reaches `issue:655615214` and 4 commits. Hop 2 finds
   nothing new.
4. `_pr_ids = {448781946}`, `_issue_ids = {655615214}`, `_shas` = the 4 SHAs. Passing plain arrays
   and testing `= ANY(...)` is what lets the filter reach the index; joining the object views
   against a list of ids instead would build all 146,654 vscode issues first and then throw them
   away.
5. Where each piece comes from:

| type | view it reads | columns it takes |
|---|---|---|
| issue | `issues_identity` (fallback: `mv_issue_and_issuecomment_activities_full`) | `issue_id`, `issue_number`, `issue_created_at` |
| issue intervals | `mv_issue_and_issuecomment_activities_full` | rows where `activity_type` is `IssueOpened` / `IssueReopened` / `IssueClosed`, plus `activity_timestamp` |
| pull request | `prs_identity` (fallback: `mv_pull_request_events_full`) | `pull_request_id`, `pr_number`, `pr_created_at` |
| PR attributes | `mv_pull_request_events_full`, only the `action = 'opened'` row | `pr_title`, `head_ref`, `base_ref` |
| PR intervals | `mv_pull_request_and_comment_activities_full` | `PullRequestOpened` / `Reopened` vs `Merged` / `Closed` |
| commit | `mv_push_commits_full` | `commit_sha`, `created_at`, `commit_message`, `commit_author_name`, `commit_author_email`, `ref`, `push_id`, `commit_index` |
| events | the two activity MVs, plus one synthetic `CommitObserved` per commit row | `event_id`, `activity_type`, `activity_timestamp`, `actor_id` |
| actors | the `actor` base table, looked up by the `actor_id` on the events that survived | `id`, `login` |

The fallbacks exist because some issues and pull requests were opened *before* the data window
starts, so they have no "opened" record: 11.3% of issues and 7,179 pull requests. Without the
fallback their events would point at an object that isn't there, and `findGraphProblems` would
reject the whole payload.

One quirk worth knowing: PR **comment** rows carry the *issue* id in their `pull_request_id`
column. So PR events are joined on `(repo_id, pr_number)` instead. Joining on `pull_request_id`
loses 99.99% of PR comments; joining on the number loses 6.5%.

6. What came out:

```json
{"id":"issue:655615214","type":"issue","label":"#102358",
 "time_semantics":"created_at(opened)",
 "intervals":[{"start":"2020-07-13T06:27:13+00:00","end":"2020-07-14T10:02:30+00:00"}],
 "vmap":{"issue_id":655615214,"issue_number":102358}}

{"id":"pr:448781946","type":"pull_request","label":"PR #102479",
 "time_semantics":"created_at(opened)",
 "intervals":[{"start":"2020-07-14T10:05:46+00:00","end":"2020-07-14T13:24:15+00:00"}],
 "vmap":{"title":"fixes #102358","pr_number":102479,
         "head_ref":"joao/release/1.47/fix-102358","base_ref":"release/1.47"}}
```

and one of the 7 links:

```json
{"source":"pr:448781946","target":"issue:655615214","qualifier":"resolves",
 "evidence":"extracted","method":"pr_title","n_methods":3,
 "link_methods":["branch_name","commit_message","pr_title"]}
```

Three separate conventions say this pull request closes that issue: `pr_title` ("fixes #102358"),
`branch_name` (`joao/release/1.47/fix-102358`), and `commit_message`. It is still classified
`extracted`, because all three are patterns we parsed out of free text ourselves — GitHub never
asserted the connection. So the edge is drawn dashed.

Object ids carry a type prefix (`issue:`, `pr:`, `commit:`, `actor:`) because the bare numbers
collide: 8 `issue_id` values equal a `pull_request_id`, and 76 `pull_request_id` values equal an
`actor.id`. Without the prefix, a sub-log holding such a pair would silently merge two objects
into one.

---

## 2. What the app builds from the payload

**In general**

1. `rpcTransport` POSTs to `/rpc/get_object_graph` and gets the JSON.
2. `assertValidGraph` checks the whole payload against the `ObjectGraph` contract and throws if
   anything is off. It collects every problem rather than stopping at the first.
3. `normalizeGraph` turns each timestamp string into a `Date`. Nothing else changes.
4. `indexObjectGraph` builds the lookups: `byId`, `objectsByType`, `eventsByObject` (sorted by
   time), `pusherByCommit`, `eventCountByActor`.
5. `deriveRelGroups`, `deriveQualifiers` and `deriveMethods` build the sidebar's checkbox
   vocabulary **from the links this sub-log actually contains** — never from a fixed list in the
   code, so a different sub-log gets different controls.
6. `deriveBursts`, `deriveCommentBursts`, `deriveCommitGroups` and `buildAdjacency` work out the
   groupings and the object-to-object connections.
7. `assignObjectColors` gives each object its own shade, and `describeSubLog` writes the
   breadcrumb.

**Here**

| step | result |
|---|---|
| `assertValidGraph` | 13 objects, 28 events, 7 links, every `activity` in the closed vocabulary → passes |
| `normalizeGraph` | `"2020-07-13T06:27:13+00:00"` → `Date`. The `+00:00` matters: bare `+00` is `Invalid Date` in JS while still passing the validator |
| `indexObjectGraph` | `eventsOf('issue:655615214')` → 12 events, oldest first |
| `deriveQualifiers` | `resolves`, `contains_commit`, `merge_commit` — three checkboxes, because that is what is present |
| `deriveMethods` | `pr_title`, `head_sha`, `merge_commit_sha`, `ref_match`, … |
| `deriveRelGroups` | `Issue ↔ PR`, `PR ↔ Commit` |
| `deriveCommitGroups` | one group, "PR #102479's commits", holding all 4 |
| `deriveBursts` | groups commits by `push_id` (`5371908516`, `5370957789`, …); each push here carried one commit, so nothing folds |
| `buildAdjacency` | PR ↔ issue, PR ↔ each of the 4 commits — this is what the focus BFS walks when you click something |
| `assignObjectColors` | one shade per object, keyed on lifecycle order, so toggling can never recolour anything |

Note what is derived **here** rather than sent by the database: bursts, comment bursts, commit
groups, adjacency, and every number on the statistics page. That is deliberate (decision 12). If
the database precomputed them, hiding comments would leave the gap figures unchanged and nothing
would say so.

---

## 3. How it gets drawn

**The render pass, in order** — one call to `createLayout()` chooses the engine by mode and
returns one shape; the renderer then draws by `layout.kind`, never by mode.

In the three timeline modes (`kind: 'temporal'`):

```
buildNodes → filterNodes → assignRanks → createScales (x) → packRows
           → computeLaneGeometry → rowY (y) → createAnchors → draw
```

`filterNodes` runs before `assignRanks` so that hiding comments cannot shift the ordinal positions
of the nodes that remain. `packRows` runs after x is known, because collisions are horizontal.

In the **off** mode (`kind: 'structural'`), time is released from position and there are no lanes:

```
buildStructuralNodes (one per OBJECT) → filterNodes → buildStructuralEdges (visible links only)
           → layoutLayered | layoutCluster → nudges (drags) → draw edges, then marks
```

The links shape the arrangement, so hiding a relationship class genuinely rearranges the picture
rather than merely erasing lines. Time survives on the arrowheads (which end came first), the
time brush, and the hovercard's first row.

**Here**

| stage | what happened |
|---|---|
| `buildNodes` | 28 events → 28 nodes, each tagged with its lane (`issue`, `pull_request`, `commit`) |
| `filterNodes` | nothing hidden by default, so all 28 survive |
| `createScales` | x position by mode: `real` is linear in time, `highlights` caps each gap at 3 hours so quiet stretches shrink, `ordinal` spaces events evenly by rank and discards real durations |
| `packRows` | the issue and PR lanes need one row each; the commit lane bumps overlapping glyphs down a row. A lane only splits into sub-lanes when two of its objects overlap *in time* |
| `computeLaneGeometry` | three lanes stacked, each as tall as its row count needs |
| `createAnchors` | where each link meets each object — for a commit, the node's packed row, not the top of the lane |
| draw | into eight ordered SVG layers: `bg`, `seq`, `link`, `halo`, `preview`, `node`, `label`, `axis` |

**What each part of the payload becomes** (in the timeline modes; in off mode every object is
one mark and every link one edge, and there are no lanes)

| payload | on screen |
|---|---|
| an `issue` or `pull_request` object | a lane |
| its `intervals` | the lifecycle bar — one bar **per interval**, so a reopened issue draws several bars on one row |
| an event | a glyph on that lane at its `time`: circle for issue, diamond for pull request, square for commit |
| `activity` in the landmark set (`IssueClosed`, `PullRequestMerged`) | drawn emphasised |
| an event with `comment: true` | a comment mark, foldable into a comment burst when several cluster within the chosen window |
| `attrs` on a `CommitObserved` | `commit_count`, `distinct_commit_count`, `truncated` — lets a folded push say "20 shown of 347 pushed" instead of quietly claiming 20 |
| a link | an edge between two objects, coloured by what it reaches: **solid when `evidence` is `validated`, dashed when `extracted`** |
| `vmap` | the hover tooltip: commit message, head and base ref, author string |
| an `actor` object | a sidebar row, the actor card, and a hover trail across everything they touched |

So the PR→issue link draws as a dashed edge from the pull request's row to the issue's row, landing
on the exact glyph for each instant, with a tooltip naming all three `link_methods` behind it. The
statistics page recomputes from `selectVisible(...)`, so its numbers always describe the picture
currently on screen.
