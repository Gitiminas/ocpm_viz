# Data contract — the frozen upstream

**This document is the authoritative list of what exists in the shared database.** If something is not
here, either it is not in the database or it is out of scope — in both cases, do not use it.

Scope is **issue → PR → commit, plus comments and actors**. Labels, forks, reviews, review comments,
commit comments, branch/ref lifecycle and bot classification are deliberately out (see §3).

**Recorded: 4 base tables + 49 views — 22 in scope (§1) and 27 excluded (§3).**
⚠️ **Measured 2026-08-04: this database holds 4 base tables and 23 materialized views.** All 22
in-scope views are present; 26 of the 27 exclusions do not exist here at all. See §0a — read it
before treating any count in this document as an inventory.

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
> ✅ **Column lists for the six views captured 2026-08-04** — queried from `pg_attribute` against
> `gharchive_ocpm_viz_wsl`, recorded in each entry below. Four of the six do **not** have the shape
> the spec assumed; see the per-view notes. (`information_schema.columns` does not list materialized
> views, so `pg_attribute` or `\d+` is the query to use.)

---

## 0a. ⚠️ Reality check, 2026-08-04 — this database has **23 views, not 49**

Queried directly (`pg_class` where `relkind='m'`, schema `public`):

**4 base tables** — `event`, `actor`, `repo`, `org` — and **23 materialized views**. There are no
plain views at all, and no schema other than `public`.

| | Recorded in §1/§3 | Present in the database |
|---|---|---|
| Base tables | 4 | **4** ✅ |
| In-scope views (§1) | 22 | **22** ✅ all present |
| Excluded views (§3) | 27 | **1** — only `mv_pr_offplatform_merges` |

**All 22 in-scope views exist and are usable as recorded.** Of the 27 §3 exclusions, 26 do not
exist in this database at all: the nine `ocel_*` views, the six label views, the three review
views, the three fork/branch-provenance views, `mv_delete_events_full`,
`mv_commit_comment_activities`, and the three analytics views. Only `mv_pr_offplatform_merges` is
really there.

This does not change any decision — everything in §3 was excluded by scope or by instruction, and
absent is at least as excluded as present. It changes two things about how to *read* the documents:

- **§3 is a list of exclusions, not an inventory.** "Finding one in `pg_views`" — the failure mode
  §3 opens by guarding against — cannot happen for 26 of them, and the nine `ocel_*` views cannot
  be read even by accident. `OCEL_TOOL_SPEC.md`'s premise that its source dump held 49 MVs is a
  statement about that dump, not about this database.
- **`mv_pr_review_activities` and `mv_commit_comment_activities` do not exist**, so
  `OCEL_TOOL_SPEC.md` §III.1's "Reviews" and "Commit comments" sections describe relations that are
  absent as well as out of scope, and its G12 claim that five row shapes must be normalised is
  really three.

**Row counts and sizes** (same query, 2026-08-04). `event` is 14 GB / 4.09M rows;
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
`40511817`, the second of which is a one-event stub. Addressing a repository by name — the dated
exception in `CLAUDE.md` — is therefore ambiguous *in this database*, not merely in principle. Any
name→id resolution must be deterministic; see decision 51.

⚠️ **The data window is not what the upstream SQL assumes.** `event.created_at` runs
2013-05-29 → **2025-04-09**, but `mv_commit_pr_links` hard-codes a window end of
`2025-10-01 02:00:00+02` (= 2025-10-01T00:00Z). The literal is a no-op ceiling here rather than a
real bound. Do not quote it as the data window.

**MV refresh timestamps, 2026-08-04** (`pg_stat_file(pg_relation_filepath(...))`): every one of the
23 was last written **2026-08-02, 19:32–19:45 UTC**. Quote this beside any figure that rests on an
upstream view — decision 52 requires it for the commit→PR link counts specifically.

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
> ✅ **Checked 2026-08-04.** `mv_issue_pr_links_closed_via_commit`, `mv_issue_pr_links_commit_message`
> and `mv_issue_pr_links_extended_conventions` **do** share those exact 11 columns.
> `mv_issue_pr_links_proximity` does **not** — 10 columns, no `validation_status`, no
> `*_created_at_utc`, plus `pr_is_merged` and `close_delta_seconds` of its own. So the "likely"
> guess was right three times out of four, which is the reason the rule is to look.
>
> **All seven are keyed on `issue_id` + `pull_request_id`. Every one of them is an issue↔PR
> relation. O11 is closed — see decision 53.**

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
**Columns (11), captured 2026-08-04:** `repo_id`, `issue_id`, `issue_number`, `pull_request_id`,
`pr_number`, `validation_status`, `link_method`, `issue_created_at_utc`, `pr_created_at_utc`,
`pr_merged_at_utc`, `issue_closed_at_utc` — **the same 11 as the four originally recorded methods.**
**Why:** the `closed_via_commit` method, the one `validated` member of this family that GitHub
states rather than anyone parsing.
⚠️ **The view is EMPTY — 0 rows**, and `pg_class.reltuples` is still `-1` (never analyzed). So
`closed_via_commit` never fires in this database: no link carries it, and `ADAPTER_AND_API.md` §3's
one `validated` issue↔PR method besides `pr_body` contributes nothing. Any RQ2 coverage figure must
say so rather than listing a method that produced no rows.
**Endpoints (O11):** keyed on `issue_id` + `pull_request_id`. **Issue ↔ PR**, not Issue → Commit.

#### `mv_issue_pr_links_commit_message`
Links derived from issue references in commit messages.
**Columns (11), captured 2026-08-04:** identical to the four originally recorded methods — `repo_id`,
`issue_id`, `issue_number`, `pull_request_id`, `pr_number`, `validation_status`, `link_method`,
`issue_created_at_utc`, `pr_created_at_utc`, `pr_merged_at_utc`, `issue_closed_at_utc`.
12,209 rows, all `link_method = 'commit_message'`.
**Endpoints (O11):** keyed on `issue_id` + `pull_request_id`. **Issue ↔ PR** — consistent with
decision 50.
⚠️ **This view is derived from commit→PR attribution, which is easy to miss and cost a partial
fix.** Its definition joins `mv_commit_pr_links … AND cpr.admitted`, so every link it emits inherits
whatever the commit→PR admission rule admits. Decision 61 narrowed that rule for commit links and
decision 62 propagates the narrowing here; consuming this view unfiltered re-imports the wide rule
through the back door. Measured 2026-08-04: on vscode PR #116416, 23 issues were mentioned under the
wide attribution and **0** survive the narrow one.

**Why:** the `commit_message` method **as an issue↔PR link**. ⚠️ Distinct from
`mv_commit_message_issue_links_all` below, which links a *commit* to an issue from the same raw
text. Two views, two different relations, and the `LINK_METHOD` enum currently has one value for
both — see the endpoint question below.

#### `mv_issue_pr_links_proximity`
Links inferred from closeness in time alone.
**Columns (10), captured 2026-08-04 — ⚠️ NOT the shared 11:** `repo_id`, `issue_id`, `issue_number`,
`pull_request_id`, `pr_number`, `pr_is_merged`, `pr_merged_at`, `issue_closed_at`,
`close_delta_seconds`, `link_method`.
It has **no `validation_status`**, **no `issue_created_at_utc` / `pr_created_at_utc`**, and its two
timestamp columns are named `pr_merged_at` / `issue_closed_at` without the `_utc` suffix. It adds
two of its own: `pr_is_merged` and `close_delta_seconds` (the timing delta the method rests on).
`mv_issue_to_pr_validated_all` absorbs this by substituting the literal `'valid_proximity'` for
`validation_status` and `NULL` for the two missing timestamps. 1,457 rows.
**Endpoints (O11):** keyed on `issue_id` + `pull_request_id`. **Issue ↔ PR**, not Commit → PR.
**Why:** the `proximity` method — the weakest thing in the enum. Nothing is asserted and nothing is
parsed; two timestamps are merely near each other. Report its share separately in any RQ2 link
count, because a coverage figure that leans on it is not the same claim as one that does not.

#### `mv_issue_pr_links_extended_conventions`
Project-specific issue-reference forms GitHub does not act on — `gh-123`, `For #123`, Symfony's PR
template, "Fixed tickets" rows — split by whether they were found in the title or the body.
**Columns (11), captured 2026-08-04:** identical to the four originally recorded methods — `repo_id`,
`issue_id`, `issue_number`, `pull_request_id`, `pr_number`, `validation_status`, `link_method`,
`issue_created_at_utc`, `pr_created_at_utc`, `pr_merged_at_utc`, `issue_closed_at_utc`.
**Why:** supplies the six extended methods of decision 42 (`pr_title_gh`, `pr_title_symfony`,
`pr_title_for`, `pr_body_gh`, `pr_body_fixed_tickets`, `pr_body_refs`). **This view materially
changes §4's limitation** — the conventions that section calls uncovered are, in fact, detected.

⚠️ **Only 205 rows, and only four of the six methods occur:** `pr_title_for` 101,
`pr_body_refs` 93, `pr_title_symfony` 10, `pr_title_gh` 1. **`pr_body_gh` and
`pr_body_fixed_tickets` produce no rows at all.** Against 18,673 rows in
`mv_issue_to_pr_validated_all`, the extended conventions are ~1.1% of detected issue↔PR links —
so §4's "the recall this section proposed recovering may already be recovered" is, measured,
a *small* recovery. State the number; do not imply the gap is closed.

⚠️ **This view is NOT part of `mv_issue_to_pr_validated_all`.** That union covers the seven method
views and stops there. Its 205 rows must be added separately, and they currently overlap the
validated set on **zero** pairs (measured 2026-08-04) — so the de-duplication guard is a guarantee
about future refreshes rather than a correction of present data.

#### `mv_issue_to_pr_validated_all`
The union of the issue↔PR method views, one row per (issue, PR).
**Columns (14), captured 2026-08-04:** `repo_id`, `issue_id`, `issue_number`, `pull_request_id`,
`pr_number`, `validation_status`, **`primary_link_method`** (not `link_method`), `priority`,
`n_methods`, `link_methods`, `issue_created_at_utc`, `pr_created_at_utc`, `pr_merged_at_utc`,
`issue_closed_at_utc`. 18,673 rows, no NULL `issue_id` or `pull_request_id`.

**Definition read 2026-08-04 — the derivation is done.** It `UNION ALL`s the **seven** method views
with a `priority` per view (`pr_body` 1, `pr_title` 2, `commit_message` 3, `issue_comment` 4,
`branch_name` 5, `closed_via_commit` 6, `proximity` 7), aggregates
`count(DISTINCT link_method)` → `n_methods` and `string_agg(DISTINCT link_method, ';')` →
`link_methods`, then keeps `DISTINCT ON (repo_id, issue_number, pull_request_id)` ordered by
`priority`. So `ADAPTER_AND_API.md` §2's `issue_pr_links` row is **built** — consume it.

Three things to know before consuming it:

- **`link_methods` is a semicolon-joined `text`, not an array.** `string_to_array(link_methods,';')`
  is what `ADAPTER_AND_API.md` §4's array field needs.
- **It de-duplicates on `issue_number`, not `issue_id`.** The surviving row's `issue_id` is
  whichever the priority order picked.
- **It does not include `mv_issue_pr_links_extended_conventions`** — those 205 rows are a separate
  union with a de-duplication guard.

**Why:** the `issue_pr_links` derivation, already built. Note the name warning above — "validated"
here is upstream's word, not decision 7's.

#### `mv_commit_pr_links`
Commit↔PR attribution.
**Columns (11), captured 2026-08-04 — a shape of its own, sharing nothing with the issue↔PR family:**
`commit_sha`, `pull_request_id`, `pr_number`, `repo_id`, `link_method`, `head_is_default`,
`n_commits`, `first_pushed_at`, `pushed_in_window`, `prewindow_only`, **`admitted`**.
222,619 rows. No `issue_id` — it is a commit↔PR relation and nothing else.

`link_method` takes exactly three values, all already in the `LINK_METHOD` enum:
`merge_commit_sha`, `head_sha`, `ref_match`.

**Definition read 2026-08-04 — O2 is closed, INHERITED.** The `admitted` rule is recorded in
`DECISIONS.md` decision 52. Admitted / not admitted, by repo and method:

| `repo_id` | `merge_commit_sha` | `head_sha` | `ref_match` | admitted % |
|---|---|---|---|---|
| 10270250 react | 5,983 / 47 | 2,110 / 27 | 3,934 / 279 | 97.1% |
| 20580498 kubernetes | 35,853 / 26 | 42,618 / 230 | 2,895 / 4,472 | 94.5% |
| 41881900 vscode | 15,017 / 513 | 10,720 / 226 | 71,470 / 26,199 | 78.5% |

⚠️ **Corrected 2026-08-04 — do not read the per-repo spread as a process difference.** An earlier
revision of this entry said the `ref_match` share (7% of kubernetes' commit links against 79% of
vscode's) was "an RQ2 finding about detection mix". **It is a contribution-model artifact.**
`ref_match` requires `head_repo_id = repo_id`, so it cannot fire on a fork-based pull request at
all, and the same-repo share is **0.8% for kubernetes, 62.9% for vscode, 7.1% for react**.
Kubernetes barely uses this method because its contributors work from forks — not because its links
are cleaner. Reporting the spread as a linking-convention difference would have put a confound in
the thesis dressed as a result.

⚠️ **This project does not consume `admitted` unchanged.** Decision 61 narrows the `ref_match`
branch, and decision 62 propagates that narrowing to the issue↔PR links derived from it — the two
divergences from upstream in this layer. The view itself is untouched; the
predicate lives in `fe.link`, and `fe.diag_ref_match_narrowing` reports exactly what it removes.
Consequence for anyone comparing figures: **our commit→PR link counts are deliberately lower than
this view yields**, by an amount that differs per repository — `ref_match` pairs go vscode
71,470 → 15,276, kubernetes 2,895 → 1,974, react 3,934 → 1,402. Cite decision 61 beside any such
number and report it as a range, with raw `ref_match` as the ceiling.

**Why:** the `commit_pr_links` derivation of `ADAPTER_AND_API.md` §2, **already built** — consume
it, do not rebuild it. Owned upstream and able to change beneath us, so quote the refresh timestamp
(§0a: 2026-08-02 19:39 UTC) beside any figure resting on it.

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

#### ✅ Which two objects does a link row join? — O11, **closed 2026-08-04**

Resolved by reading the columns, as this section instructed. Both disputed methods are **issue ↔ PR**:

| Method | `ADAPTER_AND_API.md` §3 said | The view name said | **The columns say** |
|---|---|---|---|
| `closed_via_commit` | Issue → Commit | issue ↔ PR | `issue_id` + `pull_request_id` → **issue ↔ PR** ✅ |
| `proximity` | Commit → PR | issue ↔ PR | `issue_id` + `pull_request_id` → **issue ↔ PR** ✅ |

The view names were right and `ADAPTER_AND_API.md` §3 was wrong; it has been corrected. Neither view
carries a `commit_sha` column at all, so neither can name a commit endpoint even in principle.
Consequences, all now settled: both take the `resolves` qualifier (decision 43), both land in the
issue↔PR toggle group, both are drawn between the issue and PR lanes, and the RQ2 breakdown counts
them there. Recorded as **decision 53** in `DECISIONS.md`.

The historical statement of the question is kept below, because the reasoning is what the decision
rests on.

| Method | `ADAPTER_AND_API.md` §3 said | The view name said |
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

**Resolved by reading the columns, not the names**, on 2026-08-04. `ADAPTER_AND_API.md` §3 has been
reconciled. Decision 53.

---

## 2. What this project builds on top

✅ **Settled 2026-08-04 by reading both definitions.** This section used to warn that its own premise
was unverified. It is now verified, and the warning resolved in the direction it feared:
**`mv_commit_pr_links` and `mv_issue_to_pr_validated_all` really are the first two derivations
`ADAPTER_AND_API.md` §2 tells you to build.** Both are consumed as they stand; neither is rebuilt.
`object_lifecycles` was indeed the only one still ours, and it is built as `fe_interval_issue` /
`fe_interval_pull_request` in `sql/fe_layer.sql`.

The week that would have gone into reproducing them was saved, and — the sharper risk — there is
exactly one commit→PR admission rule in this project, the inherited one (decision 52), so our link
counts and other people's cannot silently disagree.

(A fourth derivation, `process_gaps`, was specified in §2 there and superseded by decision 12: gaps
are computed in JS over the loaded sub-log so they follow the toggles. An upstream `mv_process_gaps`
also exists — see §3 — and is likewise not consumed, for the same reason and not because it is
missing.)

**Indexes** are the first performance lever, ahead of any materialization: `repo_id`, `issue_id`,
`pull_request_id`, `commit_sha`, `push_id`. With ~14 GB and 3–4M rows in the largest views, query
latency is the real risk, not render latency.

> ✅ **O9 is closed and the answer is "we own them"** (`DECISIONS.md`, 2026-08-04). Verified against
> this database on 2026-08-04: `current_user` is `minas`, which owns every relation in `public` and
> is a superuser, so `CREATE INDEX` and `ANALYZE` both simply work. The ownership errors that framed
> this warning do not arise here. The paragraph that used to stand here described a permission
> regime this database does not have.
>
> Two cautions survive rather than the question. **`ANALYZE` run by a non-owner reports success
> while skipping**, so verify `pg_class.reltuples` is not `-1` rather than trusting the command —
> two views were still at `-1` on 2026-08-04 (`mv_issue_pr_links_closed_via_commit`, which is empty,
> and `mv_pr_offplatform_merges`). And **an index changes a relation other people's queries read**,
> so it is a change to announce, not a private optimisation.
>
> Indexes actually created for this project are listed in `sql/fe_layer.sql` §0, with the measurement
> that justified each.

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
