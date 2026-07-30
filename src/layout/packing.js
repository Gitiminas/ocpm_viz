/**
 * Row allocation within a lane.
 *
 * Nodes that would overlap horizontally are bumped down a row until they fit. This
 * is the collision loop from the mockup, kept because it is already the seed of the
 * sub-lane allocation Task 2 needs: the generalization there is to pack **per
 * object** — an object's whole span claims a row — rather than per node.
 *
 * Comments in the issue and PR lanes start at row 1 rather than row 0, which keeps
 * the lifecycle row readable as a single line of events with the comment traffic
 * below it.
 */

/** Minimum horizontal separation before two nodes are considered to collide. */
export const COLLISION_THRESHOLD_PX = {
  commit: 24,
  default: 100,
};

/** Vertical pitch between rows, and the padding around a lane's content. */
export const ROW_HEIGHT = 36;
export const LANE_PAD_TOP = 40;
export const LANE_PAD_BOTTOM = 32;

export function collisionThreshold(laneType) {
  return COLLISION_THRESHOLD_PX[laneType] ?? COLLISION_THRESHOLD_PX.default;
}

/**
 * Assign `row` to every node, per lane.
 *
 * Mutates the nodes, which are throwaway view models rebuilt on every render — the
 * alternative is a parallel id→row map that every consumer then has to thread
 * through.
 *
 * @param {Array} nodes  nodes carrying `lane`, `t` and `x`
 * @param {string[]} lanes  lane types to pack, in order
 * @returns {Map<string, number>} highest row index used per lane
 */
export function packRows(nodes, lanes) {
  const maxRowByLane = new Map();

  for (const lane of lanes) {
    maxRowByLane.set(lane, 0);
    const threshold = collisionThreshold(lane);
    const placed = [];

    const inLane = nodes.filter((n) => n.lane === lane).sort((a, b) => a.t - b.t);

    for (const node of inLane) {
      let row = startingRow(node, lane);
      while (placed.some((p) => p.row === row && Math.abs(p.x - node.x) < threshold)) row++;
      node.row = row;
      placed.push(node);
      if (row > maxRowByLane.get(lane)) maxRowByLane.set(lane, row);
    }
  }

  return maxRowByLane;
}

function startingRow(node, lane) {
  const hasCommentRow = lane === 'issue' || lane === 'pull_request';
  return node.isComment && hasCommentRow ? 1 : 0;
}
