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
 * Actor links are excluded: they connect an *event* to an actor, so including them
 * would make every object adjacent to every other object that shares an actor, and
 * focus would light up the whole graph.
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
    if (link.qualifier === 'actor') continue;
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

export function objectOpacity(objectId, focus) {
  if (!focus) return 1;
  return focus.has(objectId) ? 1 : DIM_OPACITY;
}
