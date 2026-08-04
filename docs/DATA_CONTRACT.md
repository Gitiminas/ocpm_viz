# Data contract — the frozen upstream

**This document is the authoritative list of what exists in the shared database.** If something is not
here, either it is not in the database or it is out of scope — in both cases, do not use it.

Scope is **issue → PR → commit, plus comments and actors**. Labels, forks, reviews, review comments,
commit comments, branch/ref lifecycle and bot classification are deliberately out (see §3).

**Total: 4 base tables + 49 views — 22 in scope (§1) and 27 excluded (§3).**

**Ownership, corrected 2026-08-04.** The base tables and the 22 in-scope views are **this project's
own**, and may be consumed exactly as they are — no cloning, no rebuilding, and nothing blocked on
another researcher's lead time. The nine `ocel_*` views (§3) belong to the parallel PhD work and
stay out by instruction rather than by permission. Earlier revisions said the whole upstream was
owned by others; that framing produced a cloning plan for views that were already usable, and open
question O9 (indexes) rested on it.

Consuming is not the same as changing. Treat these as **stable inputs**: other people's figures and
another thesis's tables read the same relations, so redefining or refreshing one moves numbers
elsewhere. If reality diverges, update this document rather than adapting the upstream.

Views this project builds on top of them are specified in `ADAPTER_AND_API.md`, not here.

> **Snapshot: 2026-08-04**, from the API hand-off inventory. This revision added **17 relations the
> previous snapshot did not name** — six in-scope link views, the nine `ocel_*` views, and two
> analytics views — which is worth stating plainly given the first line of this document. Anyone
> reading the earlier revision would have concluded that `mv_commit_pr_links` and
> `mv_issue_to_pr_validated_all` did not exist and built them from scratch. The undated placeholder
> that stood here before is why that went unnoticed for so long; date this line on every revision.
>
> ⚠️ **Column lists for the six newly recorded views are not captured yet.** Their entries below say
> so rather than guessing. Inspect before use — `\d+ <view>`, or `information_schema.columns` — and
> record what you find here. An invented column list in a document that calls itself authoritative
> is worse than an admitted gap.

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

> **Actor objects, and the repository's own name, come from these tables — not from any view.**
> `actor` is complete as-is; `repo.name` is the repo display name. Note the asymmetry in what each
> becomes downstream: `actor` supplies *objects*, `repo` supplies the **frame** the sub-log sits in
> (`meta.repo` / `meta.repo_id`). `repo_id` is a partition key in every view below and never a
> participant, which is why decision 39 stopped modelling it as an object type.

**Pattern to use:** `event` for the backbone, MVs for the payload-derived detail. The MVs refine
`event.type` into a specific activity (`IssueOpened` / `IssueClosed` / `IssueReopened`) via the
payload's `action` field, and supply the object ids, SHAs and comment ids that live inside the JSONB.

---

## 1. The 22 views you query

Identity (3) · raw flatteners (5) · pre-built activity timelines (3) · link detection (11).
Two of the 22 — `issues_identity` and `prs_identity` — carry no `mv_` prefix; whether they are
materialized or plain views is not recorded here because nothing in this project depends on it.

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

### Object attributes & raw events (5)

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

> `mv_pr_offplatform_merges` was the sixth entry in this section. Decision 48 stopped consuming it,
> so it now sits in §3 with the rest of what is deliberately unused — but **read that entry**, because
> unlike the other exclusions it is a dependency of a view in scope.

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

### Link detection (11)

**Seven issue→PR detection methods, one view of extended conventions, one union, and two commit-link
views.** The previous snapshot recorded four method views and one commit view; the other six are the
ones this revision adds.

> The **four originally recorded** methods share the same 11 columns:
> `repo_id`, `issue_id`, `issue_number`, `pull_request_id`, `pr_number`, `validation_status`,
> `link_method`, `issue_created_at_utc`, `pr_created_at_utc`, `pr_merged_at_utc`, `issue_closed_at_utc`
>
> ⚠️ **Do not assume the other three share it.** It is likely and it is unverified, and the columns
> are what tell you which two objects a row actually joins — see the endpoint question below.

> ⚠️ **`validation_status` is not our evidence class.** Upstream it is the *temporal sanity* of a
> link (`DATA_REQUIREMENTS.md` §7) — whether the dates line up. Our `validated` means *the platform
> asserts the link* (decision 7). They are different questions with the same word, and
> `mv_issue_to_pr_validated_all` puts that word in a view name. Mapping either onto
> `link.evidence` would silently break the solid-vs-dashed uncertainty cue and make F1's
> 3 validated / 31 extracted split mean nothing.

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

#### `mv_issue_pr_links_closed_via_commit`
Links derived from GitHub's own closed-via-commit record.
**Columns:** *not captured — inspect before use.*
**Why:** the `closed_via_commit` method, the one `validated` member of this family that GitHub
states rather than anyone parsing.

#### `mv_issue_pr_links_commit_message`
Links derived from issue references in commit messages.
**Columns:** *not captured — inspect before use.*
**Why:** the `commit_message` method **as an issue↔PR link**. ⚠️ Distinct from
`mv_commit_message_issue_links_all` below, which links a *commit* to an issue from the same raw
text. Two views, two different relations, and the `LINK_METHOD` enum currently has one value for
both — see the endpoint question below.

#### `mv_issue_pr_links_proximity`
Links inferred from closeness in time alone.
**Columns:** *not captured — inspect before use.*
**Why:** the `proximity` method — the weakest thing in the enum. Nothing is asserted and nothing is
parsed; two timestamps are merely near each other. Report its share separately in any RQ2 link
count, because a coverage figure that leans on it is not the same claim as one that does not.

#### `mv_issue_pr_links_extended_conventions`
Project-specific issue-reference forms GitHub does not act on — `gh-123`, `For #123`, Symfony's PR
template, "Fixed tickets" rows — split by whether they were found in the title or the body.
**Columns:** *not captured — inspect before use.*
**Why:** supplies the six extended methods of decision 42 (`pr_title_gh`, `pr_title_symfony`,
`pr_title_for`, `pr_body_gh`, `pr_body_fixed_tickets`, `pr_body_refs`). **This view materially
changes §4's limitation** — the conventions that section calls uncovered are, in fact, detected.

#### `mv_issue_to_pr_validated_all`
The union of the issue↔PR method views, one row per (issue, PR).
**Columns:** *not captured — inspect before use.*
**Why:** ⚠️ **This is very likely the `issue_pr_links` derivation `ADAPTER_AND_API.md` §2 tells you
to build.** Read its definition before building anything: if it already dedupes and carries
`link_method` / `n_methods`, that derivation is done and the adapter's job is to consume it. Note
the name warning above — "validated" here is upstream's word, not decision 7's.

#### `mv_commit_pr_links`
Commit↔PR attribution.
**Columns:** *not captured — inspect before use.*
**Why:** ⚠️ **This is very likely the `commit_pr_links` derivation `ADAPTER_AND_API.md` §2 tells you
to build and to materialize** — the expensive join between the two largest views. If it exists, that
work is done, **and open question O2 is already answered by whoever wrote it**: the admission rule
for commit→PR matches is whatever this view implements. Read the definition, decide whether to
accept the rule, and record it as *inherited* rather than chosen. It is owned by someone else and
can change under you, so record the refresh timestamp behind any figure that depends on it.

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

#### ⚠️ Which two objects does a link row join? — open question O11

Three method names appear on **both** sides of this family, and the two documents disagree about
what they connect:

| Method | `ADAPTER_AND_API.md` §3 says | The view name says |
|---|---|---|
| `closed_via_commit` | Issue → Commit | issue ↔ PR |
| `proximity` | Commit → PR | issue ↔ PR |

`commit_message` was a third row here and is now settled (decision 50): it is one detection
technique — a regex over a commit message — producing **two** relationships, commit→issue from
`mv_commit_message_issue_links_all` and issue↔PR from `mv_issue_pr_links_commit_message`. It keeps a
single `link.method` value, because `method` records how a link was found rather than what it joins,
and the qualifier carries the endpoints. ⚠️ **Every per-method figure must therefore group by
`(method, qualifier)`** — the RQ2 breakdown is exactly the query that would otherwise sum two
different relations into one number.

Both readings are coherent — "this issue links to that PR *because* a commit closed the issue" is a
perfectly good issue↔PR method — but they cannot both be right, and the answer is load-bearing. The
endpoint types decide the qualifier (decision 43), the toggle group (`deriveRelGroups` keys on the
sorted type pair), which two lanes the link is drawn between, and how the RQ2 breakdown is counted.

**Resolve it by reading the columns, not the names.** A row keyed on `issue_id` + `pull_request_id`
is an issue↔PR link whatever its method is called. Then reconcile `ADAPTER_AND_API.md` §3. Tracked as **O11** in
`DECISIONS.md`, now narrowed to these two methods.

---

## 2. What this project builds on top

⚠️ **This section's premise has weakened, and it is the most expensive thing in this revision to get
wrong.** It said three derivations "are not materialized anywhere upstream" — `commit_pr_links`,
`issue_pr_links` and `object_lifecycles`. Two upstream views now recorded in §1,
`mv_commit_pr_links` and `mv_issue_to_pr_validated_all`, look like exactly the first two. Until
their definitions have been read, assume **`object_lifecycles` is the only one certainly yours to
build**, and treat `ADAPTER_AND_API.md` §2's "three derivations to build" as two-thirds unverified.
Building a duplicate of an upstream view would be a week spent reproducing a join that already
exists — and worse, a second admission rule for commit→PR matching that silently disagrees with the
one other people's figures use.

(A fourth derivation, `process_gaps`, was specified in §2 there and superseded by decision 12: gaps
are computed in JS over the loaded sub-log so they follow the toggles. An upstream `mv_process_gaps`
also exists — see §3 — and is likewise not consumed, for the same reason and not because it is
missing.)

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

**27 views.** They exist and are not used. Recorded so the choice is documented rather than
accidental — and so that finding one in `pg_views` is not mistaken for a discovery.

| Excluded facet | Views | Why |
|---|---|---|
| **The other thesis's OCEL tables** (9) | `ocel_repos`, `ocel_actors`, `ocel_commits`, `ocel_events`, `ocel_c_events`, `ocel_c_objects`, `ocel_c_e2o`, `ocel_c_e2o_references`, `ocel_c_o2o` | **Off-limits by rule**, not by scope: a PhD student is building the real OCEL 2.0 tables and they are theirs. This project's adapter (decision 11) exists precisely *because* we do not read these. Note the trap — `ocel_c_e2o` is the event-to-object relation that would answer open question O10, and it is exactly the thing we may not touch. Decision 43 also records that our previous four link qualifiers were inherited from these views, which is why they were replaced |
| Labels (6) | `mv_issue_pr_labels_full`, `mv_label_snapshots_per_event`, `mv_label_lifecycle_events`, `mv_process_labels`, `mv_label_objects`, `mv_issue_pr_label_membership` | Out of scope (decision 40, "add if time") |
| Reviews / review comments (3) | `mv_pr_reviews_full`, `mv_pr_review_comments_full`, `mv_pr_review_activities` | Out of scope. Never implemented, and F1's own `meta.activity_scope` says so: *"OCEL-strict + comments (reviews/dismissals/review-comments excluded)"* |
| Forks / branch provenance (3) | `mv_fork_events_full`, `mv_pr_head_provenance`, `mv_create_events_full` | Out of scope |
| Branch deletion (1) | `mv_delete_events_full` | Out of scope |
| Commit comments (1) | `mv_commit_comment_activities` | Out of scope |
| Off-platform merges (1) | `mv_pr_offplatform_merges` | **Dropped by decision 48** — see below. The only exclusion that a view in scope depends on |
| Analytics over `ocel_events` (3) | `mv_object_outcomes`, `mv_process_gaps`, `mv_comment_classification` | Read `ocel_events` throughout, so they inherit the off-limits rule above and are unsalvageable under it. Two would also be refused on their own merits: `mv_process_gaps` and `mv_object_outcomes` compute exactly what decision 12 requires be computed **in JS over the loaded sub-log**, so that they follow the toggles. A precomputed gap answers "comments hidden → gaps unchanged" silently, which is the failure decision 12 exists to prevent. `mv_comment_classification` is comment classification, out of scope |

Bot / human actor classification is likewise out of scope (decision 47); `actor` is used as-is. That
is a boundary of this thesis rather than a permanent judgement — when another student's
classification lands upstream, consuming it is a one-field addition.

#### `mv_pr_offplatform_merges` — excluded, but you will meet it anyway

PRs closed without being merged on GitHub whose commits later appear in a push.
*Depends on:* `mv_pull_request_events_full`, `mv_push_commits_full`
**Columns (14):** `repo_id`, `pull_request_id`, `pr_number`, `base_ref`, `pr_closed_at`,
`closer_actor_id`, `delivering_commit_sha`, `push_id`, `pushed_at`, `pusher_actor_id`,
`delta_seconds`, `link_convention`, `link_kind`, `link_method`

**Not consumed (decision 48).** It once supplied a `PullRequestMergedOffPlatform` activity and a
distinct PR outcome; both are gone. The view is a `delta_seconds` timing heuristic, and drawing its
output with the weight of a real merge presented an inference as ground truth. The GitHub facts it
builds on — the PR was closed, unmerged — are already carried by `mv_pull_request_events_full`.

⚠️ **It is a dependency of `mv_pull_request_and_comment_activities_full`, which *is* in scope.** So
the reference is unavoidable: that timeline JOINs this view and emits an off-platform-merge
`activity_type`. Those rows map to **`PullRequestClosed`** — the GitHub fact. Anything else throws
against the closed vocabulary, which is the intended behaviour.

---

## 4. ⚠️ Limitation to document in the thesis

⚠️ **This section was written against the four-method snapshot and is now half wrong. Do not quote it
in the thesis as it stands.**

The four originally recorded issue↔PR detection methods key on **GitHub's standard conventions**:
closing keywords in the PR body, `fix/123`-style branch names, and `#N` references in PR titles and
issue comments.

It said project-specific conventions — `gh-N`, `bug #N`, `For #N` — are **not covered**, and that
this threatens RQ2: if detection is systematically weaker on kubernetes and react than on vscode,
apparent cross-repository process differences may be artifacts of coverage rather than real
behaviour.

**What has changed.** Those exact conventions have a dedicated view,
`mv_issue_pr_links_extended_conventions`, and it supplies the six extended methods decision 42 added
to the enum. Two of the three suggested mitigations also already exist upstream:
commit-message-based issue↔PR linking (`mv_issue_pr_links_commit_message`) and commit↔PR attribution
(`mv_commit_pr_links`). The recall this section proposed recovering may already be recovered.

**What has not changed.** *Detection exists* and *coverage is comparable* are different claims, and
only the second one bears on RQ2. Nobody has measured either. The threat is therefore **narrower and
still open**, and the honest form of it is:

- Report per-repo issue↔PR link counts **broken down by method**, now across all seven plus the
  extended-convention set — not the original four.
- Report what share of each repository's links comes from `proximity`, separately. It is the weakest
  method in the enum: nothing is asserted and nothing is parsed, only two timestamps are near each
  other. A coverage figure carried by proximity is not the same claim as one carried by
  `closed_via_commit`, and a per-repo difference in that mix is itself a finding.
- State the number, or state that it is unmeasured. **Do not estimate it** — an invented coverage
  figure would undermine the very limitation it documents (`VERIFICATION.md` §5).

Until the query has actually been run, the thesis should say the gap is *narrower than first
documented and not yet quantified*, which is both true and weaker than what this section used to
claim in either direction.
