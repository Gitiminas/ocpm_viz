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

## 2. The four derivations

The deciding criterion for precomputation is **not** performance — it is whether the result depends
on the sub-log selection. Fixed properties of the data can be precomputed; anything that changes
when the user flips a toggle cannot.

| View | Purpose | Form | Notes |
|---|---|---|---|
| `commit_pr_links` | Commit↔PR attribution | **Materialize** | Match `mv_pull_request_events_full.merge_commit_sha` / `.head_sha` against `mv_push_commits_full.commit_sha`, plus branch-ref match (`head_ref` ↔ `ref`). Expensive join across the two largest views, and a rule-based derivation that must be fixed and inspectable for the RQ2 link counts. Record **which rule matched** so evidence can be graded. Admission rule: open question O2. |
| `issue_pr_links` | One deduplicated issue↔PR link table | Plain view first | UNION the four detection-method views; dedupe to one row per (issue, PR); keep `primary_link_method` by priority, `n_methods`, `link_methods`, `validation_status`, temporal columns. Promote to materialized only on measurement. |
| `object_lifecycles` | Lifecycle spans per issue / PR | Plain view | Issues: `issue_created_at` → `issue_closed_at` (+ `issue_state`). PRs: `pr_created_at` → `pr_merged_at` / `pr_closed_at` (+ `pr_is_merged`). Fold in `mv_pr_offplatform_merges`. **Emit interval lists** (decision 4). Fixed property of the data, so safe to precompute. |
| `process_gaps` | Bottleneck / idle-time analysis | **Do not materialize** | `LAG`/`LEAD` over the per-object event list → `gap_hours`, `gap_class`, `actor_changed`. Gaps depend on which events are in the sub-log; precomputing globally answers "comments hidden → gaps unchanged" silently. Compute inside the RPC over the selected event set, or materialize and label the semantics explicitly. See open question O1. |

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

| Link | Method | Class | Why |
|---|---|---|---|
| Issue ↔ PR | `pr_body` — closing keyword, e.g. "Closes #N" | `validated` | Documented GitHub syntax; GitHub auto-closes on it |
| Issue ↔ PR | `branch_name` — e.g. `fix/123` | `extracted` | Team convention, unenforced |
| Issue ↔ PR | `pr_title` | `extracted` | Convention |
| Issue ↔ PR | `issue_comment` | `extracted` | Convention |
| Commit → PR | `merge_commit_sha` / `head_sha` exact match | `validated` | Identity match, not parsing |
| Commit → PR | branch-ref match (`head_ref` ↔ `ref`) | `extracted` | Convention |
| Commit → Issue | commit-message regex (`mv_commit_message_issue_links_all`) | `extracted` | Convention. Sub-grade with `link_convention` / `ref_scope`; cross-repo refs are weaker than same-repo `fixes #N` |

> ⚠️ **Expect a visible shift.** Branch-ref matching supplies 29 of the 34 object links in the
> current example. Reclassifying it moves most of the timeline from solid to dashed. That is the
> honest result and it strengthens the S8 answer — do not treat it as a regression.

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
ObjectGraph = {
  meta:    { repo, seed object(s), traversal_degree, active types/links, generated_at },
  objects: [ { id, type, label, repo, intervals:[{start,end}], time_semantics, vmap:{…} } ],
  events:  [ { id, activity, time, object_id, actor_id, repo, comment, attrs:{…} } ],
  links:   [ { source, target, qualifier, evidence, method, n_methods } ]
}
```

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

**Milestone activities** (rendered with emphasis): `IssueClosed`, `PullRequestMerged`,
`PullRequestMergedOffPlatform`.
