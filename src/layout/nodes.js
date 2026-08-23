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
 * One aggregation mechanism reduces density: **bursts**, data-driven from `push_id` —
 * N of them, or none, folded by default and expandable individually.
 *
 * ⚠️ There is deliberately no second one. Folding runs of unremarkable commits into a
 * count badge is a presentation rule with no counterpart in the data, and the one thing
 * it produces that the data does not is a mark whose count changes with the mode.
 */

import {
  activityLabel,
  activityShortLabel,
  isLandmark,
  isUnmergedClose,
  isHeuristicLandmark,
} from '../model/activities.js';

/**
 * Build the node list for one render pass.
 *
 * @param {object} options
 * @param {object} options.graph            the normalized ObjectGraph
 * @param {object} options.index            from `indexObjectGraph`
 * @param {Array}  options.bursts           from `deriveBursts`
 * @param {Set}    options.expandedBursts   burst ids the user has unfolded
 * @param {string[]} options.laneTypes      lane-bearing object types, in order
 */
export function buildNodes({
  graph,
  index,
  bursts = [],
  commentBursts = [],
  expandedBursts = new Set(),
  expandedCommentBursts = new Set(),
  laneTypes = ['issue', 'pull_request', 'commit'],
}) {
  const nodes = [];

  // ---- event nodes, for every object of a lane-bearing, non-commit type --------
  //
  // Comments inside a collapsed comment burst are replaced by one node standing for the
  // run. Folding is a display choice, so the events are still *there* —
  // `selectVisible` and every metric count them, exactly as with a folded push.
  const foldedComments = new Map();
  for (const burst of commentBursts) {
    if (expandedCommentBursts.has(burst.id)) continue;
    for (const id of burst.eventIds) foldedComments.set(id, burst);
  }
  const emitted = new Set();

  for (const laneType of laneTypes) {
    if (laneType === 'commit') continue;
    for (const object of index.objectsOfType(laneType)) {
      for (const event of index.eventsOf(object.id)) {
        const folded = foldedComments.get(event.id);
        if (folded) {
          if (emitted.has(folded.id)) continue;
          emitted.add(folded.id);
          nodes.push({
            id: `n_${folded.id}`,
            lane: laneType,
            objectId: object.id,
            object,
            t: folded.time,
            actorId: null,
            actorIds: folded.actorIds ?? [],
            title: `${folded.size} comments`,
            short: `${folded.size} comments`,
            isComment: true,
            landmark: false,
            isCommentBurst: true,
            commentBurst: folded,
          });
          continue;
        }
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
          landmark: isLandmark(event.activity),
          // The off-platform merge: emphasised like a landmark, ringed like a
          // heuristic. Read by the renderer beside `landmark`.
          heuristicLandmark: isHeuristicLandmark(event.activity),
          // A pull request that ended without merging. Carried here rather than derived
          // in the renderer so "which glyph gets the abandoned mark" stays checkable
          // without a DOM, like `landmark` beside it.
          unmergedClose: isUnmergedClose(event.activity),
        });
      }
    }
  }

  // ---- commit nodes, with burst folding ---------------------------------------
  if (laneTypes.includes('commit')) {
    nodes.push(...buildCommitNodes({ index, bursts, expandedBursts }));
  }

  return nodes;
}

function buildCommitNodes({ index, bursts, expandedBursts }) {
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

  const commitNodes = index
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
      landmark: false,
      observations: commitObservations(index, commit),
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
      // One push has one pusher, but a commit's recorded pusher is its FIRST observation,
      // which for a re-pushed commit may be a different account — so this is a set.
      actorIds: [
        ...new Set(burst.commits.map((commit) => index.pusherByCommit.get(commit.id)).filter(Boolean)),
      ],
      title: `${burst.size} commits`,
      isComment: false,
      landmark: false,
      isBurst: true,
      burst,
    });
  }

  commitNodes.sort((a, b) => a.t - b.t);
  return commitNodes;
}

function commitTime(commit) {
  return commit.intervals?.[0]?.start ?? null;
}

/**
 * Every time this commit was observed, in order.
 *
 * **One commit object can carry many `CommitObserved` events.** The same SHA appears
 * in a new push each time it reaches another branch — cherry-picked or merged across
 * release lines — and each push is its own event. This is not rare: measured on this
 * dataset, **39.6% of vscode's commits, 13.8% of react's and 5.2% of kubernetes'**
 * have more than one, and one vscode SHA has thirty.
 *
 * Before this, the commit lane drew one glyph at the first observation and the rest
 * were dropped — while the actor counts, the statistics and the axis *range* all
 * still included them. That is the shape of the complaint that found it: a sub-log of
 * one commit whose actor row read "3", with a month of empty axis after the glyph.
 * `ARCHITECTURE.md` names this exact case as the thing OCPM exists to show ("one
 * object touching many events"), so dropping it silently was the wrong flattening.
 *
 * ⚠️ The node's own `t` is deliberately left at the first observation. A commit stays
 * **one node**, which is what `layout/anchors.js` documents as load-bearing and what
 * bursts, commit groups and link anchoring all assume; the repeats are carried as data
 * for the renderer to mark, never as extra nodes.
 */
function commitObservations(index, commit) {
  return index
    .eventsOf(commit.id)
    .map((event) => ({
      time: event.time,
      ref: event.attrs?.ref ?? null,
      pushId: event.attrs?.push_id ?? null,
      // The PUSHER of this particular observation, which is not a property of the
      // commit: 89% of vscode's repeatedly-observed commits were pushed by more than
      // one account, up to fifteen. `index.pusherByCommit` keeps only one of them, so
      // anything naming a pusher per observation has to read it from the event.
      actorId: event.actor_id ?? null,
    }))
    .sort((a, b) => +a.time - +b.time);
}

/**
 * Assign ranks for discrete mode: strict temporal order over every visible node,
 * with lane and id as deterministic tie-breakers so equal timestamps never reorder
 * between renders.
 */
export function assignRanks(nodes) {
  const marks = [];

  for (const node of nodes) {
    marks.push({ id: node.id, lane: node.lane, t: node.t, target: node });
    /*
     * ⚠️ **A repeat observation needs a rank of its own.**
     *
     * Discrete mode spaces marks by event order and discards real durations. A repeat
     * push is an event and it is drawn, but it used to get no rank — so its x came
     * from `discreteTime`, which *interpolates a timestamp* between the ranks around
     * it. Anything later than the last ranked node clamped to the right edge, which
     * put re-pushes exactly on top of whatever ended the sub-log (reported as "the
     * later push aligns perfectly with the issue closing, even though it happened
     * after") and stacked several re-pushes on one another at the same point.
     *
     * Ranking them fixes both: each occupies its own slot, in the right order.
     */
    (node.observations || []).forEach((observation, i) => {
      if (i === 0) return; // the first observation *is* the node
      marks.push({ id: `${node.id}~${i}`, lane: node.lane, t: observation.time, target: observation });
    });
  }

  marks.sort((a, b) => {
    const byTime = +a.t - +b.t;
    if (byTime) return byTime;
    if (a.lane !== b.lane) return a.lane < b.lane ? -1 : 1;
    return a.id < b.id ? -1 : 1;
  });

  marks.forEach((mark, i) => {
    mark.rank = i;
    mark.target.rank = i;
  });

  return {
    rankOrder: marks,
    rankMax: Math.max(1, marks.length - 1),
    rankTimes: marks.map((mark) => +mark.t),
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
 * hiding a node must happen *before* ranking, or discrete positions would shift
 * under a filter that is supposed to be purely subtractive.
 */
export function filterNodes(nodes, isVisible) {
  return nodes.filter((node) => isVisible(node));
}
