# Data requirements for the OCEL timeline visualization

Derived from (a) what the hardcoded example actually contains, (b) what the renderer actually reads,
and (c) what generalization to N issues / M PRs additionally needs.

**Scope:** issue → PR → commit, plus comments and actors.
**Out of scope:** labels, forks, reviews, review comments, branch/ref lifecycle, bot classification.

> **Companion documents.** `DATA_CONTRACT.md` is authoritative for what exists upstream;
> `ADAPTER_AND_API.md` for what this project builds and for the `ObjectGraph` contract;
> `DECISIONS.md` for anything settled. Where this document and those disagree, they win — this one
> is the requirements side, and it was written before several decisions were settled.

Note: this document predates decisions 7 and 12; where it says `inferred`, read `extracted`.

Legend for the **Need** column:
`R` = required, the view breaks without it · `D` = derived, compute don't store ·
`O` = optional / nice-to-have · `P` = planned — the upstream column exists and the adapter will
carry it, but nothing populates it yet, so no code may assume it is present

---

## 0. Where data comes from

Two tiers, and the distinction matters:

| Tier | What | Query directly? |
|---|---|---|
| **Base tables** | `actor` (id, login, display_login, url, updated_at) · `org` (id, login, url, avatar_url, updated_at) · `repo` (id, name, url, updated_at) · `event` (id, type, actor_id, repo_id, org_id, public, created_at, `payload` jsonb) | ✅ Yes — normal tables |
| **Materialized views** | Per-event-type extractions of `event.payload`, cached so the JSONB isn't re-parsed per query | ✅ Yes — enumerated in `DATA_CONTRACT.md` §1 |

**Consequence — the `event` table is already the event-log skeleton.** It carries `id`, `type`,
`actor_id`, `repo_id`, `created_at` for every event. So the event stream is *not* assembled by
UNION-ing six MVs; it is:

```
event (backbone: id, type, timestamp, actor, repo)
  + MVs (payload detail: action, object ids, shas, comment ids, …)
```

`event.type` gives the coarse class (`IssuesEvent`, `PullRequestEvent`, `PushEvent`,
`IssueCommentEvent`); the MVs refine it into the activity (`IssueOpened` vs `IssueClosed` vs
`IssueReopened`) via the payload's `action`. Additional MVs can be created as needed.

---

## 1. Sub-log selection metadata

> ### There is no case identifier — deliberately
> Object-centric process mining exists to *remove* the case notion: an event relates to several
> objects of different types, and no single object is privileged as "the case." A `case_id` would
> reintroduce exactly what OCPM discards, and would undercut RQ1.
>
> What the API returns is therefore a **sub-log**: a filtered set of events, objects and relations.
> It is described by *the query that produced it*, not identified by a key. The same event may
> legitimately appear in many different sub-logs — which a case identifier would forbid.
>
> Name the RPC accordingly: `get_object_graph` (or `get_sublog`), **not** `get_case`.

These fields record the query for reproducibility, not identity.

| Field | Need | Source | Used for |
|---|---|---|---|
| `repo_id` | R | `repo.id` / every event view | filtering, RQ2 grouping |
| `repo_name` | R | **`repo.name`** | header, breadcrumb, cross-repo labels |
| seed object id(s) + type(s) | R | RPC parameter | what the traversal started from |
| `traversal_degree` | R | RPC parameter | how far the graph was expanded |
| active object types | R | RPC parameter | which lanes were requested |
| active link types / methods | R | RPC parameter | which relations were included |
| time window | O | RPC parameter | if the selection is time-bounded |
| `generated_at` | O | `now()` | reproducibility stamp |
| `data_honesty` notes | O | static strings | uncertainty legend (commit time ≠ real commit time; inferred edges dashed) |

> The selection parameters are what a **saved preset / shareable URL** must encode — that is the
> reproducibility mechanism for the task-based evaluation.

---

## 2. Issue

| Field | Need | Source | Used for |
|---|---|---|---|
| `issue_id` | R | `issues_identity` / `mv_issues_full` | object identity, link joins |
| `issue_number` | R | `issues_identity` / `mv_issues_full` | node label (`#242864`), stats |
| `issue_title` | R | `mv_issues_full` | tooltip |
| `issue_state` | R | `mv_issues_full` | open vs closed rendering |
| `issue_created_at` | R | `mv_issues_full` / `issues_identity` | lane span start, lead-time metrics |
| `issue_closed_at` | R | `mv_issues_full` | lane span end, duration metrics |
| `issue_creator_id` / `issue_creator_login` | R | `mv_issues_full` | actor attribution |
| `repo_id` | R | `mv_issues_full` | filtering |
| **reopen intervals** | D | sequence of `action` in `mv_issues_full` | ⚠️ multiple open/close cycles — see note |
| `issue_comment_count` | O | `mv_issue_comments_full` | stats |
| `issue_body` | O | `mv_issues_full` | tooltip (large; probably skip) |
| `assignee_id` / `assignee_login` | O | `mv_issues_full` | actor attribution |
| `milestone_title` | O | `mv_issues_full` | not currently visualized |

> ⚠️ **Reopens break the single-span model.** The current renderer assumes one `t_start` → `t_end`
> per object. An issue opened → closed → reopened → closed has **multiple** intervals. The raw
> `action` sequence in `mv_issues_full` carries this; `issue_closed_at` alone flattens it.
> Decide whether the object carries `intervals: [{start, end}, …]` instead of a single pair.

---

## 3. PullRequest

| Field | Need | Source (`mv_pull_request_events_full` unless noted) | Used for |
|---|---|---|---|
| `pull_request_id` | R | ✓ / `prs_identity` | object identity, link joins |
| `pr_number` | R | ✓ / `prs_identity` | node label (`PR #243221`), stats |
| `pr_title` | R | ✓ | tooltip |
| `pr_state` | R | ✓ | open / closed rendering |
| `pr_is_merged` | R | ✓ | merged vs closed-unmerged (landmark glyph) |
| `pr_is_draft` | R | ✓ | draft state rendering |
| `pr_created_at` | R | ✓ | span start, lead-time metrics |
| `pr_closed_at` | R | ✓ | span end |
| `pr_merged_at` | R | ✓ | merge landmark, duration metrics |
| `author_id` / `author_login` | R | ✓ | actor attribution |
| `head_ref` | R | ✓ | commit↔PR branch matching |
| `head_sha` | R | ✓ | commit↔PR SHA matching; `head_sha_open` vs `head_sha_merge` |
| `merge_commit_sha` | R | ✓ | commit↔PR merge attribution |
| `base_ref` | O | ✓ | context (which branch merged into) |
| `base_sha` | O | ✓ | rarely needed |
| `base_repo_full_name` | O | ✓ | context only — use `repo.name` for the repo display name |
| ~~off-platform merge~~ | — | ~~`mv_pr_offplatform_merges`~~ | **Not required (decision 48).** The view exists upstream; we do not read it. A PR closed unmerged is recorded as exactly that |
| `is_fork_pr` / `pr_origin` | O | ✓ | forks out of scope, but cheap to carry |

> The hardcoded example distinguishes `head_sha_open` from `head_sha_merge`. Derive these by taking
> the earliest and latest PR event for the PR — they are not two separate columns.

---

## 4. Commit

All from `mv_push_commits_full`.

| Field | Need | Column | Used for |
|---|---|---|---|
| `commit_sha` | R | `commit_sha` | object identity |
| short label | D | first 7 chars of sha | node label (`dcc7479`) |
| `commit_message` | R | `commit_message` | tooltip, issue-reference parsing |
| `commit_author_name` | R | `commit_author_name` | actor attribution, unique-author stat |
| `commit_author_email` | O | `commit_author_email` | actor disambiguation |
| observed time | R | `created_at` | x-position ⚠️ *push time, NOT real commit time* |
| `push_id` | R | `push_id` | burst grouping |
| `ref` | R | `ref` | commit↔PR branch matching |
| `commit_index` | O | `commit_index` | order within a push |
| `size` / `distinct_size` | R | ✓ | burst size threshold |
| `actor_id` | R | `actor_id` | pusher (≠ commit author) |
| `repo_id` | R | `repo_id` | filtering |
| `in_burst` / `burst_id` | D | from `push_id` grouping | collapse/expand |

> ⚠️ **Honesty note to preserve in the UI:** commit time is *first-seen-in-PushEvent*, not the real
> git author/commit timestamp. The example already documents this; keep it visible in the tooltip
> or legend.

---

## 5. Actor

Comes from the **`actor` base table** — no reconstruction needed. Bot / human classification is out of
scope, so `actor` is used as-is.

| Field | Need | Source | Used for |
|---|---|---|---|
| `actor_id` | R | `actor.id` | object identity |
| `login` | R | `actor.login` | node label (`@connor4312`) |
| `display_login` | O | `actor.display_login` | nicer label where it differs |
| `url` | O | `actor.url` | link out from the actor card |
| event count | D | count events per actor | sidebar ordering, actor card |
| roles | D | which activities they appear in | actor card ("opened 1 issue, 3 comments") |
| `commit_author_name` / `email` | R | `mv_push_commits_full` | commit authorship ⚠️ separate identity space — see note |

> ⚠️ **Commit authors and event actors remain two different identity spaces**, and the `actor` table
> does not bridge them. `actor.id`/`login` is a GitHub user; `commit_author_name` / `_email` from the
> push payload is a **git identity string** that need not correspond to any GitHub account. The
> hardcoded example papers over this by taking the commit author from the branch ref owner
> (`connor4312/mcp-1`) and flags it in its own `data_honesty` block.
>
> Decide: attempt a heuristic join (email → `actor`), or keep git authors as a distinct,
> clearly-labelled identity. **Do not silently conflate them** — the tool's honesty about link
> provenance is part of its contribution.

### `org` (available, currently unused)

`org` (id, login, url, avatar_url, updated_at) is queryable and `event.org_id` joins to it. Not
needed for issue-to-merge, but it is the cheapest available grouping above `repo` if RQ2 ever
extends to org-level comparison.

---

## 6. Event

The T facet. Either assembled by UNION or taken from the pre-built activity views.

| Field | Need | Source | Used for |
|---|---|---|---|
| `event_id` | R | all event views | node identity |
| `activity` | R | derived / `activity_type` | glyph, label, landmark detection |
| `timestamp` | R | `event_created_at` / `activity_timestamp` | x-position |
| `object_id` | R | `issue_id` / `pull_request_id` / `commit_sha` | which lane + row |
| `object_type` | R | derived from source view | lane assignment |
| `actor_id` | R | `actor_id` | actor colouring, filtering |
| `is_comment` | R | derived (comment views) | comment toggle, second row |
| `repo_id` | R | ✓ | filtering |
| `comment_id` | O | comment views | tooltip, dedup |
| `push_id` | O | `mv_push_commits_full` | burst attribution |
| `head_sha` | O | `mv_pull_request_events_full` | tooltip on PR-opened |
| auto-close reason | O | derived | tooltip ("closed via PR #… 'Closes #…'") |

### Activity vocabulary (must be closed and complete)

Present in the hardcoded example: `IssueOpened`, `IssueCommented`, `IssueClosed`,
`PullRequestOpened`, `PullRequestMerged`, `PullRequestClosed`, `CommitObserved`.
Mapped in code but absent from the data: `IssueReopened`, `PullRequestReopened`.
Nothing must be added. `PullRequestMergedOffPlatform` was listed here as a must-add until
decision 48 removed it; an off-platform merge is recorded as `PullRequestClosed`.

**Landmark activities** (rendered with emphasis): `IssueClosed` and `PullRequestMerged`.

---

## 7. Links (object ↔ object)

> Fields marked `P` are named here and in the sub-grading promise of `ADAPTER_AND_API.md` §3, but
> are **not** in the `ObjectGraph` contract and no fixture populates them. They were marked `R`
> until the audit of 2026-07-31 found a required field with nowhere to live. They land with the
> RPC. `link_methods` went the other way — it was already produced by the fixtures and consumed by
> the app, and is now in the contract.

| Field | Need | Source | Used for |
|---|---|---|---|
| `source` / `target` | R | link views | edge endpoints — both are **object** ids; an event id is rejected (decision 49) |
| `qualifier` | R | derived | `related_issue` / `referenced_issue` / `referenced_pull_request`. `actor` was a fourth until decision 41 deleted the attribution links; who performed an event is `event.actor_id` and nothing else |
| `evidence` | R | **derived** from `link_method` | solid vs dashed (shortcoming S8) |
| `link_method` / `primary_link_method` | R | link views | evidence classification, per-method toggle |
| `validation_status` | P | link views | temporal sanity of the link |
| `n_methods` / `link_methods` | R | your dedup view | multi-method agreement = confidence |
| temporal columns | O | `issue_created_at_utc`, `pr_created_at_utc`, `pr_merged_at_utc`, `issue_closed_at_utc` | validation display |
| `ref_scope` / `link_convention` | P | `mv_commit_message_issue_links_all` | cross-repo vs same-repo refs; convention sub-classing |

### Link types needed

| Pair | Qualifier | Source |
|---|---|---|
| Issue ↔ PR | `related_issue` | the **7** detection-method views plus `mv_issue_pr_links_extended_conventions`, deduped — possibly already by upstream's `mv_issue_to_pr_validated_all` rather than by an adapter view of ours |
| Commit → PR | `referenced_pull_request` | `head_sha` / `merge_commit_sha` / `head_ref` matching — possibly already done by upstream's `mv_commit_pr_links` |
| Commit → Issue | `referenced_issue` | `mv_commit_message_issue_links_all` |
| ~~Event → Actor~~ | ~~`actor`~~ | **Deleted (decision 41).** Attribution is `event.actor_id` and is not a link. Both endpoints of a link are objects (decision 49) |

⚠️ Three of these four rows moved after this section was written. The qualifiers themselves are
also superseded on paper by decision 43 (`resolves` / `contains_commit` / `merge_commit` /
`references_issue`), which is recorded but not implemented — the code still emits the names above.
And which pair each method belongs to is open question **O11**.

---

## 8. Burst (derived, not stored)

| Field | Need | Derivation |
|---|---|---|
| `burst_id` | R | synthesized from `push_id` |
| `push_id` | R | `mv_push_commits_full.push_id` |
| `n_commits` | R | count per `push_id` (or `size`) |
| timestamp | R | push `created_at` |
| member SHAs | R | the commits in that push |
| collapse default | D | on above a size threshold — **settled** (decision 6): default `> 5` commits, exposed as a UI control |

---

## 9. Derived metrics (statistics view)

⚠️ **Superseded by decision 12.** Compute these in **JS over the loaded sub-log**, not in SQL, so
they respond to toggles. SQL is only for figures spanning data not loaded — per-repo link coverage
for RQ2. Original text below.

Compute in SQL, not JS. With N issues and M PRs each becomes per-object *and* aggregate.

| Metric | Inputs |
|---|---|
| Issue open → close | `issue_created_at`, `issue_closed_at` |
| PR open → merge | `pr_created_at`, `pr_merged_at` |
| Issue → first commit | issue open, earliest linked commit |
| Issue → PR opened | issue open, PR open |
| PR merge → issue close | `pr_merged_at`, `issue_closed_at` |
| Commit count / unique authors | `mv_push_commits_full` |
| Comment counts (issue vs PR) | comment views |
| Actor count | distinct `actor_id` |
| Link counts by evidence | your dedup view |
| **Gap / bottleneck per event** | `LAG`/`LEAD` over the event list → `gap_hours`, `gap_class`, `actor_changed` |
| PR outcome distribution | merged / closed-unmerged / open (decision 48 dropped the off-platform outcome) |

---

## 10. Open decisions

Moved to `DECISIONS.md`. All five questions this document originally raised are now settled:

| Original question | Resolution |
|---|---|
| Reopen intervals — pair or list? | **Settled** (decision 4): interval lists, derived in SQL, one source of truth. Supersedes the `D` marking on "reopen intervals" in §2 — they are emitted by `object_lifecycles`, not computed client-side. |
| Commit author ↔ actor identity | **Settled** (decision 5): two labelled identity spaces, no heuristic join |
| Burst collapse threshold | **Settled** (decision 6): UI control, default `> 5` |
| Object lifecycle spans vs events | **Settled** (decision 4): SQL-derived intervals on the object; the renderer does not recompute spans |
| `link_method` → `evidence` mapping | **Settled** (decision 7): two classes, `validated` and `extracted`, by the platform-asserts-it rule in `ADAPTER_AND_API.md` §3 |

Of the questions raised across the project, only **O2** (the commit→PR admission rule) remains
open from the original set; O9 and O10 were opened later. O4 and O8 are resolved — see the
struck-through rows in `DECISIONS.md` §2, which is the register of record.
