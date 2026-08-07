/**
 * Row allocation within a lane.
 *
 * Two mechanisms, deliberately separated, because they answer different questions:
 *
 *   sub-lanes   Do two *objects* need their own horizontal band? Allocated only
 *               when their temporal extents overlap (decision 3). Two PRs that run
 *               one after the other share a band; two that are open at the same
 *               time do not.
 *   collision   Within a band, do two *glyphs* land on top of each other? The
 *               node is bumped down a row until it fits.
 *
 * Keeping them apart is what makes "sequential objects share a lane" and "an
 * object's identity stays visually traceable" both true at once. It is also why
 * touching extents (one PR closing exactly as the next opens) may share a band:
 * the span does not overlap, and the two glyphs at that instant are separated by
 * the collision loop rather than by a whole band.
 *
 * The commit lane has no sub-lanes. A commit is an instant, not a span, and a
 * commit linked to several PRs needs extra edges rather than extra layout
 * (tasks/02). Its nodes are packed by collision alone, exactly as before.
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

/** Lanes whose objects are spans, and therefore get sub-lanes. */
export const SUB_LANE_TYPES = new Set(['issue', 'pull_request']);

export function collisionThreshold(laneType) {
  return COLLISION_THRESHOLD_PX[laneType] ?? COLLISION_THRESHOLD_PX.default;
}

/**
 * The time an object visually occupies.
 *
 * Deliberately wider than its lifecycle: an object's footprint is its bar *plus*
 * its glyphs, and events can fall outside the lifecycle — the vscode PR is merged
 * on 11 March but carries a comment on 19 March. Ignoring those would let a second
 * PR share the band and interleave its glyphs with the first one's stray comment.
 *
 * Returns null for an object with neither intervals nor nodes, which cannot
 * overlap anything.
 */
export function objectExtent(object, nodes = []) {
  const times = [];
  for (const interval of object.intervals || []) {
    if (interval.start) times.push(+interval.start);
    if (interval.end) times.push(+interval.end);
  }
  for (const node of nodes) {
    if (node.t != null) times.push(+node.t);
  }
  if (!times.length) return null;
  return { start: Math.min(...times), end: Math.max(...times) };
}

/**
 * Allocate a sub-lane index per object, greedily.
 *
 * Objects are taken in start order and each is placed in the first band whose last
 * occupant has already finished. That is the classic interval-partitioning greedy,
 * and it uses the minimum number of bands — so a sub-lane appears only when overlap
 * genuinely forces one, which is the rule decision 3 states.
 *
 * Ties are broken by id so the allocation is stable across renders; an object
 * silently swapping bands between two renders would be worse than a suboptimal
 * packing.
 */
export function assignSubLanes(objects, nodesByObject = new Map()) {
  const withExtent = objects
    .map((object) => ({ object, extent: objectExtent(object, nodesByObject.get(object.id) || []) }))
    .filter((entry) => entry.extent)
    .sort((a, b) => a.extent.start - b.extent.start || (a.object.id < b.object.id ? -1 : 1));

  const bandEnds = [];
  const subLaneOf = new Map();

  for (const { object, extent } of withExtent) {
    let band = bandEnds.findIndex((end) => end <= extent.start);
    if (band === -1) {
      band = bandEnds.length;
      bandEnds.push(extent.end);
    } else {
      bandEnds[band] = Math.max(bandEnds[band], extent.end);
    }
    subLaneOf.set(object.id, band);
  }

  // Objects with no extent still need somewhere to live.
  for (const object of objects) {
    if (!subLaneOf.has(object.id)) subLaneOf.set(object.id, 0);
  }
  return subLaneOf;
}

/**
 * Assign `row` to every node, per lane.
 *
 * Mutates the nodes, which are throwaway view models rebuilt on every render — the
 * alternative is a parallel id→row map that every consumer then has to thread
 * through.
 *
 * @param {Array} nodes  nodes carrying `lane`, `objectId`, `t` and `x`
 * @param {string[]} lanes  lane types to pack, in order
 * @param {{laneObjects?: Map<string, Array>}} options  objects per lane, for sub-lanes
 * @returns {{maxRowByLane: Map<string, number>, objectRow: Map<string, number>,
 *            repeatRow: number|null}}
 *          highest row used per lane, the base row of each object's band, and the row
 *          reserved for repeat commit observations (null when none exist)
 */
export function packRows(nodes, lanes, { laneObjects = new Map() } = {}) {
  const maxRowByLane = new Map();
  const objectRow = new Map();
  let repeatRow = null;

  for (const lane of lanes) {
    const inLane = nodes.filter((n) => n.lane === lane);

    if (!SUB_LANE_TYPES.has(lane)) {
      let maxRow = packByCollision(inLane, lane, 0);
      /*
       * One reserved row beneath the commits, for repeat observations.
       *
       * A commit's later pushes are marks on the timeline, not commits, and drawing
       * them among the glyphs would put "this SHA showed up again" in the row that
       * otherwise means "a commit happened here" — the density the commit lane is
       * already fighting. One shared row below keeps the main row reading as the
       * commits themselves, which is what it is for.
       */
      if (lane === 'commit' && inLane.some((n) => n.observations?.length > 1)) {
        repeatRow = maxRow + 1;
        maxRow = repeatRow;
      }
      maxRowByLane.set(lane, maxRow);
      continue;
    }

    const nodesByObject = new Map();
    for (const node of inLane) {
      if (!node.objectId) continue;
      if (!nodesByObject.has(node.objectId)) nodesByObject.set(node.objectId, []);
      nodesByObject.get(node.objectId).push(node);
    }

    const objects = laneObjects.get(lane) || [];
    const subLaneOf = assignSubLanes(objects, nodesByObject);

    // Group the lane's nodes by band, then pack each band independently. Bands
    // stack, so each one's base row is the running total of the heights above it.
    const bands = new Map();
    for (const node of inLane) {
      const band = subLaneOf.get(node.objectId) ?? 0;
      if (!bands.has(band)) bands.set(band, []);
      bands.get(band).push(node);
    }

    let baseRow = 0;
    let maxRow = 0;
    for (const band of [...bands.keys()].sort((a, b) => a - b)) {
      const bandMax = packByCollision(bands.get(band), lane, baseRow);
      for (const [objectId, objectBand] of subLaneOf) {
        if (objectBand === band) objectRow.set(objectId, baseRow);
      }
      maxRow = Math.max(maxRow, bandMax);
      baseRow = bandMax + 1;
    }
    maxRowByLane.set(lane, maxRow);
  }

  return { maxRowByLane, objectRow, repeatRow };
}

/**
 * The collision loop: bump a node down a row until it no longer overlaps one
 * already placed in that row. Returns the highest row used.
 */
function packByCollision(nodes, lane, baseRow) {
  const threshold = collisionThreshold(lane);
  const placed = [];
  let maxRow = baseRow;

  for (const node of nodes.slice().sort((a, b) => a.t - b.t)) {
    let row = baseRow + startingOffset(node, lane);
    while (placed.some((p) => p.row === row && Math.abs(p.x - node.x) < threshold)) row++;
    node.row = row;
    placed.push(node);
    if (row > maxRow) maxRow = row;
  }
  return maxRow;
}

/**
 * Comments sit one row below their object's events, which keeps the lifecycle
 * readable as a single line with the comment traffic beneath it.
 */
function startingOffset(node, lane) {
  const hasCommentRow = lane === 'issue' || lane === 'pull_request';
  return node.isComment && hasCommentRow ? 1 : 0;
}
