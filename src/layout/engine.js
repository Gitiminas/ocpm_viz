/**
 * The layout engines, behind one interface.
 *
 * There are two ways this tool can arrange a sub-log, and they have nothing in common
 * beyond the question they answer:
 *
 *   temporal    absolute · discrete — x is a time scale, y is a packed lane row
 *   structural  off — x and y both come from a force simulation over the link graph
 *
 * `createLayout` picks one and returns the same shape either way, so `render/timeline.js`
 * asks *once* and then draws. That is the architectural requirement: the second engine is
 * isolated behind the interface the scale-based modes already implied, and the drawing
 * code does not learn which is active beyond a single `kind` check for the marks that
 * only one of them has (lanes and an axis; edges and a ramp).
 *
 * ⚠️ **This does not make the mode branch literally singular, and claiming so would be
 * false.** The two temporal modes still branch inside `scales.js` (which curve x
 * follows), `render/axis.js` (which ticks to draw) and `render/nodes.js` (discrete dims the
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
import { createScales, MODES as TEMPORAL_MODES } from './scales.js';
import { packRows } from './packing.js';
import { computeLaneGeometry, rowY } from './lanes.js';
import { createAnchors } from './anchors.js';
import { layoutLayered } from './layered.js';
import { layoutCluster } from './cluster.js';
import { buildStructuralNodes, buildStructuralEdges, timeExtent } from './structural.js';

/** Which engine a mode uses. `relationships` is the only structural one. */
export const STRUCTURAL_MODES = ['relationships'];

/**
 * The two ways the relationships mode can arrange a sub-log.
 *
 * Both are structural — position encodes relationships either way — and they answer the
 * same question with different geometry. `layered` puts issues, pull requests and commits
 * in rows, which reads as a process direction and matches the timeline's lane order.
 * `cluster` makes every object a small hub for what hangs off it — the issue in the
 * middle, its pull requests around it, and each pull request's commits fanning around
 * *that pull request*. It reads as grouping rather than as a process direction, and suits
 * a sub-log where the question is "what belongs with what". Neither is right in general,
 * so the reader chooses.
 */
export const STRUCTURAL_LAYOUTS = ['layered', 'cluster'];
export const DEFAULT_STRUCTURAL_LAYOUT = 'layered';

/**
 * Every mode the tool has, in the order the control offers them.
 *
 * Assembled here rather than kept in `scales.js`, whose own `MODES` is correctly the
 * two modes *that module* implements — `relationships` draws no scale at all. This module is
 * the one place that knows both engines exist, so it is the one place that can name them all.
 */
export { TEMPORAL_MODES };
export const MODES = [...TEMPORAL_MODES, ...STRUCTURAL_MODES];

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
 * Ranking happens *after* filtering so that hiding comments cannot shift the discrete
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
  mode = 'absolute',
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
  // stack every repeat on top of the glyph in discrete mode.
  for (const node of nodes) {
    if (!node.observations?.length) continue;
    node.observations.forEach((observation, i) => {
      // The first observation *is* the glyph, so it takes the node's x rather than
      // recomputing it. Later ones carry their own rank (`assignRanks`), which is what
      // gives them a real slot in discrete mode instead of an interpolated one.
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
    if (node.objectId) nodeByObject.set(node.objectId, node);
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

/** Default drawing box for the structural layout, when the caller measures nothing. */
export const STRUCTURAL_PLOT_HEIGHT = 620;
/**
 * Room kept clear inside the box, so a mark on the rim still has its label and its
 * hovercard anchor on the surface. This — not the renderer's frame — is what keeps the
 * drawing off the edge; the frame around it is a hairline in relationships mode (`STRUCTURAL_MARGIN`
 * in `render/timeline.js`).
 */
const STRUCTURAL_PADDING = 48;

/**
 * The structural layout: position encodes relationships, and time is demoted.
 *
 * In a timeline, position is fully spent — one axis is time, the other is object identity
 * — so relational proximity is never spatial proximity and structure can only be read by
 * tracing long edges across the screen. Here position is free to carry structure: related
 * objects sit near each other, and an issue referenced by a pull request four years later
 * is a short edge rather than a full-width faint line.
 *
 * **Time is demoted, not deleted.** This function keeps everything the weaker channels
 * need: `extent` for the fill ramp and the time brush, `node.t` for the ramp and for the
 * hovercard's first row, and enough on each node for an arrowhead to say which endpoint
 * came first. What it does not do is let time decide where anything goes.
 *
 * @returns {object} the same shape `layoutTemporal` returns, plus `edges`, `extent` and
 *   `positions` — the last being the *unfitted* coordinates, which the caller keeps and
 *   passes back as `previousPositions` so the next render warm-starts instead of
 *   re-rolling the picture.
 */
function layoutStructural({
  graph,
  index,
  laneTypes,
  visibleLanes,
  bursts = [],
  expandedBursts = new Set(),
  isVisible = () => true,
  isLinkVisible = () => true,
  structuralLayout = DEFAULT_STRUCTURAL_LAYOUT,
  nodeNudges = new Map(),
  margin,
  plotWidth,
  plotHeight = STRUCTURAL_PLOT_HEIGHT,
  zoom = 1,
}) {
  const allNodes = buildStructuralNodes({ index, bursts, expandedBursts, laneTypes });
  const nodes = filterNodes(allNodes, isVisible);

  // The links shape the layout, so hiding a relationship class genuinely rearranges the
  // picture rather than merely erasing lines from it. That is the honest reading: with
  // the link gone, those two objects are no longer near each other *because of it*.
  const edges = buildStructuralEdges(graph.links.filter(isLinkVisible), nodes);

  // `zoom` travels with the box so the arrangements can tell magnification from room.
  const box = { width: plotWidth, height: plotHeight, padding: STRUCTURAL_PADDING, zoom };
  const arrange = structuralLayout === 'cluster' ? layoutCluster : layoutLayered;
  // `rings` and `rows` are the same thing under two names; `crossings` is a property only
  // the layered arrangement can meaningfully report, since a crossing count between two
  // rows says nothing about a circle.
  const {
    positions,
    rows,
    levels,
    crossings = null,
    waypoints = new Map(),
    footprints = new Map(),
    anchorId = null,
  } = arrange(nodes, edges, box);

  for (const node of nodes) {
    const at = positions.get(node.id);
    // The radius of the cluster hanging off this node, in canvas pixels — what a drag's
    // simulation needs to keep whole fans apart. Only the clustered arrangement has the
    // notion; the layered one leaves it undefined and the simulation treats the node as
    // a leaf, which is right, since a drag there runs no simulation at all.
    node.footprint = footprints.get(node.id);
    // Where the layout put it, kept separately from where it ends up: a drag is measured
    // against this, so nudges accumulate against the computed answer rather than against
    // each other.
    node.layoutX = margin.left + (at?.x ?? plotWidth / 2);
    node.layoutY = margin.top + (at?.y ?? plotHeight / 2);

    const nudge = nodeNudges.get(node.id);
    node.x = node.layoutX + (nudge?.dx ?? 0);
    node.y = node.layoutY + (nudge?.dy ?? 0);
  }

  /*
   * ⚠️ **Waypoints take the same offset as the nodes, and did not.** The arrangement works
   * in its own box; the margin is added when the result is placed on the canvas. Nodes got
   * that offset and the routed bends did not, so a long edge bent at a point shifted up
   * and to the left by the whole margin — 180px across — and curved away from the line it
   * was supposed to be. Nothing errors, and it is only visible on a sub-log that has a
   * row-skipping link at all.
   */
  const placedWaypoints = new Map();
  for (const [key, via] of waypoints) {
    placedWaypoints.set(
      key,
      via.map((point) => ({ x: margin.left + point.x, y: margin.top + point.y })),
    );
  }

  // Which drawn node stands for which object — including the members of a collapsed
  // push, which are represented by it. Same rule as `buildStructuralEdges`, and the same
  // reason: a mark that is drawn has to be reachable, or focusing a pull request would
  // fail to highlight the push that delivered its commits.
  const nodeByObject = new Map();
  for (const node of nodes) {
    if (node.isBurst && node.burst) {
      for (const commitId of node.burst.commitIds) nodeByObject.set(commitId, node);
    }
    if (node.objectId) nodeByObject.set(node.objectId, node);
  }

  return {
    kind: 'structural',
    nodes,
    nodeByObject,
    visibleLanes,
    // There are no lanes in this mode, and an empty map rather than null is deliberate:
    // `rowY` already answers 0 for a lane it does not know, so anything that still asks
    // gets a defined answer instead of throwing halfway through a render.
    geometry: new Map(),
    width: margin.left + plotWidth + margin.right,
    height: margin.top + plotHeight + margin.bottom,
    anchors: createStructuralAnchors(nodeByObject),
    objectRow: new Map(),
    repeatRow: null,
    // No time scale, and no ranks: both are statements about an axis this mode does not
    // draw. Null rather than a stub, so a caller that needs one fails visibly.
    scales: null,
    rankOrder: [],
    rankMax: 0,
    rankTimes: [],
    edges,
    // Everything that happened, first instant to last — what the time brush has to span.
    extent: timeExtent(nodes),
    // The bands as arranged, whichever geometry produced them, and what the ordering
    // achieved. `crossings` is reported rather than kept private because "how tangled is
    // this sub-log" is a finding, not a detail; it is null for the clustered arrangement,
    // which has no adjacent-row count to give.
    rows: rows ?? levels ?? [],
    crossings,
    waypoints: placedWaypoints,
    structuralLayout,
    // The root the clustered relaxation pinned, so a drag can keep it pinned. Null for the
    // layered arrangement, which pins nothing because it simulates nothing.
    anchorId,
  };
}

/**
 * Endpoint resolution for the structural layout.
 *
 * Deliberately the same interface as `layout/anchors.js` — `{x, y, xAt, clampToLifecycle,
 * xOfTime}` — so `render/links.js` never learns which engine ran. The bodies are trivial
 * here because a structural node has one position and nothing to slide along: there is no
 * lifecycle bar to meet side-on and no time axis to project onto.
 *
 * ⚠️ `xOfTime` **throws**, and that is the honest answer rather than an unhelpful one.
 * Its only caller is the burst-handle renderer, which projects a push's timestamp onto
 * the time axis — and this mode has no time axis, so any number it returned would be
 * fiction. Returning null instead would flow into a `translate(null, …)` and produce a
 * mark in the wrong place with no error, which is the failure this project keeps finding
 * by eye. The burst handles are not drawn in relationships mode; a collapsed push is a node here
 * and is expanded by clicking it.
 */
function createStructuralAnchors(nodeByObject) {
  const at = (anchorId) => nodeByObject.get(anchorId) ?? null;

  return {
    x: (anchorId) => at(anchorId)?.x ?? 0,
    y: (anchorId) => at(anchorId)?.y ?? 0,
    xAt: (object) => (object ? (at(object.id)?.x ?? 0) : 0),
    clampToLifecycle: (anchorId) => at(anchorId)?.x ?? 0,
    xOfTime: () => {
      throw new Error(
        'xOfTime() has no meaning in the relationships (structural) mode: there is no time axis to ' +
          'project onto. Its caller draws burst handles, which this mode does not — a ' +
          'collapsed push is a node here, expanded by clicking it.',
      );
    },
  };
}
