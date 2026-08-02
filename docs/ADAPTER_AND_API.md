# Adapter layer and API contract

Everything between the frozen upstream (`DATA_CONTRACT.md`) and the renderer. This is the only
layer this project creates, and it is deliberately thin: when the real OCEL 2.0 tables land, this
is what gets replaced, and nothing above it should move.

## 1. Where it lives

A dedicated schema owned by this project — not the shared namespace, not a `mv_thesis_*` prefix in
`public`. PostgREST exposes only `api`; the derivations sit in the project schema behind it.

**Plain `VIEW` by default.** Materialize only where a measured query justifies it. Materialization
costs disk, a refresh story, and a staleness hazard; a plain view costs nothing and can be changed
freely. With ~14 GB and 3–4M rows in the largest upstream views, the first lever is **indexes**
(`repo_id`, `issue_id`, `pull_request_id`, `commit_sha`, `push_id`), not materialization.

⚠️ Indexes on *upstream* views cannot be created by this project — `CREATE INDEX` requires
ownership. Those are a request to the owner, with lead time. Indexes on this project's own views
are unaffected. See `DATA_CONTRACT.md` §2 and open question O9.

## 2. The derivations

The deciding criterion for precomputation is **not** performance — it is whether the result depends
on the sub-log selection. Fixed properties of the data can be precomputed; anything that changes
when the user flips a toggle cannot.

Three derivations to build. A fourth is listed struck through: it was specified here, then
superseded by decision 12. It stays visible because the reasoning that produced it is what decision
12 acted on, and a reader who finds only three rows will wonder what happened to gaps.

| View | Purpose | Form | Notes |
|---|---|---|---|
| `commit_pr_links` | Commit↔PR attribution | **Materialize** | Match `mv_pull_request_events_full.merge_commit_sha` / `.head_sha` against `mv_push_commits_full.commit_sha`, plus branch-ref match (`head_ref` ↔ `ref`). Expensive join across the two largest views, and a rule-based derivation that must be fixed and inspectable for the RQ2 link counts. Record **which rule matched** so evidence can be graded. Admission rule: open question O2. |
| `issue_pr_links` | One deduplicated issue↔PR link table | Plain view first | UNION the four detection-method views; dedupe to one row per (issue, PR); keep `primary_link_method` by priority, `n_methods`, `link_methods`, `validation_status`, temporal columns. Promote to materialized only on measurement. |
| `object_lifecycles` | Lifecycle spans per issue / PR | Plain view | Issues: `issue_created_at` → `issue_closed_at` (+ `issue_state`). PRs: `pr_created_at` → `pr_merged_at` / `pr_closed_at` (+ `pr_is_merged`). Fold in `mv_pr_offplatform_merges`. **Emit interval lists** (decision 4). Fixed property of the data, so safe to precompute. |
| ~~`process_gaps`~~ | ~~Bottleneck / idle-time analysis~~ | **Superseded by decision 12** | Retained for rationale only — do not build this. `LAG`/`LEAD` over the per-object event list → `gap_hours`, `gap_class`, `actor_changed`. The reasoning still holds: gaps depend on which events are in the sub-log, so precomputing globally answers "comments hidden → gaps unchanged" silently. Decision 12 resolves it by computing gaps **in JS over the loaded sub-log**, where they follow the toggles for free. Implemented in `src/stats/metrics.js`. |

> Before building anything, **evaluate the three pre-built activity timelines**
> (`mv_issue_and_issuecomment_activities_full`, `mv_pull_request_and_comment_activities_full`,
> `mv_push_activities`). They already carry a named activity vocabulary and may supply most of the
> event stream. **Report what you find** rather than hand-rolling a UNION by default.

## 3. Link evidence (decision 7)

Nothing in the database pre-classifies links, so the solid-vs-dashed uncertainty cue (S8) is derived
from detection method. **Two classes only: `validated` and `extracted`.** `inferred` is retired
vocabulary and must not appear anywhere.

> **The rule.** A link is **validated** when the platform's own data asserts it — documented GitHub
> syntax that GitHub itself acts on, or an exact identity match. It is **extracted** when we parsed a
> human convention that no system enforces.
>
> State the rule in the thesis, not the table. The table is what the rule produces.

The **Method** column gives the `LINK_METHOD` enum value from `src/model/evidence.js` — that enum
is the vocabulary (decision 20), and every row here must have a member there and vice versa.

| Link | Method | Class | Why |
|---|---|---|---|
| Issue ↔ PR | `pr_body` — closing keyword, e.g. "Closes #N" | `validated` | Documented GitHub syntax; GitHub auto-closes on it |
| Issue ↔ PR | `branch_name` — e.g. `fix/123` | `extracted` | Team convention, unenforced |
| Issue ↔ PR | `pr_title` | `extracted` | Convention |
| Issue ↔ PR | `issue_comment` | `extracted` | Convention |
| Commit → PR | `merge_commit_sha` / `head_sha` — exact SHA match | `validated` | Identity match, not parsing |
| Commit → PR | `ref_match` — branch-ref match (`head_ref` ↔ `ref`) | `extracted` | Convention |
| Commit → PR | `merge_commit_message` — PR reference parsed from a merge commit message | `extracted` | Convention |
| Commit → Issue | `commit_message` — regex over the message (`mv_commit_message_issue_links_all`) | `extracted` | Convention. Sub-grade with `link_convention` / `ref_scope`; cross-repo refs are weaker than same-repo `fixes #N` |
| Event → Actor | `event_actor_id` — the event's own `actor_id` column | `validated` | Identity match on a platform-supplied column; nothing is parsed |

> The last three rows were classified in `src/model/evidence.js` before this table recorded them.
> `merge_commit_message` and `commit_message` follow the rule unambiguously (both parse text).
> `event_actor_id` is the one worth a second look: it is an identity match on a column GitHub
> supplies, so `validated` follows the rule — but it is an *attribution* edge rather than a
> traceability link, and it carries 42 of F1's 76 links. If actor edges are ever reported alongside
> issue↔PR link counts, say which is which, or the validated share looks far higher than the
> traceability story warrants.

> ⚠️ **Expect a visible shift.** Branch-ref matching (`ref_match`) supplies 29 of the 34 object
> links in the current example — F1 carries 76 links, of which 42 are `event_actor_id` actor
> edges, leaving 34 object links that split 3 `validated` / 31 `extracted`. Reclassifying
> `ref_match` moves most of the timeline from solid to dashed. That is the honest result and it
> strengthens the S8 answer — do not treat it as a regression. Recorded as mandated baseline
> difference #1 in `VERIFICATION.md`.

**Optional strengthening, if time allows.** `pr_body` is the one row where the rule is arguable: the
view regex-parses the body rather than observing GitHub's auto-close. It can be corroborated by
checking for an issue-close event shortly after the PR merge. Not required; worth a sentence in the
limitations either way.

Multi-method agreement raises confidence — carry `n_methods` and `link_methods` to the tooltip.

## 4. Access pattern

One RPC returning one composed bundle: `POST /rpc/get_object_graph`.

The frontend never queries individual views. Consequence: adding derived views does **not** simplify
the API — the RPC is the API surface. The views exist for SQL readability and for the thesis's own
link-count reporting.

Single adapter `loadObjectGraph(query) -> ObjectGraph` is the **only** data entry point. Implement
first against local fixtures; swapping to `fetch()` must be a one-function change.

```
query = {
  repo,              // repository name — identity by id once the RPC exists
  seed,              // object id to traverse out from; ANY object type is valid
  traversalDegree,   // how far to expand. Fixed by the fixture today
}
```

The UI states exactly this (decision 33): pick a repository, then pick the object to start
from. A commit is as valid a seed as an issue — no object type is privileged, which is the
whole point. The seed is privileged in the *query* only, never in the returned data, so
`meta.seed` records it and nothing about the objects marks them as special.

Until the RPC exists, the fixture transport can only serve seeds that were pre-built, so it
also answers a `{fixture}` address for tests. The RPC transport will understand the query and
nothing else.

```
ObjectGraph = {
  meta:    { repo, repo_id, seed:[{id,type}], traversal_degree,
             active_object_types, active_link_methods, generated_at,
             activity_scope, data_honesty:{…}, source },
  objects: [ { id, type, label, repo, intervals:[{start,end}], time_semantics, vmap:{…} } ],
  events:  [ { id, activity, time, object_id, actor_id, repo, comment, attrs:{…} } ],
  links:   [ { source, target, qualifier, evidence, method, link_methods:[…], n_methods } ]
}
```

This is the shape the fixtures actually carry — verified against `tests/fixtures/F1.json`. Two
notes on fields that are easy to get wrong:

- **`data_honesty`** is not decoration. It carries the commit-time caveat (push time, not real
  commit time) and the extracted-edge caveat, and the sidebar renders them. A transport that drops
  it silently removes the S8 uncertainty disclosure from the UI.
- **`link_methods` is the array; `method` is the primary one.** Decision 20 requires both plus
  `n_methods`, and nothing free-text.

**Reserved, not yet carried.** `validation_status`, `ref_scope` and `link_convention` are named in
`DATA_REQUIREMENTS.md` §7 and in the sub-grading promise of §3 above, but no fixture populates them
and the shape above does not include them — the upstream columns exist, the adapter does not yet.
They land with the RPC, on `links`. Until then they are planned, not required; do not write code
that assumes their presence.

### Known limitation: one object per event

`events` carry a single `object_id`. OCEL 2.0's event-to-object relation is many-valued, and
`ARCHITECTURE.md` states that one event touching several objects is exactly what OCPM exists to
show. The current model expresses convergence through `links` between objects rather than through
events, which is sufficient for the activities in scope — each has an unambiguous subject, and the
actor is carried separately on `actor_id`.

It is nonetheless a real gap at the point where OCPM is most distinctive, and it is a promise this
layer does not currently keep: a shape that cannot express E2O multiplicity is not swappable to
real OCEL 2.0 tables without changing the contract above it. **Deliberately deferred, not
overlooked** — tracked as open question O10. Migration sketch: `object_id` → `object_ids: […]`,
8 call sites across `src/model/activities.js`, `src/model/objectGraph.js` and `src/state/state.js`,
plus the 13 fixtures, both build scripts and the bundle-shape tests. Cheapest before the renderer
grows more dependants on the current grouping.

`meta` records **the query**, for reproducibility — not an identity. Those same parameters are what
a saved preset / shareable URL encodes, which is the reproducibility mechanism for the task-based
evaluation.

**Two degrees, kept apart:** `meta.traversal_degree` is server-side — how far the sub-log was
expanded. The client-side focus BFS (`focusSet()`, capped at 2) controls only highlighting within an
already-loaded sub-log. Do not conflate the names.

## 5. Activity vocabulary

Closed and complete. Fail visibly on anything unmapped rather than rendering a raw enum.

Present in the current data: `IssueOpened`, `IssueCommented`, `IssueClosed`, `PullRequestOpened`,
`PullRequestMerged`, `PullRequestClosed`, `CommitObserved`.
Mapped in code, absent from data: `IssueReopened`, `PullRequestReopened`.
**Must be added:** `PullRequestMergedOffPlatform` (from `mv_pr_offplatform_merges`) — a real outcome
class and a conformance deviation.

**Landmark activities** (rendered with emphasis): `IssueClosed`, `PullRequestMerged`,
`PullRequestMergedOffPlatform`.
