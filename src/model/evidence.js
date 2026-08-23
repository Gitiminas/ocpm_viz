/**
 * Link evidence classification (`docs/ADAPTER_AND_API.md` §3).
 *
 * Two classes only. `inferred` is retired vocabulary and must not appear anywhere.
 *
 *   validated — the platform's own data asserts the link: documented GitHub syntax
 *               that GitHub itself acts on, or an exact identity match.
 *   extracted — we parsed a human convention that no system enforces.
 *
 * The rule is what is defensible in the thesis; the table below is only what the
 * rule produces. Adding a detection method means asking "does GitHub assert this,
 * or did we parse it?" — not copying a neighbouring row.
 */

export const EVIDENCE = {
  VALIDATED: 'validated',
  EXTRACTED: 'extracted',
};

/**
 * The closed set of link detection methods.
 *
 * **Sixteen values, and every one of them is a link between two objects.**
 * `link.method` — how one object came to be linked to another — is fixed at the four
 * validated and twelve extracted entries below.
 *
 * Three values are excluded and none may return without an upstream source that
 * produces it: `merge_commit_message` (no view emits it), `offplatform_commit_message`
 * (dropped with the off-platform heuristic) and `event_actor_id`. The last is the one
 * worth remembering, because it
 * was not wrong so much as redundant: it recorded which actor performed an event,
 * which `event.actor_id` already states on the event itself. Carrying it as a
 * *link* method meant every consumer of `links` had to exclude it by hand — ten
 * sites — to avoid counting attribution as traceability.
 */
export const LINK_METHOD = {
  // --- validated: the platform asserts it, or it is an exact identity match ---

  /** Closing keyword in the PR body, e.g. "Closes #242864". */
  PR_BODY: 'pr_body',
  /** PR head SHA found among a push's commit SHAs. */
  HEAD_SHA: 'head_sha',
  /** PR merge commit SHA found among a push's commit SHAs. */
  MERGE_COMMIT_SHA: 'merge_commit_sha',
  /** GitHub's own record that a commit closed the issue. Not parsed by us. */
  CLOSED_VIA_COMMIT: 'closed_via_commit',

  // --- extracted: we parsed a convention nobody enforces, or matched on timing ---

  /** Issue reference in the PR title. */
  PR_TITLE: 'pr_title',
  /**
   * Issue reference parsed out of a commit message, e.g. "Refs #242864".
   *
   * ⚠️ **One technique, two relationships.** Upstream this arrives from two views:
   * a commit→issue link, and the issue↔PR link derived from the same mention by way of the pull
   * request carrying that commit. They stay one method because `method` records *how* a link was
   * found — one regex over one commit message — while the qualifier records what it joins
   * (`references_issue` vs `resolves`).
   *
   * The obligation that comes with that: **any figure counting links by method must group by
   * `(method, qualifier)`.** Counting by method alone silently sums two different relations, and
   * the RQ2 detection-coverage breakdown is exactly that figure.
   */
  COMMIT_MESSAGE: 'commit_message',
  /** PR reference inside an issue comment. */
  ISSUE_COMMENT: 'issue_comment',
  /** PR head branch name, e.g. `fix/123`. */
  BRANCH_NAME: 'branch_name',
  /** Matched on closeness in time alone. The weakest thing in this enum. */
  PROXIMITY: 'proximity',
  /**
   * PR head ref matched against the push ref. A branch-naming convention.
   *
   * ⚠️ **Narrowed in the data layer, not here** (`sql/fe_layer.sql` §5.0b).
   * Upstream this admits any commit pushed to the PR's head branch while the PR was open
   * — which is the right question, because GH Archive's PR payload never lists a PR's
   * commits, so for most of them this is the *only* evidence there is. But merging
   * `master` into a long-lived branch re-enumerates every incoming trunk commit in that
   * push, and all of them get attributed to the PR: vscode PR #116416 came out at 217
   * such commits, of which only 36 were born on its own branch. (The old "179 on master
   * / 34 genuine" split was computed time-blind and is wrong.)
   *
   * The layer therefore admits `ref_match` only where the commit was *first introduced*
   * on a non-default branch. Nothing changes for this module — the value stays in the
   * enum, stays `extracted`, and still reaches the payload. What changes is how many
   * links carry it, so **any count is a floor**, with raw `ref_match` as the ceiling.
   */
  REF_MATCH: 'ref_match',

  /*
   * The six extended conventions. Project-specific issue-reference
   * forms that GitHub does not act on — `gh-123`, `For #123`, Symfony's PR template
   * — split by where they were found, title or body, so a repository's linking
   * habits stay legible in the method breakdown RQ2 needs. `DATA_CONTRACT.md` §4
   * records why they matter: kubernetes and react use these forms where vscode uses
   * the standard ones, so treating them as absent would make a detection-coverage
   * artifact look like a process difference.
   */

  /** `gh-123` in the PR title. */
  PR_TITLE_GH: 'pr_title_gh',
  /** Symfony's PR-title convention. */
  PR_TITLE_SYMFONY: 'pr_title_symfony',
  /** `For #123` in the PR title. */
  PR_TITLE_FOR: 'pr_title_for',
  /** `gh-123` in the PR body. */
  PR_BODY_GH: 'pr_body_gh',
  /** A "Fixed tickets" row in a PR-body template. */
  PR_BODY_FIXED_TICKETS: 'pr_body_fixed_tickets',
  /** `Refs #123` in the PR body — a reference, not a closing keyword. */
  PR_BODY_REFS: 'pr_body_refs',
};

/**
 * Which detection methods the platform itself asserts.
 *
 * `pr_body` is the one arguable member: the upstream view regex-parses the body
 * rather than observing GitHub's auto-close. It is admitted because the syntax is
 * documented and GitHub acts on it. See `ADAPTER_AND_API.md` §3 for the optional
 * corroboration step and the limitations note.
 *
 * Note what is *not* here. `pr_body_refs` and `pr_body_fixed_tickets` are also read
 * out of the PR body, and `closed_via_commit` is also about closing — but the rule
 * asks whether GitHub acts on it, not where the text sat. `Refs #123` closes nothing,
 * so it is extracted; a closed-via-commit record is GitHub's own, so it is validated.
 */
const VALIDATED_METHODS = new Set([
  LINK_METHOD.PR_BODY,
  LINK_METHOD.HEAD_SHA,
  LINK_METHOD.MERGE_COMMIT_SHA,
  LINK_METHOD.CLOSED_VIA_COMMIT,
]);

const ALL_METHODS = new Set(Object.values(LINK_METHOD));

/**
 * Issue↔PR detection methods whose toggle is seeded even when unused (Task 3).
 *
 * These four have a toggle whatever the loaded sub-log contains; every other method
 * gets one only when a link actually carries it, which is the normal rule and the one
 * `deriveMethods` implements.
 *
 * ⚠️ **The reason for choosing these four has expired.** It was that they alone were
 * backed by their own upstream materialized view. The contract snapshot of 2026-08-04
 * records **seven** issue↔PR method views plus `mv_issue_pr_links_extended_conventions`
 * for the six extended conventions — so "has its own view" no longer picks out four,
 * and this list is now four by history rather than by rule.
 *
 * Left as-is deliberately, because widening it is a judgement rather than a
 * correction: seeding all thirteen issue↔PR methods would put ten permanently empty
 * toggles in the sidebar of every sub-log that uses none of them, and an always-visible
 * control that never does anything is its own kind of lie. Decide it against real data,
 * once a sub-log from the RPC shows which methods actually occur.
 */
export const ISSUE_PR_METHODS = [
  LINK_METHOD.PR_BODY,
  LINK_METHOD.BRANCH_NAME,
  LINK_METHOD.PR_TITLE,
  LINK_METHOD.ISSUE_COMMENT,
];

export function isKnownMethod(method) {
  return ALL_METHODS.has(method);
}

/**
 * Classify one detection method. Throws on an unknown method rather than
 * defaulting: a silent default would let an unclassified link render as solid and
 * quietly overstate the confidence of the whole picture.
 */
export function classifyMethod(method) {
  if (!ALL_METHODS.has(method)) {
    throw new Error(
      `Unknown link method "${method}". Add it to LINK_METHOD and decide, by the ` +
        `rule in docs/DATA_LAYER.md, whether the platform asserts it (validated) ` +
        `or we parsed a convention (extracted).`,
    );
  }
  return VALIDATED_METHODS.has(method) ? EVIDENCE.VALIDATED : EVIDENCE.EXTRACTED;
}

/**
 * Evidence for a link that may have been detected by several methods.
 *
 * A link is validated if *any* method validates it — one platform-asserted match is
 * enough, and further convention-based matches cannot weaken it. Multi-method
 * agreement is carried separately as `n_methods` for the tooltip.
 */
export function classifyLink(methods) {
  const list = Array.isArray(methods) ? methods : [methods];
  if (list.length === 0) throw new Error('A link must carry at least one detection method.');
  return list.some((m) => classifyMethod(m) === EVIDENCE.VALIDATED)
    ? EVIDENCE.VALIDATED
    : EVIDENCE.EXTRACTED;
}
