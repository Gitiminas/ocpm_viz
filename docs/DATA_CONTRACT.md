# Data contract — the frozen upstream

The written record of what exists in the shared database. If a relation is not here, either it is
not in the database or it is out of scope; either way, do not use it. Where this document and the
database disagree, the database wins and this document gets fixed. What the project builds on top is
in `DATA_LAYER.md`, not here.

Scope is **issue → PR → commit, plus comments and actors**. Labels, forks, reviews, review comments,
commit comments, branch/ref lifecycle and bot classification are out (§3).

**Recorded: 4 base tables + 49 views — 22 in scope (§1), 27 excluded (§3). Measured 2026-08-04, this
database holds 4 base tables and 23 materialized views**: all 22 in-scope views are present, and 26
of the 27 exclusions do not exist here at all. Read §0a before treating any count here as an
inventory.

**Ownership, corrected 2026-08-04.** The base tables and the 22 in-scope views are this project's
own and may be consumed as they stand — no cloning, no rebuilding. The nine `ocel_*` views (§3)
belong to the parallel PhD work and stay out by instruction. Consuming is not changing: other
people's figures read the same relations, so redefining or refreshing one moves numbers elsewhere.

> **Snapshot: 2026-08-04**, from the API hand-off inventory. It added 17 relations the previous
> snapshot did not name — six in-scope link views, the nine `ocel_*` views, two analytics views —
> so anyone reading the earlier revision would have concluded that `mv_commit_pr_links` and
> `mv_issue_to_pr_validated_all` did not exist and built them from scratch. An undated placeholder
> let that go unnoticed; date this line on every revision. Column lists for the six were queried
> from `pg_attribute` and four do not have the shape the spec assumed.
> (`information_schema.columns` does not list materialized views, so use `pg_attribute` or `\d+`.)

---

## 0a. Reality check, 2026-08-04 — 23 views, not 49

Queried directly (`pg_class` where `relkind='m'`, schema `public`):

**4 base tables** — `event`, `actor`, `repo`, `org` — and **23 materialized views**. No plain views
at all, and no schema other than `public`.

**All 22 in-scope views (§1) exist and are usable as recorded.** Of the 27 exclusions in §3, 26 do
not exist in this database at all — the nine `ocel_*` views, the six label views, the three review
views, the three fork/branch-provenance views, `mv_delete_events_full`,
`mv_commit_comment_activities` and the three analytics views. Only `mv_pr_offplatform_merges` is
really there.

No decision changes: everything in §3 was excluded by scope or by instruction, and absent is at
least as excluded as present. What changes is how to read §3 — it is a list of exclusions, not an
inventory, and the failure mode it guards against (finding one in `pg_views` and taking it for a
discovery) cannot happen for 26 of them.

**Row counts and sizes**, 2026-08-04. `event` is 14 GB / 4.09M rows;
`mv_issue_comments_full` 4.6 GB, `mv_pull_request_comments_full` 3.0 GB,
`mv_issues_full` 644 MB, `mv_pull_request_and_comment_activities_full` 503 MB.

**Repositories present: three, not two.** `repo` holds four rows and only three carry data:

| `repo_id` | `repo.name` | events | span |
|---|---|---|---|
| `20580498` | kubernetes/kubernetes | 2,439,575 | 2014-06-10 → 2025-04-09 |
| `41881900` | microsoft/vscode | 1,174,725 | 2015-11-18 → 2025-04-03 |
| `10270250` | facebook/react | 475,394 | 2013-05-29 → 2025-04-03 |
| `40511817` | kubernetes/kubernetes | **1** | 2015-08-10 only |

⚠️ **`repo.name` is not unique.** `kubernetes/kubernetes` resolves to two ids, `20580498` and
`40511817`, the second a one-event stub. Addressing a repository by name is therefore ambiguous in
this database, not merely in principle. Any name→id resolution must be deterministic; decision 51.

⚠️ **The data window is not what the upstream SQL assumes.** `event.created_at` runs
2013-05-29 → **2025-04-09**, but `mv_commit_pr_links` hard-codes a window end of
`2025-10-01 02:00:00+02` (= 2025-10-01T00:00Z). The literal is a no-op ceiling here rather than a
real bound. Do not quote it as the data window.

**MV refresh timestamps, 2026-08-04** (`pg_stat_file(pg_relation_filepath(...))`): every one of the
23 was last written **2026-08-02, 19:32–19:45 UTC**. Quote this beside any figure that rests on an
upstream view — decision 52 requires it for the commit→PR link counts specifically.

---

## 0. Base tables — query these directly

Normal tables, not MVs. The MVs cache extractions of `event.payload` so the JSONB is not re-parsed
on every query.

| Table | Columns | Role |
|---|---|---|
| `event` | `id`, `type`, `actor_id`, `repo_id`, `org_id`, `public`, `created_at`, `payload` (jsonb) | **The event-log skeleton.** `type` gives the coarse class (`IssuesEvent`, `PullRequestEvent`, `PushEvent`, `IssueCommentEvent`); `created_at` the timestamp; `actor_id` the actor |
| `actor` | `id`, `login`, `display_login`, `url`, `updated_at` | Actor objects — complete, no reconstruction needed |
| `repo` | `id`, `name`, `url`, `updated_at` | Repo display name and identity |
| `org` | `id`, `login`, `url`, `avatar_url`, `updated_at` | Available; unused for issue-to-merge |

> **Actor objects, and the repository's own name, come from these tables — not from any view.**
> `actor` is complete as-is. The asymmetry downstream: `actor` supplies *objects*, `repo` supplies
> the **frame** the sub-log sits in (`meta.repo` / `meta.repo_id`). `repo_id` is a partition key in
> every view below and never a participant, which is why decision 39 stopped modelling it as an
> object type.

**Pattern to use:** `event` for the backbone, MVs for the payload-derived detail. The MVs refine
`event.type` into a specific activity via the payload's `action` field, and supply the object ids,
SHAs and comment ids inside the JSONB.

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
**Why:** broader row coverage than `issues_identity` — built over *all* actions, so it also covers
issues acted on inside the window but opened before it (the 22.62% missing-object problem). Use it
to resolve references to issues whose opening event is outside the window.

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
> so it sits in §3 with the rest of what is not read directly — but **read that entry**, because
> unlike the other exclusions it is a dependency of a view in scope, and since decision 123 its
> activity is consumed again through that view.

---

### Pre-built activity timelines (3) — evaluate these first

> Ready-made unified activity timelines with a named activity vocabulary. Check them before
> hand-rolling a UNION over the raw views above; they are already most of the event stream.

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

Seven issue→PR detection methods, one view of extended conventions, one union, two commit-link
views. The previous snapshot recorded four method views and one commit view.

**All seven method views are keyed on `issue_id` + `pull_request_id`, and every one is an issue↔PR
relation** (O11 closed, decision 53). Six share the same 11 columns: `repo_id`, `issue_id`,
`issue_number`, `pull_request_id`, `pr_number`, `validation_status`, `link_method`,
`issue_created_at_utc`, `pr_created_at_utc`, `pr_merged_at_utc`, `issue_closed_at_utc`.
`mv_issue_pr_links_proximity` does not — see its entry. Checked against `pg_attribute` 2026-08-04;
the guess was right three times out of four, which is why the rule is to look.

⚠️ **`validation_status` is not our evidence class.** Upstream it is the *temporal sanity* of a link,
whether the dates line up; our `validated` means *the platform asserts the link* (decision 7). Two
different questions with the same word, and `mv_issue_to_pr_validated_all` puts that word in a view
name. Mapping either onto `link.evidence` would break the solid-vs-dashed uncertainty cue and make
F1's 3 validated / 31 extracted split mean nothing. Evidence classification is not recorded in this
document at all — nothing upstream pre-classifies a link, so a class is a research judgement rather
than an existence fact. The single mapping lives in `DATA_LAYER.md`.

The first four methods, all keyed and shaped as above:

| View | Links from | Depends on |
|---|---|---|
| `mv_issue_pr_links_pr_body` | closing keywords in the PR body ("Closes #242864") | `issues_identity`, `mv_pull_request_events_full`, `prs_identity` |
| `mv_issue_pr_links_branch_name` | the PR's head branch name (`fix/123`) | as above |
| `mv_issue_pr_links_pr_title` | issue references in the PR title | as above |
| `mv_issue_pr_links_issue_comment` | PR references inside issue comments | as above, plus `mv_issue_comments_full` |

#### `mv_issue_pr_links_closed_via_commit`
Links derived from GitHub's own closed-via-commit record.
**Columns (11), captured 2026-08-04:** the shared 11.
**Why:** the `closed_via_commit` method — the one member of this family GitHub states rather than
anyone parsing, and so the one `validated` issue↔PR method besides `pr_body`.
⚠️ **The view is EMPTY — 0 rows**, and `pg_class.reltuples` is still `-1` (never analyzed). So
`closed_via_commit` never fires in this database and contributes nothing. Any RQ2 coverage figure
must say so rather than listing a method that produced no rows.

#### `mv_issue_pr_links_commit_message`
Links derived from issue references in commit messages.
**Columns (11), captured 2026-08-04:** the shared 11. 12,209 rows, all
`link_method = 'commit_message'`.
**Why:** the `commit_message` method **as an issue↔PR link**. ⚠️ Distinct from
`mv_commit_message_issue_links_all` below, which links a *commit* to an issue from the same raw
text. Two views, two relations, one `LINK_METHOD` value for both — hence decision 50's rule that
every per-method figure groups by `(method, qualifier)`.
⚠️ **It is derived from commit→PR attribution**, which is easy to miss and cost a partial fix. Its
definition joins `mv_commit_pr_links … AND cpr.admitted`, so every link it emits inherits whatever
that rule admits. Decision 61 narrowed the rule for commit links and decision 62 propagates the
narrowing here; consuming this view unfiltered re-imports the wide rule through the back door.
Measured 2026-08-04 on vscode PR #116416: 23 issues mentioned under the wide attribution, **0**
surviving the narrow one.

#### `mv_issue_pr_links_proximity`
Links derived from closeness in time alone.
**Columns (10), captured 2026-08-04 — ⚠️ NOT the shared 11:** `repo_id`, `issue_id`, `issue_number`,
`pull_request_id`, `pr_number`, `pr_is_merged`, `pr_merged_at`, `issue_closed_at`,
`close_delta_seconds`, `link_method`.
No `validation_status`, no `issue_created_at_utc` / `pr_created_at_utc`, and its two timestamp
columns drop the `_utc` suffix. It adds `pr_is_merged` and `close_delta_seconds` (the timing delta
the method rests on). `mv_issue_to_pr_validated_all` absorbs this by substituting the literal
`'valid_proximity'` for `validation_status` and `NULL` for the two missing timestamps. 1,457 rows.
**Why:** the `proximity` method — the weakest thing in the enum. Nothing is asserted and nothing is
parsed; two timestamps are merely near each other. Report its share separately in any RQ2 link
count, because a coverage figure that leans on it is not the same claim as one that does not.

#### `mv_issue_pr_links_extended_conventions`
Project-specific issue-reference forms GitHub does not act on — `gh-123`, `For #123`, Symfony's PR
template, "Fixed tickets" rows — split by whether they were found in the title or the body.
**Columns (11), captured 2026-08-04:** the shared 11.
**Why:** supplies the six extended methods of decision 42 (`pr_title_gh`, `pr_title_symfony`,
`pr_title_for`, `pr_body_gh`, `pr_body_fixed_tickets`, `pr_body_refs`). It materially changes §4's
limitation: the conventions that section calls uncovered are, in fact, detected.

⚠️ **Only 205 rows, and only four of the six methods occur:** `pr_title_for` 101, `pr_body_refs` 93,
`pr_title_symfony` 10, `pr_title_gh` 1. `pr_body_gh` and `pr_body_fixed_tickets` produce no rows at
all. Against 18,673 rows in `mv_issue_to_pr_validated_all` that is ~1.1% of detected issue↔PR links,
so the recovery §4 hoped for is measurably *small*. State the number; do not imply the gap is closed.

⚠️ **It is NOT part of `mv_issue_to_pr_validated_all`.** That union covers the seven method views and
stops there. These 205 rows must be added separately; they overlap the union on **zero** pairs
(2026-08-04), so the de-duplication guard is a guarantee about future refreshes rather than a
correction of present data.

#### `mv_issue_to_pr_validated_all`
The union of the issue↔PR method views, one row per (issue, PR).
**Columns (14), captured 2026-08-04:** `repo_id`, `issue_id`, `issue_number`, `pull_request_id`,
`pr_number`, `validation_status`, **`primary_link_method`** (not `link_method`), `priority`,
`n_methods`, `link_methods`, `issue_created_at_utc`, `pr_created_at_utc`, `pr_merged_at_utc`,
`issue_closed_at_utc`. 18,673 rows, no NULL `issue_id` or `pull_request_id`.

**Definition read 2026-08-04 — the derivation is done, so consume it.** It `UNION ALL`s the seven
method views with a `priority` per view (`pr_body` 1, `pr_title` 2, `commit_message` 3,
`issue_comment` 4, `branch_name` 5, `closed_via_commit` 6, `proximity` 7), aggregates
`count(DISTINCT link_method)` → `n_methods` and `string_agg(DISTINCT link_method, ';')` →
`link_methods`, then keeps `DISTINCT ON (repo_id, issue_number, pull_request_id)` ordered by
`priority`.

Three things to know before consuming it:

- **`link_methods` is a semicolon-joined `text`, not an array.** The payload's array field needs
  `string_to_array(link_methods, ';')`.
- **It de-duplicates on `issue_number`, not `issue_id`.** The surviving row's `issue_id` is whichever
  the priority order picked.
- **It does not include `mv_issue_pr_links_extended_conventions`** — those 205 rows are a separate
  union with a de-duplication guard.

⚠️ "validated" here is upstream's word for temporal sanity, not decision 7's evidence class.

#### `mv_commit_pr_links`
Commit↔PR attribution.
**Columns (11), captured 2026-08-04 — a shape of its own, sharing nothing with the issue↔PR family:**
`commit_sha`, `pull_request_id`, `pr_number`, `repo_id`, `link_method`, `head_is_default`,
`n_commits`, `first_pushed_at`, `pushed_in_window`, `prewindow_only`, **`admitted`**.
222,619 rows. No `issue_id` — it is a commit↔PR relation and nothing else.

`link_method` takes exactly three values, all already in the `LINK_METHOD` enum:
`merge_commit_sha`, `head_sha`, `ref_match`.

**Definition read 2026-08-04 — O2 is closed, and the `admitted` rule is INHERITED** (decision 52).
Admitted / not admitted, by repo and method:

| `repo_id` | `merge_commit_sha` | `head_sha` | `ref_match` | admitted % |
|---|---|---|---|---|
| 10270250 react | 5,983 / 47 | 2,110 / 27 | 3,934 / 279 | 97.1% |
| 20580498 kubernetes | 35,853 / 26 | 42,618 / 230 | 2,895 / 4,472 | 94.5% |
| 41881900 vscode | 15,017 / 513 | 10,720 / 226 | 71,470 / 26,199 | 78.5% |

⚠️ **Do not read the per-repo spread as a process difference.** The `ref_match` share — 7% of
kubernetes' commit links against 79% of vscode's — is a contribution-model artifact, not a detection
finding: `ref_match` requires `head_repo_id = repo_id`, so it cannot fire on a fork-based pull
request at all, and the same-repo share is **0.8% for kubernetes, 62.9% for vscode, 7.1% for
react**. Kubernetes barely uses the method because its contributors work from forks, not because its
links are cleaner.

⚠️ **This project does not consume `admitted` unchanged.** Decision 61 narrows the `ref_match`
branch and decision 62 propagates that narrowing to the issue↔PR links derived from it — the two
divergences from upstream in this layer. The view itself is untouched: the predicate lives in
`fe.link`, and `fe.diag_ref_match_narrowing` reports what it removes. **Our commit→PR link counts
are therefore deliberately lower than this view yields**, by an amount that differs per repository —
`ref_match` pairs go vscode 71,470 → 32,262, kubernetes 2,895 → 2,037, react 3,934 → 2,152 (figures
corrected by decision 65). Cite decision 61 beside any such number and report it as a range, with
raw `ref_match` as the ceiling.

**Why:** commit↔PR attribution, already built. It can change beneath us, so quote the refresh
timestamp (§0a: 2026-08-02 19:39 UTC) beside any figure resting on it.

#### `mv_commit_message_issue_links_all`
Issue references parsed out of commit messages by regex, tagged by convention
(`fixes #N`, `gh-N`, cross-repo, …).
*Depends on:* `mv_push_commits_full`
**Columns (7):** `source_repo_id`, `commit_sha`, `issue_number`, `ref_scope`, `link_convention`,
`push_created_at`, `actor_id`
**Why:** the commit↔issue link source — the `referenced_issue` qualifier. `ref_scope` and
`link_convention` are the sub-grading inputs; cross-repo refs are weaker than same-repo `fixes #N`,
and decision 54 drops them because the view carries no target repo id. The evidence class itself is
assigned in `DATA_LAYER.md`.

---

#### Link endpoints — O11, closed 2026-08-04

Two methods had an earlier adapter note claiming a commit endpoint: `closed_via_commit` as
Issue → Commit and `proximity` as Commit → PR. Both are **issue ↔ PR**, and neither view carries a
`commit_sha` column at all, so neither could name a commit endpoint even in principle. Resolved by
reading the columns rather than the names; recorded as decision 53. The answer was load-bearing,
because endpoint types decide the qualifier (43), the toggle group, which two lanes the link is
drawn between, and how the RQ2 breakdown is counted.

---

## 2. What this project builds on top

Settled 2026-08-04 by reading both definitions: **`mv_commit_pr_links` and
`mv_issue_to_pr_validated_all` really are two of the derivations this project would otherwise have
built.** Both are consumed as they stand, so there is exactly one commit→PR admission rule in the
project — the inherited one, decision 52 — and our link counts cannot silently disagree with anyone
else's. Lifecycle intervals were the derivation still ours, built as `fe.interval_issue` /
`fe.interval_pull_request` in `sql/fe_layer.sql`. Process gaps are computed in JS over the loaded
sub-log (decision 12) so they follow the toggles, which is why upstream `mv_process_gaps` (§3) is
not consumed either. The derived layer is described in `DATA_LAYER.md`.

**Indexes** are the first performance lever, ahead of any materialization: `repo_id`, `issue_id`,
`pull_request_id`, `commit_sha`, `push_id`. With ~14 GB and 3–4M rows in the largest views, query
latency is the real risk, not render latency.

**O9 is closed and the answer is "we own them"** (2026-08-04). `current_user` is `minas`, which owns
every relation in `public` and is a superuser, so `CREATE INDEX` and `ANALYZE` both simply work; the
ownership errors that framed the question do not arise here. `sql/fe_layer.sql` §0 creates **19
indexes** on upstream relations, with the measurements that justify them in §0.1. Two cautions survive
the question rather than the question itself:

- `ANALYZE` run by a non-owner **reports success while skipping**, so verify `pg_class.reltuples` is
  not `-1` rather than trusting the command. Two views were still at `-1` on 2026-08-04:
  `mv_issue_pr_links_closed_via_commit`, which is empty, and `mv_pr_offplatform_merges`.
- An index changes a relation other people's queries also read, so it is a change to announce, not a
  private optimisation.

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

**Not read directly, but its activity is consumed again** (decision 123, 2026-08-19). Decision 48
had dropped the `PullRequestMergedOffPlatform` activity and its distinct PR outcome; both are back.
The objection 48 recorded still shapes how: the view is a `delta_seconds` timing heuristic
(−831 s … +326 s over its 31 rows), so the frontend draws the activity as a landmark with its own
dotted ring in the extracted colour and counts it as a separate outcome, never as the platform's
merge. The `offplatform_commit_message` method and `delivered_by` qualifier stay out.

⚠️ **It is a dependency of `mv_pull_request_and_comment_activities_full`, which *is* in scope.** That
timeline JOINs this view and emits the off-platform-merge `activity_type`, which is the path the
activity takes into `fe.event`. For 29 of the 31 PRs it is the only closing event; two carry a
`PullRequestClosed` as well, and both pass through as they are.

---

## 4. Limitation to document in the thesis

⚠️ **Written against the four-method snapshot and now half wrong. Do not quote it as it stands.**

The four originally recorded issue↔PR methods key on GitHub's standard conventions: closing keywords
in the PR body, `fix/123`-style branch names, `#N` references in PR titles and issue comments. This
section said project-specific conventions — `gh-N`, `bug #N`, `For #N` — are not covered, and that
this threatens RQ2: if detection is systematically weaker on kubernetes and react than on vscode,
apparent cross-repository process differences may be artifacts of coverage rather than real
behaviour.

**What changed.** Those conventions have a dedicated view,
`mv_issue_pr_links_extended_conventions`, supplying decision 42's six extended methods, and two of
the three mitigations proposed here already exist upstream as `mv_issue_pr_links_commit_message` and
`mv_commit_pr_links`. **What did not:** *detection exists* and *coverage is comparable* are
different claims, only the second bears on RQ2, and neither has been measured. The threat is
narrower and still open. Its honest form:

- Report per-repo issue↔PR link counts broken down by method, across all seven plus the
  extended-convention set — not the original four.
- Report each repository's `proximity` share separately. It is the weakest method in the enum, and a
  per-repo difference in that mix is itself a finding.
- State the number, or state that it is unmeasured. **Do not estimate it** — an invented coverage
  figure would undermine the very limitation it documents (`VERIFICATION.md` §6).

Until the query has been run, the thesis should say the gap is *narrower than first documented and
not yet quantified*.
