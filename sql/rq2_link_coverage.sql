-- ---------------------------------------------------------------------------
-- RQ2 limitation: per-repo issue<->PR link coverage, by detection method.
--
-- ⚠️ NOT YET RUN. This project has no database connection, so the figure it
-- produces is currently unmeasured. Run it against the shared instance and paste
-- the result into the thesis limitations section. Do not estimate the numbers:
-- an invented coverage figure would undermine the very limitation it documents.
--
-- WHY THIS MATTERS
--
-- The four available detection methods all key on GitHub's *standard* conventions:
-- a closing keyword in the PR body, a `fix/123`-style branch name, and `#N` in a PR
-- title or an issue comment. Project-specific conventions -- `gh-N`, `bug #N`,
-- `For #N` -- are not covered, and are common in kubernetes and react, two of the
-- three selected repositories, while vscode largely follows the standard forms.
--
-- If link detection is systematically weaker on two of three repositories, then
-- apparent cross-repository process differences may be artifacts of detection
-- coverage rather than real behaviour. That is a direct threat to RQ2, and it has
-- to be stated with numbers rather than hedged.
--
-- READ-ONLY. Touches only the frozen upstream views (DATA_CONTRACT.md §1).
-- ---------------------------------------------------------------------------

-- The three repositories in scope. Identity is by numeric id, never by name:
-- both `login` and repo `name` are renameable.
WITH scope AS (
    SELECT r.id AS repo_id, r.name AS repo_name
    FROM repo r
    WHERE r.name IN ('microsoft/vscode', 'facebook/react', 'kubernetes/kubernetes')
),

-- One row per (repo, issue, PR, method). A pair found by three methods appears
-- three times here, which is what makes the per-method breakdown possible.
detected AS (
    SELECT s.repo_id, s.repo_name, l.issue_id, l.pull_request_id, 'pr_body' AS method
    FROM mv_issue_pr_links_pr_body l JOIN scope s ON s.repo_id = l.repo_id
  UNION ALL
    SELECT s.repo_id, s.repo_name, l.issue_id, l.pull_request_id, 'branch_name'
    FROM mv_issue_pr_links_branch_name l JOIN scope s ON s.repo_id = l.repo_id
  UNION ALL
    SELECT s.repo_id, s.repo_name, l.issue_id, l.pull_request_id, 'pr_title'
    FROM mv_issue_pr_links_pr_title l JOIN scope s ON s.repo_id = l.repo_id
  UNION ALL
    SELECT s.repo_id, s.repo_name, l.issue_id, l.pull_request_id, 'issue_comment'
    FROM mv_issue_pr_links_issue_comment l JOIN scope s ON s.repo_id = l.repo_id
),

-- Deduplicated to one row per linked pair, carrying how many methods agreed.
pairs AS (
    SELECT repo_id, repo_name, issue_id, pull_request_id,
           COUNT(DISTINCT method) AS n_methods
    FROM detected
    GROUP BY repo_id, repo_name, issue_id, pull_request_id
),

-- The denominator: every PR in the repository, linked or not. Without this the
-- per-method counts say nothing about *coverage* -- a repo with more PRs would
-- simply look better linked.
pr_totals AS (
    SELECT s.repo_id, s.repo_name, COUNT(DISTINCT p.pull_request_id) AS total_prs
    FROM prs_identity p JOIN scope s ON s.repo_id = p.repo_id
    GROUP BY s.repo_id, s.repo_name
),

linked_totals AS (
    SELECT repo_id, COUNT(DISTINCT pull_request_id) AS linked_prs
    FROM pairs
    GROUP BY repo_id
)

-- ---------------------------------------------------------------------------
-- Result 1: coverage per repository. The headline number for the limitation.
-- ---------------------------------------------------------------------------
SELECT
    t.repo_name,
    t.total_prs,
    COALESCE(l.linked_prs, 0)                                   AS prs_linked_to_an_issue,
    ROUND(100.0 * COALESCE(l.linked_prs, 0) / NULLIF(t.total_prs, 0), 2)
                                                                AS pct_linked
FROM pr_totals t
LEFT JOIN linked_totals l ON l.repo_id = t.repo_id
ORDER BY t.repo_name;

-- ---------------------------------------------------------------------------
-- Result 2: which method found what, per repository.
--
-- The shape to look for: if vscode's coverage rests on `pr_body` while kubernetes
-- and react depend on the weaker conventions -- or have far lower coverage overall
-- -- that is the artifact the limitation is about.
-- ---------------------------------------------------------------------------
-- SELECT repo_name, method,
--        COUNT(*)                                        AS links_found,
--        COUNT(DISTINCT pull_request_id)                 AS distinct_prs,
--        COUNT(DISTINCT issue_id)                        AS distinct_issues
-- FROM detected
-- GROUP BY repo_name, method
-- ORDER BY repo_name, links_found DESC;

-- ---------------------------------------------------------------------------
-- Result 3: multi-method agreement, per repository.
--
-- Pairs found by several methods are the confident ones. A repository whose links
-- are overwhelmingly single-method is one where the coverage figure above is itself
-- less trustworthy.
-- ---------------------------------------------------------------------------
-- SELECT repo_name, n_methods, COUNT(*) AS pairs
-- FROM pairs
-- GROUP BY repo_name, n_methods
-- ORDER BY repo_name, n_methods;

-- ---------------------------------------------------------------------------
-- Possible mitigation, if the gap turns out to be large (DATA_CONTRACT.md §4):
-- commit-message-based issue->PR linking, joining
-- mv_commit_message_issue_links_all through the adapter's commit_pr_links view.
-- That would recover some of the missing recall, at `extracted` evidence.
-- ---------------------------------------------------------------------------
