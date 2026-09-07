-- =====================================================================================
-- fe_layer.sql — the PostgREST data layer
--
-- Produces the frontend's `SubLog` JSON (docs/DATA_LAYER.md) from the upstream
-- relations it reads: three base tables, two identity views and twelve mv_* views
-- (docs/DATA_CONTRACT.md §3). Nothing here reads an `ocel_*`
-- view; nothing here modifies anything upstream except by adding indexes, which this
-- project owns.
--
-- Layout:
--   §0  schema, indexes, measurements
--   §1  activity vocabulary                     (11 activities; §12.0 adds Push for the DFG only)
--   §2  objects        fe.object_{issue,pull_request,commit,actor}
--   §3  intervals      fe.interval_{issue,pull_request}
--   §4  events         fe.event
--   §5  links          fe.link
--   §6  the RPC        api.get_sublog(repo, seed, traversal_degree)
--   §7  diagnostics    the drop counts these views are obliged to report
--   §8  seed search    fe.seed_lookup
--   §9  the RPC        api.search_seeds(...)
--   §10 the RPC        api.list_repos()
--   §11 refreshers     fe.refresh_all() and friends
--   §12.0 DFG events   fe.dfg_event / fe.dfg_e2o — the map's OCEL 2.0 E2O layer
--   §12 the DFG        fe.dfg / fe.dfg_mat — the whole-log directly-follows graph
--   §13 the RPC        api.get_dfg(repo)
--
-- Run:  psql -d gharchive_ocpm_viz_wsl -f sql/fe_layer.sql
--
-- -------------------------------------------------------------------------------------
-- Conventions that are load-bearing, and why. Each of these is a defect someone already
-- shipped once; none of them is stylistic.
--
--   * PLAIN VIEWS, not materialized. The frontend asks
--     for one sub-log at a time — a seed and its neighbourhood, a few hundred rows out of
--     a decade. A plain view lets that filter reach the underlying MVs; a materialized
--     one computes every repository in advance, costs a second copy of a 14 GB dataset
--     and is stale from the moment upstream refreshes. Indexes go on the UNDERLYING MVs
--     (§0), which is the better place anyway: one index there serves every query touching
--     the relation rather than one path through a copy.
--
--   * OBJECT IDS ARE TYPE-PREFIXED: `issue:<issue_id>`, `pr:<pr_id>`,
--     `commit:<sha>`, `actor:<actor_id>`. Not cosmetic — the bare numeric ids COLLIDE.
--     Measured 2026-08-04: 8 issue_ids equal a pull_request_id, 11 equal an actor id, 76
--     pull_request_ids equal an actor id. Unprefixed, a sub-log holding such a pair either
--     trips `duplicate object id` or silently merges two objects into one.
--
--   * EVERY EVENT AND LINK ENDPOINT RESOLVES AGAINST fe.object_* (§4, §5), never against
--     issues_identity / prs_identity. Those carry only objects with an 'opened' event, so
--     resolving through them drops exactly the pre-window objects the first-seen fallback
--     just created: the object survives as a lifecycle bar with nothing on it, and nothing
--     reports it.
--
--   * TIMESTAMPS. Upstream types are mixed and the mixture is invisible:
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
  'This project''s derivations over the frozen upstream. Plain views.';
COMMENT ON SCHEMA api IS
  'PostgREST surface. Four RPCs. The frontend never queries a view directly.';

-- -------------------------------------------------------------------------------------
-- Indexes on the UNDERLYING MVs.
--
-- Before this file ran, the four base tables had a primary key each and NOT ONE
-- materialized view had any index at all (`pg_indexes`, 2026-08-04) — so every sub-log
-- query was a sequential scan over as much as 4.6 GB.
--
-- Keys chosen are the ones §2–§6 actually filter and join by. Measurements are recorded
-- in §0.1 below; optimisation here is a finding, not a habit.
--
-- These change relations other people read. That is why they are listed here rather than
-- applied quietly (DATA_CONTRACT.md §4).
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
-- The comment-excerpt joins in fe.event are by event_id, verified exact:
-- every comment activity row has exactly one body row. Without these, each comment event
-- in a sub-log costs a scan of a 2.3M/1.3M-row matview.
CREATE INDEX IF NOT EXISTS ix_icomments_event
  ON mv_issue_comments_full (event_id);
CREATE INDEX IF NOT EXISTS ix_prcomments_event
  ON mv_pull_request_comments_full (event_id);
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
-- and mv_pr_offplatform_merges (not consumed directly; its activity reaches us through
-- mv_pull_request_and_comment_activities_full).

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
-- candidate — rebuilding fe_commit_pr_links — is declined: that
-- join already exists upstream as mv_commit_pr_links (inherited), so
-- rebuilding it would create a second admission rule to disagree with the first.
--
-- Every figure resting on an upstream view must quote its refresh timestamp. All 23 MVs
-- were last refreshed 2026-08-02, 19:32–19:45 UTC.
-- -------------------------------------------------------------------------------------


-- =====================================================================================
-- §1 — The activity vocabulary
-- =====================================================================================

-- Exactly the ELEVEN frozen activities. This whitelist and the frontend's ACTIVITIES
-- (src/model/activities.js) must be the same set or one of them is decorative:
-- an activity that reaches the renderer unmapped throws in activities.js `lookup`.
DROP VIEW IF EXISTS fe.activity_vocabulary CASCADE;
CREATE VIEW fe.activity_vocabulary AS
SELECT * FROM (VALUES
  --  activity,             object_type,    landmark, is_comment
  ('IssueOpened',          'issue',        false, false),
  ('IssueClosed',          'issue',        true,  false),
  ('IssueReopened',        'issue',        false, false),
  ('IssueCommented',       'issue',        false, true ),
  ('PullRequestOpened',    'pull_request', false, false),
  ('PullRequestCommented', 'pull_request', false, true ),
  ('PullRequestMerged',    'pull_request', true,  false),
  -- A landmark, and a merge of a different kind; the frontend rings it as a heuristic.
  ('PullRequestMergedOffPlatform', 'pull_request', true, false),
  ('PullRequestClosed',    'pull_request', false, false),
  ('PullRequestReopened',  'pull_request', false, false),
  ('CommitObserved',       'commit',       false, false)
) AS t(activity, object_type, landmark, is_comment);

COMMENT ON VIEW fe.activity_vocabulary IS
  'The 11 activities this layer admits. Landmarks are IssueClosed, PullRequestMerged and '
  'PullRequestMergedOffPlatform. CommitObserved is synthetic — no upstream MV emits it.';

-- The upstream activity names are admitted as they are. Verified against the live
-- vocabularies (2026-08-04):
--   mv_issue_and_issuecomment_activities_full   IssueCommented 953,293 · IssueOpened 176,362
--                                               IssueClosed 175,370 · IssueReopened 10,626
--                                               + IssueComment_ (1) and IssueLabeled (1), dropped
--   mv_pull_request_and_comment_activities_full PullRequestCommented 1,343,232 · Opened 90,262
--                                               Merged 67,216 · Closed 26,366 · Reopened 4,325
--                                               PullRequestMergedOffPlatform 31
-- Retired helper; dropped so a database that has it matches this file.
DROP FUNCTION IF EXISTS fe.remap_activity(text);

-- Render one UTC instant the way the frontend can parse it.
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
-- Four types, closed. `repo` is NOT among them: it is the frame the sub-log
-- is drawn inside, carried once as meta.repo / meta.repo_id.
-- =====================================================================================

-- -------------------------------------------------------------------------------------
-- ISSUE — identity preferred, first-seen fallback for pre-window issues
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
  -- Same two kinds of row as prs_identity since 2026-09-07: from the 'opened' event, or a
  -- fallback from a later IssuesEvent / IssueCommentEvent carrying the issue's created_at.
  SELECT repo_id, issue_id, issue_number,
         issue_created_at AT TIME ZONE 'UTC' AS t0,
         0 AS priority,
         CASE WHEN issue_creation_event_id IS NULL THEN 'created_at(payload)'
              ELSE 'created_at(opened)' END::text AS time_semantics
  FROM issues_identity
  WHERE issue_id IS NOT NULL
),
first_seen AS (
  -- The issue branch needs no workaround: mv_issue_comments_full.issue_id really is
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
       'issue:' || u.issue_id::text AS id,          -- the prefix prevents collision
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
-- correction rather than a preference. The
-- comment rows of mv_pull_request_and_comment_activities_full carry
-- payload->'issue'->>'id' in the pull_request_id column, which for a PR is a DIFFERENT
-- number from the PR id. Measured 2026-08-04: those rows hold 84,209 distinct
-- `pull_request_id` values of which 84,200 are not a pull request id at all. Grouping the
-- fallback on that column would mint 84,200 phantom pull requests
-- keyed on issue ids, each with a lifecycle bar and a handful of comments.
--
-- mv_pull_request_events_full carries the correct pull_request_id on every row, and
-- recovers all 7,179 genuinely pre-window PRs. Comment events then resolve by
-- (repo_id, pr_number) in §4, which is the workaround and is safe: no (repo_id,
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
  -- it as an object would reproduce the same failure exactly — the object survives, its
  -- events do not, and nothing reports it.
  --
  -- Gating on the activities MV is the non-circular way to say "has events": §4 branch 2
  -- resolves PR events by joining that MV on (repo_id, pr_number), so this set and the set
  -- of PRs with events are the same set by construction. Every PR activity_type survives
  -- the whitelist, so nothing is lost between here and there.
  SELECT DISTINCT repo_id, pr_number
  FROM mv_pull_request_and_comment_activities_full
  WHERE pr_number IS NOT NULL
),
from_identity AS (
  -- prs_identity has two kinds of row since 2026-09-07 (its banner in matviews_scoped.sql):
  -- one from the PR's 'opened' event, and a fallback from any later PullRequestEvent whose
  -- payload carries the PR's created_at, for PRs whose opening the corpus lacks. Both give
  -- the real creation time; the semantics label says which, because only the first also
  -- means "the opening is in the log".
  SELECT i.repo_id, i.pull_request_id, i.pr_number,
         i.pr_created_at AT TIME ZONE 'UTC' AS t0,
         0 AS priority,
         CASE WHEN i.pr_creation_event_id IS NULL THEN 'created_at(payload)'
              ELSE 'created_at(opened)' END::text AS time_semantics
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
  -- The 'opened' row when there is one, else the earliest surviving event: same fallback
  -- as prs_identity, so a PR the corpus never saw opened still gets its title and refs.
  SELECT DISTINCT ON (pull_request_id)
         pull_request_id, head_ref, base_ref, pr_title
  FROM mv_pull_request_events_full
  ORDER BY pull_request_id, (action = 'opened') DESC, event_created_at
)
SELECT DISTINCT ON (u.repo_id, u.pull_request_id)
       'pr:' || u.pull_request_id::text AS id,
       'pull_request'::text             AS type,
       'PR #' || u.pr_number            AS label,
       u.repo_id,
       u.pull_request_id,
       u.pr_number,                 -- a real column: §4's comment branch joins on it
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
-- Keyed `commit:<sha>` and not `commit:<repo_id>_<sha>`: a SHA is unique by
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
--  (b) WHO EXISTS at all?  The filter above is right for (a) and wrong for (b).
--      Anyone who only closed, merged or reopened — a maintainer whose entire
--      contribution is merging, which is exactly who an issue-to-merge study is about —
--      appears in no (a) branch, so they get no actor object: no sidebar row, no colour,
--      no trail. Their events still carry actor_id, so nothing errors. The id-only
--      branches below fix that; `resolved` fills the login in from (a) when one is known.
--
-- The `actor` base table is joined last as a backstop. DATA_CONTRACT.md §2 records it as
-- complete, and it carries a login for ids the payload streams never name with one.
-- No is_bot: bot classification is out of scope.
-- -------------------------------------------------------------------------------------
-- ⚠️ Built from the `actor` BASE TABLE, not reconstructed from the payload streams —
-- which is what DATA_CONTRACT.md §2 says to do ("Actor objects come from these tables,
-- not from any view; `actor` is complete as-is").
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
-- Contributors who only close or merge are NOT missing from the actor list, and that is
-- satisfied by construction here rather than by adding branches: identity comes from the
-- actor table, so there is no `action = 'opened'` filter to be wrong about, and anyone an
-- event names has an object. The underlying trap — pairing `actor_id` with
-- `issue_creator_login`, which names the issue's CREATOR and not the event's actor — is
-- likewise gone, because no login is ever read from a payload column.
--
-- No is_bot: bot classification is out of scope.
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
-- the numeric id throughout, so a rename no longer splits one contributor
-- into two across a re-extraction — the CLAUDE.md exception expiring exactly as it said it
-- would.
--
-- ⚠️ Actors are NOT scoped by repository, and that is deliberate. A GitHub account is a
-- global entity; scoping gave the same id one row per repository it had acted in, which is
-- a duplicate object id waiting for the first cross-repo sub-log. The sub-log's actor set
-- is decided by which events survive (§6), which is the correct scope and the one the
-- sidebar wants.


-- =====================================================================================
-- §3 — Intervals  (interval LISTS, so a reopened object is representable)
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
  UNION ALL
  -- The issue's creation time as an opening — same rule and same reasons as
  -- fe.interval_pull_request below. Measured 2026-09-07: 10,607 vscode, 3,796 kubernetes,
  -- 1,100 react issues had a close and no open and drew no bar.
  SELECT i.repo_id, i.issue_id, 0::bigint AS event_id,
         i.issue_created_at AT TIME ZONE 'UTC' AS t, 1 AS is_open
  FROM issues_identity i
  WHERE i.issue_id IS NOT NULL
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
  -- PullRequestMergedOffPlatform is in the CLOSING set: whatever the frontend draws it as
  -- (a landmark, a merge of a different kind), the GitHub fact underneath
  -- is that the PR was closed, so the interval ends there. Comment rows are not in this
  -- filter, so the comment rows' bad pull_request_id never reaches here.
  SELECT repo_id, pull_request_id, event_id,
         activity_timestamp AT TIME ZONE 'UTC' AS t,
         CASE WHEN activity_type IN ('PullRequestMerged',
                                     'PullRequestMergedOffPlatform',
                                     'PullRequestClosed') THEN 0 ELSE 1 END AS is_open
  FROM mv_pull_request_and_comment_activities_full
  WHERE activity_type IN ('PullRequestOpened','PullRequestReopened','PullRequestMerged',
                          'PullRequestMergedOffPlatform','PullRequestClosed')
    AND pull_request_id IS NOT NULL
  UNION ALL
  -- The PR's creation time as an opening (2026-09-07). prs_identity knows it for every PR
  -- — from the 'opened' event, or from a later event's payload when the corpus lacks the
  -- opening. Sorted first at its instant (event_id 0), so where the opening IS in the log
  -- it is the same state at the same time and collapses into it: every existing interval
  -- is unchanged. Where it is not, the PR gets its interval from creation to the first
  -- observed close instead of none — measured 2026-09-07: 4,342 kubernetes, 1,826 vscode,
  -- 858 react PRs had a close and no open, and drew no bar; their commit links then
  -- anchored at the left edge of the axis (kubernetes #47532, PRs #65509 and #65539).
  -- A PR with no lifecycle event at all now reads [creation, null): created, never seen
  -- closed — the same meaning `end = null` already has.
  SELECT i.repo_id, i.pull_request_id, 0::bigint AS event_id,
         i.pr_created_at AT TIME ZONE 'UTC' AS t, 1 AS is_open
  FROM prs_identity i
  WHERE i.pull_request_id IS NOT NULL
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
-- Normalises three row shapes into one, then whitelists them.
-- Three branches, not six: reviews and commit comments are out of scope and their MVs
-- do not exist in this database anyway; `CommitsPushed` is not an activity — the push's
-- facts ride on each CommitObserved event's attrs instead.
-- =====================================================================================

DROP VIEW IF EXISTS fe.event CASCADE;
CREATE VIEW fe.event AS
WITH push_facts AS (
  -- The DECLARED size must come from the push event's own columns and
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
         a.activity_type                           AS activity,
         a.activity_timestamp AT TIME ZONE 'UTC'   AS time,
         'issue:' || a.issue_id::text              AS object_id,
         'actor:' || a.actor_id::text              AS actor_id,
         a.actor_id                                AS actor_num,
         a.repo_id,
         -- The comment's opening, riding on attrs the way a push's facts do.
         -- Truncated HERE, not in the client: p95 is ~3k chars
         -- and the outliers are 260k-char bot logs nobody reads in a card. The flag says
         -- an excerpt is an excerpt, so the card can show an ellipsis honestly.
         --
         -- ⚠️ A correlated subquery, NOT a join. A LEFT JOIN here made the planner hash
         -- the whole 2.3M-row comment MV before the RPC's object filter could bite —
         -- measured: the kubernetes #47532 payload went from ~1s to 6.1s. The scalar
         -- subquery runs once per SURVIVING row, through ix_icomments_event, and the
         -- payload came back to ~1s. Same trap as the seed lookup's 300× (§8).
         CASE WHEN a.activity_type = 'IssueCommented' THEN
           COALESCE((SELECT jsonb_build_object(
                       'comment_excerpt', left(ic.comment_body, 500),
                       'comment_truncated', length(ic.comment_body) > 500)
                     FROM mv_issue_comments_full ic
                     WHERE ic.event_id = a.event_id AND ic.comment_body IS NOT NULL
                     LIMIT 1), '{}'::jsonb)
         ELSE '{}'::jsonb END                      AS attrs
  FROM mv_issue_and_issuecomment_activities_full a
  WHERE a.issue_id IS NOT NULL

  UNION ALL
  ---------------------------------------------------------------------------------------
  -- 2. PR lifecycle + PR comments. Two hazards, and the second bites silently.
  --
  --    a) comment rows carry payload->'issue'->>'id' in pull_request_id, a different
  --       number from the PR id. Measured: joining on pull_request_id leaves 1,343,072
  --       of 1,343,232 comment rows unjoinable (99.99%); joining on (repo_id, pr_number)
  --       leaves 87,598 (6.5%). So the join is on (repo_id, pr_number).
  --
  --    b) an earlier draft resolved that join against prs_identity, which is built from
  --       action='opened' only. Every PR opened before the window then lost all of its
  --       events while keeping its object, and drew as an empty lifecycle bar with
  --       nothing reporting it. Resolving against fe.object_pull_request — which HAS the
  --       first-seen fallback — closes it, and accounts for most of that residual 6.5%.
  --
  --    ⚠️ `o.id` is used for the object id, NOT a.pull_request_id, on lifecycle rows too.
  --       They agree there; using one column for both branches is what stops the two from
  --       drifting apart the next time someone edits this.
  ---------------------------------------------------------------------------------------
  SELECT 'pr_act:' || a.event_id::text,
         a.activity_type,
         a.activity_timestamp AT TIME ZONE 'UTC',
         o.id,
         'actor:' || a.actor_id::text,
         a.actor_id,
         a.repo_id,
         -- Same excerpt rule — and the same correlated-subquery shape, for the same
         -- planner reason — as the issue stream above. The event_id
         -- lookup is exact; that defect touches only the object join below, not this one.
         CASE WHEN a.activity_type = 'PullRequestCommented' THEN
           COALESCE((SELECT jsonb_build_object(
                       'comment_excerpt', left(pc.comment_body, 500),
                       'comment_truncated', length(pc.comment_body) > 500)
                     FROM mv_pull_request_comments_full pc
                     WHERE pc.event_id = a.event_id AND pc.comment_body IS NOT NULL
                     LIMIT 1), '{}'::jsonb)
         ELSE '{}'::jsonb END
  FROM mv_pull_request_and_comment_activities_full a
  JOIN fe.object_pull_request o
    ON o.repo_id = a.repo_id AND o.pr_number = a.pr_number
  WHERE a.pr_number IS NOT NULL

  UNION ALL
  ---------------------------------------------------------------------------------------
  -- 3. CommitObserved — SYNTHETIC. One per commit row; no upstream MV emits this
  --    activity. It carries the push's declared size so a burst can say
  --    "20 shown of 347 pushed" instead of quietly claiming 20.
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
-- THE WHITELIST. Every activity outside fe.activity_vocabulary is dropped here, and
-- §7.1 reports what that costs.
JOIN fe.activity_vocabulary v ON v.activity = r.activity;


-- =====================================================================================
-- §5 — Links
--
-- FOUR qualifiers: resolves, contains_commit, merge_commit, references_issue.
-- No `delivered_by` and no off-platform link branch: the off-platform activity exists,
-- its link method and qualifier do not. No actor links — attribution is single-sourced
-- on event.actor_id and BOTH endpoints of a link are object ids.
--
-- ⚠️ `commit_message` is ONE method covering TWO relationships: issue↔PR in
-- branch A, commit→issue in branch D. Any per-method figure MUST group by
-- (method, qualifier) or it silently sums two different relations — and the detection
-- breakdown is exactly that figure. §7.4 does it correctly.
-- =====================================================================================

-- -------------------------------------------------------------------------------------
-- §5.0 — Where a commit was first introduced
--
-- Two facts per commit, both straight from `mv_push_commits_full` and neither consulted
-- by `mv_commit_pr_links`. They are what the `ref_match` narrowing tests.
--
--   introduced_new     GitHub's own `commit_distinct` flag: this push is the first time
--                      the repository saw this SHA. It is *GitHub's* judgement, not ours.
--   on_default_branch  the SHA has been pushed to master/main at some point.
-- -------------------------------------------------------------------------------------
DROP VIEW IF EXISTS fe.commit_branch_origin CASCADE;
CREATE VIEW fe.commit_branch_origin AS
-- ⚠️ **WHERE the commit first appeared, not whether it ever reached master.**
--
-- The first version of this view asked `bool_or(ref IN ('master','main'))` — "has this
-- SHA ever been pushed to the default branch" — and that question is **time-blind**. It
-- is true of every commit that eventually merges, so the rule built on it discarded a
-- merged pull request's own commits: the successful case, and the one an issue-to-merge
-- study exists to look at. Measured on vscode PR #116416: of 85 commits that genuinely
-- originated on its branch, 47 also reached master *because the PR merged*, and all 47
-- were dropped. Across vscode it orphaned 22,788 commits (39% of those with an admitted
-- link) — which is what made real sub-logs look disconnected.
--
-- The question that actually distinguishes the two cases is *where a commit was first
-- seen*: a commit merged INTO the branch from trunk first appeared on trunk; a commit
-- written ON the branch first appeared there, whatever happened to it afterwards.
--
-- `commit_distinct DESC` first in the ordering picks the earliest push that *declared*
-- the commit new, rather than the earliest push mentioning it — a re-push of an older
-- commit should not be mistaken for its origin.
SELECT DISTINCT ON (p.repo_id, p.commit_sha)
       p.repo_id,
       p.commit_sha,
       p.ref                                                          AS first_seen_ref,
       p.created_at AT TIME ZONE 'UTC'                                AS first_seen_at,
       p.commit_distinct                                              AS introduced_new,
       (p.ref NOT IN ('refs/heads/master','refs/heads/main'))          AS first_seen_on_branch
FROM mv_push_commits_full p
WHERE p.commit_sha IS NOT NULL
ORDER BY p.repo_id, p.commit_sha, p.commit_distinct DESC, p.created_at;

COMMENT ON VIEW fe.commit_branch_origin IS
  'Per commit: was this push the first sighting of the SHA (GitHub commit_distinct), and '
  'has the SHA ever been pushed to master/main. Inputs to the ref_match narrowing.';


-- -------------------------------------------------------------------------------------
-- §5.0b — The narrowed commit→PR relation, as ONE named view.
--
-- It exists as a view rather than inline because **two different link families depend on
-- it**, and an earlier narrowing reached only one of them. Branch B is the
-- commit→PR link itself; branch A's `commit_message` issue↔PR links are *derived* from
-- commit→PR attribution upstream and inherited the wide rule. One definition, consumed
-- twice, is what stops those two from drifting apart again.
-- -------------------------------------------------------------------------------------
-- The head branch of each pull request, as a full ref, and the (commit, ref) pairs where
-- GitHub declared a commit NEW. Named views rather than inline CTEs because the narrowing
-- and its diagnostic must test the same two things.
DROP VIEW IF EXISTS fe.pr_head_ref CASCADE;
CREATE VIEW fe.pr_head_ref AS
SELECT DISTINCT repo_id, pull_request_id, 'refs/heads/' || head_ref AS head_ref_full
FROM mv_pull_request_events_full
WHERE head_ref IS NOT NULL;

COMMENT ON VIEW fe.pr_head_ref IS
  'Pull request to its head branch, as a full ref. Input to the ref_match narrowing.';

DROP VIEW IF EXISTS fe.commit_born_ref CASCADE;
CREATE VIEW fe.commit_born_ref AS
SELECT DISTINCT repo_id, commit_sha, ref
FROM mv_push_commits_full
WHERE commit_distinct AND commit_sha IS NOT NULL;

COMMENT ON VIEW fe.commit_born_ref IS
  'Every (commit, ref) where GitHub flagged the commit new to the repository in that push. '
  'Input to the ref_match narrowing.';

-- -------------------------------------------------------------------------------------
-- ⚠️ **The question is "was this commit written FOR this pull request", and the only
-- honest proxy is "was it born on THIS PR's branch"**.
--
-- The previous rule asked whether the commit was first seen on *a* branch other than
-- master/main. That catches the common case — trunk merged into a long-lived branch — by
-- luck rather than by aim, and misses every commit merged in from a *colleague's* branch.
-- Measured on vscode PR #116416: of 87 commits it admitted, **52 were born on other
-- people's branches** (`tyriar/116467_2`, `isidorn/notificationsTelemetry`,
-- `joh/kernelLanguages`, …) and had nothing to do with `notebook/execution`. None of the
-- commits this rule drops were born on the PR's own branch.
--
-- ⚠️ **Still a FLOOR, and now for a second reason.** `commit_distinct = false` on the PR's
-- own branch also catches a force-push, a rebase, and GH Archive's 20-commit truncation
-- of `PushEvent.commits`. Measured cost: vscode 1,620 real links, react 272,
-- kubernetes 56. Measured benefit: 9,796 / 537 / 0 cross-branch pass-throughs removed.
-- **Kubernetes pays the cost and gains nothing** — its contributors work from forks, so
-- this failure mode barely occurs there. Quote three numbers, never one:
-- upstream raw, the previous rule, this rule (vscode: 71,470 / 32,262 / 20,846).
-- -------------------------------------------------------------------------------------
DROP VIEW IF EXISTS fe.commit_pr_link CASCADE;
CREATE VIEW fe.commit_pr_link AS
SELECT l.repo_id, l.commit_sha, l.pull_request_id, l.pr_number, l.link_method
FROM mv_commit_pr_links l
WHERE l.admitted
  AND (l.link_method IN ('head_sha','merge_commit_sha','push_order')
       OR EXISTS (
         SELECT 1
         FROM fe.pr_head_ref h
         JOIN fe.commit_born_ref b
           ON b.repo_id = l.repo_id
          AND b.commit_sha = l.commit_sha
          AND b.ref = h.head_ref_full
         WHERE h.repo_id = l.repo_id
           AND h.pull_request_id = l.pull_request_id));

COMMENT ON VIEW fe.commit_pr_link IS
  'mv_commit_pr_links with the ref_match narrowing applied: a ref_match commit '
  'is admitted only where GitHub flagged it new on the PR''s own head branch. push_order '
  'passes untouched like the SHA methods: it is anchored on the PR''s own head and merge '
  'SHAs and reads the merge push''s order, so the born-on-branch test does not apply. The single '
  'source of commit-to-PR attribution in this layer — fe.link branches A and B both read it.';


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
--    ALL SEVEN upstream methods here are issue↔PR, including
--    closed_via_commit and proximity. Neither carries a commit_sha column.
--    ⚠️ **The narrowing must reach this branch too, and it is easy to miss.**
--    `mv_issue_pr_links_commit_message` is defined as
--        JOIN mv_commit_pr_links cpr ON ... AND cpr.admitted
--    so its issue↔PR links are *derived from commit→PR attribution* — under the WIDE rule.
--    Narrowing branch B alone leaves this branch reading the old attribution, which
--    makes the fix look complete while more than half the issue↔PR links still rest on
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
       -- Validated if ANY method validates it, matching classifyLink in
       -- src/model/evidence.js. Testing primary_link_method alone drew well-evidenced
       -- links dashed with a "?", understating the confidence cue the tool
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
       -- An ARRAY (docs/DATA_LAYER.md). Upstream stores it semicolon-joined.
       r.methods                                           AS link_methods,
       r.repo_id
FROM resolved r
WHERE array_length(r.methods, 1) > 0

UNION ALL
-- A2. Extended conventions — the 205 rows mv_issue_to_pr_validated_all does NOT union.
--     The NOT EXISTS is the whole point. Without it an overlapping pair is emitted
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
--    `admitted` is the INHERITED commit→PR admission rule: not
--    the repo's default branch as head, under 250 candidate commits, and first pushed
--    within [pr_created_at − 7 days, pr_ended_at]. Quote the MV refresh timestamp beside
--    any figure resting on it.
--
--    ⚠️ AGGREGATED per (commit, PR), not one row per upstream row. mv_commit_pr_links
--    holds ONE ROW PER MATCHING METHOD, so a commit matched by both head_sha and
--    ref_match yields two rows — and both map to the qualifier `contains_commit`, so
--    emitting them raw puts the SAME pair in the payload twice with the same qualifier.
--    Measured 2026-08-04: 5,111 such groups. Emitted raw they fail the "no pair linked
--    twice" sanity check.
--
--    Aggregating rather than DISTINCT-ing is the better fix and not merely a tidier one:
--    it recovers real multi-method agreement into n_methods / link_methods, which is what
--    the tooltip shows and what classifyLink already knows how to
--    read. `merge_commit` wins the qualifier when it is present, because being the PR's
--    merge commit is the more specific relationship than being one of its commits.
SELECT 'pr:' || b.pull_request_id::text,
       'commit:' || b.commit_sha,
       CASE WHEN 'merge_commit_sha' = ANY(b.methods) THEN 'merge_commit'
            ELSE 'contains_commit' END,
       -- validated if ANY method validates (classifyLink, src/model/evidence.js).
       -- ref_match alone is a branch-naming convention and stays extracted; push_order
       -- is an inference from the merge push's commit order, not a GitHub assertion or
       -- an identity match, and stays extracted too.
       CASE WHEN b.methods && ARRAY['merge_commit_sha','head_sha'] THEN 'validated'
            ELSE 'extracted' END,
       -- the primary method, strongest first — same ordering the evidence rule uses
       COALESCE(
         (ARRAY(SELECT m FROM unnest(ARRAY['merge_commit_sha','head_sha','push_order','ref_match']) m
                 WHERE m = ANY(b.methods)))[1],
         b.methods[1]),
       array_length(b.methods, 1),
       b.methods,
       b.repo_id
-----------------------------------------------------------------------------------------
--    ⚠️ Reads fe.commit_pr_link — the ref_match narrowing, defined once in §5.0b.
--
--    SHA matches are identity and pass untouched. `ref_match` is admitted only where
--    GitHub flagged the commit NEW on the pull request's OWN head branch.
--
--    The defect it fixes. `ref_match` means "pushed to this PR's head branch while the PR
--    was open", which is the right question — GH Archive's PR payload never lists a PR's
--    commits, so it is the ONLY evidence most of them have. But merging anything into a
--    long-lived branch re-enumerates every incoming commit in that push, and all of them
--    are then attributed to the PR. On vscode PR #116416: 217 ref_match commits upstream,
--    87 under the previous rule, **36 under this one** — and the 52 it removes were born
--    on other people's branches, none on `notebook/execution`.
--
--    ⚠️ It is a FLOOR, not a count, and the floor's size is measured. `commit_distinct =
--    false` on the PR's own branch also catches a force-push, a rebase and GH Archive's
--    20-commit truncation: vscode 1,620 real links lost, react 272, kubernetes 56. Raw
--    ref_match is the ceiling. Report a range, never a point estimate.
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
--    Resolved against fe.object_issue, not issues_identity, or every issue opened
--    before the window loses its commit links while still being on screen.
--    Cross-repo references are DROPPED, and the reason is not
--    that they are weak. mv_commit_message_issue_links_all carries source_repo_id,
--    issue_number and ref_scope and NO TARGET REPO ID, so for a cross_repo row nothing
--    says which repository the referenced issue lives in. Joining on source_repo_id — the
--    only id available — would bind the reference to whichever issue holds that number in
--    the SOURCE repo, which is a fabricated link rather than a weak one. 1,074 of 44,792
--    rows (2.4%) are dropped; it is a limitation of the upstream view and is reported
--    as one.
--
--    ⚠️ DEDUPLICATED. mv_commit_message_issue_links_all carries one row per (commit,
--    issue-reference, PUSH) — the same commit re-pushed on a rebase or a merge produces
--    another row for the same reference. Measured 2026-08-04: 9,295 duplicate groups,
--    16,040 surplus rows. Emitted raw, one commit→issue relationship is drawn four or five
--    times, counted that many times in every link figure, and fails the "no pair linked
--    twice by the same qualifier" check.
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
-- Materializing is a finding rather than a default, so here is the finding: the
-- measurement, taken 2026-08-04 on the vscode sub-log seeded at issue:2902032454, degree 2.
--
--   whole request, no indexes at all                        19.4 s
--   + indexes on the underlying MVs (§0)                     ~16 s
--   + repo's links built once instead of twice                ~15 s
--   + fe.object_actor from the actor base table                6.8 s
--   + traversal reduced to typed key arrays (§6 step 1)        4.2 s
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
--   * 171,817 rows for the whole database (2026-09-06; 231,291 before the narrowing) — small.
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
  'Materialized copy of fe.link. The ONE measured materialization. Run '
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
--   api.get_sublog(repo, seed, traversal_degree)
--
-- Never `get_case`. There is no case notion (CLAUDE.md): the API returns a
-- SUB-LOG described by the query that produced it, not identified by a key.
--
-- ⚠️ `traversal_degree` is SERVER-SIDE — how far the graph is expanded before it is sent.
-- It is unrelated to MAX_FOCUS_DEGREE in src/model/graph.js, which caps the client-side
-- BFS deciding what is HIGHLIGHTED inside an already-loaded sub-log. CLAUDE.md
-- names these two as the pair never to conflate.
-- =====================================================================================

-- The function was named api.get_object_graph until 2026-09-06. CREATE OR REPLACE under
-- the new name would leave the old one in place, still granted to web_anon by the
-- schema-wide loop in postgrest_setup.sql, so it is dropped explicitly.
DROP FUNCTION IF EXISTS api.get_object_graph(text, text, integer);

CREATE OR REPLACE FUNCTION api.get_sublog(
  repo             text,
  seed             text,
  traversal_degree integer DEFAULT 1
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
  -- 0..2, and 1 when unstated. Mirrors TRAVERSAL_DEGREE in src/data/api.js, and is
  -- enforced HERE, where the cost is paid, not only in the stepper:
  -- a third hop turns a 42-object sub-log into 291 on vscode PR #116416, and nothing the
  -- tool asks needs it. Change the two together.
  IF traversal_degree IS NULL OR traversal_degree < 0 OR traversal_degree > 2 THEN
    RAISE EXCEPTION 'traversal_degree must be between 0 and 2, got %', traversal_degree;
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
                || 'display number: issue:<issue_id>, pr:<pull_request_id>, '
                || 'commit:<sha>. To resolve #242864, look it up: SELECT id FROM '
                || 'fe.object_issue WHERE repo_id = <id> AND issue_number = 242864. '
                || 'An actor cannot be a seed: actors are not traversed.';
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
  -- no actor links to traverse in the first place.
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
    -- Actors get NO intervals. They have no lane, so a span would draw
    -- nothing; `[]` is the honest value and is what all 14 fixtures carry.
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
  -- the validator rejects by name.
  sublog_link AS MATERIALIZED (
    SELECT l.* FROM fe.link_mat l
    WHERE l.repo_id = _repo_id
      AND l.source = ANY(_obj_ids)
      AND l.target = ANY(_obj_ids))
  SELECT jsonb_build_object(
    'meta', jsonb_build_object(
       -- From the repo table. base_repo_full_name is the wrong source
       -- (DATA_CONTRACT.md §3) and is NULL for any repository with no pull requests.
       'repo',             _repo_nm,
       'repo_id',          _repo_id,
       'repo_ambiguous',   (_n_named > 1),
       -- Every payload source declares the contract it was built against, so a stale
       -- consumer fails loudly instead of rendering subtly wrong.
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
                          || 'NOT joined to any GitHub account. The actor on '
                          || 'a CommitObserved event is the PUSHER.'),
       'source', jsonb_build_object(
          'rpc',          'api.get_sublog',
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

COMMENT ON FUNCTION api.get_sublog(text, text, integer) IS
  'Returns one sub-log as a SubLog payload (docs/DATA_LAYER.md). Seed is a prefixed object '
  'id: issue:<id>, pr:<id>, commit:<sha>. traversal_degree is SERVER-SIDE expansion, 0..2, '
  'default 1, and is unrelated to MAX_FOCUS_DEGREE. There is no case notion.';


-- =====================================================================================
-- §7 — Diagnostics
--
-- These are obligations, not extras. Each view above subtracts something, and every
-- subtraction must be declared rather than absorbed (CLAUDE.md). Run after
-- every upstream refresh.
-- =====================================================================================

-- §7.1 — what the vocabulary whitelist drops.
--
-- Reading it, as of 2026-08-04. Three rows, and only one of them is large:
--
--   CommitsPushed   144,556   EXPECTED, and not data loss. It is not an activity here;
--                             its facts — commit_count, distinct_commit_count,
--                             truncated, ref — ride on each CommitObserved event's attrs
--                             instead, so the information is carried, not dropped. This
--                             row will always be here and should not be "fixed".
--   IssueComment_         1   Upstream's name built with an empty action. Genuinely dropped.
--   IssueLabeled          1   Out of scope. Genuinely dropped.
--
-- Note what is NOT here: PullRequestCommented (1,343,232) and
-- PullRequestMergedOffPlatform (31), because both are in the vocabulary. Their absence
-- from this list is the evidence that the vocabulary is right.
DROP VIEW IF EXISTS fe.diag_dropped_activities;
CREATE VIEW fe.diag_dropped_activities AS
SELECT activity_type AS activity, count(*) AS dropped
FROM (
  SELECT activity_type FROM mv_issue_and_issuecomment_activities_full
  UNION ALL SELECT activity_type FROM mv_pull_request_and_comment_activities_full
  UNION ALL SELECT activity_type FROM mv_push_activities
) s
WHERE activity_type NOT IN (SELECT activity FROM fe.activity_vocabulary)
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

-- §7.3 — how many objects needed the first-seen fallback. This must be RENDERED, not
-- merely carried: open-ended left edge, hollow start marker.
CREATE OR REPLACE VIEW fe.diag_time_semantics AS
SELECT repo_id, type, time_semantics, count(*) AS objects
FROM (
  SELECT repo_id, type, time_semantics FROM fe.object_issue
  UNION ALL SELECT repo_id, type, time_semantics FROM fe.object_pull_request
) s
GROUP BY 1,2,3 ORDER BY 1,2,3;

-- §7.4 — the link breakdown, GROUPED BY (method, qualifier).
-- ⚠️ This grouping is binding. `commit_message` is one detection technique
-- covering two relationships — issue↔PR (`resolves`) and commit→issue (`references_issue`)
-- — so grouping by method alone silently sums two different relations into one number,
-- and this is precisely the figure where that would happen.
-- Report `proximity` separately: nothing is asserted and nothing is parsed, only two
-- timestamps are near each other, so a coverage figure carried by it is a weaker claim.
CREATE OR REPLACE VIEW fe.diag_link_methods AS
SELECT l.repo_id, l.method, l.qualifier, l.evidence, count(*) AS links
FROM fe.link l
GROUP BY 1,2,3,4 ORDER BY 1,5 DESC;

-- §7.5 — what the `ref_match` narrowing removes, and what it saves.
--
-- Reported because the narrowing is the one place we diverge from the upstream
-- `admitted` rule, and a divergence nobody can measure is a divergence nobody can argue
-- with. `kept_only_by_ref_match` is the column that answers "would SHA-only have done":
-- those commits have no SHA link at all, so under SHA-only they lose their pull request
-- entirely and fall into the "Not linked to a PR" group.
CREATE OR REPLACE VIEW fe.diag_ref_match_narrowing AS
WITH rm AS (
  SELECT DISTINCT l.repo_id, l.commit_sha, l.pull_request_id
  FROM mv_commit_pr_links l WHERE l.admitted AND l.link_method = 'ref_match'
),
sha AS (
  -- push_order counts as an anchored method here: it needs the PR's head and merge SHAs
  -- in the push, so a commit it names is not "kept only by ref_match".
  SELECT DISTINCT repo_id, commit_sha, pull_request_id
  FROM mv_commit_pr_links WHERE admitted AND link_method IN ('head_sha','merge_commit_sha','push_order')
),
-- ⚠️ Reports the narrowing's **cost as well as its benefit**, because a filter that only
-- ever printed what it removed would read as pure gain. `dropped_born_elsewhere` is the
-- cross-branch pass-through this exists to catch; `dropped_born_here` is a real link lost
-- to a force-push, a rebase or GH Archive's 20-commit truncation, and is the floor's size.
born_on_pr_branch AS (
  SELECT rm.repo_id, rm.commit_sha, rm.pull_request_id,
         EXISTS (SELECT 1 FROM fe.pr_head_ref h
                   JOIN fe.commit_born_ref b
                     ON b.repo_id = rm.repo_id AND b.commit_sha = rm.commit_sha
                    AND b.ref = h.head_ref_full
                  WHERE h.repo_id = rm.repo_id
                    AND h.pull_request_id = rm.pull_request_id) AS kept
  FROM rm
)
SELECT r.name AS repo,
       count(*)                                              AS ref_match_pairs_upstream,
       count(*) FILTER (WHERE k.kept)                        AS kept,
       count(*) FILTER (WHERE NOT k.kept AND o.first_seen_ref IS DISTINCT FROM h.head_ref_full)
                                                             AS dropped_born_elsewhere,
       count(*) FILTER (WHERE NOT k.kept AND o.first_seen_ref = h.head_ref_full)
                                                             AS dropped_born_here_floor,
       count(*) FILTER (WHERE k.kept
                          AND NOT EXISTS (SELECT 1 FROM sha s
                                WHERE s.repo_id = rm.repo_id
                                  AND s.commit_sha = rm.commit_sha
                                  AND s.pull_request_id = rm.pull_request_id))
                                                             AS kept_only_by_ref_match
FROM rm
JOIN repo r ON r.id = rm.repo_id
JOIN born_on_pr_branch k
  ON k.repo_id = rm.repo_id AND k.commit_sha = rm.commit_sha
 AND k.pull_request_id = rm.pull_request_id
LEFT JOIN fe.commit_branch_origin o
  ON o.repo_id = rm.repo_id AND o.commit_sha = rm.commit_sha
LEFT JOIN fe.pr_head_ref h
  ON h.repo_id = rm.repo_id AND h.pull_request_id = rm.pull_request_id
GROUP BY 1 ORDER BY 2 DESC;

-- §7.6 — the six sanity checks that catch the SILENT failures. Every one must equal `expected`.
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
SELECT 'distinct activities (must be exactly 11)',
       (SELECT count(DISTINCT activity) FROM fe.event), 11;


-- =====================================================================================
-- §8 — Seed search
--
-- The seed picker cannot enumerate its options: a repository holds
-- hundreds of thousands of issues and pull requests and millions of commits, so the
-- interaction is a *search*. This is what it searches.
--
-- ⚠️ **The one place this layer stores what a search could return, and nothing about
-- what a seed would YIELD.** Working out what a seed yields means running the traversal
-- for that candidate, which cannot be done for every candidate in a repository.
-- So: type, number or SHA, title. Nothing else.
--
-- MATERIALIZED, and here is the measurement that justifies it. Against the plain
-- object views a single lookup cost 348 ms (issue by number), 160 ms (commit by SHA
-- prefix) and 597 ms (title scan) — because each one rebuilds a DISTINCT ON over the
-- identity and first-seen union before filtering. A typeahead fires that on every
-- keystroke. Materialized and indexed it is sub-millisecond; the numbers are in §8.1.
--
-- A search index is also the one thing that is *unambiguously* safe to precompute here:
-- it depends only on which objects exist, never on the sub-log selection, so the rule
-- against precomputing over a sub-log does not apply.
-- =====================================================================================

DROP MATERIALIZED VIEW IF EXISTS fe.seed_lookup CASCADE;
CREATE MATERIALIZED VIEW fe.seed_lookup AS
-- Titles are edited over an object's life, so take the most recent one rather than the
-- first: it is what the object is called now, which is what someone searching for it
-- will type.
WITH issue_title AS (
  SELECT DISTINCT ON (issue_id) issue_id, issue_title
  FROM mv_issues_full
  WHERE issue_id IS NOT NULL
  ORDER BY issue_id, event_created_at DESC
)
SELECT o.repo_id,
       o.id,
       'issue'::text        AS type,
       o.label,
       o.issue_number       AS number,
       NULL::text           AS sha,
       t.issue_title        AS title
FROM fe.object_issue o
LEFT JOIN issue_title t ON t.issue_id = o.issue_id

UNION ALL
SELECT o.repo_id, o.id, 'pull_request', o.label, o.pr_number, NULL, o.vmap->>'title'
FROM fe.object_pull_request o

UNION ALL
-- A commit's "title" is the first line of its message, which is the git convention and
-- the only part worth matching against. The full message is in the payload's vmap.
SELECT o.repo_id, o.id, 'commit', o.label, NULL, o.commit_sha,
       NULLIF(split_part(o.vmap->>'commit_message', E'\n', 1), '')
FROM fe.object_commit o
WITH DATA;

-- Exact and prefix matching on a number, per repo and type.
CREATE INDEX IF NOT EXISTS ix_seed_repo_type_number ON fe.seed_lookup (repo_id, type, number);
-- ⚠️ `text_pattern_ops` is required for `LIKE 'abc%'` to use the index. A default btree
-- is built for the collation's ordering and cannot answer a prefix match, so without
-- this operator class the SHA search silently falls back to a sequential scan — fast
-- enough to look fine on a small repo and not on a large one.
CREATE INDEX IF NOT EXISTS ix_seed_repo_sha ON fe.seed_lookup (repo_id, sha text_pattern_ops);
CREATE INDEX IF NOT EXISTS ix_seed_repo_type ON fe.seed_lookup (repo_id, type);
ANALYZE fe.seed_lookup;

COMMENT ON MATERIALIZED VIEW fe.seed_lookup IS
  'What a seed search can cheaply return about an object: type, number or SHA, title. '
  'Never what a seed would yield. Refresh with fe.refresh_search().';

CREATE OR REPLACE FUNCTION fe.refresh_search() RETURNS void
LANGUAGE sql AS $$
  REFRESH MATERIALIZED VIEW fe.seed_lookup;
$$;


-- =====================================================================================
-- §12.0 — The DFG's event layer, in OCEL 2.0 E2O shape: fe.dfg_event and fe.dfg_e2o
--
-- Read ONLY by fe.dfg (§12). Trace's fe.event, fe.link and api.get_sublog are
-- untouched, and so is every fixture.
--
-- fe.event carries ONE object per event, so §4 takes a push apart into one synthetic
-- CommitObserved per commit row and drops the real `CommitsPushed` activity at the
-- whitelist (§7.1 counts them: 144,556). That is the OCEL 2.0 E2O relation flattened to
-- arity one. For the process map the push is put back together:
--
--   fe.dfg_event   one row per REAL event — the ten issue/PR activities straight from
--                  fe.event, plus `Push`, one per mv_push_activities row (upstream's
--                  name is CommitsPushed). Keyed `push:<activity_id>`: activity_id is the
--                  PushEvent id and unique (144,556 rows); push_id has one duplicate and
--                  is not a key.
--   fe.dfg_e2o     (event_id, object_id, qualifier) — every event to its SUBJECT (the
--                  issue or pull request it is about), to its actor under the role the
--                  activity gives them, and a push to every commit it carried
--                  (`pushed_commit`) and to its pusher. A push of n commits is ONE event
--                  with n commit occurrences — the shape §12 counts in.
--
-- ⚠️ `Push` is the map's only private activity. fe.activity_vocabulary (§1) stays at eleven
-- and fe.event never emits it; the map in turn never emits CommitObserved. The JS
-- ACTIVITIES table carries both, one per page, and says so.
--
-- Measured 2026-09-02 (MVs refreshed 2026-08-02):
--   * (event_id, commit_sha) is unique in mv_push_commits_full, 0 NULL shas, so
--     fe.dfg_e2o is a set. On every joined row created_at = activity_timestamp,
--     actor_id = actor_user_id and repo_id agree (0 mismatches each), so the commit
--     lane keeps its order and its pusher. actor_user_id is never NULL.
--   * 416 pushes (387 in vscode) carry no commit row: events with only a `pusher` E2O
--     row, which §12 drops with the actors. No fe.event id and no fe.link_mat endpoint
--     starts with `push:`.
--   * fe.event is scanned ONCE per view, key columns only — the §12 attrs pruning
--     survives the UNION ALL and the join (0 SubPlans by EXPLAIN). dfg_e2o ⋈ dfg_event
--     returns 3,167,844 rows (exactly fe.event's count) in 14.8 s; §12's `typed` CTE
--     is referenced three times and so computed once per build.
--
-- NOT here: PullRequestMerged → merge-commit rows (85.5% of merges resolve to a commit
-- object). That would put a PR activity on the commit lane; a separate modelling decision.
-- =====================================================================================

DROP VIEW IF EXISTS fe.dfg_event CASCADE;
CREATE VIEW fe.dfg_event AS
SELECT e.id, e.activity, e.time, e.actor_id, e.actor_num, e.repo_id
FROM fe.event e
WHERE e.activity <> 'CommitObserved'
UNION ALL
SELECT 'push:' || p.activity_id::text,
       'Push'::text,
       p.activity_timestamp AT TIME ZONE 'UTC',     -- naive upstream, lifted here (header)
       'actor:' || p.actor_user_id::text,
       p.actor_user_id,
       p.repo_id
FROM mv_push_activities p;

COMMENT ON VIEW fe.dfg_event IS
  'One row per real event, for the process map only: fe.event''s issue and PR activities '
  'plus Push, one per PushEvent (mv_push_activities). Trace does not read this.';

DROP VIEW IF EXISTS fe.dfg_e2o CASCADE;
CREATE VIEW fe.dfg_e2o AS
-- One fe.event scan yields both the subject and the actor row — a LATERAL VALUES, not a
-- second UNION ALL branch, which would read the 2.8M-row view a third time per build.
SELECT e.id AS event_id, v.object_id, v.qualifier
FROM fe.event e
CROSS JOIN LATERAL (VALUES
  (e.object_id, 'subject'::text),
  (e.actor_id, CASE e.activity
     WHEN 'IssueOpened'                  THEN 'opener'
     WHEN 'PullRequestOpened'            THEN 'opener'
     WHEN 'IssueClosed'                  THEN 'closer'
     WHEN 'PullRequestClosed'            THEN 'closer'
     -- the off-platform merge is a close on GitHub; its actor is whoever closed
     WHEN 'PullRequestMergedOffPlatform' THEN 'closer'
     WHEN 'IssueReopened'                THEN 'reopener'
     WHEN 'PullRequestReopened'          THEN 'reopener'
     WHEN 'IssueCommented'               THEN 'commenter'
     WHEN 'PullRequestCommented'         THEN 'commenter'
     WHEN 'PullRequestMerged'            THEN 'merger'
   END)) AS v(object_id, qualifier)
WHERE e.activity <> 'CommitObserved'
  AND v.object_id IS NOT NULL                       -- an actor-less event (§4) has no actor row
UNION ALL
SELECT 'push:' || pc.event_id::text, 'commit:' || pc.commit_sha, 'pushed_commit'::text
FROM mv_push_commits_full pc
WHERE pc.commit_sha IS NOT NULL
UNION ALL
SELECT 'push:' || p.activity_id::text, 'actor:' || p.actor_user_id::text, 'pusher'::text
FROM mv_push_activities p;

COMMENT ON VIEW fe.dfg_e2o IS
  'OCEL 2.0 event-to-object relation for the process map: (event_id, object_id, qualifier). '
  'Qualifiers: subject, pushed_commit, and the actor roles opener, closer, reopener, '
  'commenter, merger, pusher. Read only by fe.dfg.';

-- =====================================================================================
-- §12 — fe.dfg: the object-centric directly-follows graph over the ENTIRE log
--
-- One artifact per repository, three kinds of row: activity NODES per object type
-- (events, occurrences, objects, starts, ends), per-type EDGES (how often one activity
-- directly follows another within one object's own event sequence), and CROSS EDGES
-- (successions between the two objects of a linked pair). There is no case notion
-- anywhere in this: succession is counted per object, and across objects only through
-- links.
--
-- Built over the E2O layer (§12.0), so the unit is the event–object OCCURRENCE: a push
-- of n commits is one event with n occurrences, one in each commit's sequence. Nodes
-- carry both counts; `events` (distinct) is below `occurrences` only on `Push`.
--
-- Object type comes from the object-id PREFIX: the E2O rows carry ids, not types, and
-- the prefix is the one statement of type every id already makes.
--
-- ⚠️ **Cross-edge counts are FLOORS.** They are derived through fe.link_mat, which the
-- two admission rules narrow (§5), so they undercount by an unmeasured amount. Quote
-- them as floors, never point estimates.
--
-- MATERIALIZED, like fe.seed_lookup and for the same reason it is allowed to be: it
-- depends only on what the whole log contains, never on a sub-log selection, so the rule
-- against precomputing over a sub-log does not apply — and it aggregates data the
-- frontend never loads, which is exactly the SQL exception CLAUDE.md's metrics rule
-- names. The build is a full-log scan and could never be a request path.
--
-- Measurements, 2026-09-02 (MVs refreshed 2026-08-02):
--   * `typed` = fe.dfg_e2o ⋈ fe.dfg_event, 3,167,844 rows — exactly fe.event's count,
--     because every CommitObserved row became one `pushed_commit` occurrence. The §4
--     attrs subqueries stay pruned through the views (0 SubPlans by EXPLAIN); the join
--     costs 14.8 s against 6.6 s for the old key-only scan.
--   * output 637 rows: 33 nodes, 103 per-type edges, 501 cross rows (one per link
--     class since v2). Whole build 45 s (fe.refresh_dfg, 2026-09-02).
--   * conservation checked per (repo, type), all nine partitions:
--     Σ successions = Σ occurrences − Σ starts, and Σ starts = Σ ends; the commit
--     partition's edges are Push → Push only (a commit carried by a later push);
--     vscode's commit lane: 210,196 occurrences over 88,913 pushes, 94,907
--     successions — the same figures the CommitObserved lane had, renamed.
--   * api.get_dfg('microsoft/vscode') off the MV: ~0.8 s end to end, ~59 KB payload.
-- =====================================================================================

-- Dropped rather than replaced: the column list changed at v2 (the class columns), and
-- CREATE OR REPLACE cannot reshape a view. The CASCADE takes fe.dfg_mat, rebuilt below.
DROP VIEW IF EXISTS fe.dfg CASCADE;
CREATE VIEW fe.dfg AS
WITH typed AS (
  -- The E2O layer (§12.0), one row per event–object occurrence, typed by the object-id
  -- PREFIX. Only actor rows resolve to no lane type and the WHERE drops them, so actors
  -- stay out of the map as before. `push:` is an EVENT-id prefix and never reaches
  -- this CASE. Key columns only, still: attrs is never projected (§12.0 measurement).
  SELECT e.repo_id, o.object_id,
         CASE split_part(o.object_id, ':', 1)
           WHEN 'issue'  THEN 'issue'
           WHEN 'pr'     THEN 'pull_request'
           WHEN 'commit' THEN 'commit'
         END AS object_type,
         e.activity, e.time, e.id
  FROM fe.dfg_e2o o
  JOIN fe.dfg_event e ON e.id = o.event_id
  WHERE split_part(o.object_id, ':', 1) IN ('issue', 'pr', 'commit')
),
seq AS (
  -- Each object's own sequence, one row per OCCURRENCE. `id` breaks real ties: the
  -- commits of one push share its time and its event id, and the sub-log payload's own
  -- ordering is (time, id) too (§6).
  SELECT repo_id, object_type, object_id, activity, id,
         LAG(activity)  OVER w AS prev_activity,
         row_number()   OVER w AS rn,
         count(*) OVER (PARTITION BY repo_id, object_id) AS n_events
  FROM typed
  WINDOW w AS (PARTITION BY repo_id, object_id ORDER BY time, id)
),
nodes AS (
  SELECT repo_id, object_type, activity,
         count(*)                              AS occurrences,  -- E2O rows: the unit edges are in
         count(DISTINCT id)                    AS events,       -- real events; below occurrences only on Push
         count(DISTINCT object_id)             AS objects,
         count(*) FILTER (WHERE rn = 1)        AS starts,
         count(*) FILTER (WHERE rn = n_events) AS ends
  FROM seq GROUP BY 1, 2, 3
),
edges AS (
  SELECT repo_id, object_type, prev_activity AS from_activity, activity AS to_activity,
         count(*)                  AS successions,
         count(DISTINCT object_id) AS objects
  FROM seq WHERE prev_activity IS NOT NULL
  GROUP BY 1, 2, 3, 4
),
pair_events AS (
  -- Both endpoints' events, tagged with the pair they belong to. Two equality joins
  -- rather than `object_id IN (source, target)`, so each side can use an index path.
  -- The link's own classification rides along: verified 2026-09-01, no (source, target)
  -- appears twice in fe.link_mat, so every pair carries exactly ONE (qualifier,
  -- evidence, method) — a succession inherits it with no attribution rule. The
  -- dfg-check gate asserts that fact so it fails loudly the day it stops holding.
  SELECT l.repo_id, l.source, l.target, l.qualifier, l.evidence, l.method,
         t.object_id, t.object_type, t.activity, t.time, t.id
  FROM fe.link_mat l JOIN typed t ON t.repo_id = l.repo_id AND t.object_id = l.source
  UNION ALL
  SELECT l.repo_id, l.source, l.target, l.qualifier, l.evidence, l.method,
         t.object_id, t.object_type, t.activity, t.time, t.id
  FROM fe.link_mat l JOIN typed t ON t.repo_id = l.repo_id AND t.object_id = l.target
),
merged AS (
  -- The linked pair's two sequences interleaved by time. Only ADJACENT events that
  -- cross from one object to the other count as a succession; a run of events on one
  -- side contributes nothing until the other side speaks. The link attributes sit in
  -- the PARTITION deliberately: constant per pair today (so a no-op), but should a
  -- duplicate link ever appear, each link then counts its own interleaving instead of
  -- two copies interleaving into phantom successions.
  SELECT repo_id, source, target, qualifier, evidence, method,
         object_id, object_type, activity,
         LAG(object_id)   OVER w AS prev_object,
         LAG(object_type) OVER w AS prev_type,
         LAG(activity)    OVER w AS prev_activity
  FROM pair_events
  -- Ties are broken the way the Trace page ranks marks (layout/nodes.js assignRanks:
  -- time, then lane, then id), so the two pages agree on same-second order. Not a
  -- nicety: a commit that closes an issue is pushed and closes it in the SAME second,
  -- so the tie rule decides the direction of every closed-via-commit succession —
  -- 11,625 of vscode's 132,050 cross successions flipped when the ids alone decided.
  WINDOW w AS (PARTITION BY repo_id, source, target, qualifier, evidence, method
               ORDER BY time, object_type, id)
),
cross_edges AS (
  -- from_type <> to_type always: fe.link endpoints are cross-type by construction.
  -- One row per (edge, link class); the frontend aggregates back to one arrow and
  -- keeps the classes for its breakdown.
  SELECT repo_id, prev_type AS from_type, prev_activity AS from_activity,
         object_type AS to_type, activity AS to_activity,
         qualifier, evidence, method,
         count(*)                         AS successions,
         count(DISTINCT (source, target)) AS pairs
  FROM merged
  WHERE prev_object IS NOT NULL AND prev_object <> object_id
  GROUP BY 1, 2, 3, 4, 5, 6, 7, 8
)
SELECT repo_id, 'node'::text AS kind, object_type, activity,
       NULL::text AS from_activity, NULL::text AS to_activity, NULL::text AS to_type,
       events, occurrences, objects, starts, ends, NULL::bigint AS successions,
       NULL::text AS link_qualifier, NULL::text AS link_evidence, NULL::text AS link_method
FROM nodes
UNION ALL
SELECT repo_id, 'edge', object_type, NULL, from_activity, to_activity, NULL,
       NULL, NULL, objects, NULL, NULL, successions,
       NULL, NULL, NULL
FROM edges
UNION ALL
-- Cross rows carry the pair count in `objects`: a pair is the unit a cross succession
-- is counted within, the way an object is for a per-type edge. The class columns are
-- link_-prefixed: the classification belongs to the LINK a succession rides on, never
-- to the succession itself, which remains an observation.
SELECT repo_id, 'cross_edge', from_type, NULL, from_activity, to_activity, to_type,
       NULL, NULL, pairs, NULL, NULL, successions,
       qualifier, evidence, method
FROM cross_edges;

DROP MATERIALIZED VIEW IF EXISTS fe.dfg_mat CASCADE;
CREATE MATERIALIZED VIEW fe.dfg_mat AS SELECT * FROM fe.dfg WITH DATA;
-- No index: 637 rows for the whole database. An index here would be a habit, not a
-- finding (§0's own rule); the RPC's per-repo filter scans them faster than it could
-- plan an index path.
ANALYZE fe.dfg_mat;

CREATE OR REPLACE FUNCTION fe.refresh_dfg() RETURNS void
LANGUAGE sql AS $$
  REFRESH MATERIALIZED VIEW fe.dfg_mat;
$$;

COMMENT ON MATERIALIZED VIEW fe.dfg_mat IS
  'The whole-log directly-follows graph, per repository and object type, over the E2O '
  'layer (§12.0). ~45 s to build. '
  'Run fe.refresh_dfg() after any upstream MV refresh; fe.diag_staleness reports its age. '
  'Cross-edge rows are floors: they are derived through fe.link_mat''s narrowed links.';


-- =====================================================================================
-- §11 — Refreshing this layer
--
-- Three relations here are materialized — `fe.link_mat` (§5.1), `fe.seed_lookup`
-- (§8) and `fe.dfg_mat` (§12) — and all go stale silently the moment any upstream MV is refreshed. Silently is
-- the problem: a stale link table does not error, it just quietly answers with last
-- week's graph, and a stale search index simply cannot find objects that now exist.
--
-- One entry point, so there is nothing to half-remember:
--
--     SELECT fe.refresh_all();          -- after any upstream refresh (~11 s)
--     SELECT * FROM fe.diag_staleness;  -- is anything behind?
--
-- ⚠️ **Order matters.** `fe.seed_lookup` reads the object views, which read the upstream
-- MVs; `fe.link_mat` reads `fe.link`, which reads `fe.commit_pr_link`. Neither depends on
-- the other, so either order works today — but they are refreshed in dependency order
-- anyway, because that stops being true the moment one is built on the other.
-- =====================================================================================

CREATE OR REPLACE FUNCTION fe.refresh_all() RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  REFRESH MATERIALIZED VIEW fe.link_mat;
  REFRESH MATERIALIZED VIEW fe.seed_lookup;
  -- After link_mat: the cross-edge arm reads it, so a stale link table would bake last
  -- week's pairs into a fresh-looking DFG.
  REFRESH MATERIALIZED VIEW fe.dfg_mat;
END;
$$;

COMMENT ON FUNCTION fe.refresh_all() IS
  'Refresh every materialized relation in this layer. Run after any upstream MV refresh.';

-- Row counts alone cannot prove freshness — an upstream change that adds and removes the
-- same number of rows leaves them equal. What this catches is the common case (upstream
-- grew, we did not) and, more usefully, tells you when each copy was last written, so
-- "is this older than the upstream refresh?" is answerable at a glance.
CREATE OR REPLACE VIEW fe.diag_staleness AS
SELECT 'fe.link_mat'::text AS relation,
       (SELECT count(*) FROM fe.link)     AS live_rows,
       (SELECT count(*) FROM fe.link_mat) AS materialized_rows,
       (SELECT (pg_stat_file(pg_relation_filepath('fe.link_mat'))).modification) AS last_written
UNION ALL
SELECT 'fe.seed_lookup',
       (SELECT count(*) FROM fe.object_issue) + (SELECT count(*) FROM fe.object_pull_request)
         + (SELECT count(*) FROM fe.object_commit),
       (SELECT count(*) FROM fe.seed_lookup),
       (SELECT (pg_stat_file(pg_relation_filepath('fe.seed_lookup'))).modification)
UNION ALL
-- live_rows is honestly NULL: counting fe.dfg live IS the whole-log recomputation,
-- which a diagnostic must not cost. last_written carries the weight here.
SELECT 'fe.dfg_mat',
       NULL::bigint,
       (SELECT count(*) FROM fe.dfg_mat),
       (SELECT (pg_stat_file(pg_relation_filepath('fe.dfg_mat'))).modification);


-- -------------------------------------------------------------------------------------
-- §8.1 — Measurements for fe.seed_lookup (the number, not the habit)
--
-- Same queries, plain views versus this materialized index, 2026-08-04:
--
--   issue by exact number        348 ms  ->    1.2 ms
--   number prefix, 20 results      —    ->   12.4 ms
--   commit by SHA prefix         160 ms  ->    1.6 ms
--   title contains, 20 results   597 ms  ->   81.8 ms
--
-- 529,199 rows, built in 4.2 s. Refresh with `SELECT fe.refresh_search();`
--
-- **`pg_trgm` was considered and declined.** It is available but not installed, and a
-- GIN trigram index would take the title search below ~10 ms. At 82 ms behind a debounced
-- typeahead it is not the bottleneck, and `CREATE EXTENSION` is a database-wide change
-- that other people's work would inherit — a bigger footprint than the problem. Revisit
-- if title search moves onto the critical path; the lever is one index.
-- -------------------------------------------------------------------------------------


-- =====================================================================================
-- §9 — The search RPC
--
-- `api.search_seeds` takes an ALREADY-PARSED reference, not a raw string.
--
-- ⚠️ That is deliberate and it is the whole design of this function. `parseSeedRef` in
-- `src/data/seedQuery.js` already turns "pr #243221" into {type, number, shaPrefix, text},
-- it is unit-tested, and it is what the fixture path uses. Re-implementing that parse in
-- SQL would give the two transports two different parsers to disagree about — the
-- fixture search finding something the database search does not, or ranking it
-- differently, with nothing to say which is right.
--
-- So the split is: **SQL filters, JavaScript ranks.** This function returns a permissive
-- superset of candidates using the indexes; `scoreSeedRef` then applies exact-beats-
-- prefix-beats-substring exactly as it does for the catalogue. One parser, one ranker,
-- two sources.
-- =====================================================================================

CREATE OR REPLACE FUNCTION api.search_seeds(
  repo         text,
  seed_type    text    DEFAULT NULL,   -- 'issue' | 'pull_request' | 'commit'
  number_query text    DEFAULT NULL,   -- digits, matched as a substring
  sha_prefix   text    DEFAULT NULL,   -- matched from the front, as git abbreviates
  text_query   text    DEFAULT NULL,   -- free text, matched against title and label
  max_results  integer DEFAULT 20
) RETURNS TABLE (id text, type text, label text, number integer, sha text, title text)
LANGUAGE plpgsql STABLE AS $fn$
DECLARE
  _repo_id bigint;
BEGIN
  IF max_results IS NULL OR max_results < 1 OR max_results > 200 THEN
    RAISE EXCEPTION 'max_results must be between 1 and 200, got %', max_results;
  END IF;

  -- Same deterministic name resolution as get_sublog: repo.name is not unique in
  -- this database, so ties break on event volume rather than on whichever row came back.
  SELECT r.id INTO _repo_id
  FROM repo r
  WHERE r.name = repo
  ORDER BY (SELECT count(*) FROM event e WHERE e.repo_id = r.id) DESC, r.id
  LIMIT 1;

  IF _repo_id IS NULL THEN
    RAISE EXCEPTION 'no repository named %', repo
      USING HINT = 'SELECT name FROM repo — this database holds three with data.';
  END IF;

  RETURN QUERY
  SELECT s.id, s.type, s.label, s.number, s.sha, s.title
  FROM fe.seed_lookup s
  WHERE s.repo_id = _repo_id
    AND (seed_type IS NULL OR s.type = seed_type)
    AND (
      -- A bare "123" is a plausible issue number AND a plausible SHA prefix, and
      -- `parseSeedRef` refuses to guess between them — so both arrive and both are
      -- matched. Ranking sorts it out.
      (number_query IS NOT NULL AND s.number IS NOT NULL
         AND s.number::text LIKE '%' || number_query || '%')
      OR (sha_prefix IS NOT NULL AND s.sha IS NOT NULL
         AND s.sha LIKE sha_prefix || '%')
      OR (text_query IS NOT NULL
         AND (s.title ILIKE '%' || text_query || '%' OR s.label ILIKE '%' || text_query || '%'))
      -- A type word on its own ("pr") is a filter, not nothing: it should narrow to
      -- pull requests rather than match everything or nothing.
      OR (number_query IS NULL AND sha_prefix IS NULL AND text_query IS NULL)
    )
  -- A stable order before the cap, so the same query returns the same candidates. The
  -- client ranks properly; this only decides which ones survive the limit.
  ORDER BY s.type, s.number DESC NULLS LAST, s.id
  LIMIT max_results;
END;
$fn$;

COMMENT ON FUNCTION api.search_seeds(text, text, text, text, text, integer) IS
  'Seed search. Takes an already-parsed reference (see src/data/seedQuery.js) and returns '
  'a permissive superset of candidates; the client ranks them. Carries only what a search '
  'can cheaply return about an object, never what a seed would yield.';


-- =====================================================================================
-- §10 — Repository list
--
-- What the repository selector is populated from. Small, and the only enumerable thing
-- in the API: there are three repositories, against hundreds of thousands of objects.
--
-- ⚠️ `available` is computed, not declared. The fixture catalogue hardcoded react and
-- kubernetes as unavailable because no sub-log had been pre-built for them; that was
-- true of the fixture transport and is false of this one. A repository is available here
-- when it actually has something to seed from, which is a fact rather than a list
-- somebody has to remember to update.
-- =====================================================================================

CREATE OR REPLACE FUNCTION api.list_repos()
RETURNS TABLE (name text, repo_id bigint, available boolean, reason text, seeds bigint)
LANGUAGE sql STABLE AS $$
  -- ONE row per name: the row with the most seeds, id as the tie-break — the same rule
  -- get_sublog resolves an ambiguous name by, so the picker offers exactly what
  -- the RPC would pick. The duplicate `kubernetes/kubernetes` stub (a recreated repo,
  -- 1 event, no seeds) is hidden rather than listed as a "no data" row: a picker row
  -- that cannot be chosen demonstrates nothing to a reader, and the ambiguity is
  -- still reported where it matters, on the payload (meta.repo_ambiguous).
  SELECT DISTINCT ON (r.name)
         r.name,
         r.id,
         count(s.id) > 0,
         CASE WHEN count(s.id) > 0 THEN NULL
              ELSE 'No issues, pull requests or commits in the window.' END,
         count(s.id)
  FROM repo r
  LEFT JOIN fe.seed_lookup s ON s.repo_id = r.id
  GROUP BY r.name, r.id
  ORDER BY r.name, count(s.id) DESC, r.id;
$$;

COMMENT ON FUNCTION api.list_repos() IS
  'Repositories and whether anything can be seeded from them. Availability is computed '
  'from fe.seed_lookup, not declared.';


-- =====================================================================================
-- §13 — The DFG RPC
--
--   api.get_dfg(repo)
--
-- One whole-log directly-follows graph per repository, read from fe.dfg_mat (§12).
-- No seed, no traversal: the query IS the repository. There is no case notion — the
-- payload's own vocabulary is object type, activity, succession.
-- =====================================================================================

CREATE OR REPLACE FUNCTION api.get_dfg(
  repo text
) RETURNS jsonb
LANGUAGE plpgsql STABLE AS $fn$
DECLARE
  _repo_id  bigint;
  _repo_nm  text;
  _n_named  integer;
  _payload  jsonb;
BEGIN
  ------------------------------------------------------------------------------------
  -- Resolve the repository BY NAME, exactly as get_sublog does (§6): repo.name is
  -- not unique, ties break on event volume, and the ambiguity is reported rather than
  -- hidden. The two resolvers must never disagree about which repository a name means.
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

  SELECT jsonb_build_object(
    'meta', jsonb_build_object(
       'repo',             _repo_nm,
       'repo_id',          _repo_id,
       'repo_ambiguous',   (_n_named > 1),
       -- Its OWN counter, not the SubLog's contract_version: the two payloads
       -- change independently, and a consumer of one must not fail on the other's bump.
       'dfg_contract_version', 3,
       'generated_at',     fe.utc(now()),
       'activity_scope',   'OCEL-strict + comments (reviews/dismissals/review-comments excluded)',
       'data_honesty', jsonb_build_object(
          'succession',    'Counted within each object''s own event sequence, over the '
                        || 'whole log, no windowing — per event–object occurrence, so a '
                        || 'push of n commits is one event with n occurrences, one in '
                        || 'each commit''s sequence. A succession is an observation, '
                        || 'not a traceability claim.',
          'cross_edges',   'Derived through the admitted links, which two admission '
                        || 'rules narrow. Every cross-edge count is a floor, never a '
                        || 'point estimate. One row per link class, link_-prefixed: '
                        || 'the classification belongs to the link a succession rides '
                        || 'on, never to the succession itself.',
          'commit_time',   'first-seen in PushEvent, NOT real git commit time',
          'truncation',    'GH Archive caps PushEvent.commits at 20; commit sequences '
                        || 'undercount pushes larger than that.'),
       'source', jsonb_build_object(
          'rpc',          'api.get_dfg',
          'layer',        'sql/fe_layer.sql',
          'mv_refreshed', '2026-08-02T19:45:00+00:00')
    ),
    'nodes', COALESCE((
       SELECT jsonb_agg(jsonb_build_object(
         'object_type', d.object_type, 'activity', d.activity,
         'events', d.events, 'occurrences', d.occurrences, 'objects', d.objects,
         'starts', d.starts, 'ends', d.ends)
         ORDER BY d.object_type, d.activity)
       FROM fe.dfg_mat d WHERE d.repo_id = _repo_id AND d.kind = 'node'), '[]'::jsonb),
    'edges', COALESCE((
       SELECT jsonb_agg(jsonb_build_object(
         'object_type', d.object_type,
         'from_activity', d.from_activity, 'to_activity', d.to_activity,
         'successions', d.successions, 'objects', d.objects)
         ORDER BY d.object_type, d.from_activity, d.to_activity)
       FROM fe.dfg_mat d WHERE d.repo_id = _repo_id AND d.kind = 'edge'), '[]'::jsonb),
    'cross_edges', COALESCE((
       SELECT jsonb_agg(jsonb_build_object(
         'from_type', d.object_type, 'from_activity', d.from_activity,
         'to_type', d.to_type, 'to_activity', d.to_activity,
         'successions', d.successions, 'pairs', d.objects,
         'link_qualifier', d.link_qualifier, 'link_evidence', d.link_evidence,
         'link_method', d.link_method)
         -- The class keys joined the sort: the four-key order stopped being unique
         -- the moment one arrow could carry several class rows.
         ORDER BY d.object_type, d.from_activity, d.to_type, d.to_activity,
                  d.link_qualifier, d.link_method)
       FROM fe.dfg_mat d WHERE d.repo_id = _repo_id AND d.kind = 'cross_edge'), '[]'::jsonb)
  ) INTO _payload;

  RETURN _payload;
END;
$fn$;

COMMENT ON FUNCTION api.get_dfg(text) IS
  'The whole-log directly-follows graph for one repository (docs/DATA_LAYER.md): activity '
  'nodes and succession edges per object type, plus cross-type edges through links, which '
  'are floors and carry their link''s class (link_qualifier, link_evidence, link_method), '
  'one row per class. Counted over the E2O layer (§12.0): nodes carry events and '
  'occurrences. Pre-computed in fe.dfg_mat. There is no case notion.';


-- =====================================================================================
-- AFTER THIS FILE, RE-RUN sql/postgrest_setup.sql
--
-- ⚠️ **Not optional, and the acceptance gate cannot tell you.** This file issues
-- `CREATE OR REPLACE FUNCTION` on every `api` function, and a replaced function reverts
-- to `SECURITY INVOKER` — so it runs as `web_anon`, which by design can read nothing in
-- `fe`. The app then fails with *"permission denied for schema fe"* while every check
-- here still passes, because `scripts/rpc-check.mjs` reaches the database through `psql`
-- as the owner and never travels the `web_anon` path that actually broke.
--
-- This block turns that silence into a loud one. It only warns: the fix belongs in
-- `postgrest_setup.sql`, which applies the policy by looping over the schema rather than
-- naming functions, and duplicating it here is how the two would drift.
-- =====================================================================================
DO $$
DECLARE
  _invoker integer;
BEGIN
  SELECT count(*) INTO _invoker
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'api' AND NOT p.prosecdef;

  IF _invoker > 0 THEN
    RAISE WARNING E'\n'
      '=====================================================================\n'
      '  % api function(s) are SECURITY INVOKER and PostgREST will now fail\n'
      '  with "permission denied for schema fe".\n'
      '\n'
      '  Run this next:   psql -d % -f sql/postgrest_setup.sql\n'
      '=====================================================================',
      _invoker, current_database();
  END IF;
END $$;
