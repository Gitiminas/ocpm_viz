/**
 * Commit groups: the commits belonging to each pull request.
 *
 * Individual commits are not worth toggling one by one — a real sub-log has
 * hundreds and nobody wants a list of checkboxes that long. What *is* worth
 * toggling is "the commits that went into this PR", which is the unit people
 * actually reason about.
 *
 * ⚠️ **Groups are not a partition.** A commit can belong to several PRs at once —
 * that is convergence, and making it visible is precisely what OCPM is for, so it
 * must not be flattened away. The visibility rule is therefore a **union**: a commit
 * is shown while *any* group it belongs to is shown. Hiding "PR #1's commits" does
 * not remove a commit that is also PR #2's, because it genuinely is PR #2's commit
 * and PR #2 is still on screen. The alternative — hide if any group is hidden —
 * would make one toggle silently strip commits out of an unrelated PR.
 */

/** Commits that reach no pull request at all still need somewhere to live. */
export const UNLINKED_GROUP = '__unlinked__';

/**
 * Derive one group per pull request, plus a group for commits linked to none.
 *
 * @param {Array} commits  commit objects
 * @param {Array} links    every link in the sub-log
 * @param {Map}   byId     object lookup
 * @returns {{groups: Array, groupsByCommit: Map<string, Set<string>>}}
 */
export function deriveCommitGroups(commits, links, byId) {
  const commitIds = new Set(commits.map((commit) => commit.id));
  const groupsByCommit = new Map();
  const membersByPr = new Map();

  for (const link of links) {
    const source = byId.get(link.source);
    const target = byId.get(link.target);
    if (!source || !target) continue;

    // Accept either direction: the qualifier says commit → PR, but nothing in the
    // contract forbids a bundle stating it the other way round.
    let commitId = null;
    let prId = null;
    if (source.type === 'commit' && target.type === 'pull_request') {
      commitId = source.id;
      prId = target.id;
    } else if (source.type === 'pull_request' && target.type === 'commit') {
      commitId = target.id;
      prId = source.id;
    }
    if (!commitId || !commitIds.has(commitId)) continue;

    if (!membersByPr.has(prId)) membersByPr.set(prId, new Set());
    membersByPr.get(prId).add(commitId);
    if (!groupsByCommit.has(commitId)) groupsByCommit.set(commitId, new Set());
    groupsByCommit.get(commitId).add(prId);
  }

  const groups = [];
  for (const [prId, members] of membersByPr) {
    groups.push({
      key: prId,
      prId,
      label: byId.get(prId)?.label || prId,
      commitIds: members,
    });
  }
  groups.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));

  const unlinked = commits.filter((commit) => !groupsByCommit.has(commit.id));
  if (unlinked.length) {
    const members = new Set(unlinked.map((commit) => commit.id));
    groups.push({
      key: UNLINKED_GROUP,
      prId: null,
      label: 'Not linked to a PR',
      commitIds: members,
    });
    for (const commit of unlinked) groupsByCommit.set(commit.id, new Set([UNLINKED_GROUP]));
  }

  return { groups, groupsByCommit };
}

/**
 * Whether a commit survives the current group toggles.
 *
 * Union rule — see the note at the top of this file. A commit with no group at all
 * is always visible; absence of grouping is not a reason to hide something.
 */
export function isCommitInVisibleGroup(commitId, groupsByCommit, hiddenGroups) {
  if (!hiddenGroups || hiddenGroups.size === 0) return true;
  const groups = groupsByCommit.get(commitId);
  if (!groups || groups.size === 0) return true;
  for (const group of groups) {
    if (!hiddenGroups.has(group)) return true;
  }
  return false;
}
