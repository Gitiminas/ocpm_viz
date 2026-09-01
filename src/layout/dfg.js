/**
 * The whole-log directly-follows graph, arranged. Pure arithmetic, DOM-free.
 *
 * One row per object type in lane order — the same top-to-bottom the timeline and the
 * Rows arrangement use, so the reader's map of "issues above pull requests above
 * commits" carries over. Within a row, activities sit in the lifecycle READING_ORDER
 * (open before comment before close; model/activities.js), which is deterministic and
 * needs no crossing minimisation at ten nodes.
 *
 * Edges within a row arc: FORWARD successions (toward the later-declared activity)
 * above the row, BACKWARD ones (rework: a close followed by more comments) below it,
 * so the two directions cannot overprint each other and rework is visible as a shape.
 * A self-succession is a loop above its node. Cross-type edges curve between rows.
 *
 * ⚠️ **Node radius is fixed.** The burst-radius precedent supports √-scaling marks by
 * count, but at ≤10 nodes per row the count label and the hovercard carry the numbers
 * better than area would, and a fixed radius keeps the row legible. Edge WIDTH does
 * scale (√, clamped): with successions spanning five orders of magnitude, a linear map
 * would draw one visible edge, and equal widths would hide the orders entirely.
 */

import { LANE_TYPES, ACTIVITIES, READING_ORDER } from '../model/activities.js';

export const DFG_NODE_RADIUS = 14;

const MARGIN = { top: 48, right: 48, bottom: 48, left: 168 };
/** Vertical room per row: the marks plus the tallest arc on either side. */
const LANE_HEIGHT = 200;
/** An arc's rise: a floor so short hops stay visible, growing with the slots skipped. */
const ARC_BASE = 26;
const ARC_PER_SLOT = 14;
const ARC_MAX = 78;
/** The loop's ring above a self-succession's node. */
export const DFG_LOOP_RADIUS = 16;

const EDGE_WIDTH_MIN = 1;
const EDGE_WIDTH_MAX = 6;

/**
 * Stroke width for a succession count, √-scaled against the picture's largest count
 * and clamped. Sub-linear for the same reason burst radii are: counts differ by
 * orders of magnitude, and area or width proportional to the count would leave every
 * edge but one invisible.
 */
export function dfgEdgeWidth(successions, maxSuccessions) {
  if (!maxSuccessions || successions <= 0) return EDGE_WIDTH_MIN;
  const width = EDGE_WIDTH_MIN + (EDGE_WIDTH_MAX - EDGE_WIDTH_MIN) * Math.sqrt(successions / maxSuccessions);
  return Math.min(EDGE_WIDTH_MAX, Math.max(EDGE_WIDTH_MIN, width));
}

/** The lifecycle reading order (model/activities.js), filtered to one type. */
function activitiesOf(type) {
  return READING_ORDER.filter((activity) => ACTIVITIES[activity].objectTypes.includes(type));
}

/**
 * Arrange a validated, normalized DFG into one box.
 *
 * @param {object} dfg   from `loadDfg`
 * @param {{width?: number}} options
 * @returns {{nodes, edges, crossEdges, lanes, width, height}} — every edge carries
 *   `points` (from, apex/control, to — or the node alone for a loop), `width`, `loop`
 *   and `labelAt`; positions are finite and inside the box.
 */
export function layoutDfg(dfg, { width = 960, maxSuccessions = null } = {}) {
  // Only rows with something in them take space — an empty lane is a statement the
  // legend should not have to dim around.
  const lanes = LANE_TYPES.filter((type) => dfg.nodes.some((n) => n.object_type === type));
  const laneY = new Map(
    lanes.map((type, i) => [type, MARGIN.top + LANE_HEIGHT / 2 + i * LANE_HEIGHT]),
  );
  const height = MARGIN.top + lanes.length * LANE_HEIGHT + MARGIN.bottom;
  const plotWidth = width - MARGIN.left - MARGIN.right;

  const nodes = [];
  const nodeAt = new Map(); // `${type}/${activity}` -> positioned node
  for (const type of lanes) {
    const order = activitiesOf(type);
    const present = order.filter((activity) =>
      dfg.nodes.some((n) => n.object_type === type && n.activity === activity),
    );
    present.forEach((activity, i) => {
      const source = dfg.nodes.find((n) => n.object_type === type && n.activity === activity);
      const node = {
        ...source,
        x: MARGIN.left + ((i + 0.5) / present.length) * plotWidth,
        y: laneY.get(type),
        radius: DFG_NODE_RADIUS,
        slot: i,
      };
      nodes.push(node);
      nodeAt.set(`${type}/${activity}`, node);
    });
  }

  // The width scale's ceiling. A caller filtering the artifact passes the UNFILTERED
  // maximum, so a stroke means the same count at every filter setting — the same rule
  // that stops toggling from ever recolouring an object.
  const maxS =
    maxSuccessions ??
    Math.max(0, ...dfg.edges.map((e) => e.successions), ...dfg.cross_edges.map((e) => e.successions));

  const edges = dfg.edges.flatMap((edge) => {
    const from = nodeAt.get(`${edge.object_type}/${edge.from_activity}`);
    const to = nodeAt.get(`${edge.object_type}/${edge.to_activity}`);
    if (!from || !to) return []; // a node the payload named but did not carry
    const strokeWidth = dfgEdgeWidth(edge.successions, maxS);

    if (from === to) {
      return [{
        ...edge,
        loop: true,
        width: strokeWidth,
        points: [{ x: from.x, y: from.y }],
        labelAt: { x: from.x, y: from.y - from.radius - 2 * DFG_LOOP_RADIUS - 8 },
      }];
    }

    // Forward arcs above the row, backward (rework) below — the two directions must
    // not overprint, and which side an arc rises on is itself the reading.
    const span = Math.abs(to.slot - from.slot);
    const rise = Math.min(ARC_MAX, ARC_BASE + span * ARC_PER_SLOT);
    const side = to.slot > from.slot ? -1 : 1;
    const apex = { x: (from.x + to.x) / 2, y: from.y + side * rise };
    return [{
      ...edge,
      loop: false,
      width: strokeWidth,
      points: [{ x: from.x, y: from.y }, apex, { x: to.x, y: to.y }],
      labelAt: { x: apex.x, y: apex.y + side * 10 },
    }];
  });

  /*
   * Cross edges sharing the two SAME endpoints — the usual case is one in each
   * direction — fan apart perpendicular to the line, or the later-drawn one buries the
   * earlier and two counts read as one arrow. A singleton keeps the exact midpoint: only
   * offset when there is something to separate from (the link-fanning rule).
   */
  const crossKey = (edge) =>
    [`${edge.from_type}/${edge.from_activity}`, `${edge.to_type}/${edge.to_activity}`]
      .sort()
      .join('|');
  const crossBundles = new Map();
  for (const edge of dfg.cross_edges) {
    const key = crossKey(edge);
    if (!crossBundles.has(key)) crossBundles.set(key, []);
    crossBundles.get(key).push(edge);
  }

  const crossEdges = [...crossBundles.values()].flatMap((bundle) => {
    // Rank by directed key, so the offset is deterministic whatever order the payload
    // listed the bundle in.
    const ranked = [...bundle].sort((a, b) =>
      `${a.from_type}/${a.from_activity}`.localeCompare(`${b.from_type}/${b.from_activity}`),
    );
    return ranked.flatMap((edge, rank) => {
      const from = nodeAt.get(`${edge.from_type}/${edge.from_activity}`);
      const to = nodeAt.get(`${edge.to_type}/${edge.to_activity}`);
      if (!from || !to) return [];
      // The perpendicular is taken in ONE canonical frame for the whole bundle (endpoints
      // in sorted-key order), or the two directions of a pair would flip its sign and
      // land their offsets on the same side.
      const [a, b] = `${edge.from_type}/${edge.from_activity}` < `${edge.to_type}/${edge.to_activity}`
        ? [from, to]
        : [to, from];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const length = Math.hypot(dx, dy) || 1;
      const shift = (rank - (ranked.length - 1) / 2) * 20;
      const control = {
        x: (from.x + to.x) / 2 + (-dy / length) * shift,
        y: (from.y + to.y) / 2 + (dx / length) * shift,
      };
      return [{
        ...edge,
        loop: false,
        width: dfgEdgeWidth(edge.successions, maxS),
        points: [{ x: from.x, y: from.y }, control, { x: to.x, y: to.y }],
        labelAt: { x: control.x, y: control.y - 8 },
      }];
    });
  });

  return {
    nodes,
    edges,
    crossEdges,
    lanes: lanes.map((type) => ({ type, y: laneY.get(type), height: LANE_HEIGHT })),
    width,
    height,
  };
}
