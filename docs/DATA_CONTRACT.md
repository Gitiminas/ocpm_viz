# Data contract — the frozen upstream

**This document is the authoritative list of what exists in the shared database.** If something is not
here, either it is not in the database or it is out of scope — in both cases, do not use it.

Scope is **issue → PR → commit, plus comments and actors**. Labels, forks, reviews, review comments,
commit comments, branch/ref lifecycle and bot classification are deliberately out (see §3).

**Total: 4 base tables + 17 materialized views.** These are owned by other researchers and are
**read-only** for this project — no modification, no refresh, no extension. Snapshot taken
`<date>`; if reality diverges, update this document rather than adapting the upstream.

Views this project builds on top of them are specified in `ADAPTER_AND_API.md`, not here.

---

## 0. Base tables — query these directly

Normal tables, not MVs. The MVs exist only to cache extractions of `event.payload` so the JSONB
isn't re-parsed on every query.

| Table | Columns | Role |
|---|---|---|
| `event` | `id`, `type`, `actor_id`, `repo_id`, `org_id`, `public`, `created_at`, `payload` (jsonb) | **The event-log skeleton.** `type` gives the coarse class (`IssuesEvent`, `PullRequestEvent`, `PushEvent`, `IssueCommentEvent`); `created_at` the timestamp; `actor_id` the actor |
| `actor` | `id`, `login`, `display_login`, `url`, `updated_at` | Actor objects — complete, no reconstruction needed |
| `repo` | `id`, `name`, `url`, `updated_at` | Repo display name and identity |
| `org` | `id`, `login`, `url`, `avatar_url`, `updated_at` | Available; unused for issue-to-merge |

> **Actor and repo objects come from these tables, not from any view.** `actor` is complete as-is;
> `repo.name` is the repo display name.

**Pattern to use:** `event` for the backbone, MVs for the payload-derived detail. The MVs refine
`event.type` into a specific activity (`IssueOpened` / `IssueClosed` / `IssueReopened`) via the
payload's `action` field, and supply the object ids, SHAs and comment ids that live inside the JSONB.

---

## 1. The 17 views you query

### Identity (3)

#### `issues_identity`
One row per issue, capturing the event that opened it — canonical `issue_id` ↔ `issue_number` ↔
opening-event mapping.
**Columns (5):** `repo_id`, `issue_id`, `issue_number`, `issue_creation_event_id`, `issue_created_at`
**Why:** issue identity backbone; joins every issue→PR link view.

#### `prs_identity`
One row per pull request, capturing the event that opened it.
**Columns (5):** `repo_id`, `pull_request_id`, `pr_number`, `pr_creation_event_id`, `pr_created_at`
**Why:** PR identity backbone.

#### `mv_issue_id_to_number`
Compact `issue_id` → `issue_number` lookup per repo.
*Depends on:* `mv_issues_full`
**Columns (3):** `repo_id`, `issue_id`, `issue_number`
**Why:** **broader row coverage than `issues_identity`** — built over *all* actions, so it also
covers issues acted on inside the window but opened before it (the 22.62% missing-object problem).
Use it to resolve references to issues whose opening event is outside the window.

---

### Object attributes & raw events (6)

#### `mv_issues_full`
Flattened IssuesEvent payloads: full issue state per event.
**Columns (24):** `event_id`, `actor_id`, `repo_id`, `org_id`, `event_created_at`, `public`, `action`,
`issue_id`, `issue_number`, `issue_title`, `issue_body`, `issue_state`, `issue_created_at`,
`issue_updated_at`, `issue_closed_at`, `issue_creator_id`, `issue_creator_login`, `assignee_id`,
`assignee_login`, `milestone_id`, `milestone_number`, `milestone_title`, `labels_json`, `assignees_json`
**Why:** the only source of issue attributes and of the `action` sequence needed to detect **reopens**.

#### `mv_issue_comments_full`
Flattened IssueCommentEvent payloads for comments on issues.
**Columns (30):** `event_id`, `actor_id`, `repo_id`, `org_id`, `event_created_at`, `public`, `action`,
`is_pull_request`, `comment_id`, `comment_body`, `comment_created_at`, `comment_updated_at`,
`comment_html_url`, `comment_author_association`, `comment_user_id`, `comment_user_login`,
`comment_user_is_site_admin`, `issue_id`, `issue_number`, `issue_title`, `issue_state`,
`issue_comment_count`, `issue_creator_id`, `issue_creator_login`, `issue_assignee_id`,
`issue_assignee_login`, `issue_labels_json`, `issue_assignees_json`, `pr_api_url`, `pr_html_url`
**Why:** `IssueCommented` — the largest activity class (2.3M) and in scope.

#### `mv_pull_request_events_full`
Flattened PullRequestEvent payloads: full PR state per event.
**Columns (36):** `event_id`, `actor_id`, `repo_id`, `org_id`, `event_created_at`, `action`,
`pr_number`, `pull_request_id`, `pr_title`, `pr_body`, `pr_state`, `pr_is_draft`, `pr_is_merged`,
`pr_created_at`, `pr_updated_at`, `pr_closed_at`, `pr_merged_at`, `author_id`, `author_login`,
`author_url`, `author_association`, `assignee_id`, `assignee_login`, `base_ref`, `base_sha`,
`base_repo_id`, `base_repo_full_name`, `head_ref`, `head_sha`, `head_repo_id`,
`head_repo_full_name`, `merge_commit_sha`, `labels_json`, `assignees_json`, `is_fork_pr`, `pr_origin`
**Why:** the PR half of the backbone. Carries `head_sha` / `merge_commit_sha` / `head_ref` — the
inputs for rebuilding commit↔PR attribution. (For repo display names use `repo.name`, not
`base_repo_full_name`.)

#### `mv_pull_request_comments_full`
IssueCommentEvent payloads where the target is a PR rather than an issue.
**Columns (29):** `event_id`, `actor_id`, `repo_id`, `org_id`, `event_created_at`, `public`, `action`,
`comment_id`, `comment_body`, `comment_created_at`, `comment_updated_at`, `comment_html_url`,
`comment_author_association`, `comment_user_id`, `comment_user_login`, `comment_user_is_site_admin`,
`issue_id`, `pr_number`, `pr_title`, `pr_state`, `pr_comment_count`, `pr_creator_id`,
`pr_creator_login`, `pr_assignee_id`, `pr_assignee_login`, `pr_labels_json`, `pr_assignees_json`,
`pr_api_url`, `pr_html_url`
**Why:** PR comments; in scope.

#### `mv_push_commits_full`
One row per commit inside every PushEvent.
**Columns (18):** `event_id`, `created_at`, `actor_id`, `repo_id`, `org_id`, `push_id`, `ref`,
`before`, `head`, `size`, `distinct_size`, `commit_sha`, `commit_url`, `commit_message`,
`commit_author_name`, `commit_author_email`, `commit_distinct`, `commit_index`
**Why:** the entire commit layer, plus `push_id` / `size` for burst detection.
⚠️ `created_at` is **push time, not real commit time** — preserve this caveat in the UI.

#### `mv_pr_offplatform_merges`
PRs closed without being merged on GitHub whose commits later appear in a push.
*Depends on:* `mv_pull_request_events_full`, `mv_push_commits_full`
**Columns (14):** `repo_id`, `pull_request_id`, `pr_number`, `base_ref`, `pr_closed_at`,
`closer_actor_id`, `delivering_commit_sha`, `push_id`, `pushed_at`, `pusher_actor_id`,
`delta_seconds`, `link_convention`, `link_kind`, `link_method`
**Why:** a **conformance deviation class** — reality departing from issue→PR→merge→close. Supplies
the `PullRequestMergedOffPlatform` activity and a distinct PR outcome.

---

### Pre-built activity timelines (3) — evaluate these first

> These are ready-made unified activity timelines with an existing named activity vocabulary.
> **Check them before hand-rolling a UNION over the six raw views above** — they may already be most
> of the event stream.

#### `mv_issue_and_issuecomment_activities_full`
Unified per-issue activity timeline merging IssuesEvent + IssueCommentEvent into named activity
types, with label/assignee change detection.
*Depends on:* `mv_issue_comments_full`, `mv_issues_full`
**Columns (14):** `event_id`, `repo_id`, `actor_id`, `issue_id`, `issue_number`,
`activity_timestamp`, `activity_type`, `labels`, `previous_labels`, `activity_order`,
`if_labels_change`, `assignees`, `previous_assignees`, `if_assignees_change`

#### `mv_pull_request_and_comment_activities_full`
Unified per-PR activity timeline merging PR events, PR comments and off-platform merges.
*Depends on:* `mv_pr_offplatform_merges`, `mv_pull_request_comments_full`,
`mv_pull_request_events_full`
**Columns (20):** `event_id`, `repo_id`, `actor_id`, `org_id`, `pull_request_id`, `pr_number`,
`activity_timestamp`, `activity_type`, `author_user_id`, `head_sha`, `base_ref`, `head_ref`,
`merge_commit_sha`, `labels`, `previous_labels`, `activity_order`, `if_labels_change`, `assignees`,
`previous_assignees`, `if_assignees_change`

#### `mv_push_activities`
PushEvents reshaped into generic activity records.
**Columns (14):** `activity_id`, `activity_timestamp`, `object_type`, `object_id`, `object_key`,
`activity_type`, `actor_user_id`, `repo_id`, `org_id`, `push_id`, `ref`, `commit_count`,
`distinct_commit_count`, `activity_payload`

---

### Link detection (5)

> Four issue→PR detection methods are available. All four share the same 11 columns:
> `repo_id`, `issue_id`, `issue_number`, `pull_request_id`, `pr_number`, `validation_status`,
> `link_method`, `issue_created_at_utc`, `pr_created_at_utc`, `pr_merged_at_utc`, `issue_closed_at_utc`

> **Evidence classification is not recorded here.** Nothing upstream pre-classifies a link, so a
> class is a research judgement rather than an existence fact, and this document's remit is what
> exists. The single mapping from detection method to `validated` / `extracted` lives in
> `ADAPTER_AND_API.md` §3 (decision 7). Earlier revisions of this section carried "suggested
> evidence class" lines; they disagreed with that mapping and have been removed rather than
> corrected, so there is one place to look and one place to change.

#### `mv_issue_pr_links_pr_body`
Links from closing keywords in the PR body (e.g. "Closes #242864").
*Depends on:* `issues_identity`, `mv_pull_request_events_full`, `prs_identity`

#### `mv_issue_pr_links_branch_name`
Links from the PR's head branch name (e.g. `fix/123`).
*Depends on:* `issues_identity`, `mv_pull_request_events_full`, `prs_identity`

#### `mv_issue_pr_links_pr_title`
Links from issue references in the PR title.
*Depends on:* `issues_identity`, `mv_pull_request_events_full`, `prs_identity`

#### `mv_issue_pr_links_issue_comment`
Links from PR references inside issue comments.
*Depends on:* `issues_identity`, `mv_issue_comments_full`, `mv_pull_request_events_full`,
`prs_identity`

#### `mv_commit_message_issue_links_all`
Issue references parsed out of commit messages by regex, tagged by convention
(`fixes #N`, `gh-N`, cross-repo, …).
*Depends on:* `mv_push_commits_full`
**Columns (7):** `source_repo_id`, `commit_sha`, `issue_number`, `ref_scope`, `link_convention`,
`push_created_at`, `actor_id`
**Why:** the commit↔issue link source — the `referenced_issue` qualifier.
**Sub-grading inputs:** `ref_scope` and `link_convention` — cross-repo refs are weaker than
same-repo `fixes #N`. The evidence class itself is assigned in `ADAPTER_AND_API.md` §3.

---

## 2. What this project builds on top

Three derivations are not materialized anywhere upstream — `commit_pr_links`, `issue_pr_links`
and `object_lifecycles`. Their specification, form (plain view vs materialized) and rationale live
in `ADAPTER_AND_API.md` §2 — deliberately kept out of this document so the frozen contract and my
own work are never confused. (A fourth, `process_gaps`, was specified there and then superseded by
decision 12: gaps are computed in JS over the loaded sub-log so they follow the toggles.)

**Indexes** are the first performance lever, ahead of any materialization: `repo_id`, `issue_id`,
`pull_request_id`, `commit_sha`, `push_id`. With ~14 GB and 3–4M rows in the largest views, query
latency is the real risk, not render latency.

> ⚠️ **This is not something this project can do unilaterally, and it conflicts with the read-only
> rule above.** `CREATE INDEX` requires ownership of the relation; a role holding only `SELECT`
> gets `must be owner of materialized view`. `ANALYZE` is worse — a non-owner gets
> `WARNING: permission denied to analyze …, skipping it` and the command still **reports success**,
> so a maintenance script can appear to work while the planner stays blind. There is no grantable
> privilege for either before PostgreSQL 17's `MAINTAIN`.
>
> So an index on an upstream view is a **request to its owner**, with lead time, and it sits on the
> critical path at this data volume. Before asking, check what already exists (`pg_indexes`) and
> whether `pg_class.reltuples` is populated or still `-1` for the large views. Indexes on *this
> project's own* views in its own schema are unaffected — those we own. Tracked as open question
> O9 in `DECISIONS.md`.

---

## 3. Deliberately out of scope

These views exist but are not used, because the thesis scope is issue → PR → commit plus comments
and actors. Recorded so the choice is documented rather than accidental.

| Excluded facet | Views |
|---|---|
| Labels | `mv_issue_pr_labels_full`, `mv_label_snapshots_per_event`, `mv_label_lifecycle_events`, `mv_process_labels`, `mv_label_objects`, `mv_issue_pr_label_membership` |
| Reviews / review comments | `mv_pr_reviews_full`, `mv_pr_review_comments_full`, `mv_pr_review_activities` |
| Forks / branch provenance | `mv_fork_events_full`, `mv_pr_head_provenance`, `mv_create_events_full` |
| Branch deletion | `mv_delete_events_full` |
| Commit comments | `mv_commit_comment_activities` |
| Comment classification | `mv_comment_classification` |

Bot / human actor classification is likewise out of scope; `actor` is used as-is.

---

## 4. ⚠️ Limitation to document in the thesis

The four available issue↔PR detection methods key on **GitHub's standard conventions**: closing
keywords in the PR body, `fix/123`-style branch names, and `#N` references in PR titles and issue
comments.

**Project-specific conventions are not covered** — `gh-N`, `bug #N`, `For #N` and similar. These are
common in **kubernetes and react, two of the three selected repositories**, while vscode largely
follows the standard forms.

This is a threat to **RQ2**: if link detection is systematically weaker on kubernetes and react than
on vscode, apparent cross-repository process differences may be artifacts of detection coverage
rather than real behaviour.

**Mitigation:** report per-repo issue↔PR link counts broken down by detection method, and state the
coverage gap numerically. If it turns out large, consider adding commit-message-based issue→PR
linking by joining `mv_commit_message_issue_links_all` through the adapter's `commit_pr_links` view, which
would recover some of the missing recall.
