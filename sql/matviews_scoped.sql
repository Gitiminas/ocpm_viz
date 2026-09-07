-- ============================================================================
-- matviews_scoped.sql  —  the 23 views the OCPM viz tool needs. RUNNABLE AS-IS.
--
-- What this file is: the subset of a larger 49-view upstream dump that this tool
-- actually reads, already filtered, dependency-ordered, and with four hand patches:
-- two to mv_commit_pr_links (it used to read ocel_events, which is off-limits; and a
-- fourth detection method, push_order, added 2026-09-07) and one each to prs_identity and
-- issues_identity (a fallback for objects whose 'opened' event the corpus lacks,
-- 2026-09-07) — each in its banner.
--
-- The view selection is settled. Excluded on purpose: all ocel_* views, reviews,
-- labels, branches, forks, commit comments, and the ocel_events analytics views.
-- That scope decision is the one in docs/DATA_CONTRACT.md, which documents every
-- relation this file creates; §5 there lists what is deliberately not read.
--
-- This is server setup, not a step in running the tool. It was applied once, to the
-- server holding the corpus, and it is kept here as the record of what that database
-- was built with. There are no IF NOT EXISTS guards: re-running it against a database
-- that already has these views fails on the first CREATE.
--
-- It creates only the views. The base tables must already exist and be populated —
-- docs/DATA_CONTRACT.md §2 gives the shape of the three that are read (event, actor,
-- repo); a fourth, org, is present but unused.
--
--     psql -d <your_db> -f sql/matviews_scoped.sql
-- Section 1 creates all views empty (fast). Section 2 populates them in
-- dependency order (slow — minutes to hours depending on data size).
-- ============================================================================

-- ============================ SECTION 1: CREATE =============================


-- ---- issues_identity ----
-- issue identity: one row per issue, from its 'opened' event when the corpus has it, else
-- from any other IssuesEvent, else from an IssueCommentEvent on the issue.
--
-- PATCHED 2026-09-07, the same fallback as prs_identity (see its banner): the original read
-- the 'opened' event and nothing else, so an issue whose opening fell into an ingestion gap
-- had no identity row although its later events carry the same `issue` payload — id,
-- number and created_at. Measured before patching: issues seen in mv_issues_full with no
-- identity row react 1,144, kubernetes 4,054, vscode 11,304; seen in the issue-or-comment
-- activities MV 1,684 / 5,700 / 15,023. Priority: the 'opened' row (unchanged: same
-- issue_creation_event_id, same issue_created_at = the event's own time), then the earliest
-- other IssuesEvent, then the earliest IssueCommentEvent whose issue is not a pull request.
-- Fallback rows carry issue_creation_event_id NULL and the payload's created_at as naive
-- UTC; the two comment-stream conditions (not a PR, created_at present) exist because
-- IssueCommentEvent also fires on pull requests and a few old rows lack the field.
-- Measured after refresh (2026-09-07, this database): fallback rows react 1,684,
-- kubernetes 5,700, vscode 15,023 — exactly the activities MV's gap; validated issue↔PR
-- links 19,238 → 21,863 (+13.6%: every link view resolves the issue through this relation,
-- and a link to an issue with no identity row was dropped as missing_issue); fe.link_mat
-- 191,519 → 193,245; fe.diag_time_semantics: every former first_seen(activity) issue is
-- now created_at(payload).
--

CREATE MATERIALIZED VIEW public.issues_identity AS
 SELECT DISTINCT ON (repo_id, issue_id) repo_id,
    issue_id,
    issue_number,
    issue_creation_event_id,
    issue_created_at
   FROM ( SELECT event.repo_id,
            (((event.payload -> 'issue'::text) ->> 'id'::text))::bigint AS issue_id,
            (((event.payload -> 'issue'::text) ->> 'number'::text))::integer AS issue_number,
                CASE
                    WHEN ((event.type = 'IssuesEvent'::public.event_type) AND ((event.payload ->> 'action'::text) = 'opened'::text)) THEN event.id
                    ELSE NULL::bigint
                END AS issue_creation_event_id,
                CASE
                    WHEN ((event.type = 'IssuesEvent'::public.event_type) AND ((event.payload ->> 'action'::text) = 'opened'::text)) THEN event.created_at
                    ELSE ((((event.payload -> 'issue'::text) ->> 'created_at'::text))::timestamp with time zone AT TIME ZONE 'UTC'::text)
                END AS issue_created_at,
                CASE
                    WHEN ((event.type = 'IssuesEvent'::public.event_type) AND ((event.payload ->> 'action'::text) = 'opened'::text)) THEN 0
                    WHEN (event.type = 'IssuesEvent'::public.event_type) THEN 1
                    ELSE 2
                END AS priority,
            event.created_at AS event_created_at
           FROM public.event
          WHERE ((event.type = 'IssuesEvent'::public.event_type) OR ((event.type = 'IssueCommentEvent'::public.event_type) AND (((event.payload -> 'issue'::text) ->> 'created_at'::text) IS NOT NULL) AND (((event.payload -> 'issue'::text) -> 'pull_request'::text) IS NULL)))) s
  ORDER BY repo_id, issue_id, priority, event_created_at
  WITH NO DATA;

--
-- PostgreSQL database dump complete
--

-- public.mv_commit_comment_activities
--
-- PostgreSQL database dump
--

-- Dumped from database version 18.1 (Homebrew)
-- Dumped by pg_dump version 18.1 (Homebrew)

--


-- ---- prs_identity ----
-- PR identity: one row per PR, from its 'opened' event when the corpus has it, else from
-- any other PullRequestEvent row of that PR.
--
-- PATCHED 2026-09-07: the original read the 'opened' event and nothing else, so a pull
-- request whose opening fell into one of the corpus's ingestion gaps (facebook/react
-- #27024, id 1413026032: only its close, a review and a review comment survive; react has
-- no PullRequestEvent at all 2023-06-26..07-03) had no identity row although its later
-- events carry the same `pull_request` payload — id, number and created_at. Measured
-- before patching: 7,179 such PRs (react 760, kubernetes 4,556, vscode 1,863), every one
-- with created_at available from a later event. Ten link views join this relation; the
-- issue-comment detector inner-joins it and lost those PRs outright, the others left-join
-- it for pr_created_at and admitted 2,059 of 19,259 validated issue↔PR links without the
-- issue_created_after_pr test. Rows that HAVE an opened event are unchanged: same
-- pr_creation_event_id, same pr_created_at (the event's own time). Fallback rows carry
-- pr_creation_event_id NULL and the payload's created_at as naive UTC, so a consumer can
-- tell the two apart. Measured after refresh (2026-09-07, this database): fallback rows
-- react 777, kubernetes 4,595, vscode 1,863 (the raw table holds a few PRs the events MV's
-- window does not); validated issue↔PR links 19,259 → 19,238, the 21 leavers now failing
-- a plausibility test they could not be given before; links still lacking pr_created_at
-- 2,059 → 1,457, all of them proximity rows, which never carry it; issue-comment links
-- 83 → 84; fe.diag_time_semantics: every former first_seen(activity) PR is now
-- created_at(payload).
--

CREATE MATERIALIZED VIEW public.prs_identity AS
 SELECT DISTINCT ON (repo_id, pull_request_id) repo_id,
    pull_request_id,
    pr_number,
    pr_creation_event_id,
    pr_created_at
   FROM ( SELECT event.repo_id,
            (((event.payload -> 'pull_request'::text) ->> 'id'::text))::bigint AS pull_request_id,
            (((event.payload -> 'pull_request'::text) ->> 'number'::text))::integer AS pr_number,
                CASE
                    WHEN ((event.payload ->> 'action'::text) = 'opened'::text) THEN event.id
                    ELSE NULL::bigint
                END AS pr_creation_event_id,
                CASE
                    WHEN ((event.payload ->> 'action'::text) = 'opened'::text) THEN event.created_at
                    ELSE ((((event.payload -> 'pull_request'::text) ->> 'created_at'::text))::timestamp with time zone AT TIME ZONE 'UTC'::text)
                END AS pr_created_at,
            ((event.payload ->> 'action'::text) = 'opened'::text) AS is_opened,
            event.created_at AS event_created_at
           FROM public.event
          WHERE (event.type = 'PullRequestEvent'::public.event_type)) s
  ORDER BY repo_id, pull_request_id, is_opened DESC, event_created_at
  WITH NO DATA;

--
-- PostgreSQL database dump complete
--

-- public.mv_commit_message_issue_links_all
--
-- PostgreSQL database dump
--

-- Dumped from database version 18.1 (Homebrew)
-- Dumped by pg_dump version 18.1 (Homebrew)

--


-- ---- mv_issues_full ----
-- raw IssuesEvent rows, flattened
--

CREATE MATERIALIZED VIEW public.mv_issues_full AS
 SELECT id AS event_id,
    actor_id,
    repo_id,
    org_id,
    created_at AS event_created_at,
    public,
    (payload ->> 'action'::text) AS action,
    (((payload -> 'issue'::text) ->> 'id'::text))::bigint AS issue_id,
    (((payload -> 'issue'::text) ->> 'number'::text))::integer AS issue_number,
    ((payload -> 'issue'::text) ->> 'title'::text) AS issue_title,
    ((payload -> 'issue'::text) ->> 'body'::text) AS issue_body,
    ((payload -> 'issue'::text) ->> 'state'::text) AS issue_state,
    (((payload -> 'issue'::text) ->> 'created_at'::text))::timestamp with time zone AS issue_created_at,
    (((payload -> 'issue'::text) ->> 'updated_at'::text))::timestamp with time zone AS issue_updated_at,
    (((payload -> 'issue'::text) ->> 'closed_at'::text))::timestamp with time zone AS issue_closed_at,
    ((((payload -> 'issue'::text) -> 'user'::text) ->> 'id'::text))::bigint AS issue_creator_id,
    (((payload -> 'issue'::text) -> 'user'::text) ->> 'login'::text) AS issue_creator_login,
    ((((payload -> 'issue'::text) -> 'assignee'::text) ->> 'id'::text))::bigint AS assignee_id,
    (((payload -> 'issue'::text) -> 'assignee'::text) ->> 'login'::text) AS assignee_login,
    ((((payload -> 'issue'::text) -> 'milestone'::text) ->> 'id'::text))::bigint AS milestone_id,
    ((((payload -> 'issue'::text) -> 'milestone'::text) ->> 'number'::text))::integer AS milestone_number,
    (((payload -> 'issue'::text) -> 'milestone'::text) ->> 'title'::text) AS milestone_title,
    ((payload -> 'issue'::text) -> 'labels'::text) AS labels_json,
    ((payload -> 'issue'::text) -> 'assignees'::text) AS assignees_json
   FROM public.event e
  WHERE ((type = 'IssuesEvent'::public.event_type) AND (created_at >= '2015-01-01 01:00:00+01'::timestamp with time zone) AND (created_at < '2025-10-01 02:00:00+02'::timestamp with time zone))
  WITH NO DATA;

--
-- PostgreSQL database dump complete
--

-- public.mv_pr_review_comments_full
--
-- PostgreSQL database dump
--

-- Dumped from database version 18.1 (Homebrew)
-- Dumped by pg_dump version 18.1 (Homebrew)

--


-- ---- mv_issue_comments_full ----
-- raw IssueCommentEvent rows (issues AND PRs; is_pull_request flag)
--

CREATE MATERIALIZED VIEW public.mv_issue_comments_full AS
 SELECT id AS event_id,
    actor_id,
    repo_id,
    org_id,
    created_at AS event_created_at,
    public,
    (payload ->> 'action'::text) AS action,
        CASE
            WHEN (((payload -> 'issue'::text) -> 'pull_request'::text) IS NOT NULL) THEN true
            ELSE false
        END AS is_pull_request,
    (((payload -> 'comment'::text) ->> 'id'::text))::bigint AS comment_id,
    ((payload -> 'comment'::text) ->> 'body'::text) AS comment_body,
    (((payload -> 'comment'::text) ->> 'created_at'::text))::timestamp with time zone AS comment_created_at,
    (((payload -> 'comment'::text) ->> 'updated_at'::text))::timestamp with time zone AS comment_updated_at,
    ((payload -> 'comment'::text) ->> 'html_url'::text) AS comment_html_url,
    ((payload -> 'comment'::text) ->> 'author_association'::text) AS comment_author_association,
    ((((payload -> 'comment'::text) -> 'user'::text) ->> 'id'::text))::bigint AS comment_user_id,
    (((payload -> 'comment'::text) -> 'user'::text) ->> 'login'::text) AS comment_user_login,
    ((((payload -> 'comment'::text) -> 'user'::text) ->> 'site_admin'::text))::boolean AS comment_user_is_site_admin,
    (((payload -> 'issue'::text) ->> 'id'::text))::bigint AS issue_id,
    (((payload -> 'issue'::text) ->> 'number'::text))::integer AS issue_number,
    ((payload -> 'issue'::text) ->> 'title'::text) AS issue_title,
    ((payload -> 'issue'::text) ->> 'state'::text) AS issue_state,
    (((payload -> 'issue'::text) ->> 'comments'::text))::integer AS issue_comment_count,
    ((((payload -> 'issue'::text) -> 'user'::text) ->> 'id'::text))::bigint AS issue_creator_id,
    (((payload -> 'issue'::text) -> 'user'::text) ->> 'login'::text) AS issue_creator_login,
    ((((payload -> 'issue'::text) -> 'assignee'::text) ->> 'id'::text))::bigint AS issue_assignee_id,
    (((payload -> 'issue'::text) -> 'assignee'::text) ->> 'login'::text) AS issue_assignee_login,
    ((payload -> 'issue'::text) -> 'labels'::text) AS issue_labels_json,
    ((payload -> 'issue'::text) -> 'assignees'::text) AS issue_assignees_json,
    (((payload -> 'issue'::text) -> 'pull_request'::text) ->> 'url'::text) AS pr_api_url,
    (((payload -> 'issue'::text) -> 'pull_request'::text) ->> 'html_url'::text) AS pr_html_url
   FROM public.event e
  WHERE ((type = 'IssueCommentEvent'::public.event_type) AND (created_at >= '2015-01-01 01:00:00+01'::timestamp with time zone) AND (created_at < '2025-10-01 02:00:00+02'::timestamp with time zone))
  WITH NO DATA;

--
-- PostgreSQL database dump complete
--

-- public.mv_issue_pr_labels_full
--
-- PostgreSQL database dump
--

-- Dumped from database version 18.1 (Homebrew)
-- Dumped by pg_dump version 18.1 (Homebrew)

--


-- ---- mv_pull_request_events_full ----
-- raw PullRequestEvent rows, flattened
--

CREATE MATERIALIZED VIEW public.mv_pull_request_events_full AS
 WITH pr_events AS (
         SELECT e.id AS event_id,
            e.actor_id,
            e.repo_id,
            e.org_id,
            e.created_at AS event_created_at,
            (e.payload ->> 'action'::text) AS action,
            ((e.payload ->> 'number'::text))::integer AS pr_number,
            (((e.payload -> 'pull_request'::text) ->> 'id'::text))::bigint AS pull_request_id,
            ((e.payload -> 'pull_request'::text) ->> 'title'::text) AS pr_title,
            ((e.payload -> 'pull_request'::text) ->> 'body'::text) AS pr_body,
            ((e.payload -> 'pull_request'::text) ->> 'state'::text) AS pr_state,
            (((e.payload -> 'pull_request'::text) ->> 'draft'::text))::boolean AS pr_is_draft,
            (((e.payload -> 'pull_request'::text) ->> 'merged'::text))::boolean AS pr_is_merged,
            (((e.payload -> 'pull_request'::text) ->> 'created_at'::text))::timestamp with time zone AS pr_created_at,
            (((e.payload -> 'pull_request'::text) ->> 'updated_at'::text))::timestamp with time zone AS pr_updated_at,
            (((e.payload -> 'pull_request'::text) ->> 'closed_at'::text))::timestamp with time zone AS pr_closed_at,
            (((e.payload -> 'pull_request'::text) ->> 'merged_at'::text))::timestamp with time zone AS pr_merged_at,
            ((((e.payload -> 'pull_request'::text) -> 'user'::text) ->> 'id'::text))::bigint AS author_id,
            (((e.payload -> 'pull_request'::text) -> 'user'::text) ->> 'login'::text) AS author_login,
            (((e.payload -> 'pull_request'::text) -> 'user'::text) ->> 'html_url'::text) AS author_url,
            ((e.payload -> 'pull_request'::text) ->> 'author_association'::text) AS author_association,
            ((((e.payload -> 'pull_request'::text) -> 'assignee'::text) ->> 'id'::text))::bigint AS assignee_id,
            (((e.payload -> 'pull_request'::text) -> 'assignee'::text) ->> 'login'::text) AS assignee_login,
            (((e.payload -> 'pull_request'::text) -> 'base'::text) ->> 'ref'::text) AS base_ref,
            (((e.payload -> 'pull_request'::text) -> 'base'::text) ->> 'sha'::text) AS base_sha,
            (((((e.payload -> 'pull_request'::text) -> 'base'::text) -> 'repo'::text) ->> 'id'::text))::bigint AS base_repo_id,
            ((((e.payload -> 'pull_request'::text) -> 'base'::text) -> 'repo'::text) ->> 'full_name'::text) AS base_repo_full_name,
            (((e.payload -> 'pull_request'::text) -> 'head'::text) ->> 'ref'::text) AS head_ref,
            (((e.payload -> 'pull_request'::text) -> 'head'::text) ->> 'sha'::text) AS head_sha,
            (((((e.payload -> 'pull_request'::text) -> 'head'::text) -> 'repo'::text) ->> 'id'::text))::bigint AS head_repo_id,
            ((((e.payload -> 'pull_request'::text) -> 'head'::text) -> 'repo'::text) ->> 'full_name'::text) AS head_repo_full_name,
            ((e.payload -> 'pull_request'::text) ->> 'merge_commit_sha'::text) AS merge_commit_sha,
            ((e.payload -> 'pull_request'::text) -> 'labels'::text) AS labels_json,
            ((e.payload -> 'pull_request'::text) -> 'assignees'::text) AS assignees_json
           FROM public.event e
          WHERE ((e.type = 'PullRequestEvent'::public.event_type) AND (e.created_at >= '2015-01-01 01:00:00+01'::timestamp with time zone) AND (e.created_at < '2025-10-01 02:00:00+02'::timestamp with time zone))
        )
 SELECT event_id,
    actor_id,
    repo_id,
    org_id,
    event_created_at,
    action,
    pr_number,
    pull_request_id,
    pr_title,
    pr_body,
    pr_state,
    pr_is_draft,
    pr_is_merged,
    pr_created_at,
    pr_updated_at,
    pr_closed_at,
    pr_merged_at,
    author_id,
    author_login,
    author_url,
    author_association,
    assignee_id,
    assignee_login,
    base_ref,
    base_sha,
    base_repo_id,
    base_repo_full_name,
    head_ref,
    head_sha,
    head_repo_id,
    head_repo_full_name,
    merge_commit_sha,
    labels_json,
    assignees_json,
        CASE
            WHEN (head_repo_id IS NULL) THEN NULL::boolean
            ELSE (head_repo_id <> base_repo_id)
        END AS is_fork_pr,
        CASE
            WHEN (head_repo_id IS NULL) THEN 'unknown_head_deleted'::text
            WHEN (head_repo_id = base_repo_id) THEN 'same_repo'::text
            ELSE 'fork'::text
        END AS pr_origin
   FROM pr_events
  WITH NO DATA;

--
-- PostgreSQL database dump complete
--

-- public.mv_push_activities
--
-- PostgreSQL database dump
--

-- Dumped from database version 18.1 (Homebrew)
-- Dumped by pg_dump version 18.1 (Homebrew)

--


-- ---- mv_pull_request_comments_full ----
-- raw IssueCommentEvent rows where the 'issue' is a PR
--

CREATE MATERIALIZED VIEW public.mv_pull_request_comments_full AS
 SELECT id AS event_id,
    actor_id,
    repo_id,
    org_id,
    created_at AS event_created_at,
    public,
    (payload ->> 'action'::text) AS action,
    (((payload -> 'comment'::text) ->> 'id'::text))::bigint AS comment_id,
    ((payload -> 'comment'::text) ->> 'body'::text) AS comment_body,
    (((payload -> 'comment'::text) ->> 'created_at'::text))::timestamp with time zone AS comment_created_at,
    (((payload -> 'comment'::text) ->> 'updated_at'::text))::timestamp with time zone AS comment_updated_at,
    ((payload -> 'comment'::text) ->> 'html_url'::text) AS comment_html_url,
    ((payload -> 'comment'::text) ->> 'author_association'::text) AS comment_author_association,
    ((((payload -> 'comment'::text) -> 'user'::text) ->> 'id'::text))::bigint AS comment_user_id,
    (((payload -> 'comment'::text) -> 'user'::text) ->> 'login'::text) AS comment_user_login,
    ((((payload -> 'comment'::text) -> 'user'::text) ->> 'site_admin'::text))::boolean AS comment_user_is_site_admin,
    (((payload -> 'issue'::text) ->> 'id'::text))::bigint AS issue_id,
    (((payload -> 'issue'::text) ->> 'number'::text))::integer AS pr_number,
    ((payload -> 'issue'::text) ->> 'title'::text) AS pr_title,
    ((payload -> 'issue'::text) ->> 'state'::text) AS pr_state,
    (((payload -> 'issue'::text) ->> 'comments'::text))::integer AS pr_comment_count,
    ((((payload -> 'issue'::text) -> 'user'::text) ->> 'id'::text))::bigint AS pr_creator_id,
    (((payload -> 'issue'::text) -> 'user'::text) ->> 'login'::text) AS pr_creator_login,
    ((((payload -> 'issue'::text) -> 'assignee'::text) ->> 'id'::text))::bigint AS pr_assignee_id,
    (((payload -> 'issue'::text) -> 'assignee'::text) ->> 'login'::text) AS pr_assignee_login,
    ((payload -> 'issue'::text) -> 'labels'::text) AS pr_labels_json,
    ((payload -> 'issue'::text) -> 'assignees'::text) AS pr_assignees_json,
    (((payload -> 'issue'::text) -> 'pull_request'::text) ->> 'url'::text) AS pr_api_url,
    (((payload -> 'issue'::text) -> 'pull_request'::text) ->> 'html_url'::text) AS pr_html_url
   FROM public.event e
  WHERE ((type = 'IssueCommentEvent'::public.event_type) AND (((payload -> 'issue'::text) -> 'pull_request'::text) IS NOT NULL) AND (created_at >= '2015-01-01 01:00:00+01'::timestamp with time zone) AND (created_at < '2025-10-01 02:00:00+02'::timestamp with time zone))
  WITH NO DATA;

--
-- PostgreSQL database dump complete
--

-- public.mv_pull_request_events_full
--
-- PostgreSQL database dump
--

-- Dumped from database version 18.1 (Homebrew)
-- Dumped by pg_dump version 18.1 (Homebrew)

--


-- ---- mv_push_commits_full ----
-- PushEvent exploded: one row per commit (max 20 per push - GH Archive cap)
--

CREATE MATERIALIZED VIEW public.mv_push_commits_full AS
 SELECT e.id AS event_id,
    e.created_at,
    e.actor_id,
    e.repo_id,
    e.org_id,
    ((e.payload ->> 'push_id'::text))::bigint AS push_id,
    (e.payload ->> 'ref'::text) AS ref,
    (e.payload ->> 'before'::text) AS before,
    (e.payload ->> 'head'::text) AS head,
    ((e.payload ->> 'size'::text))::integer AS size,
    ((e.payload ->> 'distinct_size'::text))::integer AS distinct_size,
    (c.value ->> 'sha'::text) AS commit_sha,
    (c.value ->> 'url'::text) AS commit_url,
    (c.value ->> 'message'::text) AS commit_message,
    ((c.value -> 'author'::text) ->> 'name'::text) AS commit_author_name,
    ((c.value -> 'author'::text) ->> 'email'::text) AS commit_author_email,
    ((c.value ->> 'distinct'::text))::boolean AS commit_distinct,
    (c.ordinality)::integer AS commit_index
   FROM (public.event e
     JOIN LATERAL jsonb_array_elements((e.payload -> 'commits'::text)) WITH ORDINALITY c(value, ordinality) ON (true))
  WHERE ((e.type = 'PushEvent'::public.event_type) AND (e.created_at >= '2015-01-01 01:00:00+01'::timestamp with time zone) AND (e.created_at < '2025-10-01 02:00:00+02'::timestamp with time zone))
  WITH NO DATA;

--
-- PostgreSQL database dump complete
--

-- public.ocel_repos
--
-- PostgreSQL database dump
--

-- Dumped from database version 18.1 (Homebrew)
-- Dumped by pg_dump version 18.1 (Homebrew)

--


-- ---- mv_push_activities ----
-- one row per push, with commit_count and the truncated flag
--

CREATE MATERIALIZED VIEW public.mv_push_activities AS
 SELECT id AS activity_id,
    created_at AS activity_timestamp,
    'push'::text AS object_type,
    ((payload ->> 'push_id'::text))::bigint AS object_id,
    (payload ->> 'push_id'::text) AS object_key,
    'CommitsPushed'::text AS activity_type,
    actor_id AS actor_user_id,
    repo_id,
    org_id,
    ((payload ->> 'push_id'::text))::bigint AS push_id,
    (payload ->> 'ref'::text) AS ref,
    ((payload ->> 'size'::text))::integer AS commit_count,
    ((payload ->> 'distinct_size'::text))::integer AS distinct_commit_count,
    jsonb_strip_nulls(jsonb_build_object('before', (payload ->> 'before'::text), 'head', (payload ->> 'head'::text), 'size', ((payload ->> 'size'::text))::integer, 'distinct_size', ((payload ->> 'distinct_size'::text))::integer, 'truncated',
        CASE
            WHEN (((payload ->> 'size'::text))::integer > 20) THEN true
            ELSE false
        END)) AS activity_payload
   FROM public.event e
  WHERE ((type = 'PushEvent'::public.event_type) AND (created_at >= '2015-01-01 01:00:00+01'::timestamp with time zone) AND (created_at < '2025-10-01 02:00:00+02'::timestamp with time zone))
  WITH NO DATA;

--
-- PostgreSQL database dump complete
--

-- public.mv_push_commits_full
--
-- PostgreSQL database dump
--

-- Dumped from database version 18.1 (Homebrew)
-- Dumped by pg_dump version 18.1 (Homebrew)

--


-- ---- mv_issue_id_to_number ----
-- small id<->number lookup
--

CREATE MATERIALIZED VIEW public.mv_issue_id_to_number AS
 SELECT DISTINCT ON (repo_id, issue_id) repo_id,
    issue_id,
    issue_number
   FROM public.mv_issues_full
  WHERE ((issue_id IS NOT NULL) AND (issue_number IS NOT NULL))
  ORDER BY repo_id, issue_id, event_created_at
  WITH NO DATA;

--
-- PostgreSQL database dump complete
--

-- public.mv_issue_pr_label_membership
--
-- PostgreSQL database dump
--

-- Dumped from database version 18.1 (Homebrew)
-- Dumped by pg_dump version 18.1 (Homebrew)

--


-- ---- mv_pr_offplatform_merges ----
-- DEPENDENCY ONLY - do not consume. The PR activities view joins it. Rows it flags produce the activity label 'PullRequestMergedOffPlatform', which the tool REMAPS to 'PullRequestClosed' (heuristic ruled out of scope)
--

CREATE MATERIALIZED VIEW public.mv_pr_offplatform_merges AS
 WITH closed_unmerged AS (
         SELECT DISTINCT ON (p.repo_id, p.pull_request_id) p.repo_id,
            p.pull_request_id,
            p.pr_number,
            p.base_ref,
            p.event_created_at AS pr_closed_at,
            p.actor_id AS closer_actor_id
           FROM public.mv_pull_request_events_full p
          WHERE ((p.action = 'closed'::text) AND (COALESCE(p.pr_is_merged, false) = false))
          ORDER BY p.repo_id, p.pull_request_id, p.event_created_at DESC
        ), ever_merged AS (
         SELECT DISTINCT mv_pull_request_events_full.repo_id,
            mv_pull_request_events_full.pull_request_id
           FROM public.mv_pull_request_events_full
          WHERE ((mv_pull_request_events_full.action = 'closed'::text) AND (COALESCE(mv_pull_request_events_full.pr_is_merged, false) = true))
        ), push_pr_refs AS (
         SELECT pc.repo_id,
            pc.ref,
            pc.created_at AS pushed_at,
            pc.commit_sha,
            pc.push_id,
            pc.actor_id AS pusher_actor_id,
            (m.m[1])::integer AS ref_number,
            'gh_prefix'::text AS link_convention
           FROM (public.mv_push_commits_full pc
             CROSS JOIN LATERAL regexp_matches(pc.commit_message, '(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+gh-(\d+)'::text, 'gi'::text) m(m))
          WHERE (pc.commit_message ~* '(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+gh-\d+'::text)
        UNION ALL
         SELECT pc.repo_id,
            pc.ref,
            pc.created_at,
            pc.commit_sha,
            pc.push_id,
            pc.actor_id,
            (m.m[1])::integer AS m,
            'merge_title'::text AS text
           FROM (public.mv_push_commits_full pc
             CROSS JOIN LATERAL regexp_matches(pc.commit_message, '(?:bug|feature|minor)\s+#(\d+)'::text, 'gi'::text) m(m))
          WHERE (pc.commit_message ~* '(?:bug|feature|minor)\s+#\d+'::text)
        UNION ALL
         SELECT pc.repo_id,
            pc.ref,
            pc.created_at,
            pc.commit_sha,
            pc.push_id,
            pc.actor_id,
            (m.m[1])::integer AS m,
            'standard'::text AS text
           FROM (public.mv_push_commits_full pc
             CROSS JOIN LATERAL regexp_matches(pc.commit_message, '(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s*#(\d+)'::text, 'gi'::text) m(m))
          WHERE (pc.commit_message ~* '(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s*#\d+'::text)
        ), matched AS (
         SELECT cu.repo_id,
            cu.pull_request_id,
            cu.pr_number,
            cu.base_ref,
            cu.pr_closed_at,
            cu.closer_actor_id,
            pr.commit_sha,
            pr.push_id,
            pr.pushed_at,
            pr.pusher_actor_id,
            pr.link_convention,
            EXTRACT(epoch FROM (pr.pushed_at - cu.pr_closed_at)) AS delta_seconds
           FROM ((closed_unmerged cu
             JOIN push_pr_refs pr ON (((pr.repo_id = cu.repo_id) AND (pr.ref_number = cu.pr_number) AND (pr.ref = ('refs/heads/'::text || cu.base_ref)) AND (pr.pushed_at >= (cu.pr_closed_at - '00:15:00'::interval)) AND (pr.pushed_at <= (cu.pr_closed_at + '00:15:00'::interval)))))
             LEFT JOIN ever_merged em ON (((em.repo_id = cu.repo_id) AND (em.pull_request_id = cu.pull_request_id))))
          WHERE (em.pull_request_id IS NULL)
        )
 SELECT DISTINCT ON (repo_id, pull_request_id) repo_id,
    pull_request_id,
    pr_number,
    base_ref,
    pr_closed_at,
    closer_actor_id,
    commit_sha AS delivering_commit_sha,
    push_id,
    pushed_at,
    pusher_actor_id,
    delta_seconds,
    link_convention,
    'heuristic'::text AS link_kind,
    'offplatform_commit_message'::text AS link_method
   FROM matched
  ORDER BY repo_id, pull_request_id, (abs(delta_seconds)), link_convention, pushed_at
  WITH NO DATA;

--
-- PostgreSQL database dump complete
--

-- public.mv_pr_review_activities
--
-- PostgreSQL database dump
--

-- Dumped from database version 18.1 (Homebrew)
-- Dumped by pg_dump version 18.1 (Homebrew)

--


-- ---- mv_issue_and_issuecomment_activities_full ----
-- ACTIVITY STREAM: issue lifecycle + issue comments
--

CREATE MATERIALIZED VIEW public.mv_issue_and_issuecomment_activities_full AS
 WITH issue_activity_labels_timeline AS (
         SELECT f.event_id,
            f.repo_id,
            f.actor_id,
            f.issue_id,
            f.issue_number,
                CASE
                    WHEN (f.action = 'opened'::text) THEN 'IssueOpened'::text
                    WHEN (f.action = 'reopened'::text) THEN 'IssueReopened'::text
                    WHEN (f.action = 'closed'::text) THEN 'IssueClosed'::text
                    WHEN (f.action = 'edited'::text) THEN 'IssueEdited'::text
                    WHEN (f.action = 'labeled'::text) THEN 'IssueLabeled'::text
                    WHEN (f.action = 'unlabeled'::text) THEN 'IssueUnlabeled'::text
                    WHEN (f.action = 'assigned'::text) THEN 'IssueAssigned'::text
                    WHEN (f.action = 'unassigned'::text) THEN 'IssueUnassigned'::text
                    WHEN (f.action = 'milestoned'::text) THEN 'IssueMilestoned'::text
                    WHEN (f.action = 'demilestoned'::text) THEN 'IssueDemilestoned'::text
                    WHEN (f.action = 'locked'::text) THEN 'IssueLocked'::text
                    WHEN (f.action = 'unlocked'::text) THEN 'IssueUnlocked'::text
                    WHEN (f.action = 'pinned'::text) THEN 'IssuePinned'::text
                    WHEN (f.action = 'unpinned'::text) THEN 'IssueUnpinned'::text
                    WHEN (f.action = 'transferred'::text) THEN 'IssueTransferred'::text
                    ELSE concat('Issue_', f.action)
                END AS activity_type,
            f.event_created_at AS activity_timestamp,
            string_agg((elem.value ->> 'name'::text), ';'::text) AS labels
           FROM (public.mv_issues_full f
             LEFT JOIN LATERAL jsonb_array_elements(
                CASE
                    WHEN (f.labels_json IS NOT NULL) THEN f.labels_json
                    ELSE '[]'::jsonb
                END) elem(value) ON (true))
          GROUP BY f.event_id, f.repo_id, f.actor_id, f.issue_id, f.issue_number, f.action, f.event_created_at
        UNION ALL
         SELECT c.event_id,
            c.repo_id,
            c.actor_id,
            c.issue_id,
            c.issue_number,
                CASE
                    WHEN (c.action = 'created'::text) THEN 'IssueCommented'::text
                    WHEN (c.action = 'edited'::text) THEN 'IssueCommentEdited'::text
                    WHEN (c.action = 'deleted'::text) THEN 'IssueCommentDeleted'::text
                    ELSE concat('IssueComment_', c.action)
                END AS concat,
            c.event_created_at,
            string_agg((elem.value ->> 'name'::text), ';'::text) AS string_agg
           FROM (public.mv_issue_comments_full c
             LEFT JOIN LATERAL jsonb_array_elements(
                CASE
                    WHEN ((c.issue_labels_json IS NOT NULL) AND (jsonb_typeof(c.issue_labels_json) = 'array'::text)) THEN c.issue_labels_json
                    ELSE '[]'::jsonb
                END) elem(value) ON (true))
          WHERE (c.is_pull_request = false)
          GROUP BY c.event_id, c.repo_id, c.actor_id, c.issue_id, c.issue_number, c.action, c.event_created_at
        ), issue_activity_labels_with_lag AS (
         SELECT t.event_id,
            t.repo_id,
            t.actor_id,
            t.issue_id,
            t.issue_number,
            t.activity_timestamp,
            t.activity_type,
            t.labels,
            lag(t.labels) OVER (PARTITION BY t.repo_id, t.issue_number ORDER BY t.activity_timestamp) AS previous_labels,
            row_number() OVER (PARTITION BY t.repo_id, t.issue_number ORDER BY t.activity_timestamp) AS activity_order
           FROM issue_activity_labels_timeline t
        ), issue_activity_assignees_timeline AS (
         SELECT f.event_id,
            f.repo_id,
            f.actor_id,
            f.issue_id,
            f.issue_number,
                CASE
                    WHEN (f.action = 'opened'::text) THEN 'IssueOpened'::text
                    WHEN (f.action = 'reopened'::text) THEN 'IssueReopened'::text
                    WHEN (f.action = 'closed'::text) THEN 'IssueClosed'::text
                    WHEN (f.action = 'edited'::text) THEN 'IssueEdited'::text
                    WHEN (f.action = 'labeled'::text) THEN 'IssueLabeled'::text
                    WHEN (f.action = 'unlabeled'::text) THEN 'IssueUnlabeled'::text
                    WHEN (f.action = 'assigned'::text) THEN 'IssueAssigned'::text
                    WHEN (f.action = 'unassigned'::text) THEN 'IssueUnassigned'::text
                    WHEN (f.action = 'milestoned'::text) THEN 'IssueMilestoned'::text
                    WHEN (f.action = 'demilestoned'::text) THEN 'IssueDemilestoned'::text
                    WHEN (f.action = 'locked'::text) THEN 'IssueLocked'::text
                    WHEN (f.action = 'unlocked'::text) THEN 'IssueUnlocked'::text
                    WHEN (f.action = 'pinned'::text) THEN 'IssuePinned'::text
                    WHEN (f.action = 'unpinned'::text) THEN 'IssueUnpinned'::text
                    WHEN (f.action = 'transferred'::text) THEN 'IssueTransferred'::text
                    ELSE concat('Issue_', f.action)
                END AS activity_type,
            f.event_created_at AS activity_timestamp,
            string_agg((elem.value ->> 'login'::text), ';'::text) AS assignees
           FROM (public.mv_issues_full f
             LEFT JOIN LATERAL jsonb_array_elements(
                CASE
                    WHEN (f.assignees_json IS NOT NULL) THEN f.assignees_json
                    ELSE '[]'::jsonb
                END) elem(value) ON (true))
          GROUP BY f.event_id, f.repo_id, f.actor_id, f.issue_id, f.issue_number, f.action, f.event_created_at
        UNION ALL
         SELECT c.event_id,
            c.repo_id,
            c.actor_id,
            c.issue_id,
            c.issue_number,
                CASE
                    WHEN (c.action = 'created'::text) THEN 'IssueCommented'::text
                    WHEN (c.action = 'edited'::text) THEN 'IssueCommentEdited'::text
                    WHEN (c.action = 'deleted'::text) THEN 'IssueCommentDeleted'::text
                    ELSE concat('IssueComment_', c.action)
                END AS concat,
            c.event_created_at,
            string_agg((elem.value ->> 'login'::text), ';'::text) AS string_agg
           FROM (public.mv_issue_comments_full c
             LEFT JOIN LATERAL jsonb_array_elements(
                CASE
                    WHEN ((c.issue_assignees_json IS NOT NULL) AND (jsonb_typeof(c.issue_assignees_json) = 'array'::text)) THEN c.issue_assignees_json
                    ELSE '[]'::jsonb
                END) elem(value) ON (true))
          WHERE (c.is_pull_request = false)
          GROUP BY c.event_id, c.repo_id, c.actor_id, c.issue_id, c.issue_number, c.action, c.event_created_at
        ), issue_activity_assignees_with_lag AS (
         SELECT t.event_id,
            t.repo_id,
            t.actor_id,
            t.issue_id,
            t.issue_number,
            t.activity_timestamp,
            t.activity_type,
            t.assignees,
            lag(t.assignees) OVER (PARTITION BY t.repo_id, t.issue_number ORDER BY t.activity_timestamp) AS previous_assignees,
            row_number() OVER (PARTITION BY t.repo_id, t.issue_number ORDER BY t.activity_timestamp) AS activity_order
           FROM issue_activity_assignees_timeline t
        )
 SELECT la.event_id,
    la.repo_id,
    la.actor_id,
    la.issue_id,
    la.issue_number,
    la.activity_timestamp,
    la.activity_type,
    la.labels,
    la.previous_labels,
    la.activity_order,
        CASE
            WHEN ((la.labels <> la.previous_labels) AND (la.activity_order > 1)) THEN 'yes'::text
            ELSE 'no'::text
        END AS if_labels_change,
    ass.assignees,
    ass.previous_assignees,
        CASE
            WHEN ((ass.assignees <> ass.previous_assignees) AND (ass.activity_order > 1)) THEN 'yes'::text
            ELSE 'no'::text
        END AS if_assignees_change
   FROM (issue_activity_labels_with_lag la
     LEFT JOIN issue_activity_assignees_with_lag ass ON (((la.event_id = ass.event_id) AND (la.repo_id = ass.repo_id))))
  WITH NO DATA;

--
-- PostgreSQL database dump complete
--

-- public.mv_issue_id_to_number
--
-- PostgreSQL database dump
--

-- Dumped from database version 18.1 (Homebrew)
-- Dumped by pg_dump version 18.1 (Homebrew)

--


-- ---- mv_pull_request_and_comment_activities_full ----
-- ACTIVITY STREAM: PR lifecycle + PR comments. NB: on comment rows, pull_request_id is suspect (issue_id aliased) - join via (repo_id, pr_number)
--

CREATE MATERIALIZED VIEW public.mv_pull_request_and_comment_activities_full AS
 WITH pr_activity_labels_timeline AS (
         SELECT p.event_id,
            p.repo_id,
            p.actor_id,
            p.org_id,
            p.pull_request_id,
            p.pr_number,
                CASE
                    WHEN (p.action = 'opened'::text) THEN 'PullRequestOpened'::text
                    WHEN (p.action = 'reopened'::text) THEN 'PullRequestReopened'::text
                    WHEN ((p.action = 'closed'::text) AND COALESCE(p.pr_is_merged, false)) THEN 'PullRequestMerged'::text
                    WHEN ((p.action = 'closed'::text) AND (op.pull_request_id IS NOT NULL)) THEN 'PullRequestMergedOffPlatform'::text
                    WHEN (p.action = 'closed'::text) THEN 'PullRequestClosed'::text
                    WHEN (p.action = 'edited'::text) THEN 'PullRequestEdited'::text
                    WHEN (p.action = 'synchronize'::text) THEN 'PullRequestSynchronized'::text
                    WHEN (p.action = 'ready_for_review'::text) THEN 'PullRequestReadyForReview'::text
                    WHEN (p.action = 'converted_to_draft'::text) THEN 'PullRequestConvertedToDraft'::text
                    WHEN (p.action = 'review_requested'::text) THEN 'PullRequestReviewRequested'::text
                    WHEN (p.action = 'review_request_removed'::text) THEN 'PullRequestReviewRequestRemoved'::text
                    WHEN (p.action = 'labeled'::text) THEN 'PullRequestLabeled'::text
                    WHEN (p.action = 'unlabeled'::text) THEN 'PullRequestUnlabeled'::text
                    WHEN (p.action = 'assigned'::text) THEN 'PullRequestAssigned'::text
                    WHEN (p.action = 'unassigned'::text) THEN 'PullRequestUnassigned'::text
                    WHEN (p.action = 'locked'::text) THEN 'PullRequestLocked'::text
                    WHEN (p.action = 'unlocked'::text) THEN 'PullRequestUnlocked'::text
                    WHEN (p.action = 'milestoned'::text) THEN 'PullRequestMilestoned'::text
                    WHEN (p.action = 'demilestoned'::text) THEN 'PullRequestDemilestoned'::text
                    WHEN (p.action = 'enqueued'::text) THEN 'PullRequestEnqueued'::text
                    WHEN (p.action = 'dequeued'::text) THEN 'PullRequestDequeued'::text
                    WHEN (p.action = 'auto_merge_enabled'::text) THEN 'PullRequestAutoMergeEnabled'::text
                    WHEN (p.action = 'auto_merge_disabled'::text) THEN 'PullRequestAutoMergeDisabled'::text
                    ELSE concat('PullRequest_', p.action)
                END AS activity_type,
            p.event_created_at AS activity_timestamp,
            p.author_id AS author_user_id,
            p.head_sha,
            p.base_ref,
            p.head_ref,
            p.merge_commit_sha,
            string_agg((elem.value ->> 'name'::text), ';'::text) AS labels
           FROM ((public.mv_pull_request_events_full p
             LEFT JOIN public.mv_pr_offplatform_merges op ON (((op.repo_id = p.repo_id) AND (op.pull_request_id = p.pull_request_id) AND (op.pr_closed_at = p.event_created_at) AND (p.action = 'closed'::text))))
             LEFT JOIN LATERAL jsonb_array_elements(
                CASE
                    WHEN ((p.labels_json IS NOT NULL) AND (jsonb_typeof(p.labels_json) = 'array'::text)) THEN p.labels_json
                    ELSE '[]'::jsonb
                END) elem(value) ON (true))
          GROUP BY p.event_id, p.repo_id, p.actor_id, p.org_id, p.pull_request_id, p.pr_number, p.action, p.pr_is_merged, op.pull_request_id, p.event_created_at, p.author_id, p.head_sha, p.base_ref, p.head_ref, p.merge_commit_sha
        UNION ALL
         SELECT c.event_id,
            c.repo_id,
            c.actor_id,
            c.org_id,
            c.issue_id AS pull_request_id,
            c.pr_number,
                CASE
                    WHEN (c.action = 'created'::text) THEN 'PullRequestCommented'::text
                    WHEN (c.action = 'edited'::text) THEN 'PullRequestCommentEdited'::text
                    WHEN (c.action = 'deleted'::text) THEN 'PullRequestCommentDeleted'::text
                    ELSE concat('PullRequestComment_', c.action)
                END AS concat,
            c.event_created_at,
            NULL::bigint AS int8,
            NULL::text AS text,
            NULL::text AS text,
            NULL::text AS text,
            NULL::text AS text,
            string_agg((elem.value ->> 'name'::text), ';'::text) AS string_agg
           FROM (public.mv_pull_request_comments_full c
             LEFT JOIN LATERAL jsonb_array_elements(
                CASE
                    WHEN ((c.pr_labels_json IS NOT NULL) AND (jsonb_typeof(c.pr_labels_json) = 'array'::text)) THEN c.pr_labels_json
                    ELSE '[]'::jsonb
                END) elem(value) ON (true))
          GROUP BY c.event_id, c.repo_id, c.actor_id, c.org_id, c.issue_id, c.pr_number, c.action, c.event_created_at
        ), pr_activity_labels_with_lag AS (
         SELECT t.event_id,
            t.repo_id,
            t.actor_id,
            t.org_id,
            t.pull_request_id,
            t.pr_number,
            t.activity_type,
            t.activity_timestamp,
            t.author_user_id,
            t.head_sha,
            t.base_ref,
            t.head_ref,
            t.merge_commit_sha,
            t.labels,
            lag(t.labels) OVER (PARTITION BY t.repo_id, t.pr_number ORDER BY t.activity_timestamp) AS previous_labels,
            row_number() OVER (PARTITION BY t.repo_id, t.pr_number ORDER BY t.activity_timestamp) AS activity_order
           FROM pr_activity_labels_timeline t
        ), pr_activity_assignees_timeline AS (
         SELECT p.event_id,
            p.repo_id,
            p.pr_number,
            p.event_created_at AS activity_timestamp,
            string_agg((elem.value ->> 'login'::text), ';'::text) AS assignees
           FROM (public.mv_pull_request_events_full p
             LEFT JOIN LATERAL jsonb_array_elements(
                CASE
                    WHEN ((p.assignees_json IS NOT NULL) AND (jsonb_typeof(p.assignees_json) = 'array'::text)) THEN p.assignees_json
                    ELSE '[]'::jsonb
                END) elem(value) ON (true))
          GROUP BY p.event_id, p.repo_id, p.pr_number, p.event_created_at
        UNION ALL
         SELECT c.event_id,
            c.repo_id,
            c.pr_number,
            c.event_created_at,
            string_agg((elem.value ->> 'login'::text), ';'::text) AS string_agg
           FROM (public.mv_pull_request_comments_full c
             LEFT JOIN LATERAL jsonb_array_elements(
                CASE
                    WHEN ((c.pr_assignees_json IS NOT NULL) AND (jsonb_typeof(c.pr_assignees_json) = 'array'::text)) THEN c.pr_assignees_json
                    ELSE '[]'::jsonb
                END) elem(value) ON (true))
          GROUP BY c.event_id, c.repo_id, c.pr_number, c.event_created_at
        ), pr_activity_assignees_with_lag AS (
         SELECT t.event_id,
            t.repo_id,
            t.pr_number,
            t.activity_timestamp,
            t.assignees,
            lag(t.assignees) OVER (PARTITION BY t.repo_id, t.pr_number ORDER BY t.activity_timestamp) AS previous_assignees,
            row_number() OVER (PARTITION BY t.repo_id, t.pr_number ORDER BY t.activity_timestamp) AS activity_order
           FROM pr_activity_assignees_timeline t
        )
 SELECT la.event_id,
    la.repo_id,
    la.actor_id,
    la.org_id,
    la.pull_request_id,
    la.pr_number,
    la.activity_timestamp,
    la.activity_type,
    la.author_user_id,
    la.head_sha,
    la.base_ref,
    la.head_ref,
    la.merge_commit_sha,
    la.labels,
    la.previous_labels,
    la.activity_order,
        CASE
            WHEN ((la.labels <> la.previous_labels) AND (la.activity_order > 1)) THEN 'yes'::text
            ELSE 'no'::text
        END AS if_labels_change,
    ass.assignees,
    ass.previous_assignees,
        CASE
            WHEN ((ass.assignees <> ass.previous_assignees) AND (ass.activity_order > 1)) THEN 'yes'::text
            ELSE 'no'::text
        END AS if_assignees_change
   FROM (pr_activity_labels_with_lag la
     LEFT JOIN pr_activity_assignees_with_lag ass ON (((la.event_id = ass.event_id) AND (la.repo_id = ass.repo_id))))
  WITH NO DATA;

--
-- PostgreSQL database dump complete
--

-- public.ocel_events
--
-- PostgreSQL database dump
--

-- Dumped from database version 18.1 (Homebrew)
-- Dumped by pg_dump version 18.1 (Homebrew)

--


-- ---- mv_commit_pr_links ----
-- commit<->PR links (merge_commit_sha / head_sha / ref_match / push_order). PATCHED: ocel_events dependency replaced - see banner
--
-- PATCHED 2026-09-07: fourth method `push_order`. head_sha and merge_commit_sha name
-- only the branch tip and the merge commit; ref_match needs a push to the PR's branch
-- in the SAME repo and so never fires for fork-based PRs (kubernetes: 0.8% same-repo).
-- The commits BEHIND the tip therefore had no method at all when the branch lived on a
-- fork, although the merge push to the base branch enumerates them, oldest first,
-- immediately before the tip. `push_order` reads that enumeration: in a push where the
-- PR's head_sha sits at index h and its merge_commit_sha at h+1, every commit with index
-- in (previous merge commit in the push, h) is the PR's. The lower bound handles batched
-- merges (several PRs in one push); any commit whose message starts with "Merge " also
-- bounds, so a trunk merge inside the span cannot pull trunk commits in. A floor by
-- design: squash merges (the head never reaches the base branch), non-adjacent pairs, and
-- pushes truncated at 20 commits yield nothing. The `admitted` rule below applies to it
-- unchanged. Measured after refresh (2026-09-07, this database): push_order rows
-- admitted / not admitted — kubernetes 13,516 / 223 on 6,580 PRs, vscode 9,994 / 934 on
-- 2,478, react 417 / 0 on 101; fe.link_mat grew 171,817 → 191,540. Some of those rows
-- also carry head_sha (an earlier event's head) or ref_match; fe.link aggregates them.
--

CREATE MATERIALIZED VIEW public.mv_commit_pr_links AS
 WITH pr_meta AS (
         SELECT mv_pull_request_events_full.pull_request_id,
            mv_pull_request_events_full.repo_id,
            min(mv_pull_request_events_full.pr_created_at) AS pr_created_at,
            max(COALESCE(mv_pull_request_events_full.pr_merged_at, mv_pull_request_events_full.pr_closed_at)) AS pr_ended_at,
            bool_or(((mv_pull_request_events_full.head_repo_id = mv_pull_request_events_full.repo_id) AND (mv_pull_request_events_full.head_ref = ANY (ARRAY['master'::text, 'main'::text])))) AS head_is_default
           FROM public.mv_pull_request_events_full
          GROUP BY mv_pull_request_events_full.pull_request_id, mv_pull_request_events_full.repo_id
        ), pr_opened AS (
         SELECT DISTINCT ON (mv_pull_request_events_full.pull_request_id) mv_pull_request_events_full.pull_request_id,
            mv_pull_request_events_full.pr_number,
            mv_pull_request_events_full.repo_id,
            mv_pull_request_events_full.head_ref,
            mv_pull_request_events_full.head_repo_id
           FROM public.mv_pull_request_events_full
          WHERE (mv_pull_request_events_full.action = 'opened'::text)
          ORDER BY mv_pull_request_events_full.pull_request_id, mv_pull_request_events_full.event_created_at
        ), merge_tips AS (
         SELECT DISTINCT pv.repo_id,
            pv.event_id,
            pr.pull_request_id,
            pr.pr_number,
            pv.commit_index AS head_idx
           FROM ((public.mv_push_commits_full pv
             JOIN public.mv_pull_request_events_full pr ON (((pr.repo_id = pv.repo_id) AND (pr.head_sha = pv.commit_sha) AND (pr.action = 'closed'::text) AND (COALESCE(pr.pr_is_merged, false) = true) AND (pr.merge_commit_sha IS NOT NULL))))
             JOIN public.mv_push_commits_full pm ON (((pm.repo_id = pv.repo_id) AND (pm.event_id = pv.event_id) AND (pm.commit_index = (pv.commit_index + 1)) AND (pm.commit_sha = pr.merge_commit_sha))))
        ), merge_walk AS (
         SELECT pc.repo_id,
            pc.event_id,
            pc.commit_sha,
            pc.commit_index,
            pc.commit_message,
            t.pull_request_id AS pr_at_head,
            max(
                CASE
                    WHEN (pc.commit_message ~~ 'Merge %'::text) THEN pc.commit_index
                    ELSE NULL::integer
                END) OVER (PARTITION BY pc.event_id ORDER BY pc.commit_index ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS prev_merge,
            min(
                CASE
                    WHEN (t.pull_request_id IS NOT NULL) THEN pc.commit_index
                    ELSE NULL::integer
                END) OVER (PARTITION BY pc.event_id ORDER BY pc.commit_index DESC ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS next_head
           FROM ((public.mv_push_commits_full pc
             JOIN ( SELECT DISTINCT merge_tips.event_id
                   FROM merge_tips) e ON ((e.event_id = pc.event_id)))
             LEFT JOIN merge_tips t ON (((t.event_id = pc.event_id) AND (t.head_idx = pc.commit_index))))
        ), candidates AS (
         SELECT DISTINCT pv.commit_sha,
            pr.pull_request_id,
            pr.pr_number,
            pr.repo_id,
            'merge_commit_sha'::text AS link_method
           FROM (public.mv_push_commits_full pv
             JOIN public.mv_pull_request_events_full pr ON (((pv.commit_sha = pr.merge_commit_sha) AND (pv.repo_id = pr.repo_id))))
          WHERE ((pr.action = 'closed'::text) AND (COALESCE(pr.pr_is_merged, false) = true) AND (pr.merge_commit_sha IS NOT NULL))
        UNION
         SELECT DISTINCT pv.commit_sha,
            pr.pull_request_id,
            pr.pr_number,
            pr.repo_id,
            'head_sha'::text AS text
           FROM (public.mv_push_commits_full pv
             JOIN public.mv_pull_request_events_full pr ON (((pv.commit_sha = pr.head_sha) AND (pv.repo_id = pr.repo_id))))
        UNION
         SELECT DISTINCT pv.commit_sha,
            po.pull_request_id,
            po.pr_number,
            po.repo_id,
            'ref_match'::text AS text
           FROM ((public.mv_push_commits_full pv
             JOIN pr_opened po ON (((pv.repo_id = po.repo_id) AND (pv.ref = ('refs/heads/'::text || po.head_ref)) AND (po.head_repo_id = po.repo_id))))
             JOIN pr_meta pm ON (((pm.repo_id = po.repo_id) AND (pm.pull_request_id = po.pull_request_id))))
          WHERE ((pv.created_at >= (pm.pr_created_at - '7 days'::interval)) AND (pv.created_at <= COALESCE(pm.pr_ended_at, '2025-10-01 02:00:00+02'::timestamp with time zone)))
        UNION
         SELECT DISTINCT w.commit_sha,
            h.pull_request_id,
            h.pr_number,
            w.repo_id,
            'push_order'::text AS text
           FROM (merge_walk w
             JOIN merge_tips h ON (((h.event_id = w.event_id) AND (h.head_idx = w.next_head))))
          WHERE ((w.pr_at_head IS NULL) AND (w.commit_index > COALESCE(w.prev_merge, 0)) AND (w.commit_message !~~ 'Merge %'::text))
        ), pr_size AS (
         SELECT candidates.repo_id,
            candidates.pull_request_id,
            count(DISTINCT candidates.commit_sha) AS n_commits
           FROM candidates
          GROUP BY candidates.repo_id, candidates.pull_request_id
        ), commit_first_seen AS (
         -- PATCHED 2026-08-02: original joined ocel_events (off-limits, another thesis)
         -- purely to get each commit's first push time. Same number, straight from
         -- the push rows themselves. Nothing else in this view changed.
         SELECT pcs.repo_id,
            pcs.commit_sha,
            min(pcs.created_at) AS first_pushed_at
           FROM public.mv_push_commits_full pcs
          WHERE (pcs.commit_sha IS NOT NULL)
          GROUP BY pcs.repo_id, pcs.commit_sha
        )
 SELECT c.commit_sha,
    c.pull_request_id,
    c.pr_number,
    c.repo_id,
    c.link_method,
    COALESCE(m.head_is_default, false) AS head_is_default,
    s.n_commits,
    cf.first_pushed_at,
    ((cf.first_pushed_at IS NULL) OR ((cf.first_pushed_at >= (m.pr_created_at - '7 days'::interval)) AND (cf.first_pushed_at <= COALESCE(m.pr_ended_at, '2025-10-01 02:00:00+02'::timestamp with time zone)))) AS pushed_in_window,
    ((cf.first_pushed_at IS NOT NULL) AND (cf.first_pushed_at < m.pr_created_at)) AS prewindow_only,
    ((NOT COALESCE(m.head_is_default, false)) AND (s.n_commits < 250) AND ((cf.first_pushed_at IS NULL) OR ((cf.first_pushed_at >= (m.pr_created_at - '7 days'::interval)) AND (cf.first_pushed_at <= COALESCE(m.pr_ended_at, '2025-10-01 02:00:00+02'::timestamp with time zone))))) AS admitted
   FROM (((candidates c
     JOIN pr_meta m ON (((m.repo_id = c.repo_id) AND (m.pull_request_id = c.pull_request_id))))
     JOIN pr_size s ON (((s.repo_id = c.repo_id) AND (s.pull_request_id = c.pull_request_id))))
     LEFT JOIN commit_first_seen cf ON (((cf.repo_id = c.repo_id) AND (cf.commit_sha = c.commit_sha))))
  WITH NO DATA;

--
-- PostgreSQL database dump complete
--

-- public.mv_object_outcomes
--
-- PostgreSQL database dump
--

-- Dumped from database version 18.1 (Homebrew)
-- Dumped by pg_dump version 18.1 (Homebrew)

--


-- ---- mv_commit_message_issue_links_all ----
-- commit->issue references parsed from commit messages
--

CREATE MATERIALIZED VIEW public.mv_commit_message_issue_links_all AS
 SELECT DISTINCT mv_push_commits_full.repo_id AS source_repo_id,
    mv_push_commits_full.commit_sha,
    ((regexp_matches(mv_push_commits_full.commit_message, '(?:fix(?:e[sd])?|close[sd]?|resolve[sd]?)\s+#(\d+)'::text, 'gi'::text))[1])::integer AS issue_number,
    'same_repo'::text AS ref_scope,
    'standard'::text AS link_convention,
    mv_push_commits_full.created_at AS push_created_at,
    mv_push_commits_full.actor_id
   FROM public.mv_push_commits_full
  WHERE (mv_push_commits_full.commit_message ~* '(?:fix(?:e[sd])?|close[sd]?|resolve[sd]?)\s+#\d+'::text)
UNION ALL
 SELECT DISTINCT mv_push_commits_full.repo_id AS source_repo_id,
    mv_push_commits_full.commit_sha,
    ((regexp_matches(mv_push_commits_full.commit_message, '(?:fix(?:e[sd])?|close[sd]?|resolve[sd]?)\s+[\w.-]+/[\w.-]+#(\d+)'::text, 'gi'::text))[1])::integer AS issue_number,
    'cross_repo'::text AS ref_scope,
    'standard'::text AS link_convention,
    mv_push_commits_full.created_at AS push_created_at,
    mv_push_commits_full.actor_id
   FROM public.mv_push_commits_full
  WHERE (mv_push_commits_full.commit_message ~* '(?:fix(?:e[sd])?|close[sd]?|resolve[sd]?)\s+[\w.-]+/[\w.-]+#\d+'::text)
UNION ALL
 SELECT DISTINCT mv_push_commits_full.repo_id AS source_repo_id,
    mv_push_commits_full.commit_sha,
    ((regexp_matches(mv_push_commits_full.commit_message, '\mFor\s+#(\d+)'::text, 'gi'::text))[1])::integer AS issue_number,
    'same_repo'::text AS ref_scope,
    'for_reference'::text AS link_convention,
    mv_push_commits_full.created_at AS push_created_at,
    mv_push_commits_full.actor_id
   FROM public.mv_push_commits_full
  WHERE (mv_push_commits_full.commit_message ~* '\mFor\s+#\d+'::text)
UNION ALL
 SELECT DISTINCT mv_push_commits_full.repo_id AS source_repo_id,
    mv_push_commits_full.commit_sha,
    ((regexp_matches(mv_push_commits_full.commit_message, '(?:fix(?:e[sd])?|close[sd]?|resolve[sd]?)\s+issue\s+#(\d+)'::text, 'gi'::text))[1])::integer AS issue_number,
    'same_repo'::text AS ref_scope,
    'issue_keyword'::text AS link_convention,
    mv_push_commits_full.created_at AS push_created_at,
    mv_push_commits_full.actor_id
   FROM public.mv_push_commits_full
  WHERE (mv_push_commits_full.commit_message ~* '(?:fix(?:e[sd])?|close[sd]?|resolve[sd]?)\s+issue\s+#\d+'::text)
UNION ALL
 SELECT DISTINCT mv_push_commits_full.repo_id AS source_repo_id,
    mv_push_commits_full.commit_sha,
    ((regexp_matches(mv_push_commits_full.commit_message, '(?:fix(?:e[sd])?|close[sd]?|resolve[sd]?|see)\s+gh-(\d+)'::text, 'gi'::text))[1])::integer AS issue_number,
    'same_repo'::text AS ref_scope,
    'gh_prefix'::text AS link_convention,
    mv_push_commits_full.created_at AS push_created_at,
    mv_push_commits_full.actor_id
   FROM public.mv_push_commits_full
  WHERE (mv_push_commits_full.commit_message ~* '(?:fix(?:e[sd])?|close[sd]?|resolve[sd]?|see)\s+gh-\d+'::text)
UNION ALL
 SELECT DISTINCT mv_push_commits_full.repo_id AS source_repo_id,
    mv_push_commits_full.commit_sha,
    ((regexp_matches(mv_push_commits_full.commit_message, 'Fixed tickets\s*\|\s*#(\d+)'::text, 'gi'::text))[1])::integer AS issue_number,
    'same_repo'::text AS ref_scope,
    'fixed_tickets_table'::text AS link_convention,
    mv_push_commits_full.created_at AS push_created_at,
    mv_push_commits_full.actor_id
   FROM public.mv_push_commits_full
  WHERE (mv_push_commits_full.commit_message ~* 'Fixed tickets\s*\|\s*#\d+'::text)
UNION ALL
 SELECT DISTINCT mv_push_commits_full.repo_id AS source_repo_id,
    mv_push_commits_full.commit_sha,
    ((regexp_matches(mv_push_commits_full.commit_message, 'REFS\s+#(\d+)'::text, 'gi'::text))[1])::integer AS issue_number,
    'same_repo'::text AS ref_scope,
    'refs'::text AS link_convention,
    mv_push_commits_full.created_at AS push_created_at,
    mv_push_commits_full.actor_id
   FROM public.mv_push_commits_full
  WHERE (mv_push_commits_full.commit_message ~* 'REFS\s+#\d+'::text)
UNION ALL
 SELECT DISTINCT mv_push_commits_full.repo_id AS source_repo_id,
    mv_push_commits_full.commit_sha,
    ((regexp_matches(mv_push_commits_full.commit_message, '(?:bug|feature|minor)\s+#(\d+)'::text, 'gi'::text))[1])::integer AS issue_number,
    'same_repo'::text AS ref_scope,
    'merge_title'::text AS link_convention,
    mv_push_commits_full.created_at AS push_created_at,
    mv_push_commits_full.actor_id
   FROM public.mv_push_commits_full
  WHERE (mv_push_commits_full.commit_message ~* '(?:bug|feature|minor)\s+#\d+'::text)
  WITH NO DATA;

--
-- PostgreSQL database dump complete
--

-- public.mv_issue_and_issuecomment_activities_full
--
-- PostgreSQL database dump
--

-- Dumped from database version 18.1 (Homebrew)
-- Dumped by pg_dump version 18.1 (Homebrew)

--


-- ---- mv_issue_pr_links_pr_body ----
-- issue<->PR link method 1: closing keyword in PR body (validated)
--

CREATE MATERIALIZED VIEW public.mv_issue_pr_links_pr_body AS
 WITH pr_latest AS (
         SELECT DISTINCT ON (e.pull_request_id) e.repo_id,
            e.pull_request_id,
            e.pr_number,
            e.pr_body,
            e.pr_is_merged,
            e.pr_merged_at,
            e.pr_created_at
           FROM public.mv_pull_request_events_full e
          WHERE (e.pr_body IS NOT NULL)
          ORDER BY e.pull_request_id, e.event_created_at DESC
        ), matches AS (
         SELECT p.repo_id,
            p.pull_request_id,
            p.pr_number,
            p.pr_is_merged,
            p.pr_merged_at,
            p.pr_created_at,
            m.m[1] AS keyword,
            NULLIF(m.m[2], ''::text) AS ref_repo,
            (m.m[3])::integer AS issue_number
           FROM (pr_latest p
             CROSS JOIN LATERAL regexp_matches(COALESCE(p.pr_body, ''::text), '(?is)(close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved)\s*:?\s*(?:https?://github\.com/)?(?:([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+))?(?:/issues/|#)(\d+)'::text, 'g'::text) m(m))
        ), validated AS (
         SELECT m.repo_id,
            i.issue_id,
            m.issue_number,
            m.pull_request_id,
            m.pr_number,
            i.issue_created_at,
            p.pr_created_at,
            m.pr_merged_at,
            ic.issue_closed_at,
            m.ref_repo,
            (m.ref_repo IS NULL) AS same_repo_syntax,
                CASE
                    WHEN (i.issue_id IS NULL) THEN 'missing_issue'::text
                    WHEN (pr_ref.pull_request_id IS NOT NULL) THEN 'issue_number_is_pr'::text
                    WHEN (i.issue_created_at > p.pr_created_at) THEN 'issue_created_after_pr'::text
                    WHEN ((m.pr_merged_at IS NOT NULL) AND (ic.issue_closed_at IS NOT NULL) AND (m.pr_merged_at > ic.issue_closed_at)) THEN 'merge_after_issue_close'::text
                    ELSE 'valid'::text
                END AS validation_status
           FROM ((((matches m
             LEFT JOIN public.issues_identity i ON (((i.repo_id = m.repo_id) AND (i.issue_number = m.issue_number))))
             LEFT JOIN public.prs_identity p ON (((p.repo_id = m.repo_id) AND (p.pull_request_id = m.pull_request_id))))
             LEFT JOIN public.prs_identity pr_ref ON (((pr_ref.repo_id = m.repo_id) AND (pr_ref.pr_number = m.issue_number))))
             LEFT JOIN ( SELECT e.repo_id,
                    (((e.payload -> 'issue'::text) ->> 'number'::text))::integer AS issue_number,
                    min(e.created_at) AS issue_closed_at
                   FROM public.event e
                  WHERE ((e.type = 'IssuesEvent'::public.event_type) AND ((e.payload ->> 'action'::text) = 'closed'::text))
                  GROUP BY e.repo_id, (((e.payload -> 'issue'::text) ->> 'number'::text))::integer) ic ON (((ic.repo_id = m.repo_id) AND (ic.issue_number = m.issue_number))))
          WHERE (m.ref_repo IS NULL)
        )
 SELECT repo_id,
    issue_id,
    issue_number,
    pull_request_id,
    pr_number,
    validation_status,
    'pr_body'::text AS link_method,
    issue_created_at AS issue_created_at_utc,
    pr_created_at AS pr_created_at_utc,
    pr_merged_at AS pr_merged_at_utc,
    issue_closed_at AS issue_closed_at_utc
   FROM validated
  WHERE (validation_status = 'valid'::text)
  ORDER BY repo_id, issue_number, pr_number
  WITH NO DATA;

--
-- PostgreSQL database dump complete
--

-- public.mv_issue_pr_links_pr_title
--
-- PostgreSQL database dump
--

-- Dumped from database version 18.1 (Homebrew)
-- Dumped by pg_dump version 18.1 (Homebrew)

--


-- ---- mv_issue_pr_links_pr_title ----
-- method 2: keyword in PR title
--

CREATE MATERIALIZED VIEW public.mv_issue_pr_links_pr_title AS
 WITH pr_latest AS (
         SELECT DISTINCT ON (e.pull_request_id) e.repo_id,
            e.pull_request_id,
            e.pr_number,
            e.pr_title,
            e.pr_is_merged,
            e.pr_merged_at,
            e.pr_created_at
           FROM public.mv_pull_request_events_full e
          WHERE (e.pr_title IS NOT NULL)
          ORDER BY e.pull_request_id, e.event_created_at DESC
        ), matches AS (
         SELECT p.repo_id,
            p.pull_request_id,
            p.pr_number,
            p.pr_is_merged,
            p.pr_merged_at,
            p.pr_created_at,
            (m.m[1])::integer AS issue_number
           FROM (pr_latest p
             CROSS JOIN LATERAL regexp_matches(p.pr_title, '(?:fix(?:e[sd])?|close[sd]?|resolve[sd]?)\s*:?\s*#(\d+)'::text, 'gi'::text) m(m))
          WHERE (((m.m[1])::integer > 0) AND ((m.m[1])::integer < 1000000))
        ), validated AS (
         SELECT m.repo_id,
            i.issue_id,
            m.issue_number,
            m.pull_request_id,
            m.pr_number,
            i.issue_created_at,
            p.pr_created_at,
            m.pr_merged_at,
            ic.issue_closed_at,
                CASE
                    WHEN (i.issue_id IS NULL) THEN 'missing_issue'::text
                    WHEN (pr_ref.pull_request_id IS NOT NULL) THEN 'issue_number_is_pr'::text
                    WHEN (i.issue_created_at > p.pr_created_at) THEN 'issue_created_after_pr'::text
                    ELSE 'valid'::text
                END AS validation_status
           FROM ((((matches m
             LEFT JOIN public.issues_identity i ON (((i.repo_id = m.repo_id) AND (i.issue_number = m.issue_number))))
             LEFT JOIN public.prs_identity p ON (((p.repo_id = m.repo_id) AND (p.pull_request_id = m.pull_request_id))))
             LEFT JOIN public.prs_identity pr_ref ON (((pr_ref.repo_id = m.repo_id) AND (pr_ref.pr_number = m.issue_number))))
             LEFT JOIN ( SELECT e.repo_id,
                    (((e.payload -> 'issue'::text) ->> 'number'::text))::integer AS issue_number,
                    min(e.created_at) AS issue_closed_at
                   FROM public.event e
                  WHERE ((e.type = 'IssuesEvent'::public.event_type) AND ((e.payload ->> 'action'::text) = 'closed'::text))
                  GROUP BY e.repo_id, (((e.payload -> 'issue'::text) ->> 'number'::text))::integer) ic ON (((ic.repo_id = m.repo_id) AND (ic.issue_number = m.issue_number))))
        )
 SELECT repo_id,
    issue_id,
    issue_number,
    pull_request_id,
    pr_number,
    validation_status,
    'pr_title'::text AS link_method,
    issue_created_at AS issue_created_at_utc,
    pr_created_at AS pr_created_at_utc,
    pr_merged_at AS pr_merged_at_utc,
    issue_closed_at AS issue_closed_at_utc
   FROM validated
  WHERE (validation_status = 'valid'::text)
  ORDER BY repo_id, issue_number, pr_number
  WITH NO DATA;

--
-- PostgreSQL database dump complete
--

-- public.mv_label_objects
--
-- PostgreSQL database dump
--

-- Dumped from database version 18.1 (Homebrew)
-- Dumped by pg_dump version 18.1 (Homebrew)

--


-- ---- mv_issue_pr_links_issue_comment ----
-- method 3: keyword in an issue comment
--

CREATE MATERIALIZED VIEW public.mv_issue_pr_links_issue_comment AS
 WITH comment_refs AS (
         SELECT c.repo_id,
            c.issue_number,
            (m.m[1])::integer AS referenced_number
           FROM (public.mv_issue_comments_full c
             CROSS JOIN LATERAL regexp_matches(c.comment_body, '(?:fix(?:e[sd])?|close[sd]?|resolve[sd]?)\s*:?\s*#(\d+)'::text, 'gi'::text) m(m))
          WHERE ((c.is_pull_request = false) AND (c.comment_body IS NOT NULL) AND ((m.m[1])::integer > 0) AND ((m.m[1])::integer < 1000000))
        ), linked AS (
         SELECT DISTINCT cr.repo_id,
            cr.issue_number,
            pr.pull_request_id,
            pr.pr_number
           FROM (comment_refs cr
             JOIN public.prs_identity pr ON (((pr.repo_id = cr.repo_id) AND (pr.pr_number = cr.referenced_number))))
          WHERE (cr.issue_number <> cr.referenced_number)
        ), validated AS (
         SELECT l.repo_id,
            i.issue_id,
            l.issue_number,
            l.pull_request_id,
            l.pr_number,
            i.issue_created_at,
            p.pr_created_at,
            pr_evt.pr_merged_at,
            ic.issue_closed_at,
                CASE
                    WHEN (i.issue_id IS NULL) THEN 'missing_issue'::text
                    WHEN (pr_ref.pull_request_id IS NOT NULL) THEN 'issue_number_is_pr'::text
                    WHEN (i.issue_created_at > p.pr_created_at) THEN 'issue_created_after_pr'::text
                    ELSE 'valid'::text
                END AS validation_status
           FROM (((((linked l
             LEFT JOIN public.issues_identity i ON (((i.repo_id = l.repo_id) AND (i.issue_number = l.issue_number))))
             LEFT JOIN public.prs_identity p ON (((p.repo_id = l.repo_id) AND (p.pull_request_id = l.pull_request_id))))
             LEFT JOIN public.prs_identity pr_ref ON (((pr_ref.repo_id = l.repo_id) AND (pr_ref.pr_number = l.issue_number))))
             LEFT JOIN ( SELECT DISTINCT ON (mv_pull_request_events_full.pull_request_id) mv_pull_request_events_full.pull_request_id,
                    mv_pull_request_events_full.repo_id,
                    mv_pull_request_events_full.pr_merged_at
                   FROM public.mv_pull_request_events_full
                  WHERE (COALESCE(mv_pull_request_events_full.pr_is_merged, false) = true)
                  ORDER BY mv_pull_request_events_full.pull_request_id, mv_pull_request_events_full.event_created_at DESC) pr_evt ON ((pr_evt.pull_request_id = l.pull_request_id)))
             LEFT JOIN ( SELECT e.repo_id,
                    (((e.payload -> 'issue'::text) ->> 'number'::text))::integer AS issue_number,
                    min(e.created_at) AS issue_closed_at
                   FROM public.event e
                  WHERE ((e.type = 'IssuesEvent'::public.event_type) AND ((e.payload ->> 'action'::text) = 'closed'::text))
                  GROUP BY e.repo_id, (((e.payload -> 'issue'::text) ->> 'number'::text))::integer) ic ON (((ic.repo_id = l.repo_id) AND (ic.issue_number = l.issue_number))))
        )
 SELECT repo_id,
    issue_id,
    issue_number,
    pull_request_id,
    pr_number,
    validation_status,
    'issue_comment'::text AS link_method,
    issue_created_at AS issue_created_at_utc,
    pr_created_at AS pr_created_at_utc,
    pr_merged_at AS pr_merged_at_utc,
    issue_closed_at AS issue_closed_at_utc
   FROM validated
  WHERE (validation_status = 'valid'::text)
  ORDER BY repo_id, issue_number, pr_number
  WITH NO DATA;

--
-- PostgreSQL database dump complete
--

-- public.mv_issue_pr_links_pr_body
--
-- PostgreSQL database dump
--

-- Dumped from database version 18.1 (Homebrew)
-- Dumped by pg_dump version 18.1 (Homebrew)

--


-- ---- mv_issue_pr_links_branch_name ----
-- method 4: fix/123-style branch name
--

CREATE MATERIALIZED VIEW public.mv_issue_pr_links_branch_name AS
 WITH pr_branches AS (
         SELECT DISTINCT ON (e.pull_request_id) e.repo_id,
            e.pull_request_id,
            e.pr_number,
            e.head_ref,
            e.head_repo_id,
            e.pr_is_merged,
            e.pr_merged_at,
            e.pr_created_at
           FROM public.mv_pull_request_events_full e
          WHERE (e.head_ref IS NOT NULL)
          ORDER BY e.pull_request_id, e.event_created_at DESC
        ), extracted AS (
         SELECT pb.repo_id,
            pb.pull_request_id,
            pb.pr_number,
            pb.pr_is_merged,
            pb.pr_merged_at,
            pb.pr_created_at,
            (m.m[1])::integer AS issue_number
           FROM (pr_branches pb
             CROSS JOIN LATERAL regexp_matches(pb.head_ref, '(?:^|[/_-])(?:issue|fix|bug|gh|feat|feature|hotfix)[/-](\d+)(?:$|[/_-])'::text, 'gi'::text) m(m))
          WHERE ((pb.head_repo_id = pb.repo_id) AND ((m.m[1])::integer > 0) AND ((m.m[1])::integer < 1000000))
        ), validated AS (
         SELECT ex.repo_id,
            i.issue_id,
            ex.issue_number,
            ex.pull_request_id,
            ex.pr_number,
            i.issue_created_at,
            ex.pr_created_at,
            ex.pr_merged_at,
            ic.issue_closed_at,
                CASE
                    WHEN (i.issue_id IS NULL) THEN 'missing_issue'::text
                    WHEN (pr_ref.pull_request_id IS NOT NULL) THEN 'issue_number_is_pr'::text
                    WHEN (i.issue_created_at > ex.pr_created_at) THEN 'issue_created_after_pr'::text
                    ELSE 'valid'::text
                END AS validation_status
           FROM (((extracted ex
             LEFT JOIN public.issues_identity i ON (((i.repo_id = ex.repo_id) AND (i.issue_number = ex.issue_number))))
             LEFT JOIN public.prs_identity pr_ref ON (((pr_ref.repo_id = ex.repo_id) AND (pr_ref.pr_number = ex.issue_number))))
             LEFT JOIN ( SELECT e.repo_id,
                    (((e.payload -> 'issue'::text) ->> 'number'::text))::integer AS issue_number,
                    min(e.created_at) AS issue_closed_at
                   FROM public.event e
                  WHERE ((e.type = 'IssuesEvent'::public.event_type) AND ((e.payload ->> 'action'::text) = 'closed'::text))
                  GROUP BY e.repo_id, (((e.payload -> 'issue'::text) ->> 'number'::text))::integer) ic ON (((ic.repo_id = ex.repo_id) AND (ic.issue_number = ex.issue_number))))
        )
 SELECT repo_id,
    issue_id,
    issue_number,
    pull_request_id,
    pr_number,
    validation_status,
    'branch_name'::text AS link_method,
    issue_created_at AS issue_created_at_utc,
    pr_created_at AS pr_created_at_utc,
    pr_merged_at AS pr_merged_at_utc,
    issue_closed_at AS issue_closed_at_utc
   FROM validated
  WHERE (validation_status = 'valid'::text)
  ORDER BY repo_id, issue_number, pr_number
  WITH NO DATA;

--
-- PostgreSQL database dump complete
--

-- public.mv_issue_pr_links_issue_comment
--
-- PostgreSQL database dump
--

-- Dumped from database version 18.1 (Homebrew)
-- Dumped by pg_dump version 18.1 (Homebrew)

--


-- ---- mv_issue_pr_links_closed_via_commit ----
-- method 5: GitHub's own commit_id on the close event (validated)
--

CREATE MATERIALIZED VIEW public.mv_issue_pr_links_closed_via_commit AS
 WITH issue_closed_with_commit AS (
         SELECT e.repo_id,
            (((e.payload -> 'issue'::text) ->> 'number'::text))::integer AS issue_number,
            (e.payload ->> 'commit_id'::text) AS commit_sha,
            e.created_at AS issue_closed_at
           FROM public.event e
          WHERE ((e.type = 'IssuesEvent'::public.event_type) AND ((e.payload ->> 'action'::text) = 'closed'::text) AND ((e.payload ->> 'commit_id'::text) IS NOT NULL) AND ((e.payload ->> 'commit_id'::text) <> ''::text))
        ), linked AS (
         SELECT DISTINCT ic.repo_id,
            ic.issue_number,
            ic.commit_sha,
            ic.issue_closed_at,
            cpr.pull_request_id,
            cpr.pr_number
           FROM (issue_closed_with_commit ic
             JOIN public.mv_commit_pr_links cpr ON (((cpr.commit_sha = ic.commit_sha) AND (cpr.repo_id = ic.repo_id))))
        ), validated AS (
         SELECT l.repo_id,
            i.issue_id,
            l.issue_number,
            l.pull_request_id,
            l.pr_number,
            i.issue_created_at,
            p.pr_created_at,
            pr_evt.pr_merged_at,
            l.issue_closed_at,
                CASE
                    WHEN (i.issue_id IS NULL) THEN 'missing_issue'::text
                    WHEN (pr_ref.pull_request_id IS NOT NULL) THEN 'issue_number_is_pr'::text
                    WHEN (i.issue_created_at > p.pr_created_at) THEN 'issue_created_after_pr'::text
                    ELSE 'valid'::text
                END AS validation_status
           FROM ((((linked l
             LEFT JOIN public.issues_identity i ON (((i.repo_id = l.repo_id) AND (i.issue_number = l.issue_number))))
             LEFT JOIN public.prs_identity p ON (((p.repo_id = l.repo_id) AND (p.pull_request_id = l.pull_request_id))))
             LEFT JOIN public.prs_identity pr_ref ON (((pr_ref.repo_id = l.repo_id) AND (pr_ref.pr_number = l.issue_number))))
             LEFT JOIN ( SELECT DISTINCT ON (mv_pull_request_events_full.pull_request_id) mv_pull_request_events_full.pull_request_id,
                    mv_pull_request_events_full.repo_id,
                    mv_pull_request_events_full.pr_merged_at
                   FROM public.mv_pull_request_events_full
                  WHERE (COALESCE(mv_pull_request_events_full.pr_is_merged, false) = true)
                  ORDER BY mv_pull_request_events_full.pull_request_id, mv_pull_request_events_full.event_created_at DESC) pr_evt ON ((pr_evt.pull_request_id = l.pull_request_id)))
        )
 SELECT repo_id,
    issue_id,
    issue_number,
    pull_request_id,
    pr_number,
    validation_status,
    'closed_via_commit'::text AS link_method,
    issue_created_at AS issue_created_at_utc,
    pr_created_at AS pr_created_at_utc,
    pr_merged_at AS pr_merged_at_utc,
    issue_closed_at AS issue_closed_at_utc
   FROM validated
  WHERE (validation_status = 'valid'::text)
  ORDER BY repo_id, issue_number, pr_number
  WITH NO DATA;

--
-- PostgreSQL database dump complete
--

-- public.mv_issue_pr_links_commit_message
--
-- PostgreSQL database dump
--

-- Dumped from database version 18.1 (Homebrew)
-- Dumped by pg_dump version 18.1 (Homebrew)

--


-- ---- mv_issue_pr_links_commit_message ----
-- method 6: keyword in commit message
--

CREATE MATERIALIZED VIEW public.mv_issue_pr_links_commit_message AS
 WITH commit_issue_refs AS (
         SELECT pcs.repo_id,
            pcs.commit_sha,
            (m.m[1])::integer AS issue_number
           FROM (public.mv_push_commits_full pcs
             CROSS JOIN LATERAL regexp_matches(pcs.commit_message, '(?:fix(?:e[sd])?|close[sd]?|resolve[sd]?)\s*:?\s*#(\d+)'::text, 'gi'::text) m(m))
          WHERE ((pcs.commit_message IS NOT NULL) AND ((m.m[1])::integer > 0) AND ((m.m[1])::integer < 1000000))
        ), linked AS (
         SELECT DISTINCT cir.repo_id,
            cir.issue_number,
            cpr.pull_request_id,
            cpr.pr_number
           FROM (commit_issue_refs cir
             JOIN public.mv_commit_pr_links cpr ON (((cpr.commit_sha = cir.commit_sha) AND (cpr.repo_id = cir.repo_id) AND cpr.admitted)))
        ), validated AS (
         SELECT l.repo_id,
            i.issue_id,
            l.issue_number,
            l.pull_request_id,
            l.pr_number,
            i.issue_created_at,
            p.pr_created_at,
            pr_evt.pr_merged_at,
            ic.issue_closed_at,
                CASE
                    WHEN (i.issue_id IS NULL) THEN 'missing_issue'::text
                    WHEN (pr_ref.pull_request_id IS NOT NULL) THEN 'issue_number_is_pr'::text
                    WHEN (i.issue_created_at > p.pr_created_at) THEN 'issue_created_after_pr'::text
                    ELSE 'valid'::text
                END AS validation_status
           FROM (((((linked l
             LEFT JOIN public.issues_identity i ON (((i.repo_id = l.repo_id) AND (i.issue_number = l.issue_number))))
             LEFT JOIN public.prs_identity p ON (((p.repo_id = l.repo_id) AND (p.pull_request_id = l.pull_request_id))))
             LEFT JOIN public.prs_identity pr_ref ON (((pr_ref.repo_id = l.repo_id) AND (pr_ref.pr_number = l.issue_number))))
             LEFT JOIN ( SELECT DISTINCT ON (mv_pull_request_events_full.pull_request_id) mv_pull_request_events_full.pull_request_id,
                    mv_pull_request_events_full.repo_id,
                    mv_pull_request_events_full.pr_merged_at
                   FROM public.mv_pull_request_events_full
                  WHERE (COALESCE(mv_pull_request_events_full.pr_is_merged, false) = true)
                  ORDER BY mv_pull_request_events_full.pull_request_id, mv_pull_request_events_full.event_created_at DESC) pr_evt ON ((pr_evt.pull_request_id = l.pull_request_id)))
             LEFT JOIN ( SELECT e.repo_id,
                    (((e.payload -> 'issue'::text) ->> 'number'::text))::integer AS issue_number,
                    min(e.created_at) AS issue_closed_at
                   FROM public.event e
                  WHERE ((e.type = 'IssuesEvent'::public.event_type) AND ((e.payload ->> 'action'::text) = 'closed'::text))
                  GROUP BY e.repo_id, (((e.payload -> 'issue'::text) ->> 'number'::text))::integer) ic ON (((ic.repo_id = l.repo_id) AND (ic.issue_number = l.issue_number))))
        )
 SELECT repo_id,
    issue_id,
    issue_number,
    pull_request_id,
    pr_number,
    validation_status,
    'commit_message'::text AS link_method,
    issue_created_at AS issue_created_at_utc,
    pr_created_at AS pr_created_at_utc,
    pr_merged_at AS pr_merged_at_utc,
    issue_closed_at AS issue_closed_at_utc
   FROM validated
  WHERE (validation_status = 'valid'::text)
  ORDER BY repo_id, issue_number, pr_number
  WITH NO DATA;

--
-- PostgreSQL database dump complete
--

-- public.ocel_c_events
--
-- PostgreSQL database dump
--

-- Dumped from database version 18.1 (Homebrew)
-- Dumped by pg_dump version 18.1 (Homebrew)

--


-- ---- mv_issue_pr_links_proximity ----
-- method 7: issue closed within -5s/+60s of a PR merge (weakest)
--

CREATE MATERIALIZED VIEW public.mv_issue_pr_links_proximity AS
 WITH issue_close_events AS (
         SELECT e.repo_id,
            (((e.payload -> 'issue'::text) ->> 'number'::text))::integer AS issue_number,
            (((e.payload -> 'issue'::text) ->> 'id'::text))::bigint AS issue_id,
            min(e.created_at) AS issue_closed_at
           FROM public.event e
          WHERE ((e.type = 'IssuesEvent'::public.event_type) AND ((e.payload ->> 'action'::text) = 'closed'::text))
          GROUP BY e.repo_id, (((e.payload -> 'issue'::text) ->> 'number'::text))::integer, (((e.payload -> 'issue'::text) ->> 'id'::text))::bigint
        ), pr_merges AS (
         SELECT DISTINCT ON (mv_pull_request_events_full.pull_request_id) mv_pull_request_events_full.repo_id,
            mv_pull_request_events_full.pull_request_id,
            mv_pull_request_events_full.pr_number,
            mv_pull_request_events_full.pr_merged_at
           FROM public.mv_pull_request_events_full
          WHERE ((COALESCE(mv_pull_request_events_full.pr_is_merged, false) = true) AND (mv_pull_request_events_full.pr_merged_at IS NOT NULL))
          ORDER BY mv_pull_request_events_full.pull_request_id, mv_pull_request_events_full.event_created_at DESC
        ), already_linked AS (
         SELECT DISTINCT mv_issue_pr_links_pr_body.repo_id,
            mv_issue_pr_links_pr_body.issue_number,
            mv_issue_pr_links_pr_body.pull_request_id
           FROM public.mv_issue_pr_links_pr_body
        UNION
         SELECT DISTINCT mv_issue_pr_links_pr_title.repo_id,
            mv_issue_pr_links_pr_title.issue_number,
            mv_issue_pr_links_pr_title.pull_request_id
           FROM public.mv_issue_pr_links_pr_title
        UNION
         SELECT DISTINCT mv_issue_pr_links_commit_message.repo_id,
            mv_issue_pr_links_commit_message.issue_number,
            mv_issue_pr_links_commit_message.pull_request_id
           FROM public.mv_issue_pr_links_commit_message
        UNION
         SELECT DISTINCT mv_issue_pr_links_issue_comment.repo_id,
            mv_issue_pr_links_issue_comment.issue_number,
            mv_issue_pr_links_issue_comment.pull_request_id
           FROM public.mv_issue_pr_links_issue_comment
        UNION
         SELECT DISTINCT mv_issue_pr_links_branch_name.repo_id,
            mv_issue_pr_links_branch_name.issue_number,
            mv_issue_pr_links_branch_name.pull_request_id
           FROM public.mv_issue_pr_links_branch_name
        UNION
         SELECT DISTINCT mv_issue_pr_links_closed_via_commit.repo_id,
            mv_issue_pr_links_closed_via_commit.issue_number,
            mv_issue_pr_links_closed_via_commit.pull_request_id
           FROM public.mv_issue_pr_links_closed_via_commit
        ), pr_numbers AS (
         SELECT DISTINCT prs_identity.repo_id,
            prs_identity.pr_number
           FROM public.prs_identity
        ), candidates AS (
         SELECT ic.repo_id,
            ic.issue_id,
            ic.issue_number,
            pm.pull_request_id,
            pm.pr_number,
            true AS pr_is_merged,
            pm.pr_merged_at,
            ic.issue_closed_at,
            EXTRACT(epoch FROM ((ic.issue_closed_at)::timestamp with time zone - pm.pr_merged_at)) AS close_delta_seconds
           FROM (((issue_close_events ic
             JOIN pr_merges pm ON (((pm.repo_id = ic.repo_id) AND (ic.issue_closed_at >= (pm.pr_merged_at - '00:00:05'::interval)) AND (ic.issue_closed_at <= (pm.pr_merged_at + '00:01:00'::interval)))))
             LEFT JOIN pr_numbers prn ON (((prn.repo_id = ic.repo_id) AND (prn.pr_number = ic.issue_number))))
             LEFT JOIN already_linked al ON (((al.repo_id = ic.repo_id) AND (al.issue_number = ic.issue_number) AND (al.pull_request_id = pm.pull_request_id))))
          WHERE ((prn.pr_number IS NULL) AND (al.pull_request_id IS NULL) AND (ic.issue_number <> pm.pr_number))
        )
 SELECT DISTINCT ON (repo_id, issue_number) repo_id,
    issue_id,
    issue_number,
    pull_request_id,
    pr_number,
    pr_is_merged,
    pr_merged_at,
    issue_closed_at,
    close_delta_seconds,
    'proximity'::text AS link_method
   FROM candidates
  ORDER BY repo_id, issue_number, (abs(close_delta_seconds))
  WITH NO DATA;

--
-- PostgreSQL database dump complete
--

-- public.ocel_c_e2o
--
-- PostgreSQL database dump
--

-- Dumped from database version 18.1 (Homebrew)
-- Dumped by pg_dump version 18.1 (Homebrew)

--


-- ---- mv_issue_to_pr_validated_all ----
-- THE issue<->PR link table: union of all 7 methods, deduped by priority, with n_methods agreement
--

CREATE MATERIALIZED VIEW public.mv_issue_to_pr_validated_all AS
 WITH all_links AS (
         SELECT mv_issue_pr_links_pr_body.repo_id,
            mv_issue_pr_links_pr_body.issue_id,
            mv_issue_pr_links_pr_body.issue_number,
            mv_issue_pr_links_pr_body.pull_request_id,
            mv_issue_pr_links_pr_body.pr_number,
            'valid'::text AS validation_status,
            mv_issue_pr_links_pr_body.link_method,
            mv_issue_pr_links_pr_body.issue_created_at_utc,
            mv_issue_pr_links_pr_body.pr_created_at_utc,
            mv_issue_pr_links_pr_body.pr_merged_at_utc,
            mv_issue_pr_links_pr_body.issue_closed_at_utc,
            1 AS priority
           FROM public.mv_issue_pr_links_pr_body
        UNION ALL
         SELECT mv_issue_pr_links_pr_title.repo_id,
            mv_issue_pr_links_pr_title.issue_id,
            mv_issue_pr_links_pr_title.issue_number,
            mv_issue_pr_links_pr_title.pull_request_id,
            mv_issue_pr_links_pr_title.pr_number,
            mv_issue_pr_links_pr_title.validation_status,
            mv_issue_pr_links_pr_title.link_method,
            mv_issue_pr_links_pr_title.issue_created_at_utc,
            mv_issue_pr_links_pr_title.pr_created_at_utc,
            mv_issue_pr_links_pr_title.pr_merged_at_utc,
            mv_issue_pr_links_pr_title.issue_closed_at_utc,
            2
           FROM public.mv_issue_pr_links_pr_title
        UNION ALL
         SELECT mv_issue_pr_links_commit_message.repo_id,
            mv_issue_pr_links_commit_message.issue_id,
            mv_issue_pr_links_commit_message.issue_number,
            mv_issue_pr_links_commit_message.pull_request_id,
            mv_issue_pr_links_commit_message.pr_number,
            mv_issue_pr_links_commit_message.validation_status,
            mv_issue_pr_links_commit_message.link_method,
            mv_issue_pr_links_commit_message.issue_created_at_utc,
            mv_issue_pr_links_commit_message.pr_created_at_utc,
            mv_issue_pr_links_commit_message.pr_merged_at_utc,
            mv_issue_pr_links_commit_message.issue_closed_at_utc,
            3
           FROM public.mv_issue_pr_links_commit_message
        UNION ALL
         SELECT mv_issue_pr_links_issue_comment.repo_id,
            mv_issue_pr_links_issue_comment.issue_id,
            mv_issue_pr_links_issue_comment.issue_number,
            mv_issue_pr_links_issue_comment.pull_request_id,
            mv_issue_pr_links_issue_comment.pr_number,
            mv_issue_pr_links_issue_comment.validation_status,
            mv_issue_pr_links_issue_comment.link_method,
            mv_issue_pr_links_issue_comment.issue_created_at_utc,
            mv_issue_pr_links_issue_comment.pr_created_at_utc,
            mv_issue_pr_links_issue_comment.pr_merged_at_utc,
            mv_issue_pr_links_issue_comment.issue_closed_at_utc,
            4
           FROM public.mv_issue_pr_links_issue_comment
        UNION ALL
         SELECT mv_issue_pr_links_branch_name.repo_id,
            mv_issue_pr_links_branch_name.issue_id,
            mv_issue_pr_links_branch_name.issue_number,
            mv_issue_pr_links_branch_name.pull_request_id,
            mv_issue_pr_links_branch_name.pr_number,
            mv_issue_pr_links_branch_name.validation_status,
            mv_issue_pr_links_branch_name.link_method,
            mv_issue_pr_links_branch_name.issue_created_at_utc,
            mv_issue_pr_links_branch_name.pr_created_at_utc,
            mv_issue_pr_links_branch_name.pr_merged_at_utc,
            mv_issue_pr_links_branch_name.issue_closed_at_utc,
            5
           FROM public.mv_issue_pr_links_branch_name
        UNION ALL
         SELECT mv_issue_pr_links_closed_via_commit.repo_id,
            mv_issue_pr_links_closed_via_commit.issue_id,
            mv_issue_pr_links_closed_via_commit.issue_number,
            mv_issue_pr_links_closed_via_commit.pull_request_id,
            mv_issue_pr_links_closed_via_commit.pr_number,
            mv_issue_pr_links_closed_via_commit.validation_status,
            mv_issue_pr_links_closed_via_commit.link_method,
            mv_issue_pr_links_closed_via_commit.issue_created_at_utc,
            mv_issue_pr_links_closed_via_commit.pr_created_at_utc,
            mv_issue_pr_links_closed_via_commit.pr_merged_at_utc,
            mv_issue_pr_links_closed_via_commit.issue_closed_at_utc,
            6
           FROM public.mv_issue_pr_links_closed_via_commit
        UNION ALL
         SELECT mv_issue_pr_links_proximity.repo_id,
            mv_issue_pr_links_proximity.issue_id,
            mv_issue_pr_links_proximity.issue_number,
            mv_issue_pr_links_proximity.pull_request_id,
            mv_issue_pr_links_proximity.pr_number,
            'valid_proximity'::text AS text,
            mv_issue_pr_links_proximity.link_method,
            NULL::timestamp with time zone AS timestamptz,
            NULL::timestamp with time zone AS timestamptz,
            mv_issue_pr_links_proximity.pr_merged_at,
            mv_issue_pr_links_proximity.issue_closed_at,
            7
           FROM public.mv_issue_pr_links_proximity
        ), method_counts AS (
         SELECT all_links.repo_id,
            all_links.issue_number,
            all_links.pull_request_id,
            count(DISTINCT all_links.link_method) AS n_methods,
            string_agg(DISTINCT all_links.link_method, ';'::text ORDER BY all_links.link_method) AS all_methods
           FROM all_links
          GROUP BY all_links.repo_id, all_links.issue_number, all_links.pull_request_id
        )
 SELECT DISTINCT ON (a.repo_id, a.issue_number, a.pull_request_id) a.repo_id,
    a.issue_id,
    a.issue_number,
    a.pull_request_id,
    a.pr_number,
    a.validation_status,
    a.link_method AS primary_link_method,
    a.priority,
    mc.n_methods,
    mc.all_methods AS link_methods,
    a.issue_created_at_utc,
    a.pr_created_at_utc,
    a.pr_merged_at_utc,
    a.issue_closed_at_utc
   FROM (all_links a
     JOIN method_counts mc ON (((mc.repo_id = a.repo_id) AND (mc.issue_number = a.issue_number) AND (mc.pull_request_id = a.pull_request_id))))
  ORDER BY a.repo_id, a.issue_number, a.pull_request_id, a.priority
  WITH NO DATA;

--
-- PostgreSQL database dump complete
--

-- public.mv_issue_pr_links_extended_conventions
--
-- PostgreSQL database dump
--

-- Dumped from database version 18.1 (Homebrew)
-- Dumped by pg_dump version 18.1 (Homebrew)

--


-- ---- mv_issue_pr_links_extended_conventions ----
-- extra project-specific conventions (gh-123, 'bug #123', ...) for pairs the 7 methods missed
--

CREATE MATERIALIZED VIEW public.mv_issue_pr_links_extended_conventions AS
 WITH pr_latest AS (
         SELECT DISTINCT ON (mv_pull_request_events_full.pull_request_id) mv_pull_request_events_full.repo_id,
            mv_pull_request_events_full.pull_request_id,
            mv_pull_request_events_full.pr_number,
            mv_pull_request_events_full.pr_title,
            mv_pull_request_events_full.pr_body,
            mv_pull_request_events_full.pr_is_merged,
            mv_pull_request_events_full.pr_merged_at,
            mv_pull_request_events_full.pr_created_at
           FROM public.mv_pull_request_events_full
          WHERE ((mv_pull_request_events_full.pr_title IS NOT NULL) OR (mv_pull_request_events_full.pr_body IS NOT NULL))
          ORDER BY mv_pull_request_events_full.pull_request_id, mv_pull_request_events_full.event_created_at DESC
        ), title_matches AS (
         SELECT pr_latest.repo_id,
            pr_latest.pull_request_id,
            pr_latest.pr_number,
            pr_latest.pr_merged_at,
            pr_latest.pr_created_at,
            ((regexp_matches(pr_latest.pr_title, '(?:fix(?:e[sd])?|close[sd]?|resolve[sd]?|see|backport)?\s*gh-(\d+)'::text, 'gi'::text))[1])::integer AS issue_number,
            'pr_title_gh'::text AS link_method
           FROM pr_latest
          WHERE (pr_latest.pr_title ~* 'gh-\d+'::text)
        UNION ALL
         SELECT pr_latest.repo_id,
            pr_latest.pull_request_id,
            pr_latest.pr_number,
            pr_latest.pr_merged_at,
            pr_latest.pr_created_at,
            ((regexp_matches(pr_latest.pr_title, '(?:bug|feature|minor)\s+#(\d+)'::text, 'gi'::text))[1])::integer AS regexp_matches,
            'pr_title_symfony'::text AS text
           FROM pr_latest
          WHERE (pr_latest.pr_title ~* '(?:bug|feature|minor)\s+#\d+'::text)
        UNION ALL
         SELECT pr_latest.repo_id,
            pr_latest.pull_request_id,
            pr_latest.pr_number,
            pr_latest.pr_merged_at,
            pr_latest.pr_created_at,
            ((regexp_matches(pr_latest.pr_title, '\mFor\s+#(\d+)'::text, 'gi'::text))[1])::integer AS regexp_matches,
            'pr_title_for'::text AS text
           FROM pr_latest
          WHERE (pr_latest.pr_title ~* '\mFor\s+#\d+'::text)
        ), body_matches AS (
         SELECT pr_latest.repo_id,
            pr_latest.pull_request_id,
            pr_latest.pr_number,
            pr_latest.pr_merged_at,
            pr_latest.pr_created_at,
            ((regexp_matches(pr_latest.pr_body, '(?:fix(?:e[sd])?|close[sd]?|resolve[sd]?|see)?\s*gh-(\d+)'::text, 'gi'::text))[1])::integer AS issue_number,
            'pr_body_gh'::text AS link_method
           FROM pr_latest
          WHERE (pr_latest.pr_body ~* 'gh-\d+'::text)
        UNION ALL
         SELECT pr_latest.repo_id,
            pr_latest.pull_request_id,
            pr_latest.pr_number,
            pr_latest.pr_merged_at,
            pr_latest.pr_created_at,
            ((regexp_matches(pr_latest.pr_body, 'Fixed tickets\s*\|\s*#(\d+)'::text, 'gi'::text))[1])::integer AS issue_number,
            'pr_body_fixed_tickets'::text AS link_method
           FROM pr_latest
          WHERE (pr_latest.pr_body ~* 'Fixed tickets\s*\|\s*#\d+'::text)
        UNION ALL
         SELECT pr_latest.repo_id,
            pr_latest.pull_request_id,
            pr_latest.pr_number,
            pr_latest.pr_merged_at,
            pr_latest.pr_created_at,
            ((regexp_matches(pr_latest.pr_body, 'REFS\s+#(\d+)'::text, 'gi'::text))[1])::integer AS issue_number,
            'pr_body_refs'::text AS link_method
           FROM pr_latest
          WHERE (pr_latest.pr_body ~* 'REFS\s+#\d+'::text)
        ), all_matches AS (
         SELECT title_matches.repo_id,
            title_matches.pull_request_id,
            title_matches.pr_number,
            title_matches.pr_merged_at,
            title_matches.pr_created_at,
            title_matches.issue_number,
            title_matches.link_method
           FROM title_matches
        UNION ALL
         SELECT body_matches.repo_id,
            body_matches.pull_request_id,
            body_matches.pr_number,
            body_matches.pr_merged_at,
            body_matches.pr_created_at,
            body_matches.issue_number,
            body_matches.link_method
           FROM body_matches
        ), validated AS (
         SELECT m.repo_id,
            i.issue_id,
            m.issue_number,
            m.pull_request_id,
            m.pr_number,
            i.issue_created_at AS issue_created_at_utc,
            p.pr_created_at AS pr_created_at_utc,
            m.pr_merged_at AS pr_merged_at_utc,
            ic.issue_closed_at AS issue_closed_at_utc,
            m.link_method,
                CASE
                    WHEN (i.issue_id IS NULL) THEN 'missing_issue'::text
                    WHEN (pr_ref.pull_request_id IS NOT NULL) THEN 'issue_number_is_pr'::text
                    WHEN (i.issue_created_at > p.pr_created_at) THEN 'issue_created_after_pr'::text
                    ELSE 'valid'::text
                END AS validation_status
           FROM (((((all_matches m
             LEFT JOIN public.issues_identity i ON (((i.repo_id = m.repo_id) AND (i.issue_number = m.issue_number))))
             LEFT JOIN public.prs_identity p ON (((p.repo_id = m.repo_id) AND (p.pull_request_id = m.pull_request_id))))
             LEFT JOIN public.prs_identity pr_ref ON (((pr_ref.repo_id = m.repo_id) AND (pr_ref.pr_number = m.issue_number))))
             LEFT JOIN ( SELECT event.repo_id,
                    (((event.payload -> 'issue'::text) ->> 'number'::text))::integer AS issue_number,
                    min(event.created_at) AS issue_closed_at
                   FROM public.event
                  WHERE ((event.type = 'IssuesEvent'::public.event_type) AND ((event.payload ->> 'action'::text) = 'closed'::text))
                  GROUP BY event.repo_id, (((event.payload -> 'issue'::text) ->> 'number'::text))::integer) ic ON (((ic.repo_id = m.repo_id) AND (ic.issue_number = m.issue_number))))
             LEFT JOIN public.mv_issue_to_pr_validated_all existing ON (((existing.repo_id = m.repo_id) AND (existing.issue_number = m.issue_number) AND (existing.pull_request_id = m.pull_request_id))))
          WHERE (existing.pull_request_id IS NULL)
        )
 SELECT DISTINCT ON (repo_id, issue_number, pull_request_id) repo_id,
    issue_id,
    issue_number,
    pull_request_id,
    pr_number,
    validation_status,
    link_method,
    issue_created_at_utc,
    pr_created_at_utc,
    pr_merged_at_utc,
    issue_closed_at_utc
   FROM validated
  WHERE (validation_status = 'valid'::text)
  ORDER BY repo_id, issue_number, pull_request_id, link_method
  WITH NO DATA;

--
-- PostgreSQL database dump complete
--

-- public.ocel_c_e2o_references
--
-- PostgreSQL database dump
--

-- Dumped from database version 18.1 (Homebrew)
-- Dumped by pg_dump version 18.1 (Homebrew)

--


-- ============================ SECTION 2: POPULATE ===========================
-- Same order as creation. If one fails, fix and re-run from that line down.

REFRESH MATERIALIZED VIEW public.issues_identity;
REFRESH MATERIALIZED VIEW public.prs_identity;
REFRESH MATERIALIZED VIEW public.mv_issues_full;
REFRESH MATERIALIZED VIEW public.mv_issue_comments_full;
REFRESH MATERIALIZED VIEW public.mv_pull_request_events_full;
REFRESH MATERIALIZED VIEW public.mv_pull_request_comments_full;
REFRESH MATERIALIZED VIEW public.mv_push_commits_full;
REFRESH MATERIALIZED VIEW public.mv_push_activities;
REFRESH MATERIALIZED VIEW public.mv_issue_id_to_number;
REFRESH MATERIALIZED VIEW public.mv_pr_offplatform_merges;
REFRESH MATERIALIZED VIEW public.mv_issue_and_issuecomment_activities_full;
REFRESH MATERIALIZED VIEW public.mv_pull_request_and_comment_activities_full;
REFRESH MATERIALIZED VIEW public.mv_commit_pr_links;
REFRESH MATERIALIZED VIEW public.mv_commit_message_issue_links_all;
REFRESH MATERIALIZED VIEW public.mv_issue_pr_links_pr_body;
REFRESH MATERIALIZED VIEW public.mv_issue_pr_links_pr_title;
REFRESH MATERIALIZED VIEW public.mv_issue_pr_links_issue_comment;
REFRESH MATERIALIZED VIEW public.mv_issue_pr_links_branch_name;
REFRESH MATERIALIZED VIEW public.mv_issue_pr_links_closed_via_commit;
REFRESH MATERIALIZED VIEW public.mv_issue_pr_links_commit_message;
REFRESH MATERIALIZED VIEW public.mv_issue_pr_links_proximity;
REFRESH MATERIALIZED VIEW public.mv_issue_to_pr_validated_all;
REFRESH MATERIALIZED VIEW public.mv_issue_pr_links_extended_conventions;
