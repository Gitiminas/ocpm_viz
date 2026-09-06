# Data contract — the frozen upstream

The written record of what the tool reads from the shared database. Read-only: no `UPDATE`,
no `DROP`, no refreshes, no altering a definition. The database is shared, so redefining or
refreshing a relation changes what every other query sees. Where this document and the database
disagree, the database wins and this document gets fixed. What the project builds on top is in
`DATA_LAYER.md`, not here.

Scope is **issue → PR → commit, plus comments and actors**. Labels, forks, reviews, review
comments, commit comments, branch/ref lifecycle and bot classification are out.

The relations below are the whole set `sql/fe_layer.sql` reads: base tables `event`, `actor`,
`repo`, the two identity views, and twelve `mv_*` views. Everything else in the database is listed
by name in §5 and is not read.

---

## 1. Database snapshot, 2026-08-04

Schema `public` holds **4 base tables and 23 materialized views**. No plain views, and no schema
other than `public`.

`information_schema.columns` does not list materialized views. Use `pg_attribute` or `\d+` to check
a shape, and check it rather than assuming it.

**Row counts and sizes.** `event` is 14 GB / 4.09M rows; `mv_issue_comments_full` 4.6 GB,
`mv_pull_request_comments_full` 3.0 GB, `mv_issues_full` 644 MB,
`mv_pull_request_and_comment_activities_full` 503 MB.

**Repositories.** `repo` holds four rows; three carry data.

| `repo_id` | `repo.name` | events | span |
|---|---|---|---|
| `20580498` | kubernetes/kubernetes | 2,439,575 | 2014-06-10 → 2025-04-09 |
| `41881900` | microsoft/vscode | 1,174,725 | 2015-11-18 → 2025-04-03 |
| `10270250` | facebook/react | 475,394 | 2013-05-29 → 2025-04-03 |
| `40511817` | kubernetes/kubernetes | **1** | 2015-08-10 only |

⚠️ **`repo.name` is not unique.** `kubernetes/kubernetes` resolves to two ids, `20580498` and
`40511817`, the second a one-event stub. Addressing a repository by name is ambiguous in this
database, not merely in principle. Any name→id resolution must be deterministic.

⚠️ **The data window is not what the upstream SQL assumes.** `event.created_at` runs
2013-05-29 → **2025-04-09**, but `mv_commit_pr_links` hard-codes a window end of
`2025-10-01 02:00:00+02` (= 2025-10-01T00:00Z). The literal is a no-op ceiling here rather than a
real bound. Do not quote it as the data window.

**MV refresh timestamps** (`pg_stat_file(pg_relation_filepath(...))`): every one of the 23 was last
written **2026-08-02, 19:32–19:45 UTC**. Quote this beside any figure that rests on an upstream
view, the commit→PR link counts above all.

---

## 2. Base tables — query these directly

Normal tables, not MVs. The MVs cache extractions of `event.payload` so the JSONB is not re-parsed
on every query.

| Table | Columns | Role |
|---|---|---|
| `event` | `id`, `type`, `actor_id`, `repo_id`, `org_id`, `public`, `created_at`, `payload` (jsonb) | **The event-log skeleton.** `type` gives the coarse class (`IssuesEvent`, `PullRequestEvent`, `PushEvent`, `IssueCommentEvent`); `created_at` the timestamp; `actor_id` the actor |
| `actor` | `id`, `login`, `display_login`, `url`, `updated_at` | Actor objects — complete, no reconstruction needed |
| `repo` | `id`, `name`, `url`, `updated_at` | Repo display name and identity |

> **Actor objects, and the repository's own name, come from these tables — not from any view.**
> The asymmetry downstream: `actor` supplies *objects*, `repo` supplies the **frame** the sub-log
> sits in (`meta.repo` / `meta.repo_id`). `repo_id` is a partition key in every view below and never
> a participant, which is why it is not modelled as an object type.

**Pattern to use:** `event` for the backbone, MVs for the payload-derived detail. The MVs refine
`event.type` into a specific activity via the payload's `action` field, and supply the object ids,
SHAs and comment ids inside the JSONB.

---

## 3. The views the tool reads

Identity (2) · raw flatteners (5) · pre-built activity timelines (3) · link detection (4).
`issues_identity` and `prs_identity` carry no `mv_` prefix; whether they are materialized or plain
is not recorded here because nothing in this project depends on it.

### Identity (2)

#### `issues_identity`
One row per issue, capturing the event that opened it — canonical `issue_id` ↔ `issue_number` ↔
opening-event mapping.
**Columns (5):** `repo_id`, `issue_id`, `issue_number`, `issue_creation_event_id`, `issue_created_at`

#### `prs_identity`
One row per pull request, capturing the event that opened it.
**Columns (5):** `repo_id`, `pull_request_id`, `pr_number`, `pr_creation_event_id`, `pr_created_at`

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
**Why:** `IssueCommented` — the largest activity class (2.3M).

#### `mv_pull_request_events_full`
Flattened PullRequestEvent payloads: full PR state per event.
**Columns (36):** `event_id`, `actor_id`, `repo_id`, `org_id`, `event_created_at`, `action`,
`pr_number`, `pull_request_id`, `pr_title`, `pr_body`, `pr_state`, `pr_is_draft`, `pr_is_merged`,
`pr_created_at`, `pr_updated_at`, `pr_closed_at`, `pr_merged_at`, `author_id`, `author_login`,
`author_url`, `author_association`, `assignee_id`, `assignee_login`, `base_ref`, `base_sha`,
`base_repo_id`, `base_repo_full_name`, `head_ref`, `head_sha`, `head_repo_id`,
`head_repo_full_name`, `merge_commit_sha`, `labels_json`, `assignees_json`, `is_fork_pr`, `pr_origin`
**Why:** the PR half of the backbone. Carries `head_sha` / `merge_commit_sha` / `head_ref` — the
inputs for commit↔PR attribution. For repo display names use `repo.name`, not `base_repo_full_name`.

#### `mv_pull_request_comments_full`
IssueCommentEvent payloads where the target is a PR rather than an issue.
**Columns (29):** `event_id`, `actor_id`, `repo_id`, `org_id`, `event_created_at`, `public`, `action`,
`comment_id`, `comment_body`, `comment_created_at`, `comment_updated_at`, `comment_html_url`,
`comment_author_association`, `comment_user_id`, `comment_user_login`, `comment_user_is_site_admin`,
`issue_id`, `pr_number`, `pr_title`, `pr_state`, `pr_comment_count`, `pr_creator_id`,
`pr_creator_login`, `pr_assignee_id`, `pr_assignee_login`, `pr_labels_json`, `pr_assignees_json`,
`pr_api_url`, `pr_html_url`

#### `mv_push_commits_full`
One row per commit inside every PushEvent.
**Columns (18):** `event_id`, `created_at`, `actor_id`, `repo_id`, `org_id`, `push_id`, `ref`,
`before`, `head`, `size`, `distinct_size`, `commit_sha`, `commit_url`, `commit_message`,
`commit_author_name`, `commit_author_email`, `commit_distinct`, `commit_index`
**Why:** the entire commit layer, plus `push_id` / `size` for burst detection.
⚠️ `created_at` is **push time, not real commit time** — preserve this caveat in the UI.

---

### Pre-built activity timelines (3)

Ready-made unified activity timelines with a named activity vocabulary. They are already most of
the event stream; check them before hand-rolling a UNION over the raw views above.

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

⚠️ **The off-platform merge activity arrives through this view.** `mv_pr_offplatform_merges` is not
read directly, but this timeline JOINs it and emits the off-platform-merge `activity_type`, which is
the path that activity takes into `fe.event`. It is a `delta_seconds` timing heuristic
(−831 s … +326 s over its 31 rows), so the frontend draws it as a landmark with its own dotted ring
in the extracted colour and counts it as a separate PR outcome, never as the platform's merge.
For 29 of the 31 PRs it is the only closing event; two carry a `PullRequestClosed`
as well, and both pass through as they are. The `offplatform_commit_message` method and
`delivered_by` qualifier stay out.

#### `mv_push_activities`
PushEvents reshaped into generic activity records.
**Columns (14):** `activity_id`, `activity_timestamp`, `object_type`, `object_id`, `object_key`,
`activity_type`, `actor_user_id`, `repo_id`, `org_id`, `push_id`, `ref`, `commit_count`,
`distinct_commit_count`, `activity_payload`

---

### Link detection (4)

⚠️ **`validation_status` is not our evidence class.** Upstream it is the *temporal sanity* of a
link, whether the dates line up; our `validated` means *the platform asserts the link*.
Two different questions with the same word, and `mv_issue_to_pr_validated_all` puts that word in a
view name. Mapping either onto `link.evidence` would break the solid-vs-dashed uncertainty cue.
Nothing upstream pre-classifies a link by evidence; the single mapping lives in `DATA_LAYER.md`.

#### `mv_issue_to_pr_validated_all`
The union of the seven issue↔PR method views, one row per (issue, PR).
**Columns (14), captured 2026-08-04:** `repo_id`, `issue_id`, `issue_number`, `pull_request_id`,
`pr_number`, `validation_status`, **`primary_link_method`** (not `link_method`), `priority`,
`n_methods`, `link_methods`, `issue_created_at_utc`, `pr_created_at_utc`, `pr_merged_at_utc`,
`issue_closed_at_utc`. 18,673 rows, no NULL `issue_id` or `pull_request_id`.

It `UNION ALL`s the seven method views with a `priority` per view (`pr_body` 1, `pr_title` 2,
`commit_message` 3, `issue_comment` 4, `branch_name` 5, `closed_via_commit` 6, `proximity` 7),
aggregates `count(DISTINCT link_method)` → `n_methods` and `string_agg(DISTINCT link_method, ';')`
→ `link_methods`, then keeps `DISTINCT ON (repo_id, issue_number, pull_request_id)` ordered by
`priority`. All seven method views are keyed on `issue_id` + `pull_request_id`, and every one is an
issue↔PR relation — none carries a `commit_sha` column, so none can name a commit endpoint.
The derivation is done; consume it rather than rebuilding it.

Things to know before consuming it:

- **`link_methods` is a semicolon-joined `text`, not an array.** The payload's array field needs
  `string_to_array(link_methods, ';')`.
- **It de-duplicates on `issue_number`, not `issue_id`.** The surviving row's `issue_id` is whichever
  the priority order picked.
- **The `closed_via_commit` member is empty — 0 rows**, and its `pg_class.reltuples` is still `-1`
  (never analyzed). That method never fires in this database and contributes nothing, so a coverage
  figure must say so rather than listing a method that produced no rows.
- **The `commit_message` member is derived from commit→PR attribution.** Its definition joins
  `mv_commit_pr_links … AND cpr.admitted`, so those links inherit whatever that rule admits.
  This project narrows the rule for commit links and propagates the narrowing here;
  consuming the union unfiltered re-imports the wide rule through the back door. Measured
  2026-08-04 on vscode PR #116416: 23 issues mentioned under the wide attribution, **0** surviving
  the narrow one. `commit_message` is also the `link_method` value used by
  `mv_commit_message_issue_links_all`, which is a *commit*↔issue relation — hence the rule
  that every per-method figure groups by `(method, qualifier)`.
- **`proximity` asserts nothing and parses nothing**; two timestamps are merely near each other
  (1,457 rows in the member view). Report its share separately from any link count, because a
  coverage figure that leans on it is not the same claim as one that does not.
- **It does not include `mv_issue_pr_links_extended_conventions`** — those rows are a separate union
  with a de-duplication guard.

#### `mv_issue_pr_links_extended_conventions`
Project-specific issue-reference forms GitHub does not act on — `gh-123`, `For #123`, Symfony's PR
template, "Fixed tickets" rows — split by whether they were found in the title or the body.
**Columns (11), captured 2026-08-04:** `repo_id`, `issue_id`, `issue_number`, `pull_request_id`,
`pr_number`, `validation_status`, `link_method`, `issue_created_at_utc`, `pr_created_at_utc`,
`pr_merged_at_utc`, `issue_closed_at_utc`.
**Why:** supplies the six extended methods (`pr_title_gh`, `pr_title_symfony`,
`pr_title_for`, `pr_body_gh`, `pr_body_fixed_tickets`, `pr_body_refs`).

⚠️ **Only 205 rows, and only four of the six methods occur:** `pr_title_for` 101, `pr_body_refs` 93,
`pr_title_symfony` 10, `pr_title_gh` 1. `pr_body_gh` and `pr_body_fixed_tickets` produce no rows at
all. Against 18,673 rows in `mv_issue_to_pr_validated_all` that is ~1.1% of detected issue↔PR links.
State the number; do not imply the extended conventions close the coverage gap.

⚠️ **It is NOT part of `mv_issue_to_pr_validated_all`.** These 205 rows must be added separately.
They overlap the union on **zero** pairs (2026-08-04), so the de-duplication guard is a guarantee
about future refreshes rather than a correction of present data.

#### `mv_commit_pr_links`
Commit↔PR attribution.
**Columns (11), captured 2026-08-04 — a shape of its own, sharing nothing with the issue↔PR family:**
`commit_sha`, `pull_request_id`, `pr_number`, `repo_id`, `link_method`, `head_is_default`,
`n_commits`, `first_pushed_at`, `pushed_in_window`, `prewindow_only`, **`admitted`**.
222,619 rows. No `issue_id` — it is a commit↔PR relation and nothing else.

`link_method` takes exactly three values, all already in the `LINK_METHOD` enum:
`merge_commit_sha`, `head_sha`, `ref_match`.

The `admitted` rule is **inherited, not reimplemented**. Admitted / not admitted, by
repo and method, 2026-08-04:

| `repo_id` | `merge_commit_sha` | `head_sha` | `ref_match` | admitted % |
|---|---|---|---|---|
| 10270250 react | 5,983 / 47 | 2,110 / 27 | 3,934 / 279 | 97.1% |
| 20580498 kubernetes | 35,853 / 26 | 42,618 / 230 | 2,895 / 4,472 | 94.5% |
| 41881900 vscode | 15,017 / 513 | 10,720 / 226 | 71,470 / 26,199 | 78.3% |

⚠️ **Do not read the per-repo spread as a process difference.** The `ref_match` share — 7% of
kubernetes' commit links against 79% of vscode's — is a contribution-model artifact, not a detection
finding: `ref_match` requires `head_repo_id = repo_id`, so it cannot fire on a fork-based pull
request at all, and the same-repo share is **0.8% for kubernetes, 62.9% for vscode, 7.1% for
react**. Kubernetes barely uses the method because its contributors work from forks, not because its
links are cleaner.

⚠️ **This project does not consume `admitted` unchanged.** `fe.link` narrows the `ref_match`
branch and propagates that narrowing to the issue↔PR links derived from it — the two
divergences from upstream in this layer. The view itself is untouched: the predicate lives in
`fe.link`, and `fe.diag_ref_match_narrowing` reports what it removes. **Our commit→PR link counts
are therefore deliberately lower than this view yields**, by an amount that differs per repository —
`ref_match` pairs go vscode 71,470 → 20,846, kubernetes 2,895 → 1,981, react 3,934 → 1,343
(`fe.diag_ref_match_narrowing`, 2026-09-06; the earlier rule, since replaced, kept 32,262 /
2,037 / 2,152).
Cite the narrowing beside any such number and report it as a range, with raw `ref_match` as the
ceiling.

The view can change beneath us, so quote its refresh timestamp (§1: 2026-08-02 19:39 UTC) beside any
figure resting on it.

#### `mv_commit_message_issue_links_all`
Issue references parsed out of commit messages by regex, tagged by convention
(`fixes #N`, `gh-N`, cross-repo, …).
*Depends on:* `mv_push_commits_full`
**Columns (7):** `source_repo_id`, `commit_sha`, `issue_number`, `ref_scope`, `link_convention`,
`push_created_at`, `actor_id`
**Why:** the commit↔issue link source — the `referenced_issue` qualifier. `ref_scope` and
`link_convention` are the sub-grading inputs; cross-repo refs are weaker than same-repo `fixes #N`,
and they are dropped because the view carries no target repo id. The evidence class itself is
assigned in `DATA_LAYER.md`.

---

## 4. What this project builds on top

`mv_commit_pr_links` and `mv_issue_to_pr_validated_all` are two derivations this project would
otherwise have built. Both are consumed as they stand, so there is exactly one commit→PR admission
rule in the project — the inherited one. Lifecycle intervals are ours, built as
`fe.interval_issue` / `fe.interval_pull_request` in `sql/fe_layer.sql`. Process gaps are computed in
JS over the loaded sub-log so they follow the toggles; no upstream gap view is
consumed. The derived layer is described in `DATA_LAYER.md`.

**Indexes** are the first performance lever, ahead of any materialization: `repo_id`, `issue_id`,
`pull_request_id`, `commit_sha`, `push_id`. With ~14 GB and 3–4M rows in the largest views, query
latency is the real risk, not render latency. `sql/fe_layer.sql` §0 creates **19 indexes** on
upstream relations, with the measurements that justify them in §0.1. Two cautions:

- `ANALYZE` run by a non-owner **reports success while skipping**, so verify `pg_class.reltuples` is
  not `-1` rather than trusting the command. Two views were still at `-1` on 2026-08-04:
  `mv_issue_pr_links_closed_via_commit`, which is empty, and `mv_pr_offplatform_merges`.
- An index changes a relation other queries also read, so it is a change to announce, not a private
  optimisation.

Roles and grants for the HTTP surface are created by `sql/postgrest_setup.sql`, applied after
`fe_layer.sql`: `fe_owner` owns the `fe` and `api` objects and holds `SELECT` on `public`;
`web_anon` may only `EXECUTE` the four `api` functions; `authenticator` is the `NOINHERIT` login
role PostgREST connects as.

---

## 5. Not used

The database also holds the relations below. The tool does not read them, and nothing in `fe` or
`api` should be wired to them.

Base table `org`. Views `mv_issue_id_to_number`, `mv_issue_pr_links_pr_body`,
`mv_issue_pr_links_branch_name`, `mv_issue_pr_links_pr_title`, `mv_issue_pr_links_issue_comment`,
`mv_issue_pr_links_closed_via_commit`, `mv_issue_pr_links_commit_message`,
`mv_issue_pr_links_proximity`, `mv_pr_offplatform_merges`. The seven method views and
`mv_pr_offplatform_merges` reach the tool only through `mv_issue_to_pr_validated_all` and
`mv_pull_request_and_comment_activities_full` respectively; read those, not these.

The `ocel_*` views are not read by this tool either; do not wire them in. None were present in this
database on 2026-08-04.

Bot / human actor classification is out of scope; `actor` is used as-is.
