/**
 * Node model construction: turning a sub-log into the things that get drawn.
 *
 * Pure and DOM-free, so the answer to "how many nodes, in what order, in which
 * lane" can be checked without rendering.
 *
 * This is where the mockup's core defect lived. It took
 * `objects.filter(o => o.type === 'issue')[0]` and the same for the PR, then built
 * nodes for those two objects only — every other issue and PR in the sub-log was
 * silently dropped. Here every object of a lane-bearing type contributes its events.
 *
 * Two aggregation mechanisms reduce density, and they are independent:
 *
 *   bursts   data-driven, from `push_id`. N of them, or none. Collapsed by default
 *            above the size threshold; expandable individually.
 *   groups   computed, highlights mode only. Runs of consecutive unremarkable
 *            commits fold into a count badge between the notable ones.
 */

import { activityLabel, activityShortLabel, isMilestone } from '../model/activities.js';

/**
 * Build the node list for one render pass.
 *
 * @param {object} options
 * @param {object} options.graph            the normalized ObjectGraph
 * @param {object} options.index            from `indexObjectGraph`
 * @param {Array}  options.bursts           from `deriveBursts`
 * @param {Set}    options.expandedBursts   burst ids the user has unfolded
 * @param {Set}    options.expandedGroups   group keys the user has unfolded
 * @param {string} options.mode             active time mode
 * @param {string[]} options.laneTypes      lane-bearing object types, in order
 */
export function buildNodes({
  graph,
  index,
  bursts = [],
  expandedBursts = new Set(),
  expandedGroups = new Set(),
  mode = 'real',
  laneTypes = ['issue', 'pull_request', 'commit'],
}) {
  const nodes = [];

  // ---- event nodes, for every object of a lane-bearing, non-commit type --------
  for (const laneType of laneTypes) {
    if (laneType === 'commit') continue;
    for (const object of index.objectsOfType(laneType)) {
      for (const event of index.eventsOf(object.id)) {
        nodes.push({
          id: `n_${event.id}`,
          lane: laneType,
          objectId: object.id,
          object,
          event,
          t: event.time,
          actorId: event.actor_id,
          title: activityLabel(event.activity),
          short: activityShortLabel(event.activity),
          isComment: !!event.comment,
          milestone: isMilestone(event.activity),
        });
      }
    }
  }

  // ---- commit nodes, with burst folding ---------------------------------------
  if (laneTypes.includes('commit')) {
    nodes.push(
      ...buildCommitNodes({ index, bursts, expandedBursts, expandedGroups, mode }),
    );
  }

  return nodes;
}

function buildCommitNodes({ index, bursts, expandedBursts, expandedGroups, mode }) {
  const collapsedBursts = bursts.filter((b) => !expandedBursts.has(b.id));
  const foldedCommitIds = new Set();
  for (const burst of collapsedBursts) {
    for (const id of burst.commitIds) foldedCommitIds.add(id);
  }

  const memberOfExpandedBurst = new Set();
  for (const burst of bursts) {
    if (!expandedBursts.has(burst.id)) continue;
    for (const id of burst.commitIds) memberOfExpandedBurst.add(id);
  }

  let commitNodes = index
    .objectsOfType('commit')
    .filter((commit) => !foldedCommitIds.has(commit.id))
    .map((commit) => ({
      id: `n_${commit.id}`,
      lane: 'commit',
      objectId: commit.id,
      object: commit,
      t: commitTime(commit),
      actorId: index.pusherByCommit.get(commit.id) || null,
      title: commit.label,
      isComment: false,
      milestone: false,
      // Whether this commit belongs to a burst the user has unfolded. Anchors the
      // run-grouping pass so an expanded burst is never re-folded into a count badge.
      inBurst: memberOfExpandedBurst.has(commit.id),
    }));

  // One synthetic node per collapsed burst. Its label is the actual member count —
  // never metadata, which is what made the mockup claim 21 members for a 20-commit
  // push.
  for (const burst of collapsedBursts) {
    commitNodes.push({
      id: `n_${burst.id}`,
      lane: 'commit',
      objectId: burst.id,
      object: { id: burst.id, type: 'commit', label: `${burst.size} commits`, vmap: { push_id: burst.pushId } },
      t: burst.time,
      actorId: null,
      title: `${burst.size} commits`,
      isComment: false,
      milestone: false,
      isBurst: true,
      burst,
    });
  }

  commitNodes.sort((a, b) => a.t - b.t);

  if (mode === 'highlights' && commitNodes.length > 1) {
    commitNodes = groupUnremarkableRuns(commitNodes, expandedGroups);
  }
  return commitNodes;
}

function commitTime(commit) {
  return commit.intervals?.[0]?.start ?? null;
}

/**
 * Fold runs of consecutive unremarkable commits into count badges.
 *
 * Anchors — kept individually — are the first and last commit, any collapsed burst,
 * and any member of an expanded burst. Everything between two anchors collapses,
 * unless the user has expanded that particular group.
 */
function groupUnremarkableRuns(commitNodes, expandedGroups) {
  const out = [];
  let run = [];

  const flush = () => {
    if (!run.length) return;
    if (run.length === 1) {
      out.push(run[0]);
    } else {
      const groupKey = run[0].id;
      if (expandedGroups.has(groupKey)) {
        for (const member of run) {
          member.groupKey = groupKey;
          out.push(member);
        }
      } else {
        out.push({
          id: `grp_${groupKey}`,
          lane: 'commit',
          isGroup: true,
          groupKey,
          t: run[0].t,
          groupCount: run.length,
          groupStart: run[0].t,
          groupEnd: run[run.length - 1].t,
          members: run.slice(),
        });
      }
    }
    run = [];
  };

  commitNodes.forEach((node, i) => {
    const isAnchor = i === 0 || i === commitNodes.length - 1 || node.isBurst || node.inBurst;
    if (isAnchor) {
      flush();
      out.push(node);
    } else {
      run.push(node);
    }
  });
  flush();
  return out;
}

/**
 * Assign ranks for ordinal mode: strict temporal order over every visible node,
 * with lane and id as deterministic tie-breakers so equal timestamps never reorder
 * between renders.
 */
export function assignRanks(nodes) {
  const sorted = nodes.slice().sort((a, b) => {
    const byTime = +a.t - +b.t;
    if (byTime) return byTime;
    if (a.lane !== b.lane) return a.lane < b.lane ? -1 : 1;
    return a.id < b.id ? -1 : 1;
  });
  sorted.forEach((node, i) => {
    node.rank = i;
  });
  return {
    rankOrder: sorted,
    rankMax: Math.max(1, sorted.length - 1),
    rankTimes: sorted.map((n) => +n.t),
  };
}

/**
 * Filter nodes by visibility.
 *
 * Takes a predicate rather than the state object so this layer stays independent of
 * how visibility is decided — the rules live in `state/state.js`, where they are
 * testable on their own, and layout does not need to know about lanes, hidden
 * objects, commit groups or any control added later.
 *
 * Kept separate from construction so the toggles cannot accidentally change ranks:
 * hiding a node must happen *before* ranking, or ordinal positions would shift
 * under a filter that is supposed to be purely subtractive.
 */
export function filterNodes(nodes, isVisible) {
  return nodes.filter((node) => isVisible(node));
}
