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

import { LANE_TYPES, ACTIVITIES, READING_ORDER, activityShortLabel } from '../model/activities.js';

export const DFG_NODE_RADIUS = 14;

const MARGIN = { top: 48, right: 48, bottom: 48, left: 168 };
/** Vertical room per row: the marks plus the tallest arc on either side. */
const LANE_HEIGHT = 240;
/** An arc's rise: a floor so short hops stay visible, growing with the slots skipped. */
const ARC_BASE = 34;
const ARC_PER_SLOT = 22;
const ARC_MAX = 100;
/** The loop's ring above a self-succession's node. */
export const DFG_LOOP_RADIUS = 16;
/**
 * The loop sits up and to the LEFT of its node: forward arcs leave a node toward the
 * upper right, and a loop centred above the node sat exactly in their way.
 */
export const DFG_LOOP_DX = -16;

const EDGE_WIDTH_MIN = 1;
const EDGE_WIDTH_MAX = 6;
/**
 * Cross edges meeting at one node fan their mid-curves apart by this much per edge,
 * ordered by where the other end is, so a node with twenty arrows does not draw them
 * as one bundle whose counts sit on top of each other.
 */
const FAN_STEP = 11;
/** A count label's box, for keeping labels off each other: per digit, plus padding. */
const LABEL_CHAR_W = 6;
const LABEL_H = 12;
/**
 * Where along its curve a label may sit, tried in order until the box is clear of every
 * label already placed and of every node. In-row arcs start at the apex, as always;
 * cross edges start off-centre, because the middle of the picture is where every
 * cross edge crosses every other.
 */
const LABEL_T_ARC = [0.5, 0.4, 0.6, 0.3, 0.7].map((t) => ({ t, flip: false }));
const LABEL_T_CROSS = [0.36, 0.5, 0.64, 0.26, 0.74, 0.18, 0.82].flatMap((t) => [
  { t, flip: false },
  { t, flip: true },
]);
/**
 * The two captions under every node — the activity name and its event count — as the
 * renderer draws them (render/dfg.js): reserved so no count label lands on them.
 */
const NODE_CAPTION = [
  { dy: 12, h: 13, charW: 7 }, // the activity name, 11 px, at radius + 12
  { dy: 25, h: 11, charW: 6 }, // the event count, 9 px, at radius + 25
];

/** A point on the quadratic curve (from, control, to) at parameter t. */
function pointOnQuad([p0, p1, p2], t) {
  const u = 1 - t;
  return {
    x: u * u * p0.x + 2 * u * t * p1.x + t * t * p2.x,
    y: u * u * p0.y + 2 * u * t * p1.y + t * t * p2.y,
  };
}

/** Axis-aligned box of a label centred at (x, y) for the given text. */
function labelBox(x, y, text) {
  const w = text.length * LABEL_CHAR_W + 6;
  return { x0: x - w / 2, x1: x + w / 2, y0: y - LABEL_H / 2, y1: y + LABEL_H / 2 };
}

const boxesOverlap = (a, b) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

/**
 * Place every non-loop edge's count label along its own curve, at the first candidate
 * position whose box is clear of the labels placed before it and of every node mark.
 * Loops keep their fixed spot but occupy it. Greedy in edge order — successions
 * descending, so the counts that matter most get first pick — and deterministic.
 * When nothing is clear the first candidate stands: a label that overlaps beats a
 * label that is missing, and the hovercard carries the number either way.
 */
function placeLabels(edges, nodes, { offsetOf, captionsOf }) {
  const placed = nodes.flatMap((n) => [
    { x0: n.x - n.radius - 2, x1: n.x + n.radius + 2, y0: n.y - n.radius - 2, y1: n.y + n.radius + 2 },
    ...NODE_CAPTION.map(({ dy, h, charW }, i) => {
      const w = captionsOf(n)[i].length * charW + 6;
      return { x0: n.x - w / 2, x1: n.x + w / 2, y0: n.y + n.radius + dy - h / 2, y1: n.y + n.radius + dy + h / 2 };
    }),
  ]);
  const order = [...edges].sort((a, b) => b.successions - a.successions);
  for (const edge of order) {
    const text = edge.successions.toLocaleString('en-US');
    if (edge.loop) {
      placed.push(labelBox(edge.labelAt.x, edge.labelAt.y, text));
      continue;
    }
    const candidates = edge.cross ? LABEL_T_CROSS : LABEL_T_ARC;
    let chosen = null;
    let first = null;
    for (const { t, flip } of candidates) {
      const at = pointOnQuad(edge.points, t);
      const off = offsetOf(edge, t, flip);
      const spot = { x: at.x + off.x, y: at.y + off.y };
      const box = labelBox(spot.x, spot.y, text);
      first = first ?? { spot, box };
      if (!placed.some((other) => boxesOverlap(box, other))) {
        chosen = { spot, box };
        break;
      }
    }
    const { spot, box } = chosen ?? first;
    edge.labelAt = spot;
    placed.push(box);
  }
}

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
        labelAt: { x: from.x + DFG_LOOP_DX, y: from.y - from.radius - 2 * DFG_LOOP_RADIUS - 8 },
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
      cross: false,
      side,
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

  /*
   * The fan. Every cross edge is ranked among the cross edges meeting at its source and
   * among those meeting at its target, each list ordered by where the OTHER end sits
   * left to right; the edge's mid-curve then shifts sideways by its rank from centre at
   * both ends, averaged. Edges leaving one node toward different places spread apart in
   * the order of their destinations, so none crosses a neighbour needlessly and no two
   * lie on one curve. Deterministic: the ranking keys are node positions and names.
   */
  // node key -> the OTHER nodes its cross edges reach, as `otherKey -> otherX`. Ranked by
  // node, not by edge: the two directions of one pair share a fan slot and are told
  // apart by the perpendicular shift below, so a lone pair still sits on the midpoint.
  const incident = new Map();
  for (const edge of dfg.cross_edges) {
    const fromKey = `${edge.from_type}/${edge.from_activity}`;
    const toKey = `${edge.to_type}/${edge.to_activity}`;
    const from = nodeAt.get(fromKey);
    const to = nodeAt.get(toKey);
    if (!from || !to) continue;
    for (const [key, otherKey, otherX] of [[fromKey, toKey, to.x], [toKey, fromKey, from.x]]) {
      if (!incident.has(key)) incident.set(key, new Map());
      incident.get(key).set(otherKey, otherX);
    }
  }
  const fanShift = (key, otherKey) => {
    const others = [...(incident.get(key) || new Map()).entries()].sort(
      (a, b) => a[1] - b[1] || a[0].localeCompare(b[0]),
    );
    const rank = others.findIndex(([k]) => k === otherKey);
    return (rank - (others.length - 1) / 2) * FAN_STEP;
  };

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
      const fromKey = `${edge.from_type}/${edge.from_activity}`;
      const toKey = `${edge.to_type}/${edge.to_activity}`;
      const fan = (fanShift(fromKey, toKey) + fanShift(toKey, fromKey)) / 2;
      const control = {
        x: (from.x + to.x) / 2 + (-dy / length) * shift + fan,
        y: (from.y + to.y) / 2 + (dx / length) * shift,
      };
      return [{
        ...edge,
        loop: false,
        cross: true,
        width: dfgEdgeWidth(edge.successions, maxS),
        points: [{ x: from.x, y: from.y }, control, { x: to.x, y: to.y }],
        labelAt: { x: control.x, y: control.y - 8 },
      }];
    });
  });

  // Labels last, over the finished curves: an in-row arc's label sits just outside its
  // arc (above a forward arc, below a rework one); a cross edge's a little above its
  // curve. Both then slide along the curve until clear.
  placeLabels([...edges, ...crossEdges], nodes, {
    // A cross label sits just above its curve, or just below it when above is taken.
    offsetOf: (edge, t, flip) =>
      edge.cross ? { x: 0, y: flip ? 9 : -8 } : { x: 0, y: edge.side * (t === 0.5 ? 10 : 12) },
    captionsOf: (node) => [activityShortLabel(node.activity), `${node.events.toLocaleString('en-US')} ev`],
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
