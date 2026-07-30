/**
 * Link evidence classification (decision 7, `docs/ADAPTER_AND_API.md` §3).
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
 * The first four are the issue↔PR detection methods that exist upstream as
 * materialized views (`docs/DATA_CONTRACT.md` §1) and that Task 3 must be able to
 * toggle independently. The rest are commit attribution and actor attribution.
 */
export const LINK_METHOD = {
  /** Closing keyword in the PR body, e.g. "Closes #242864". */
  PR_BODY: 'pr_body',
  /** PR head branch name, e.g. `fix/123`. */
  BRANCH_NAME: 'branch_name',
  /** Issue reference in the PR title. */
  PR_TITLE: 'pr_title',
  /** PR reference inside an issue comment. */
  ISSUE_COMMENT: 'issue_comment',
  /** PR head SHA found among a push's commit SHAs. */
  HEAD_SHA: 'head_sha',
  /** PR merge commit SHA found among a push's commit SHAs. */
  MERGE_COMMIT_SHA: 'merge_commit_sha',
  /** PR head ref matched against the push ref. A branch-naming convention. */
  REF_MATCH: 'ref_match',
  /** Issue reference parsed out of a commit message, e.g. "Refs #242864". */
  COMMIT_MESSAGE: 'commit_message',
  /** PR reference parsed out of a merge commit message. */
  MERGE_COMMIT_MESSAGE: 'merge_commit_message',
  /** The event's own `actor_id` column. */
  EVENT_ACTOR_ID: 'event_actor_id',
};

/**
 * Which detection methods the platform itself asserts.
 *
 * `pr_body` is the one arguable member: the upstream view regex-parses the body
 * rather than observing GitHub's auto-close. It is admitted because the syntax is
 * documented and GitHub acts on it. See `ADAPTER_AND_API.md` §3 for the optional
 * corroboration step and the limitations note.
 */
const VALIDATED_METHODS = new Set([
  LINK_METHOD.PR_BODY,
  LINK_METHOD.HEAD_SHA,
  LINK_METHOD.MERGE_COMMIT_SHA,
  LINK_METHOD.EVENT_ACTOR_ID,
]);

const ALL_METHODS = new Set(Object.values(LINK_METHOD));

/** The four issue↔PR detection methods, independently toggleable (Task 3). */
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
        `rule in ADAPTER_AND_API.md §3, whether the platform asserts it (validated) ` +
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
