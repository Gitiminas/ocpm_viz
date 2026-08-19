/**
 * Object-to-object adjacency and the focus BFS.
 *
 * Two distinct notions of degree exist in this project and must not be conflated:
 *
 *   traversal degree — server-side, how far the sub-log was expanded. Recorded in
 *                      `meta.traversal_degree`. Decides what is *in* the bundle.
 *   focus degree     — client-side, this file. Decides what is *highlighted* within
 *                      an already-loaded sub-log. Capped at 2.
 */

/** The client-side focus BFS never expands further than this. */
export const MAX_FOCUS_DEGREE = 2;

/**
 * Build undirected adjacency between objects.
 *
 * Every link in the bundle is object→object, so every link is an edge here. That is
 * a property of the data since decision 41: actor links used to be skipped, because
 * they connected an *event* to an actor and would have made every object adjacent to
 * every other object that shared an actor — one focus click lighting up the whole
 * graph. They no longer exist, and `findGraphProblems` rejects an event endpoint, so
 * the guard has nothing left to guard against.
 *
 * Burst folding: a collapsed burst is drawn as one node, so whatever its members
 * connect to must also be reachable from the burst id, and vice versa. Otherwise
 * focusing a PR would fail to highlight the folded push that delivered its commits.
 * The mockup did this for a single hardcoded burst; here it is done for N.
 */
export function buildAdjacency(links, bursts = []) {
  const adjacency = new Map();

  const connect = (a, b) => {
    if (!adjacency.has(a)) adjacency.set(a, new Set());
    adjacency.get(a).add(b);
  };

  for (const link of links) {
    connect(link.source, link.target);
    connect(link.target, link.source);
  }

  for (const burst of bursts) {
    for (const commit of burst.commits) {
      const neighbours = adjacency.get(commit.id);
      if (!neighbours) continue;
      for (const neighbour of neighbours) {
        if (burst.commitIds.has(neighbour)) continue; // stay inside the fold
        connect(burst.id, neighbour);
        connect(neighbour, burst.id);
      }
    }
  }

  return adjacency;
}

/**
 * Breadth-first search out from the focused object.
 *
 * Returns a Map of object id → hop distance, or `null` when nothing is focused —
 * `null` meaning "no focus", which callers distinguish from an empty set.
 */
export function focusSet(adjacency, focusId, degree = 1) {
  if (!focusId) return null;

  const limit = Math.min(Math.max(degree, 1), MAX_FOCUS_DEGREE);
  const depth = new Map([[focusId, 0]]);
  const queue = [focusId];

  while (queue.length) {
    const current = queue.shift();
    const currentDepth = depth.get(current);
    if (currentDepth >= limit) continue;
    for (const neighbour of adjacency.get(current) || []) {
      if (depth.has(neighbour)) continue;
      depth.set(neighbour, currentDepth + 1);
      queue.push(neighbour);
    }
  }
  return depth;
}

/** Opacity for an object under the current focus: dimmed when outside the set. */
export const DIM_OPACITY = 0.15;

/**
 * How bright a mark is at each hop from the focused object.
 *
 * Index is the hop count: the focused object itself, then its neighbours, then theirs.
 * Graded rather than binary because "in the focus set" is not one thing — a direct
 * neighbour is what you clicked to see, and something two hops away is context. Drawn at
 * one brightness they say the same thing, and the reader has to trace edges to work out
 * which is which, which is the work the focus was supposed to save.
 *
 * The steps are wide apart on purpose. Three brightnesses a few percent apart are not
 * three categories, they are one blur; these are far enough to be counted at a glance.
 *
 * ⚠️ And the LAST ring must sit well clear of `DIM_OPACITY`, because opacity is not read
 * linearly on a dark surface: at `[1, 0.72, 0.4]` the second ring and the unrelated marks
 * (0.15) both read as "faded" and the ring fell on the wrong side of the line — reported
 * as degree 2 being too close to the unrelated ones. Raised rather than sinking the
 * unrelated marks further: 0.15 is already near the floor, the brush dims to 0.13 and the
 * two dims must not swap meaning, and anything under ~0.1 reads as absent — which is the
 * brush's statement, not the focus's. The test keeps the last ring ≥ 3× the dim level.
 */
export const FOCUS_FALLOFF = [1, 0.8, 0.55];

/**
 * Opacity for an object under the current focus.
 *
 * ⚠️ **Binary by default, graded only where asked**, and the default is not laziness. The
 * timeline has drawn focus as in-or-out since the mockup, and its screenshots are the
 * visual regression baseline; grading it here would change every one of them as a side
 * effect of a change to a different mode. The structural mode asks for the graded form,
 * where marks sit at arbitrary distances from each other and a hop count is the only
 * thing that says how related two things are.
 */
export function objectOpacity(objectId, focus, { graded = false } = {}) {
  if (!focus) return 1;
  if (!focus.has(objectId)) return DIM_OPACITY;
  if (!graded) return 1;
  return FOCUS_FALLOFF[focus.get(objectId)] ?? DIM_OPACITY;
}
