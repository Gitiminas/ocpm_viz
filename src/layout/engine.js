/**
 * The layout engines, behind one interface.
 *
 * There are two ways this tool can arrange a sub-log, and they have nothing in common
 * beyond the question they answer:
 *
 *   temporal    real · highlights · ordinal — x is a time scale, y is a packed lane row
 *   structural  off — x and y both come from a force simulation over the link graph
 *
 * `createLayout` picks one and returns the same shape either way, so `render/timeline.js`
 * asks *once* and then draws. That is the architectural requirement: the second engine is
 * isolated behind the interface the scale-based modes already implied, and the drawing
 * code does not learn which is active beyond a single `kind` check for the marks that
 * only one of them has (lanes and an axis; edges and a ramp).
 *
 * ⚠️ **This does not make the mode branch literally singular, and claiming so would be
 * false.** The three temporal modes still branch inside `scales.js` (which curve x
 * follows), `layout/nodes.js` (highlights folds runs of unremarkable commits),
 * `render/axis.js` (which ticks to draw) and `render/nodes.js` (ordinal dims the
 * lifecycle bars, since a bar spanning a time axis means nothing when the axis is
 * rank-ordered). Every one of those is a branch *within* the temporal engine, which is
 * where they belong. What this module removes is the fifth kind of branch — the one that
 * would have spread "is time on?" through the render pass.
 *
 * Pure and DOM-free, like everything under `layout/`. Visibility arrives as a predicate
 * rather than as the state object, so this layer never learns what a lane toggle is —
 * the same rule `filterNodes` follows.
 */

import { buildNodes, assignRanks, filterNodes } from './nodes.js';
import { createScales } from './scales.js';
import { packRows } from './packing.js';
import { computeLaneGeometry, rowY } from './lanes.js';
import { createAnchors } from './anchors.js';

/** Which engine a mode uses. `off` is the only structural one. */
export const STRUCTURAL_MODES = ['off'];

export function isStructuralMode(mode) {
  return STRUCTURAL_MODES.includes(mode);
}

/**
 * Lay out a sub-log.
 *
 * @param {object} options
 * @param {string} options.mode
 * @param {object} options.graph                 the normalized ObjectGraph
 * @param {object} options.index                 from `indexObjectGraph`
 * @param {string[]} options.laneTypes            lane-bearing object types, in order
 * @param {string[]} options.visibleLanes         those the user has left switched on
 * @param {Array}  options.bursts
 * @param {Array}  options.commentBursts
 * @param {number[]} options.instants             every distinct instant, sorted
 * @param {Set}    options.expandedBursts
 * @param {Set}    options.expandedCommentBursts
 * @param {Set}    options.expandedGroups
 * @param {Function} options.isVisible            node predicate
 * @param {object} options.margin                 `{top, right, bottom, left}`
 * @param {number} options.plotWidth
 * @returns {object} a positioned layout — see `layoutTemporal` for the fields
 */
export function createLayout(options) {
  // The one branch. Everything downstream reads `kind`, never `mode`.
  return isStructuralMode(options.mode) ? layoutStructural(options) : layoutTemporal(options);
}

/**
 * The timeline layout: time along x, packed lane rows down y.
 *
 * Extracted verbatim from `render/timeline.js`, where it was interleaved with the
 * drawing. The order of operations is load-bearing and is the reason it is one function
 * rather than several the caller sequences:
 *
 *   build nodes → filter → rank → position (x) → pack rows → lane geometry → position (y)
 *
 * Ranking happens *after* filtering so that hiding comments cannot shift the ordinal
 * positions of the nodes that remain; row packing happens after x is known because
 * collisions are horizontal.
 */
function layoutTemporal({
  graph,
  index,
  laneTypes,
  visibleLanes,
  bursts = [],
  commentBursts = [],
  instants = [],
  expandedBursts = new Set(),
  expandedCommentBursts = new Set(),
  expandedGroups = new Set(),
  mode = 'real',
  isVisible = () => true,
  margin,
  plotWidth,
}) {
  const allNodes = buildNodes({
    graph,
    index,
    bursts,
    commentBursts,
    expandedBursts,
    expandedCommentBursts,
    expandedGroups,
    mode,
    laneTypes,
  });
  const nodes = filterNodes(allNodes, isVisible);
  const { rankOrder, rankMax, rankTimes } = assignRanks(nodes);

  // ---- horizontal position --------------------------------------------------
  const scales = createScales({
    instants,
    marginLeft: margin.left,
    plotWidth,
    mode,
    rankTimes,
    rankMax,
  });
  for (const node of nodes) node.x = scales.x(node.t, node);

  // Where each observation falls. Taken from the scale by *time*, never through the
  // node: the node's rank belongs to its first observation, so passing it here would
  // stack every repeat on top of the glyph in ordinal mode.
  for (const node of nodes) {
    if (!node.observations?.length) continue;
    node.observations.forEach((observation, i) => {
      // The first observation *is* the glyph, so it takes the node's x rather than
      // recomputing it. Later ones carry their own rank (`assignRanks`), which is what
      // gives them a real slot in ordinal mode instead of an interpolated one.
      observation.x = i === 0 ? node.x : scales.x(observation.time, observation);
    });
  }

  // ---- vertical position ----------------------------------------------------
  // Objects are passed in so a lane can allocate sub-lanes when two of its objects
  // overlap in time; without them the packer can only see nodes, and an object's *span*
  // is what decides whether it needs its own band.
  const laneObjects = new Map(visibleLanes.map((lane) => [lane, index.objectsOfType(lane)]));
  const { maxRowByLane, objectRow, repeatRow } = packRows(nodes, visibleLanes, { laneObjects });
  const { lanes: geometry, height } = computeLaneGeometry(visibleLanes, maxRowByLane, margin);
  for (const node of nodes) node.y = rowY(geometry, node.lane, node.row);

  // Repeat observations live on their own reserved row, so each carries the y it is
  // drawn at. The first observation stays on the glyph: it *is* the glyph.
  const repeatY = repeatRow == null ? null : rowY(geometry, 'commit', repeatRow);
  for (const node of nodes) {
    if (!node.observations?.length) continue;
    node.observations.forEach((observation, i) => {
      observation.y = i === 0 || repeatY == null ? node.y : repeatY;
    });
  }

  // Which drawn node stands for which object — commits carry their packed row, so a link
  // into the commit lane must meet the node, not the lane's top (decisions 19 and 37).
  const nodeByObject = new Map();
  for (const node of nodes) {
    if (node.isGroup) {
      for (const member of node.members) nodeByObject.set(member.objectId, node);
    } else if (node.objectId) {
      nodeByObject.set(node.objectId, node);
    }
  }

  return {
    kind: 'temporal',
    nodes,
    nodeByObject,
    visibleLanes,
    geometry,
    width: margin.left + plotWidth + margin.right,
    height,
    // `objectRow` is what tells an edge which band its issue or PR was packed into;
    // without it every link into a lane lands on band 0.
    anchors: createAnchors({ nodes, nodeByObject, geometry, scales, objectRow }),
    objectRow,
    repeatRow,
    scales,
    rankOrder,
    rankMax,
    rankTimes,
  };
}

/**
 * The structural layout: position encodes relationships, and time is demoted.
 *
 * Filled in by the next step. It throws rather than returning an empty layout, because a
 * silently empty picture is the one failure mode this project keeps finding by eye —
 * `render/timeline.js` reports a thrown error on the chart's own message surface, where
 * it can be read.
 */
function layoutStructural() {
  throw new Error('The off (structural) layout is not wired up yet.');
}
