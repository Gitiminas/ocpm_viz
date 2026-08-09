/**
 * Burst (bulk push) derivation.
 *
 * A burst is a group of commits that entered the log through one PushEvent. The
 * mockup hardcoded exactly one burst, at a literal timestamp, with its size read
 * from `meta.burst.n_commits` — which said 21 while only 20 commits were actually
 * members. Here bursts are derived from `push_id`, so:
 *
 *   - there may be **N bursts, or none**;
 *   - a burst's size is **always its actual member count**, never metadata, which is
 *     what makes the 21/20 discrepancy structurally impossible to reproduce;
 *   - the burst's position is derived from its members rather than written in source.
 *
 * On well-formed data every member of a push shares the push timestamp, so the
 * derived position is exactly that timestamp. Taking the minimum is the safe general
 * choice: if members ever disagree, a burst that starts when its earliest commit
 * appeared is defensible, whereas one positioned at a literal is not.
 */

/**
 * Collapse a push into a single node above this many commits (decision 6).
 * Exposed as a UI control in Task 3; this is only the default.
 */
/**
 * A push carrying more than one commit is a burst. There is no size threshold.
 *
 * There used to be one, exposed as a slider. It never chose *what* a burst is — `push_id`
 * does that, and it is a fact in the data — only how big one had to be before the tool
 * bothered folding it. That is a preference dressed as a finding: two readers with the
 * slider in different positions see different pictures of the same sub-log and have no
 * way to tell, and nothing downstream distinguishes a push of three from a push of six.
 * Folding every real push is one rule, always the same, and expanding any of them is
 * still one click (decision 94).
 */
export const MIN_BURST = 2;

export function burstId(pushId) {
  return `burst:${pushId}`;
}

/**
 * Group commit objects into bursts.
 *
 * @param {Array} commits    commit objects, each with `vmap.push_id` and `intervals`
 * @returns {Array<{id, pushId, time, size, commits, commitIds}>} bursts, in time order
 */
export function deriveBursts(commits) {
  const byPush = new Map();

  for (const commit of commits) {
    const pushId = commit.vmap?.push_id;
    // A commit with no push_id cannot be attributed to a burst. It is not an error —
    // it simply always renders individually.
    if (pushId == null) continue;
    if (!byPush.has(pushId)) byPush.set(pushId, []);
    byPush.get(pushId).push(commit);
  }

  const bursts = [];
  for (const [pushId, members] of byPush) {
    if (members.length < MIN_BURST) continue;
    const times = members.map(commitTime).filter((t) => t != null);
    bursts.push({
      id: burstId(pushId),
      pushId,
      time: times.length ? new Date(Math.min(...times)) : null,
      size: members.length,
      commits: members,
      commitIds: new Set(members.map((c) => c.id)),
    });
  }

  bursts.sort((a, b) => (a.time && b.time ? a.time - b.time : 0));
  return bursts;
}

function commitTime(commit) {
  const start = commit.intervals?.[0]?.start;
  return start ? +new Date(start) : null;
}

/**
 * Index bursts by member commit id, so a commit can be resolved to its burst in
 * constant time during layout and link folding.
 */
export function indexBurstsByCommit(bursts) {
  const index = new Map();
  for (const burst of bursts) {
    for (const commit of burst.commits) index.set(commit.id, burst);
  }
  return index;
}

/**
 * Whether a commit belongs to any burst.
 *
 * Deliberately derived rather than read from `vmap.in_burst`: the fixture still
 * carries that field, but trusting it would reintroduce exactly the metadata
 * dependence that produced the wrong count.
 */
export function isBurstMember(commitId, burstsByCommit) {
  return burstsByCommit.has(commitId);
}
