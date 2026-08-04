-- =====================================================================================
-- fe_layer.sql — the PostgREST data layer
--
-- Produces the frontend's `ObjectGraph` JSON (docs/ADAPTER_AND_API.md §4) from the 22
-- in-scope upstream views (docs/DATA_CONTRACT.md §1). Nothing here reads an `ocel_*`
-- view; nothing here modifies anything upstream except by adding indexes, which this
-- project owns (O9, closed).
--
-- Layout:
--   §0  schema, indexes, measurements
--   §1  activity vocabulary + the remap          (9 activities, decision 40)
--   §2  objects        fe.object_{issue,pull_request,commit,actor}
--   §3  intervals      fe.interval_{issue,pull_request}
--   §4  events         fe.event
--   §5  links          fe.link
--   §6  the RPC        api.get_object_graph(repo, seed, traversal_degree)
--   §7  diagnostics    the drop counts these views are obliged to report
--
-- Run:  psql -d gharchive_ocpm_viz_wsl -f sql/fe_layer.sql
--
-- -------------------------------------------------------------------------------------
-- Conventions that are load-bearing, and why. Each of these is a defect someone already
-- shipped once; none of them is stylistic.
--
--   * PLAIN VIEWS, not materialized (decision 10, ADAPTER_AND_API §1). The frontend asks
--     for one sub-log at a time — a seed and its neighbourhood, a few hundred rows out of
--     a decade. A plain view lets that filter reach the underlying MVs; a materialized
--     one computes every repository in advance, costs a second copy of a 14 GB dataset
--     and is stale from the moment upstream refreshes. Indexes go on the UNDERLYING MVs
--     (§0), which is the better place anyway: one index there serves every query touching
--     the relation rather than one path through a copy.
--
--   * OBJECT IDS ARE TYPE-PREFIXED (decision 51): `issue:<issue_id>`, `pr:<pr_id>`,
--     `commit:<sha>`, `actor:<actor_id>`. Not cosmetic — the bare numeric ids COLLIDE.
--     Measured 2026-08-04: 8 issue_ids equal a pull_request_id, 11 equal an actor id, 76
--     pull_request_ids equal an actor id. Unprefixed, a sub-log holding such a pair either
--     trips `duplicate object id` or silently merges two objects into one.
--
--   * REMAP FIRST, WHITELIST SECOND (§4). Reversed, `PullRequestCommented` is dropped as
--     unknown before it can become `IssueCommented`, and all 1,343,232 PR comments — the
--     single largest activity stream in the database — vanish without a word.
--
--   * EVERY EVENT AND LINK ENDPOINT RESOLVES AGAINST fe.object_* (§4, §5), never against
--     issues_identity / prs_identity. Those carry only objects with an 'opened' event, so
--     resolving through them drops exactly the pre-window objects the first-seen fallback
--     just created: the object survives as a lifecycle bar with nothing on it, and nothing
--     reports it. (SPEC R1.)
--
--   * TIMESTAMPS (decisions 55, 56). Upstream types are mixed and the mixture is invisible:
--     `activity_timestamp`, `mv_push_commits_full.created_at` and both identity views are
--     `timestamp` WITHOUT zone, while `mv_pull_request_events_full.pr_*_at` are timestamptz.
--     The server runs Europe/Berlin, so a naive value left alone lands 1–2 hours off. Every
--     naive column is lifted with `AT TIME ZONE 'UTC'` where it is first selected; the layer
--     is timestamptz from there; the payload renders `+00:00` — NOT bare `+00`, which
--     `new Date()` rejects as Invalid Date while passing this project's validator.
-- =====================================================================================


-- =====================================================================================
-- §0 — Schema and indexes
-- =====================================================================================

CREATE SCHEMA IF NOT EXISTS fe;    -- the derivations
CREATE SCHEMA IF NOT EXISTS api;   -- the only schema PostgREST exposes

COMMENT ON SCHEMA fe  IS
  'Thesis-owned derivations over the frozen upstream. Plain views (decision 10).';
COMMENT ON SCHEMA api IS
  'PostgREST surface. One RPC: get_object_graph. The frontend never queries a view directly.';

-- -------------------------------------------------------------------------------------
-- Indexes on the UNDERLYING MVs.
--
-- Before this file ran, the four base tables had a primary key each and NOT ONE
-- materialized view had any index at all (`pg_indexes`, 2026-08-04) — so every sub-log
-- query was a sequential scan over as much as 4.6 GB.
--
-- Keys chosen are the ones §2–§6 actually filter and join by. Measurements are recorded
-- in §0.1 below; decision 10 asks for optimisation to be a finding, not a habit.
--
-- These change relations other people read. That is why they are listed here rather than
-- applied quietly (DATA_CONTRACT.md §2).
-- -------------------------------------------------------------------------------------

-- Covering, deliberately. fe.object_issue's first-seen branch aggregates
-- min(issue_number), min(activity_timestamp) grouped by (repo_id, issue_id); with only
-- the two key columns indexed the planner still chose a sequential scan over 770,175 rows
-- because it had to fetch the other two from the heap. Carrying all four turns that into
-- an index-only scan, and fe.object_issue is on the hot path of every request — fe.link
-- branch D joins it to resolve commit→issue references.
CREATE INDEX IF NOT EXISTS ix_iact_repo_issue
  ON mv_issue_and_issuecomment_activities_full (repo_id, issue_id, issue_number, activity_timestamp);
CREATE INDEX IF NOT EXISTS ix_pract_repo_prnum
  ON mv_pull_request_and_comment_activities_full (repo_id, pr_number);
CREATE INDEX IF NOT EXISTS ix_pract_repo_prid
  ON mv_pull_request_and_comment_activities_full (repo_id, pull_request_id);
CREATE INDEX IF NOT EXISTS ix_prev_repo_prid
  ON mv_pull_request_events_full (repo_id, pull_request_id);
CREATE INDEX IF NOT EXISTS ix_prev_repo_prnum
  ON mv_pull_request_events_full (repo_id, pr_number);
CREATE INDEX IF NOT EXISTS ix_pushc_repo_sha
  ON mv_push_commits_full (repo_id, commit_sha);
CREATE INDEX IF NOT EXISTS ix_pushc_event
  ON mv_push_commits_full (event_id);
CREATE INDEX IF NOT EXISTS ix_pusha_activity
  ON mv_push_activities (activity_id);
CREATE INDEX IF NOT EXISTS ix_issues_full_repo_actor
  ON mv_issues_full (repo_id, actor_id);
CREATE INDEX IF NOT EXISTS ix_icomments_repo_actor
  ON mv_issue_comments_full (repo_id, actor_id);
CREATE INDEX IF NOT EXISTS ix_issident_repo_issue
  ON issues_identity (repo_id, issue_id);
CREATE INDEX IF NOT EXISTS ix_prident_repo_prid
  ON prs_identity (repo_id, pull_request_id);

-- link relations: small, but walked on every single request by the traversal
CREATE INDEX IF NOT EXISTS ix_v2pr_repo         ON mv_issue_to_pr_validated_all (repo_id);
CREATE INDEX IF NOT EXISTS ix_v2pr_pair         ON mv_issue_to_pr_validated_all (repo_id, issue_id, pull_request_id);
CREATE INDEX IF NOT EXISTS ix_extconv_repo      ON mv_issue_pr_links_extended_conventions (repo_id);
CREATE INDEX IF NOT EXISTS ix_cprl_repo_adm     ON mv_commit_pr_links (repo_id) WHERE admitted;
CREATE INDEX IF NOT EXISTS ix_cmil_repo_issue   ON mv_commit_message_issue_links_all (source_repo_id, issue_number);

ANALYZE mv_issue_and_issuecomment_activities_full;
ANALYZE mv_pull_request_and_comment_activities_full;
ANALYZE mv_pull_request_events_full;
ANALYZE mv_push_commits_full;
ANALYZE mv_push_activities;
ANALYZE mv_issues_full;
ANALYZE mv_issue_comments_full;
ANALYZE issues_identity;
ANALYZE prs_identity;
ANALYZE mv_issue_to_pr_validated_all;
ANALYZE mv_issue_pr_links_extended_conventions;
ANALYZE mv_commit_pr_links;
ANALYZE mv_commit_message_issue_links_all;

-- ⚠️ ANALYZE run by a NON-owner reports success while silently skipping. This role owns
-- every relation, so the above really ran — but verify rather than trust:
--     SELECT relname, reltuples FROM pg_class WHERE reltuples = -1;
-- Two views sat at -1 on 2026-08-04: mv_issue_pr_links_closed_via_commit (it is empty)
-- and mv_pr_offplatform_merges (not consumed, decision 48).

-- -------------------------------------------------------------------------------------
-- §0.1 — Measurements
--
-- Latency for one real sub-log: microsoft/vscode, seed issue:2902032454 (issue #242864 --
-- the sub-log F1 models), traversal_degree 2. Measured 2026-08-04, best of three, warm
-- cache, end-to-end through psql. Payload identical at every step (10,588 bytes), so
-- these are like-for-like.
--
--   no indexes anywhere, first working version              19.4 s
--   + the indexes above                                     16.5 s
--   + repository's links built once, not twice per direction 15.3 s
--   + fe.object_actor read from the `actor` base table        6.8 s   <- biggest single win
--   + traversal reduced to typed key arrays (§6 step 1)       4.2 s
--   + fe.link_mat (§5.1)                                      1.7 s
--
-- Where the remaining 1.7 s goes, measured component by component: fe.interval_issue
-- 499 ms and fe.interval_pull_request 260 ms (window functions over the repository's whole
-- lifecycle stream, which a qual on the partition key does not fully avoid), the traversal
-- ~120 ms, fe.event 134 ms, everything else under 10 ms. The intervals are the next thing
-- to attack if it matters; nothing here needed it to.
--
-- MATERIALIZATION: exactly one, fe.link_mat, with its measurement in §5.1. The other
-- candidate OCEL_TOOL_SPEC.md names — rebuilding fe_commit_pr_links — is declined: that
-- join already exists upstream as mv_commit_pr_links (decision 52, inherited), so
-- rebuilding it would create a second admission rule to disagree with the first.
--
-- Every figure resting on an upstream view must quote its refresh timestamp. All 23 MVs
-- were last refreshed 2026-08-02, 19:32–19:45 UTC.
-- -------------------------------------------------------------------------------------


-- =====================================================================================
-- §1 — The activity vocabulary, and the remap
-- =====================================================================================

-- Exactly the NINE of decision 40. This whitelist and the frontend's ACTIVITIES
-- (src/model/activities.js) must be the same set or one of them is decorative:
-- an activity that reaches the renderer unmapped throws at activities.js:121.
DROP VIEW IF EXISTS fe.activity_vocabulary CASCADE;
CREATE VIEW fe.activity_vocabulary AS
SELECT * FROM (VALUES
  --  activity,             object_type,    landmark, is_comment
  ('IssueOpened',          'issue',        false, false),
  ('IssueClosed',          'issue',        true,  false),
  ('IssueReopened',        'issue',        false, false),
  ('IssueCommented',       'issue',        false, true ),
  ('PullRequestOpened',    'pull_request', false, false),
  ('PullRequestMerged',    'pull_request', true,  false),
  ('PullRequestClosed',    'pull_request', false, false),
  ('PullRequestReopened',  'pull_request', false, false),
  ('CommitObserved',       'commit',       false, false)
) AS t(activity, object_type, landmark, is_comment);

COMMENT ON VIEW fe.activity_vocabulary IS
  'The 9 activities of decision 40. Landmarks are IssueClosed and PullRequestMerged '
  '(decision 48 removed the third). CommitObserved is synthetic — no upstream MV emits it.';

-- The two remaps of decision 40/48. Applied BEFORE the whitelist join, so a remapped row
-- survives it. Verified against the live vocabularies (2026-08-04):
--   mv_issue_and_issuecomment_activities_full   IssueCommented 953,293 · IssueOpened 176,362
--                                               IssueClosed 175,370 · IssueReopened 10,626
--                                               + IssueComment_ (1) and IssueLabeled (1), dropped
--   mv_pull_request_and_comment_activities_full PullRequestCommented 1,343,232 · Opened 90,262
--                                               Merged 67,216 · Closed 26,366 · Reopened 4,325
--                                               PullRequestMergedOffPlatform 31, remapped
CREATE OR REPLACE FUNCTION fe.remap_activity(raw text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE raw
    -- GitHub models PR comments as issue comments; so does this tool (decision 40)
    WHEN 'PullRequestCommented'         THEN 'IssueCommented'
    -- the underlying GitHub fact is: closed, not merged (decision 48)
    WHEN 'PullRequestMergedOffPlatform' THEN 'PullRequestClosed'
    ELSE raw
  END;
$$;

-- Render one UTC instant the way the frontend can parse it (decision 55).
-- `+00:00`, never bare `+00`: `new Date('...T22:47:49+00')` is Invalid Date, and
-- findGraphProblems only checks that `time` is non-empty — so the bare form passes
-- validation and hands the layout a NaN.
CREATE OR REPLACE FUNCTION fe.utc(t timestamptz) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT to_char(t AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS+00:00');
$$;


-- =====================================================================================
-- §2 — Objects
--
-- Four types, closed (decision 39). `repo` is NOT among them: it is the frame the sub-log
-- is drawn inside, carried once as meta.repo / meta.repo_id.
-- =====================================================================================

-- -------------------------------------------------------------------------------------
-- ISSUE — identity preferred, first-seen fallback for pre-window issues (decision 46, G3)
--
-- 22,407 issue_ids appear in the activity stream with no issues_identity row (measured
-- 2026-08-04) — 11.3% of all issues, acted on inside the window but opened before it.
-- Without the fallback every one of their events references a missing object and the
-- validator rejects the bundle.
-- -------------------------------------------------------------------------------------
DROP VIEW IF EXISTS fe.object_issue CASCADE;
CREATE VIEW fe.object_issue AS
WITH from_identity AS (
  -- ⚠️ `issue_id IS NOT NULL` is not defensive padding. issues_identity holds 2 rows whose
  -- issue_id is NULL (measured 2026-08-04), and `'issue:' || NULL` is NULL — so without
  -- this the view emits two objects with a NULL id, which findGraphProblems reports as
  -- "an object has no id" and which would take their events down with them.
  SELECT repo_id, issue_id, issue_number,
         issue_created_at AT TIME ZONE 'UTC' AS t0,
         0 AS priority,
         'created_at(opened)'::text AS time_semantics
  FROM issues_identity
  WHERE issue_id IS NOT NULL
),
first_seen AS (
  -- The issue branch needs no G9 workaround: mv_issue_comments_full.issue_id really is
  -- the issue's id, so `issue_id` is trustworthy on every row here. That asymmetry with
  -- the PR branch below is the tell that something is wrong over there.
  SELECT repo_id, issue_id,
         min(issue_number)                            AS issue_number,
         min(activity_timestamp) AT TIME ZONE 'UTC'   AS t0,
         1 AS priority,
         'first_seen(activity)'::text AS time_semantics
  FROM mv_issue_and_issuecomment_activities_full
  WHERE issue_id IS NOT NULL
  GROUP BY repo_id, issue_id
)
SELECT DISTINCT ON (u.repo_id, u.issue_id)
       'issue:' || u.issue_id::text AS id,          -- decision 51: the prefix prevents collision
       'issue'::text                AS type,
       '#' || u.issue_number        AS label,
       u.repo_id,
       u.issue_id,
       u.issue_number,              -- a real column: fe.link's commit→issue branch joins on it
       u.t0,
       u.time_semantics,
       jsonb_build_object(
         'issue_number', u.issue_number,
         'issue_id',     u.issue_id
       ) AS vmap
FROM (SELECT * FROM from_identity UNION ALL SELECT * FROM first_seen) u
ORDER BY u.repo_id, u.issue_id, u.priority, u.t0;

-- -------------------------------------------------------------------------------------
-- PULL REQUEST — identity preferred, first-seen fallback
--
-- ⚠️ The fallback reads mv_pull_request_events_full, NOT the activities MV, and that is a
-- correction to OCEL_TOOL_SPEC.md Step 2 rather than a preference. G9 is confirmed: the
-- comment rows of mv_pull_request_and_comment_activities_full carry
-- payload->'issue'->>'id' in the pull_request_id column, which for a PR is a DIFFERENT
-- number from the PR id. Measured 2026-08-04: those rows hold 84,209 distinct
-- `pull_request_id` values of which 84,200 are not a pull request id at all. Grouping the
-- fallback on that column — as the spec does — would mint 84,200 phantom pull requests
-- keyed on issue ids, each with a lifecycle bar and a handful of comments.
--
-- mv_pull_request_events_full carries the correct pull_request_id on every row, and
-- recovers all 7,179 genuinely pre-window PRs. Comment events then resolve by
-- (repo_id, pr_number) in §4, which is the G9 workaround and is safe: no (repo_id,
-- pr_number) maps to two pull_request_ids anywhere in this database (verified).
--
-- ⚠️ What this cannot recover: 1,999 pull requests known ONLY by comments, with no
-- PullRequestEvent anywhere in the window. No correct numeric PR id exists for them in
-- this database — mv_pull_request_comments_full carries the issue id and pr_number and no
-- pull_request_id. They get no object and their 17,737 comment events are dropped (1.3%
-- of PR comments). §7.2 reports the count. Inventing an id would be fabrication; keying
-- them on pr_number would put two id spaces in one column.
-- -------------------------------------------------------------------------------------
DROP VIEW IF EXISTS fe.object_pull_request CASCADE;
CREATE VIEW fe.object_pull_request AS
WITH observed AS (
  -- The pull requests that will actually have at least one in-scope event.
  --
  -- ⚠️ This gate is what stops the layer from drawing empty lifecycle bars, and it was
  -- added because the sanity check caught 3,357 of them. `prs_identity` is built from the
  -- raw `event` table (`payload->'pull_request'->>'id'` where action = 'opened'), while
  -- `mv_pull_request_events_full` is a separate flattening — and they disagree: 3,357 PRs
  -- have a prs_identity row but appear in NEITHER the events MV nor the activities MV, so
  -- there is nothing to draw on them. That is an upstream extraction gap, and inheriting
  -- it as an object would reproduce SPEC R1's exact failure — the object survives, its
  -- events do not, and nothing reports it.
  --
  -- Gating on the activities MV is the non-circular way to say "has events": §4 branch 2
  -- resolves PR events by joining that MV on (repo_id, pr_number), so this set and the set
  -- of PRs with events are the same set by construction. Every PR activity_type survives
  -- the remap and the whitelist, so nothing is lost between here and there.
  SELECT DISTINCT repo_id, pr_number
  FROM mv_pull_request_and_comment_activities_full
  WHERE pr_number IS NOT NULL
),
from_identity AS (
  SELECT i.repo_id, i.pull_request_id, i.pr_number,
         i.pr_created_at AT TIME ZONE 'UTC' AS t0,
         0 AS priority,
         'created_at(opened)'::text AS time_semantics
  FROM prs_identity i
  JOIN observed o ON o.repo_id = i.repo_id AND o.pr_number = i.pr_number
  WHERE i.pull_request_id IS NOT NULL
),
first_seen AS (
  SELECT p.repo_id, p.pull_request_id,
         min(p.pr_number)                             AS pr_number,
         min(p.event_created_at) AT TIME ZONE 'UTC'   AS t0,
         1 AS priority,
         'first_seen(activity)'::text AS time_semantics
  FROM mv_pull_request_events_full p
  JOIN observed o ON o.repo_id = p.repo_id AND o.pr_number = p.pr_number
  WHERE p.pull_request_id IS NOT NULL
  GROUP BY p.repo_id, p.pull_request_id
),
refs AS (
  SELECT DISTINCT ON (pull_request_id)
         pull_request_id, head_ref, base_ref, pr_title
  FROM mv_pull_request_events_full
  WHERE action = 'opened'
  ORDER BY pull_request_id, event_created_at
)
SELECT DISTINCT ON (u.repo_id, u.pull_request_id)
       'pr:' || u.pull_request_id::text AS id,
       'pull_request'::text             AS type,
       'PR #' || u.pr_number            AS label,
       u.repo_id,
       u.pull_request_id,
       u.pr_number,                 -- a real column: §4's comment branch joins on it (G9)
       u.t0,
       u.time_semantics,
       jsonb_strip_nulls(jsonb_build_object(
         'pr_number',       u.pr_number,
         'pull_request_id', u.pull_request_id,
         'title',           r.pr_title,
         'head_ref',        r.head_ref,
         'base_ref',        r.base_ref
       )) AS vmap
FROM (SELECT * FROM from_identity UNION ALL SELECT * FROM first_seen) u
LEFT JOIN refs r ON r.pull_request_id = u.pull_request_id
ORDER BY u.repo_id, u.pull_request_id, u.priority, u.t0;

-- -------------------------------------------------------------------------------------
-- COMMIT — one object per distinct SHA, attributes from the first observing push.
--
-- Keyed `commit:<sha>` and not `commit:<repo_id>_<sha>` (decision 51): a SHA is unique by
-- construction, a sub-log is one repository, and seedQuery.js:106 takes everything after
-- the first ':' as the SHA — the repo-prefixed form silently demotes an exact commit-seed
-- match to a prefix match.
--
-- ⚠️ `created_at` is PUSH time, not git author time. mv_push_commits_full has no author
-- date at all. The caveat is carried in meta.data_honesty and rendered at nodes.js:468.
-- -------------------------------------------------------------------------------------
DROP VIEW IF EXISTS fe.object_commit CASCADE;
CREATE VIEW fe.object_commit AS
WITH first_seen AS (
  SELECT repo_id, commit_sha, min(created_at) AS first_seen_at
  FROM mv_push_commits_full
  WHERE commit_sha IS NOT NULL
  GROUP BY repo_id, commit_sha
),
first_event AS (
  SELECT f.repo_id, f.commit_sha, f.first_seen_at, min(p.event_id) AS first_event_id
  FROM first_seen f
  JOIN mv_push_commits_full p
    ON p.repo_id = f.repo_id AND p.commit_sha = f.commit_sha
   AND p.created_at = f.first_seen_at
  GROUP BY f.repo_id, f.commit_sha, f.first_seen_at
)
SELECT DISTINCT ON (e.repo_id, e.commit_sha)
       'commit:' || e.commit_sha            AS id,
       'commit'::text                       AS type,
       left(e.commit_sha, 7)                AS label,
       e.repo_id,
       e.commit_sha,
       e.first_seen_at AT TIME ZONE 'UTC'   AS t0,
       'first_seen(push)'::text             AS time_semantics,
       jsonb_strip_nulls(jsonb_build_object(
         'commit_sha',          p.commit_sha,
         'commit_message',      p.commit_message,
         'commit_author_name',  p.commit_author_name,
         'commit_author_email', p.commit_author_email,
         'ref',                 p.ref,
         'push_id',             p.push_id,
         'commit_index',        p.commit_index
       )) AS vmap
FROM first_event e
JOIN mv_push_commits_full p
  ON p.repo_id = e.repo_id AND p.commit_sha = e.commit_sha AND p.event_id = e.first_event_id
ORDER BY e.repo_id, e.commit_sha, p.commit_index;

-- -------------------------------------------------------------------------------------
-- ACTOR — no upstream MV; assembled from every stream that names one.
--
-- Two different questions, needing two different filters. Getting either wrong is silent.
--
--  (a) WHICH LOGIN belongs to this actor_id?  `action = 'opened'` is load-bearing:
--      outside it, issue_creator_login names the issue's CREATOR while actor_id is
--      whoever performed *this* event, so pairing them on a close row attributes the
--      closer's id to the creator's login.
--
--  (b) WHO EXISTS at all?  SPEC R2: the filter above is right for (a) and wrong for (b).
--      Anyone who only closed, merged or reopened — a maintainer whose entire
--      contribution is merging, which is exactly who an issue-to-merge study is about —
--      appears in no (a) branch, so they get no actor object: no sidebar row, no colour,
--      no trail. Their events still carry actor_id, so nothing errors. The id-only
--      branches below fix that; `resolved` fills the login in from (a) when one is known.
--
-- The `actor` base table is joined last as a backstop. DATA_CONTRACT.md §0 records it as
-- complete, and it carries a login for ids the payload streams never name with one.
-- No is_bot: bot classification is another student's thesis (decision 47).
-- -------------------------------------------------------------------------------------
-- ⚠️ Built from the `actor` BASE TABLE, not reconstructed from the payload streams —
-- which is what DATA_CONTRACT.md §0 says to do ("Actor objects come from these tables,
-- not from any view; `actor` is complete as-is") and what OCEL_TOOL_SPEC.md Step 2
-- overlooked when it wrote "ACTOR: no MV exists; assembled from every stream that names
-- one".
--
-- Verified before switching, because "complete" is a claim and this file's rule is to
-- check claims: the union of every distinct actor_id appearing in mv_issues_full,
-- mv_pull_request_events_full, mv_issue_comments_full, mv_pull_request_comments_full and
-- mv_push_commits_full is **137,336 ids, of which 0 are missing from `actor` and 0 have a
-- NULL login** (2026-08-04). So the reconstruction recovered nothing the base table did
-- not already hold.
--
-- It cost a great deal, though, and this was the single biggest thing wrong with the
-- layer's performance: the stream version aggregated 1,225,526 rows per request behind a
-- parallel sequential scan of mv_issue_comments_full (4.6 GB) and
-- mv_pull_request_comments_full (3.0 GB) — 4.0 s of a 12 s request — to build every actor
-- in the repository and then keep six.
--
-- SPEC R2 ("contributors who only close or merge are missing from the actor list") is
-- satisfied by construction here rather than by adding branches: identity comes from the
-- actor table, so there is no `action = 'opened'` filter to be wrong about, and anyone an
-- event names has an object. R2's underlying trap — pairing `actor_id` with
-- `issue_creator_login`, which names the issue's CREATOR and not the event's actor — is
-- likewise gone, because no login is ever read from a payload column.
--
-- No is_bot: bot classification is another student's thesis (decision 47).
DROP VIEW IF EXISTS fe.object_actor CASCADE;
CREATE VIEW fe.object_actor AS
SELECT 'actor:' || a.id::text                                   AS id,
       'actor'::text                                            AS type,
       '@' || COALESCE(a.login, a.display_login, a.id::text)     AS label,
       a.id                                                     AS actor_id,
       'static'::text                                           AS time_semantics,
       jsonb_strip_nulls(jsonb_build_object(
         'login',    COALESCE(a.login, a.display_login),
         'actor_id', a.id
       )) AS vmap
FROM actor a;

-- ⚠️ `actor.login` is the account's login as recorded in that table, not necessarily the
-- login a historical event displayed: a renamed account shows its later name. Identity is
-- the numeric id throughout (decision 51), so a rename no longer splits one contributor
-- into two across a re-extraction — the CLAUDE.md exception expiring exactly as it said it
-- would.
--
-- ⚠️ Actors are NOT scoped by repository, and that is deliberate. A GitHub account is a
-- global entity; scoping gave the same id one row per repository it had acted in, which is
-- a duplicate object id waiting for the first cross-repo sub-log. The sub-log's actor set
-- is decided by which events survive (§6), which is the correct scope and the one the
-- sidebar wants.


-- =====================================================================================
-- §3 — Intervals  (decision 4: interval LISTS, so a reopened object is representable)
--
-- Consecutive same-state events are collapsed, so close-after-close and reopen-after-
-- reopen do not mint spurious intervals. An unclosed object gets `end = NULL`, which the
-- renderer draws as still-open — that is a fact, not missing data.
-- =====================================================================================

DROP VIEW IF EXISTS fe.interval_issue CASCADE;
CREATE VIEW fe.interval_issue AS
WITH lifecycle AS (
  SELECT repo_id, issue_id, event_id,
         activity_timestamp AT TIME ZONE 'UTC' AS t,
         CASE WHEN activity_type = 'IssueClosed' THEN 0 ELSE 1 END AS is_open
  FROM mv_issue_and_issuecomment_activities_full
  WHERE activity_type IN ('IssueOpened','IssueReopened','IssueClosed')
    AND issue_id IS NOT NULL
),
edges AS (
  SELECT *, lag(is_open) OVER w AS prev_open
  FROM lifecycle
  WINDOW w AS (PARTITION BY repo_id, issue_id ORDER BY t, event_id)
),
transitions AS (
  SELECT repo_id, issue_id, t, is_open,
         row_number() OVER (PARTITION BY repo_id, issue_id, is_open ORDER BY t, event_id) AS rn
  FROM edges
  WHERE prev_open IS DISTINCT FROM is_open
),
opens  AS (SELECT repo_id, issue_id, t AS start_t, rn FROM transitions WHERE is_open = 1),
closes AS (SELECT repo_id, issue_id, t AS end_t,   rn FROM transitions WHERE is_open = 0)
SELECT o.repo_id,
       o.issue_id,                    -- the natural key, exposed so §6 can filter on it:
                                      -- a qual on the window PARTITION BY column pushes
                                      -- through, one on the derived string cannot
       'issue:' || o.issue_id::text AS object_id,
       o.rn      AS interval_index,
       o.start_t AS start,
       c.end_t   AS "end"
FROM opens o
LEFT JOIN closes c
  ON c.repo_id = o.repo_id AND c.issue_id = o.issue_id AND c.rn = o.rn;

DROP VIEW IF EXISTS fe.interval_pull_request CASCADE;
CREATE VIEW fe.interval_pull_request AS
WITH lifecycle AS (
  -- PullRequestMergedOffPlatform is in the CLOSING set, not excluded: decision 48 removed
  -- the activity, and the GitHub fact underneath it — the PR was closed — is preserved
  -- exactly. Only the overlay went. Comment rows are not in this filter, so G9's bad
  -- pull_request_id never reaches here.
  SELECT repo_id, pull_request_id, event_id,
         activity_timestamp AT TIME ZONE 'UTC' AS t,
         CASE WHEN activity_type IN ('PullRequestMerged',
                                     'PullRequestMergedOffPlatform',
                                     'PullRequestClosed') THEN 0 ELSE 1 END AS is_open
  FROM mv_pull_request_and_comment_activities_full
  WHERE activity_type IN ('PullRequestOpened','PullRequestReopened','PullRequestMerged',
                          'PullRequestMergedOffPlatform','PullRequestClosed')
    AND pull_request_id IS NOT NULL
),
edges AS (
  SELECT *, lag(is_open) OVER w AS prev_open
  FROM lifecycle
  WINDOW w AS (PARTITION BY repo_id, pull_request_id ORDER BY t, event_id)
),
transitions AS (
  SELECT repo_id, pull_request_id, t, is_open,
         row_number() OVER (PARTITION BY repo_id, pull_request_id, is_open
                            ORDER BY t, event_id) AS rn
  FROM edges
  WHERE prev_open IS DISTINCT FROM is_open
),
opens  AS (SELECT repo_id, pull_request_id, t AS start_t, rn FROM transitions WHERE is_open = 1),
closes AS (SELECT repo_id, pull_request_id, t AS end_t,   rn FROM transitions WHERE is_open = 0)
SELECT o.repo_id,
       o.pull_request_id,             -- see fe.interval_issue
       'pr:' || o.pull_request_id::text AS object_id,
       o.rn      AS interval_index,
       o.start_t AS start,
       c.end_t   AS "end"
FROM opens o
LEFT JOIN closes c
  ON c.repo_id = o.repo_id AND c.pull_request_id = o.pull_request_id AND c.rn = o.rn;


-- =====================================================================================
-- §4 — Events
--
-- Normalises three row shapes into one, remapped then whitelisted (G12, G13).
-- Three branches, not six: reviews and commit comments are out of scope (decision 40) and
-- their MVs do not exist in this database anyway; `CommitsPushed` is not an activity
-- (decision 44) — the push's facts ride on each CommitObserved event's attrs instead.
-- =====================================================================================

DROP VIEW IF EXISTS fe.event CASCADE;
CREATE VIEW fe.event AS
WITH push_facts AS (
  -- decision 44 / G4: the DECLARED size must come from the push event's own columns and
  -- never from counting commit rows. GH Archive caps payload.commits at 20, so a push of
  -- 347 yields 20 rows here and any count over them reads 20 — a silent wrong number.
  SELECT activity_id, ref, commit_count, distinct_commit_count,
         (activity_payload->>'truncated')::boolean AS truncated
  FROM mv_push_activities
),
raw AS (
  ---------------------------------------------------------------------------------------
  -- 1. issue lifecycle + issue comments.
  --    `issue_id` is trustworthy on every row of this MV, so the object id is built
  --    directly. Rows whose issue_id is NULL (exactly 1, an `IssueComment_` fallback)
  --    are excluded; they would dangle.
  ---------------------------------------------------------------------------------------
  SELECT 'issue_act:' || a.event_id::text          AS id,
         fe.remap_activity(a.activity_type)        AS activity,
         a.activity_timestamp AT TIME ZONE 'UTC'   AS time,
         'issue:' || a.issue_id::text              AS object_id,
         'actor:' || a.actor_id::text              AS actor_id,
         a.actor_id                                AS actor_num,
         a.repo_id,
         '{}'::jsonb                               AS attrs
  FROM mv_issue_and_issuecomment_activities_full a
  WHERE a.issue_id IS NOT NULL

  UNION ALL
  ---------------------------------------------------------------------------------------
  -- 2. PR lifecycle + PR comments. Two hazards, and R1 is the one that bites silently.
  --
  --    G9 — comment rows carry payload->'issue'->>'id' in pull_request_id, a different
  --         number from the PR id. Measured: joining on pull_request_id leaves 1,343,072
  --         of 1,343,232 comment rows unjoinable (99.99%); joining on (repo_id, pr_number)
  --         leaves 87,598 (6.5%). So the join is on (repo_id, pr_number).
  --
  --    R1 — an earlier draft resolved that join against prs_identity, which is built from
  --         action='opened' only. Every PR opened before the window then lost all of its
  --         events while keeping its object, and drew as an empty lifecycle bar with
  --         nothing reporting it. Resolving against fe.object_pull_request — which HAS the
  --         first-seen fallback — closes it, and accounts for most of that residual 6.5%.
  --
  --    ⚠️ `o.id` is used for the object id, NOT a.pull_request_id, on lifecycle rows too.
  --       They agree there; using one column for both branches is what stops the two from
  --       drifting apart the next time someone edits this.
  ---------------------------------------------------------------------------------------
  SELECT 'pr_act:' || a.event_id::text,
         fe.remap_activity(a.activity_type),
         a.activity_timestamp AT TIME ZONE 'UTC',
         o.id,
         'actor:' || a.actor_id::text,
         a.actor_id,
         a.repo_id,
         '{}'::jsonb
  FROM mv_pull_request_and_comment_activities_full a
  JOIN fe.object_pull_request o
    ON o.repo_id = a.repo_id AND o.pr_number = a.pr_number
  WHERE a.pr_number IS NOT NULL

  UNION ALL
  ---------------------------------------------------------------------------------------
  -- 3. CommitObserved — SYNTHETIC. One per commit row; no upstream MV emits this activity
  --    (decision 44 documents it as synthetic). It carries the push's declared size so a
  --    burst can say "20 shown of 347 pushed" instead of quietly claiming 20.
  ---------------------------------------------------------------------------------------
  SELECT 'commit_obs:' || pc.event_id::text || ':' || pc.commit_index::text,
         'CommitObserved'::text,
         pc.created_at AT TIME ZONE 'UTC',
         'commit:' || pc.commit_sha,
         'actor:' || pc.actor_id::text,
         pc.actor_id,
         pc.repo_id,
         jsonb_strip_nulls(jsonb_build_object(
           'commit_count',          pf.commit_count,
           'distinct_commit_count', pf.distinct_commit_count,
           'truncated',             pf.truncated,
           'ref',                   COALESCE(pf.ref, pc.ref),
           'push_id',               pc.push_id))
  FROM mv_push_commits_full pc
  LEFT JOIN push_facts pf ON pf.activity_id = pc.event_id
  WHERE pc.commit_sha IS NOT NULL
)
SELECT r.id,
       r.activity,
       r.time,
       r.object_id,
       NULLIF(r.actor_id, 'actor:') AS actor_id,   -- 'actor:' || NULL is NULL already; this
                                                   -- guards the literal-empty case too
       r.actor_num,                 -- the same actor, numerically. Carried so §6 can look
                                    -- actors up on actor.id (a primary key) instead of
                                    -- re-parsing the prefix off the string form.
       r.repo_id,
       v.is_comment AS comment,
       v.landmark,
       r.attrs
FROM raw r
-- THE WHITELIST. Runs AFTER fe.remap_activity, which is the whole point: reversed, every
-- PullRequestCommented row is dropped as unknown before it can become IssueCommented.
-- §7.1 reports what this drops.
JOIN fe.activity_vocabulary v ON v.activity = r.activity;


-- =====================================================================================
-- §5 — Links
--
-- FOUR qualifiers (decision 43): resolves, contains_commit, merge_commit, references_issue.
-- No `delivered_by` and no off-platform branch (decision 48). No actor links — attribution
-- is single-sourced on event.actor_id (decision 41) and BOTH endpoints of a link are
-- object ids (decision 49).
--
-- ⚠️ `commit_message` is ONE method covering TWO relationships (decision 50): issue↔PR in
-- branch A, commit→issue in branch D. Any per-method figure MUST group by
-- (method, qualifier) or it silently sums two different relations — and the RQ2 detection
-- breakdown is exactly that figure. §7.4 does it correctly.
-- =====================================================================================

-- -------------------------------------------------------------------------------------
-- §5.0 — Where a commit was first introduced
--
-- Two facts per commit, both straight from `mv_push_commits_full` and neither consulted
-- by `mv_commit_pr_links`. They are what decision 61's `ref_match` narrowing tests.
--
--   introduced_new     GitHub's own `commit_distinct` flag: this push is the first time
--                      the repository saw this SHA. It is *GitHub's* judgement, not ours.
--   on_default_branch  the SHA has been pushed to master/main at some point.
-- -------------------------------------------------------------------------------------
DROP VIEW IF EXISTS fe.commit_branch_origin CASCADE;
CREATE VIEW fe.commit_branch_origin AS
SELECT p.repo_id,
       p.commit_sha,
       bool_or(p.commit_distinct)                                    AS introduced_new,
       bool_or(p.ref IN ('refs/heads/master','refs/heads/main'))      AS on_default_branch
FROM mv_push_commits_full p
WHERE p.commit_sha IS NOT NULL
GROUP BY p.repo_id, p.commit_sha;

COMMENT ON VIEW fe.commit_branch_origin IS
  'Per commit: was this push the first sighting of the SHA (GitHub commit_distinct), and '
  'has the SHA ever been pushed to master/main. Inputs to the ref_match narrowing, '
  'decision 61.';


-- -------------------------------------------------------------------------------------
-- §5.0b — The narrowed commit→PR relation (decision 61), as ONE named view.
--
-- It exists as a view rather than inline because **two different link families depend on
-- it**, and the first version of decision 61 only narrowed one of them. Branch B is the
-- commit→PR link itself; branch A's `commit_message` issue↔PR links are *derived* from
-- commit→PR attribution upstream and inherited the wide rule. One definition, consumed
-- twice, is what stops those two from drifting apart again.
-- -------------------------------------------------------------------------------------
DROP VIEW IF EXISTS fe.commit_pr_link CASCADE;
CREATE VIEW fe.commit_pr_link AS
SELECT l.repo_id, l.commit_sha, l.pull_request_id, l.pr_number, l.link_method
FROM mv_commit_pr_links l
LEFT JOIN fe.commit_branch_origin o
  ON o.repo_id = l.repo_id AND o.commit_sha = l.commit_sha
WHERE l.admitted
  AND (l.link_method IN ('head_sha','merge_commit_sha')
       OR (COALESCE(o.introduced_new, false) AND NOT COALESCE(o.on_default_branch, false)));

COMMENT ON VIEW fe.commit_pr_link IS
  'mv_commit_pr_links with the decision-61 ref_match narrowing applied. The single source '
  'of commit-to-PR attribution in this layer — fe.link branches A and B both read it.';


DROP VIEW IF EXISTS fe.link CASCADE;
CREATE VIEW fe.link AS
WITH
-- Which (issue, PR) pairs a `commit_message` link can still stand on, once commit→PR
-- attribution is narrowed. See the note on branch A.
-- ⚠️ Both CTEs are MATERIALIZED, and that is not a hint — it is the difference between
-- a sub-second view and a nine-minute one. `resolved` tests them with correlated
-- EXISTS / NOT EXISTS over 18,673 rows; without MATERIALIZED the planner re-derives
-- cm_support (which walks fe.commit_pr_link, ~380 ms) for each of them.
cm_mention AS MATERIALIZED (
  -- issues that `mv_commit_message_issue_links_all` can speak about at all, per repo
  SELECT DISTINCT source_repo_id AS repo_id, issue_number
  FROM mv_commit_message_issue_links_all
),
cm_support AS MATERIALIZED (
  -- ... and the (issue, PR) pairs where a commit we STILL admit carries the mention
  SELECT DISTINCT c.source_repo_id AS repo_id, c.issue_number, n.pull_request_id
  FROM mv_commit_message_issue_links_all c
  JOIN fe.commit_pr_link n
    ON n.repo_id = c.source_repo_id AND n.commit_sha = c.commit_sha
),
-- Branch A's method list, with an unsupported `commit_message` removed and the primary
-- method recomputed. Pairs left with no method at all drop out entirely.
resolved AS (
  SELECT v.repo_id, v.issue_id, v.pull_request_id,
         CASE
           WHEN 'commit_message' = ANY(string_to_array(v.link_methods, ';'))
            AND EXISTS (SELECT 1 FROM cm_mention m
                        WHERE m.repo_id = v.repo_id AND m.issue_number = v.issue_number)
            AND NOT EXISTS (SELECT 1 FROM cm_support s
                        WHERE s.repo_id = v.repo_id AND s.issue_number = v.issue_number
                          AND s.pull_request_id = v.pull_request_id)
           THEN array_remove(string_to_array(v.link_methods, ';'), 'commit_message')
           ELSE string_to_array(v.link_methods, ';')
         END AS methods
  FROM mv_issue_to_pr_validated_all v
  WHERE v.issue_id IS NOT NULL AND v.pull_request_id IS NOT NULL
)
-- A. PR resolves Issue — from the upstream union, already deduped to one row per pair.
--    O11 is closed (decision 53): ALL SEVEN upstream methods here are issue↔PR, including
--    closed_via_commit and proximity. Neither carries a commit_sha column.
--    ⚠️ **DECISION 62 — the narrowing reaches this branch too, and it did not at first.**
--    `mv_issue_pr_links_commit_message` is defined as
--        JOIN mv_commit_pr_links cpr ON ... AND cpr.admitted
--    so its issue↔PR links are *derived from commit→PR attribution* — under the WIDE rule.
--    Decision 61 narrowed branch B and left this branch reading the old attribution, which
--    meant the fix looked complete while more than half the issue↔PR links still rested on
--    trunk commits that merely passed through a branch. On vscode PR #116416 that was all
--    11 of its issue links: 23 issues mentioned under the wide attribution, **0** surviving.
--
--    `resolved` above re-tests each `commit_message` method against fe.commit_pr_link and
--    strips it when unsupported, then this branch recomputes the primary method from what
--    is left. A pair whose only method was `commit_message` disappears.
--
--    ⚠️ **The test is deliberately conservative — it removes only what it can positively
--    disprove.** The two upstream views parse commit messages differently:
--    `mv_issue_pr_links_commit_message` matches `fix|close|resolve #N`, while
--    `mv_commit_message_issue_links_all` covers several conventions, and 280 of 26,057
--    upstream mentions (1.1%) have no row in the latter at all. For those the support
--    table cannot adjudicate, so the `cm_mention` guard keeps the link rather than
--    dropping it for a reason that is really a parser difference. Erring the other way
--    would delete valid links and call it rigour.
SELECT 'pr:'    || r.pull_request_id::text AS source,
       'issue:' || r.issue_id::text        AS target,
       'resolves'::text                    AS qualifier,
       -- R4: validated if ANY method validates it, matching classifyLink in
       -- src/model/evidence.js. Testing primary_link_method alone drew well-evidenced
       -- links dashed with a "?", understating exactly the S8 confidence cue the tool
       -- exists to show. The validated set here is the issue↔PR half of
       -- VALIDATED_METHODS; head_sha / merge_commit_sha cannot occur in this branch.
       CASE WHEN r.methods && ARRAY['pr_body','closed_via_commit']
            THEN 'validated' ELSE 'extracted' END          AS evidence,
       -- The primary method, recomputed: upstream's own priority order, applied to
       -- whatever survived. Carrying `v.primary_link_method` through would name a method
       -- the link no longer has.
       (ARRAY(SELECT m FROM unnest(ARRAY['pr_body','pr_title','commit_message',
                                         'issue_comment','branch_name',
                                         'closed_via_commit','proximity']) m
               WHERE m = ANY(r.methods)))[1]               AS method,
       array_length(r.methods, 1)                          AS n_methods,
       -- R6: an ARRAY (ADAPTER_AND_API.md §4). Upstream stores it semicolon-joined.
       r.methods                                           AS link_methods,
       r.repo_id
FROM resolved r
WHERE array_length(r.methods, 1) > 0

UNION ALL
-- A2. Extended conventions — the 205 rows mv_issue_to_pr_validated_all does NOT union.
--     R3: the NOT EXISTS is the whole point. Without it an overlapping pair is emitted
--     twice — double-counted in every link figure, drawn twice, and reading as two methods
--     corroborating each other when it is one link recorded once. Measured 2026-08-04 the
--     overlap is currently ZERO, so this guard protects future refreshes rather than
--     correcting present data; that is a reason to keep it, not to drop it.
SELECT 'pr:' || x.pull_request_id::text,
       'issue:' || x.issue_id::text,
       'resolves',
       'extracted',                    -- every extended convention is a parsed convention
       x.link_method,
       1,
       ARRAY[x.link_method],
       x.repo_id
FROM mv_issue_pr_links_extended_conventions x
WHERE x.issue_id IS NOT NULL AND x.pull_request_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM mv_issue_to_pr_validated_all v
    WHERE v.repo_id = x.repo_id
      AND v.issue_id = x.issue_id
      AND v.pull_request_id = x.pull_request_id)

UNION ALL
-- B. PR contains Commit / merged as Commit.
--    `admitted` is the INHERITED commit→PR admission rule (decision 52, O2 closed): not
--    the repo's default branch as head, under 250 candidate commits, and first pushed
--    within [pr_created_at − 7 days, pr_ended_at]. Quote the MV refresh timestamp beside
--    any figure resting on it.
--
--    ⚠️ AGGREGATED per (commit, PR), not one row per upstream row. mv_commit_pr_links
--    holds ONE ROW PER MATCHING METHOD, so a commit matched by both head_sha and
--    ref_match yields two rows — and both map to the qualifier `contains_commit`, so
--    emitting them raw puts the SAME pair in the payload twice with the same qualifier.
--    Measured 2026-08-04: 5,111 such groups. That is SPEC R3's defect arriving through a
--    branch R3 never looked at, and it fails the "no pair linked twice" sanity check.
--
--    Aggregating rather than DISTINCT-ing is the better fix and not merely a tidier one:
--    it recovers real multi-method agreement into n_methods / link_methods, which is what
--    decision 20 asks the tooltip to show and what classifyLink already knows how to
--    read. `merge_commit` wins the qualifier when it is present, because being the PR's
--    merge commit is the more specific relationship than being one of its commits.
SELECT 'pr:' || b.pull_request_id::text,
       'commit:' || b.commit_sha,
       CASE WHEN 'merge_commit_sha' = ANY(b.methods) THEN 'merge_commit'
            ELSE 'contains_commit' END,
       -- validated if ANY method validates (classifyLink, src/model/evidence.js).
       -- ref_match alone is a branch-naming convention and stays extracted.
       CASE WHEN b.methods && ARRAY['merge_commit_sha','head_sha'] THEN 'validated'
            ELSE 'extracted' END,
       -- the primary method, strongest first — same ordering the evidence rule uses
       COALESCE(
         (ARRAY(SELECT m FROM unnest(ARRAY['merge_commit_sha','head_sha','ref_match']) m
                 WHERE m = ANY(b.methods)))[1],
         b.methods[1]),
       array_length(b.methods, 1),
       b.methods,
       b.repo_id
-----------------------------------------------------------------------------------------
--    ⚠️ Reads fe.commit_pr_link — the DECISION 61 narrowing, defined once in §5.0b.
--
--    SHA matches are identity and pass untouched. `ref_match` is admitted only where the
--    commit was FIRST INTRODUCED on a branch that is not master/main.
--
--    The defect it fixes. `ref_match` means "pushed to this PR's head branch while the PR
--    was open", which is the right question — GH Archive's PR payload never lists a PR's
--    commits, so it is the ONLY evidence most of them have. But merging master into a
--    long-lived branch re-enumerates every incoming trunk commit in that push, and all of
--    them are then attributed to the PR. On vscode PR #116416: 217 ref_match commits, of
--    which **179 were already on master**, 4 were re-pushes, **34 were the branch's work**.
--
--    ⚠️ It is a FLOOR, not a count. `commit_distinct = false` also catches a legitimate
--    force-push or rebase of the author's own commit, so this under-counts. Raw ref_match
--    is the ceiling. Report a range, never a point estimate.
--
--    ⚠️ Why not SHA-only, which was the first instinct and is wrong. `head_sha` and
--    `merge_commit_sha` do not describe a PR's contents — they are the branch tip at the
--    moment an event fired, plus the merge commit. Measured: they average 1.00 and 1.07
--    commits per PR across the whole dataset, ceilings of 2 and 6. SHA-only therefore
--    reports ~1-2 commits for every PR in the database regardless of its real size,
--    orphaning ~33,000 vscode commits that have no SHA link at all. Uniform because
--    degenerate, not because accurate.
-----------------------------------------------------------------------------------------
FROM (
  SELECT l.repo_id, l.commit_sha, l.pull_request_id,
         array_agg(DISTINCT l.link_method) AS methods
  FROM fe.commit_pr_link l
  GROUP BY l.repo_id, l.commit_sha, l.pull_request_id
) b

UNION ALL
-- D. Commit references Issue.
--    R1 again: resolved against fe.object_issue, not issues_identity, or every issue
--    opened before the window loses its commit links while still being on screen.
--    R9 answered as decision 54: cross-repo references are DROPPED, and the reason is not
--    that they are weak. mv_commit_message_issue_links_all carries source_repo_id,
--    issue_number and ref_scope and NO TARGET REPO ID, so for a cross_repo row nothing
--    says which repository the referenced issue lives in. Joining on source_repo_id — the
--    only id available — would bind the reference to whichever issue holds that number in
--    the SOURCE repo, which is a fabricated link rather than a weak one. 1,074 of 44,792
--    rows (2.4%) are dropped; it is a limitation of the upstream view and belongs in the
--    thesis as one.
--
--    ⚠️ DEDUPLICATED. mv_commit_message_issue_links_all carries one row per (commit,
--    issue-reference, PUSH) — the same commit re-pushed on a rebase or a merge produces
--    another row for the same reference. Measured 2026-08-04: 9,295 duplicate groups,
--    16,040 surplus rows. Emitted raw, one commit→issue relationship is drawn four or five
--    times, counted that many times in every RQ2 figure, and fails the "no pair linked
--    twice by the same qualifier" check. This is SPEC R3's defect in a second branch.
SELECT DISTINCT
       'commit:' || c.commit_sha,
       o.id,
       'references_issue',
       'extracted',                    -- a regex over free text; GitHub asserts nothing
       'commit_message',
       1,
       ARRAY['commit_message'],
       c.source_repo_id
FROM mv_commit_message_issue_links_all c
JOIN fe.object_issue o
  ON o.repo_id = c.source_repo_id AND o.issue_number = c.issue_number
WHERE c.ref_scope = 'same_repo';


-- -------------------------------------------------------------------------------------
-- §5.1 — fe.link_mat: the ONE materialization in this layer, and the measurement for it
--
-- Decision 10 makes materializing a finding rather than a default, so here is the finding.
-- OCEL_TOOL_SPEC.md named fe.link as one of two candidates "if measured"; this is the
-- measurement, taken 2026-08-04 on the vscode sub-log seeded at issue:2902032454, degree 2.
--
--   whole request, no indexes at all                        19.4 s
--   + indexes on the underlying MVs (§0)                     ~16 s
--   + repo's links built once instead of twice                ~15 s
--   + fe.object_actor from the actor base table                7.0 s
--   + traversal reduced to typed key arrays (§6 step 1)        4.3 s
--   + fe.link_mat (this view)                                  1.7 s   <- 2.5x, and the
--                                                                         reason it stays
--
-- Why this one and nothing else. Every other relation in the layer is reachable by an
-- index once the filter is a natural key — the object views answer in 1.5 ms. fe.link is
-- the exception, because the TRAVERSAL cannot filter it: to find what the seed reaches it
-- must have the whole repository's adjacency, and building that means running all four
-- branches, one of which (D) derives every issue object in the repository. There is no
-- predicate that makes it smaller, so the only lever left is precomputation.
--
-- What it costs, stated plainly rather than buried:
--   * 231,291 rows for the whole database — small, unlike the MVs underneath it.
--   * A REFRESH OBLIGATION. It is stale from the moment any upstream MV refreshes until
--     `SELECT fe.refresh_links()` runs. `fe.diag_link_staleness` below reports the drift
--     rather than leaving it to be discovered in a figure.
--   * fe.link (the plain view) remains the definition and is what §7's diagnostics read,
--     so a divergence shows up as a diagnostic disagreeing with the payload, which is a
--     visible failure rather than a silent one.
-- -------------------------------------------------------------------------------------

DROP MATERIALIZED VIEW IF EXISTS fe.link_mat CASCADE;
CREATE MATERIALIZED VIEW fe.link_mat AS SELECT * FROM fe.link WITH DATA;

CREATE INDEX IF NOT EXISTS ix_linkmat_repo_source ON fe.link_mat (repo_id, source);
CREATE INDEX IF NOT EXISTS ix_linkmat_repo_target ON fe.link_mat (repo_id, target);
CREATE INDEX IF NOT EXISTS ix_linkmat_repo        ON fe.link_mat (repo_id);
ANALYZE fe.link_mat;

CREATE OR REPLACE FUNCTION fe.refresh_links() RETURNS void
LANGUAGE sql AS $$
  REFRESH MATERIALIZED VIEW fe.link_mat;
$$;

COMMENT ON MATERIALIZED VIEW fe.link_mat IS
  'Materialized copy of fe.link. The ONE measured materialization (decision 57). Run '
  'fe.refresh_links() after any upstream MV refresh; fe.diag_link_staleness reports drift.';

-- Cheap drift check: compares the materialized copy against the live view. Not free, but
-- it is a diagnostic, not a request path.
CREATE OR REPLACE VIEW fe.diag_link_staleness AS
SELECT (SELECT count(*) FROM fe.link)     AS live_rows,
       (SELECT count(*) FROM fe.link_mat) AS materialized_rows,
       (SELECT count(*) FROM fe.link) - (SELECT count(*) FROM fe.link_mat) AS drift;


-- =====================================================================================
-- §6 — The RPC
--
--   api.get_object_graph(repo, seed, traversal_degree)
--
-- Never `get_case`. There is no case notion (decision 1, CLAUDE.md): the API returns a
-- SUB-LOG described by the query that produced it, not identified by a key.
--
-- ⚠️ `traversal_degree` is SERVER-SIDE — how far the graph is expanded before it is sent.
-- It is unrelated to MAX_FOCUS_DEGREE in src/model/graph.js, which caps the client-side
-- BFS deciding what is HIGHLIGHTED inside an already-loaded sub-log (SPEC R8). CLAUDE.md
-- names these two as the pair never to conflate.
-- =====================================================================================

CREATE OR REPLACE FUNCTION api.get_object_graph(
  repo             text,
  seed             text,
  traversal_degree integer DEFAULT 2
) RETURNS jsonb
LANGUAGE plpgsql STABLE AS $fn$
DECLARE
  _repo_id  bigint;
  _repo_nm  text;
  _n_named  integer;
  _obj_ids  text[];
  _issue_ids bigint[];
  _pr_ids   bigint[];
  _shas     text[];
  _payload  jsonb;
BEGIN
  IF traversal_degree IS NULL OR traversal_degree < 0 THEN
    RAISE EXCEPTION 'traversal_degree must be >= 0, got %', traversal_degree;
  END IF;

  ------------------------------------------------------------------------------------
  -- Resolve the repository BY NAME. This is the second of CLAUDE.md's two dated
  -- exceptions to identity-by-id, and it is load-bearing that it be deterministic:
  -- repo.name is NOT unique in this database — 'kubernetes/kubernetes' resolves to both
  -- 20580498 (2.4M events) and 40511817 (1 event). Ties break on event volume, and the
  -- ambiguity is reported back in meta.repo_ambiguous rather than hidden.
  ------------------------------------------------------------------------------------
  SELECT r.id, r.name, count(*) OVER ()
    INTO _repo_id, _repo_nm, _n_named
  FROM repo r
  WHERE r.name = repo
  ORDER BY (SELECT count(*) FROM event e WHERE e.repo_id = r.id) DESC, r.id
  LIMIT 1;

  IF _repo_id IS NULL THEN
    RAISE EXCEPTION 'no repository named %', repo
      USING HINT = 'SELECT name FROM repo — this database holds three with data.';
  END IF;

  ------------------------------------------------------------------------------------
  -- STEP 0 — does the seed name a real object in this repository?
  --
  -- ⚠️ This must be checked HERE and cannot be inferred later, which is the mistake the
  -- first version made. The traversal seeds `reach` with the literal string, so `reached`
  -- always contains at least the seed itself whether or not it exists — testing it for
  -- emptiness therefore never fires. What came back instead was a structurally valid,
  -- completely empty payload: no objects, no events, no links. That renders as a blank
  -- timeline and reads as "this repository has no process", which is the wrong-picture-
  -- no-error failure this whole layer is built to avoid. A seed naming nothing is a query
  -- error and must say so.
  --
  -- Decoded rather than compared as a string: `o.id = seed` is a qual on a derived
  -- expression and would build the whole object view (~500 ms), while a qual on the
  -- natural key reaches the index (~1.5 ms).
  ------------------------------------------------------------------------------------
  IF NOT (CASE
      WHEN seed ~ '^issue:[0-9]+$'  THEN EXISTS (SELECT 1 FROM fe.object_issue o
             WHERE o.repo_id = _repo_id AND o.issue_id = substring(seed from 7)::bigint)
      WHEN seed ~ '^pr:[0-9]+$'     THEN EXISTS (SELECT 1 FROM fe.object_pull_request o
             WHERE o.repo_id = _repo_id AND o.pull_request_id = substring(seed from 4)::bigint)
      WHEN seed ~ '^commit:[0-9a-f]+$' THEN EXISTS (SELECT 1 FROM fe.object_commit o
             WHERE o.repo_id = _repo_id AND o.commit_sha = substring(seed from 8))
      ELSE false
    END) THEN
    RAISE EXCEPTION 'seed % is not an issue, pull request or commit in %', seed, repo
      USING HINT = 'Object ids are type-prefixed and carry the DATABASE id, not the '
                || 'display number (decision 51): issue:<issue_id>, pr:<pull_request_id>, '
                || 'commit:<sha>. To resolve #242864, look it up: SELECT id FROM '
                || 'fe.object_issue WHERE repo_id = <id> AND issue_number = 242864. '
                || 'An actor cannot be a seed — actors are not traversed (decision 41).';
  END IF;

  ------------------------------------------------------------------------------------
  -- STEP 1 — the traversal, run on its own and reduced to typed key arrays.
  --
  -- `adj` is bidirectional because a link is an undirected traceability edge for
  -- reachability purposes, even though it keeps its direction in the payload.
  --
  -- ⚠️ `reached` (min(hop) GROUP BY id) is REQUIRED, not tidying. Because adj is
  -- bidirectional the seed is reachable from itself at hop 2, and UNION in a recursive
  -- CTE dedupes on (id, hop) rather than on id — so every object would appear once per
  -- hop count and multiply through obj → ev, duplicating events and yielding a
  -- multi-element meta.seed.
  --
  -- ⚠️ Why this is a SEPARATE STATEMENT that ends in arrays, rather than one more CTE in
  -- the assembly below. It is the difference between a 7 s request and a fast one, and
  -- the reason is worth writing down because it will be tempting to merge them again.
  --
  -- Object ids are derived strings — `'issue:' || issue_id` — so a qual on `o.id` is a
  -- qual on an expression, and the planner cannot push it into the object views. Joining
  -- the views against a 4-row `reached` CTE therefore built EVERY object in the
  -- repository and hash-joined four rows against it: 146,654 issues, 115,289 commits,
  -- twice over. A qual on the NATURAL key does push down, all the way to the index —
  -- measured at 1.5 ms per object view against 500 ms for the whole-view build.
  --
  -- Passing the keys as plpgsql arrays and testing `= ANY(...)` is what makes them plain
  -- restriction clauses rather than joins or sub-selects, which is what makes them
  -- pushable. Hence: traverse, decode, then assemble.
  ------------------------------------------------------------------------------------
  WITH RECURSIVE
  -- The repository's links, computed EXACTLY ONCE and reused by both directions of `adj`.
  --
  -- ⚠️ `adj` used to select from fe.link twice, once per direction, and the planner
  -- obliged by building the whole four-branch view twice — including branch D, which
  -- joins fe.object_issue and so re-derives every issue object in the repository.
  repo_link AS MATERIALIZED (
    SELECT source, target FROM fe.link_mat WHERE repo_id = _repo_id
  ),
  adj AS MATERIALIZED (
    SELECT source AS a, target AS b FROM repo_link
    UNION ALL
    SELECT target,      source   FROM repo_link
  ),
  reach AS (
    SELECT seed AS id, 0 AS hop
    UNION
    SELECT adj.b, reach.hop + 1
    FROM reach JOIN adj ON adj.a = reach.id
    WHERE reach.hop < traversal_degree
  ),
  reached AS (
    SELECT id, min(hop) AS hop FROM reach GROUP BY id
  )
  SELECT array_agg(id),
         array_agg(substring(id from 7)::bigint) FILTER (WHERE id LIKE 'issue:%'),
         array_agg(substring(id from 4)::bigint) FILTER (WHERE id LIKE 'pr:%'),
         array_agg(substring(id from 8))         FILTER (WHERE id LIKE 'commit:%')
    INTO _obj_ids, _issue_ids, _pr_ids, _shas
  FROM reached;

  -- Step 0 has already established the seed exists, so this can only be a genuinely
  -- unreachable state; failing loudly beats returning an empty picture.
  IF _obj_ids IS NULL THEN
    RAISE EXCEPTION 'traversal from seed % returned nothing', seed;
  END IF;

  _issue_ids := COALESCE(_issue_ids, '{}');
  _pr_ids    := COALESCE(_pr_ids,    '{}');
  _shas      := COALESCE(_shas,      '{}');

  ------------------------------------------------------------------------------------
  -- STEP 2 — assembly. Every filter below is `= ANY(<array>)` on a natural key, so it
  -- reaches an index rather than building a view and discarding it.
  ------------------------------------------------------------------------------------
  WITH
  obj AS MATERIALIZED (
    SELECT o.id, o.type, o.label, o.vmap, o.time_semantics, NULL::timestamptz AS t0
      FROM fe.object_issue o
     WHERE o.repo_id = _repo_id AND o.issue_id = ANY(_issue_ids)
    UNION ALL
    SELECT o.id, o.type, o.label, o.vmap, o.time_semantics, NULL
      FROM fe.object_pull_request o
     WHERE o.repo_id = _repo_id AND o.pull_request_id = ANY(_pr_ids)
    UNION ALL
    SELECT o.id, o.type, o.label, o.vmap, o.time_semantics, o.t0
      FROM fe.object_commit o
     WHERE o.repo_id = _repo_id AND o.commit_sha = ANY(_shas)
  ),
  ev AS MATERIALIZED (
    SELECT e.* FROM fe.event e
    WHERE e.repo_id = _repo_id AND e.object_id = ANY(_obj_ids)
  ),
  -- ACTORS ARE NOT TRAVERSED. They are pulled in by whichever events survive — which is
  -- what the sidebar and the actor card want, and is the only scope that makes sense now
  -- that fe.object_actor is global. Traversing them would explode the sub-log: one
  -- maintainer connects to thousands of objects at a single hop. It is also why there are
  -- no actor links to traverse in the first place (decision 41).
  --
  -- Joined on `actor_num` against `actor.id`, a primary key, rather than on the prefixed
  -- string: an `IN` over the string form cannot use the index and made the planner build
  -- every actor before keeping six.
  act AS MATERIALIZED (
    SELECT a.* FROM fe.object_actor a
    WHERE a.actor_id IN (SELECT DISTINCT actor_num FROM ev WHERE actor_num IS NOT NULL)
  ),
  iv AS MATERIALIZED (
    SELECT object_id, start, "end" FROM fe.interval_issue
     WHERE repo_id = _repo_id AND issue_id = ANY(_issue_ids)
    UNION ALL
    SELECT object_id, start, "end" FROM fe.interval_pull_request
     WHERE repo_id = _repo_id AND pull_request_id = ANY(_pr_ids)
    UNION ALL
    -- A commit is observed at an instant, so its interval is a point: start = end. Not
    -- end = NULL, which the renderer reads as "still open" and metrics.js counts as an
    -- unfinished lifetime.
    --
    -- ⚠️ ONE interval, from the object's own first-seen time — NOT one per CommitObserved
    -- event. A commit re-pushed on a rebase or a merge is genuinely observed several
    -- times and genuinely gets several events, but it is still one object with one
    -- birth. Deriving the interval from the events gave the vscode commit eb70000 FOUR
    -- point-intervals; since layout/nodes.js:136 positions a commit at intervals[0].start
    -- the extras drew nothing and simply lied in the payload, which is the shape of
    -- failure this project cannot afford.
    SELECT o.id, o.t0, o.t0
      FROM obj o WHERE o.type = 'commit' AND o.t0 IS NOT NULL
    -- Actors get NO intervals. They have no lane (decision 15), so a span would draw
    -- nothing; `[]` is the honest value and is what all 13 fixtures carry.
  ),
  all_obj AS MATERIALIZED (
    SELECT id, type, label, vmap, time_semantics FROM obj
    UNION ALL
    SELECT id, type, label, vmap, time_semantics FROM act
  ),
  -- The sub-log's links, computed ONCE and reused by `links` and `active_link_methods`.
  -- An earlier version selected from fe.link separately for each, rebuilding all 231,291
  -- rows across every repository both times.
  --
  -- BOTH endpoints must be in the sub-log, or the payload carries a dangling reference
  -- the validator rejects by name (decision 49).
  sublog_link AS MATERIALIZED (
    SELECT l.* FROM fe.link_mat l
    WHERE l.repo_id = _repo_id
      AND l.source = ANY(_obj_ids)
      AND l.target = ANY(_obj_ids))
  SELECT jsonb_build_object(
    'meta', jsonb_build_object(
       -- R5: from the repo table. base_repo_full_name is the wrong source
       -- (DATA_CONTRACT.md §1) and is NULL for any repository with no pull requests.
       'repo',             _repo_nm,
       'repo_id',          _repo_id,
       'repo_ambiguous',   (_n_named > 1),
       -- decision 45: every payload source declares the contract it was built against,
       -- so a stale consumer fails loudly instead of rendering subtly wrong.
       'contract_version', 2,
       'seed',             COALESCE((SELECT jsonb_agg(jsonb_build_object('id', o.id, 'type', o.type))
                                     FROM all_obj o WHERE o.id = seed), '[]'::jsonb),
       'traversal_degree', traversal_degree,
       'active_object_types', COALESCE((SELECT jsonb_agg(DISTINCT o.type) FROM all_obj o), '[]'::jsonb),
       'active_link_methods', COALESCE((SELECT jsonb_agg(DISTINCT m)
                                        FROM sublog_link l, unnest(l.link_methods) m), '[]'::jsonb),
       'generated_at',     fe.utc(now()),
       'activity_scope',   'OCEL-strict + comments (reviews/dismissals/review-comments excluded)',
       'data_honesty', jsonb_build_object(
          'commit_time',     'first-seen in PushEvent, NOT real git commit time',
          'extracted_edges', 'Links we parsed from an unenforced human convention '
                          || '(branch-ref matches, commit-message references, timing '
                          || 'proximity) render dashed with a "?" badge.',
          'validated_edges', 'Links the platform''s own data asserts (a closing keyword '
                          || 'in the PR body, an exact SHA match) render solid.',
          'truncation',      'GH Archive caps PushEvent.commits at 20; events with '
                          || 'attrs.truncated = true describe a push with more commits '
                          || 'than are drawn.',
          'commit_authorship', 'vmap.commit_author_name is a git identity string and is '
                          || 'NOT joined to any GitHub account (decision 5). The actor on '
                          || 'a CommitObserved event is the PUSHER.'),
       'source', jsonb_build_object(
          'rpc',          'api.get_object_graph',
          'layer',        'sql/fe_layer.sql',
          'mv_refreshed', '2026-08-02T19:45:00+00:00')
    ),
    'objects', COALESCE((
       SELECT jsonb_agg(jsonb_build_object(
         'id', x.id, 'type', x.type, 'label', x.label, 'repo', _repo_nm,
         'time_semantics', x.time_semantics, 'vmap', x.vmap,
         'intervals', COALESCE((
            SELECT jsonb_agg(jsonb_build_object('start', fe.utc(iv.start), 'end', fe.utc(iv."end"))
                             ORDER BY iv.start)
            FROM iv WHERE iv.object_id = x.id), '[]'::jsonb)
       ) ORDER BY x.type, x.id)
       FROM all_obj x), '[]'::jsonb),
    'events', COALESCE((
       SELECT jsonb_agg(jsonb_build_object(
         'id', e.id, 'activity', e.activity, 'time', fe.utc(e.time),
         'object_id', e.object_id, 'actor_id', e.actor_id, 'repo', _repo_nm,
         'comment', e.comment, 'attrs', e.attrs) ORDER BY e.time, e.id)
       FROM ev e), '[]'::jsonb),
    'links', COALESCE((
       SELECT jsonb_agg(jsonb_build_object(
         'source', l.source, 'target', l.target, 'qualifier', l.qualifier,
         'evidence', l.evidence, 'method', l.method,
         'n_methods', l.n_methods, 'link_methods', to_jsonb(l.link_methods)))
       FROM sublog_link l), '[]'::jsonb)
  ) INTO _payload;

  RETURN _payload;
END;
$fn$;

COMMENT ON FUNCTION api.get_object_graph(text, text, integer) IS
  'Returns one ObjectGraph sub-log (docs/ADAPTER_AND_API.md §4). Seed is a prefixed object '
  'id: issue:<id>, pr:<id>, commit:<sha>. traversal_degree is SERVER-SIDE expansion and is '
  'unrelated to MAX_FOCUS_DEGREE. There is no case notion (decision 1).';


-- =====================================================================================
-- §7 — Diagnostics
--
-- These are obligations, not extras. Each view above subtracts something, and CLAUDE.md /
-- decision 27 require every subtraction to be declared rather than absorbed. Run after
-- every upstream refresh.
-- =====================================================================================

-- §7.1 — what the vocabulary whitelist drops, WITH the remap already applied.
-- Without the remap this reports PullRequestCommented as "not covered" when it is in fact
-- kept, which is the misreading that makes someone "fix" it in the wrong direction.
--
-- Reading it, as of 2026-08-04. Three rows, and only one of them is large:
--
--   CommitsPushed   144,556   EXPECTED, and not data loss. Decision 44 rejected it as an
--                             activity; its facts — commit_count, distinct_commit_count,
--                             truncated, ref — ride on each CommitObserved event's attrs
--                             instead, so the information is carried, not dropped. This
--                             row will always be here and should not be "fixed".
--   IssueComment_         1   The G13 fallback firing on an empty action. Genuinely dropped.
--   IssueLabeled          1   Out of scope (decision 40). Genuinely dropped.
--
-- Note what is NOT here: PullRequestCommented (1,343,232) and
-- PullRequestMergedOffPlatform (31), because the remap ran first and both survived it.
-- Their absence from this list is the evidence that the ordering is right.
CREATE OR REPLACE VIEW fe.diag_dropped_activities AS
SELECT fe.remap_activity(activity_type) AS activity_after_remap, count(*) AS dropped
FROM (
  SELECT activity_type FROM mv_issue_and_issuecomment_activities_full
  UNION ALL SELECT activity_type FROM mv_pull_request_and_comment_activities_full
  UNION ALL SELECT activity_type FROM mv_push_activities
) s
WHERE fe.remap_activity(activity_type) NOT IN (SELECT activity FROM fe.activity_vocabulary)
GROUP BY 1 ORDER BY 2 DESC;

-- §7.2 — PR comment events with no resolvable pull request (§2's 1,999 comment-only PRs).
-- These are dropped from fe.event because no numeric PR id for them exists in this
-- database. Reported so the loss is a number rather than a silence.
CREATE OR REPLACE VIEW fe.diag_unresolvable_pr_comments AS
SELECT a.repo_id,
       count(*)                    AS dropped_events,
       count(DISTINCT a.pr_number) AS dropped_pull_requests
FROM mv_pull_request_and_comment_activities_full a
WHERE a.activity_type LIKE 'PullRequestComment%'
  AND NOT EXISTS (SELECT 1 FROM mv_pull_request_events_full p
                  WHERE p.repo_id = a.repo_id AND p.pr_number = a.pr_number)
GROUP BY 1;

-- §7.3 — how many objects needed the first-seen fallback. Decision 46 requires this be
-- RENDERED, not merely carried: open-ended left edge, hollow start marker.
CREATE OR REPLACE VIEW fe.diag_time_semantics AS
SELECT repo_id, type, time_semantics, count(*) AS objects
FROM (
  SELECT repo_id, type, time_semantics FROM fe.object_issue
  UNION ALL SELECT repo_id, type, time_semantics FROM fe.object_pull_request
) s
GROUP BY 1,2,3 ORDER BY 1,2,3;

-- §7.4 — the RQ2 link breakdown, GROUPED BY (method, qualifier).
-- ⚠️ Decision 50 makes this grouping binding. `commit_message` is one detection technique
-- covering two relationships — issue↔PR (`resolves`) and commit→issue (`references_issue`)
-- — so grouping by method alone silently sums two different relations into one number,
-- and this is precisely the figure where that would happen.
-- Report `proximity` separately: nothing is asserted and nothing is parsed, only two
-- timestamps are near each other, so a coverage figure carried by it is a weaker claim.
CREATE OR REPLACE VIEW fe.diag_link_methods AS
SELECT l.repo_id, l.method, l.qualifier, l.evidence, count(*) AS links
FROM fe.link l
GROUP BY 1,2,3,4 ORDER BY 1,5 DESC;

-- §7.6 — what the decision-61 `ref_match` narrowing removes, and what it saves.
--
-- Reported because the narrowing is the one place we diverge from the upstream
-- `admitted` rule, and a divergence nobody can measure is a divergence nobody can argue
-- with. `kept_only_by_ref_match` is the column that answers "would SHA-only have done":
-- those commits have no SHA link at all, so under SHA-only they lose their pull request
-- entirely and fall into the "Not linked to a PR" group (decision 26).
CREATE OR REPLACE VIEW fe.diag_ref_match_narrowing AS
WITH rm AS (
  SELECT DISTINCT l.repo_id, l.commit_sha, l.pull_request_id
  FROM mv_commit_pr_links l WHERE l.admitted AND l.link_method = 'ref_match'
),
sha AS (
  SELECT DISTINCT repo_id, commit_sha, pull_request_id
  FROM mv_commit_pr_links WHERE admitted AND link_method IN ('head_sha','merge_commit_sha')
)
SELECT r.name AS repo,
       count(*)                                                       AS ref_match_pairs_upstream,
       count(*) FILTER (WHERE o.introduced_new AND NOT o.on_default_branch) AS kept,
       count(*) FILTER (WHERE o.on_default_branch)                     AS dropped_already_on_trunk,
       count(*) FILTER (WHERE NOT o.on_default_branch
                          AND NOT COALESCE(o.introduced_new, false))   AS dropped_repush,
       count(*) FILTER (WHERE o.introduced_new AND NOT o.on_default_branch
                          AND NOT EXISTS (SELECT 1 FROM sha s
                                WHERE s.repo_id = rm.repo_id
                                  AND s.commit_sha = rm.commit_sha
                                  AND s.pull_request_id = rm.pull_request_id))
                                                                       AS kept_only_by_ref_match
FROM rm
JOIN repo r ON r.id = rm.repo_id
LEFT JOIN fe.commit_branch_origin o
  ON o.repo_id = rm.repo_id AND o.commit_sha = rm.commit_sha
GROUP BY 1 ORDER BY 2 DESC;

-- §7.5 — the four sanity checks that catch the SILENT failures. Every one must be 0.
CREATE OR REPLACE VIEW fe.diag_sanity AS
WITH all_objects AS (
  SELECT id FROM fe.object_issue
  UNION ALL SELECT id FROM fe.object_pull_request
  UNION ALL SELECT id FROM fe.object_commit
)
SELECT 'dangling event objects'      AS check_name,
       (SELECT count(*) FROM fe.event e
         WHERE NOT EXISTS (SELECT 1 FROM all_objects o WHERE o.id = e.object_id)) AS n,
       0 AS expected
UNION ALL
SELECT 'issue/PR objects with no events',
       (SELECT count(*) FROM (
          SELECT id FROM fe.object_issue UNION ALL SELECT id FROM fe.object_pull_request) o
         WHERE NOT EXISTS (SELECT 1 FROM fe.event e WHERE e.object_id = o.id)), 0
UNION ALL
SELECT 'actors named by an event with no actor object',
       (SELECT count(DISTINCT e.actor_id) FROM fe.event e
         WHERE e.actor_id IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM fe.object_actor a WHERE a.id = e.actor_id)), 0
UNION ALL
SELECT 'pairs linked twice by the same qualifier',
       (SELECT count(*) FROM (
          SELECT source, target, qualifier FROM fe.link_mat
          GROUP BY 1,2,3 HAVING count(*) > 1) d), 0
UNION ALL
SELECT 'link endpoints that are not objects',
       -- fe.link_mat, not fe.link: it is what the RPC actually serves, and it is
       -- indexed. fe.diag_link_staleness separately catches the two drifting apart.
       (SELECT count(*) FROM fe.link_mat l
         WHERE NOT EXISTS (SELECT 1 FROM all_objects o WHERE o.id = l.source)
            OR NOT EXISTS (SELECT 1 FROM all_objects o WHERE o.id = l.target)), 0
UNION ALL
SELECT 'distinct activities (must be exactly 9)',
       (SELECT count(DISTINCT activity) FROM fe.event), 9;
