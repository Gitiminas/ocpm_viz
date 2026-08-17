/**
 * The radial layout for the **off** time mode — the alternative to `layered.js`.
 *
 * Concentric rings instead of rows: issues at the centre, pull requests around them,
 * commits around those. It is the arrangement most general-purpose graph tools use, and
 * it suits a hub-shaped sub-log — one issue with everything hanging off it — far better
 * than rows do, because a hub is *radially* symmetric and rows have to flatten it.
 *
 * ## What is the same as the layered layout, and why
 *
 * Rings are assigned **by object type**, using the same `assignLayers` rule, so "issue in
 * the middle, pull requests around it, commits outside them" is true by construction
 * rather than by luck. Assigning rings by hop-distance from the seed instead would be the
 * other defensible choice — it is what a Neo4j-style explorer does — but it would make
 * the ring a node sits on depend on which object you happened to seed from, so the same
 * sub-log would look structurally different from two different starting points. Type is
 * the stable answer, and it keeps one vocabulary across both structural layouts.
 *
 * It is likewise **not a tree**. A commit belonging to two pull requests stays one node
 * and settles between their wedges; duplicating it would let a reader count it twice, and
 * dropping an edge would hide the convergence object-centric process mining exists to
 * show.
 *
 * ## The angle rule, which is the whole design
 *
 * A node's preferred angle is the **circular mean** of its parents on the ring inside it:
 * a pull request sits at the average bearing of the issues it resolves, a commit at the
 * average bearing of the pull requests carrying it. Children therefore gather into a
 * wedge under their parent, which is what makes clusters legible, and the mean is what
 * puts a shared child between the two parents claiming it.
 *
 * ⚠️ **Circular, not arithmetic.** The mean of 350° and 10° is 0°, not 180°. Averaging
 * the numbers would fling a node to the opposite side of the picture from both of its
 * parents whenever their wedge happens to straddle the origin — a wrong position with no
 * error, occurring for a twelfth of all pairs.
 *
 * Each ring's radius is then whatever it takes to hold its own contents at a minimum arc
 * spacing, so a busy ring grows outwards rather than crowding.
 *
 * Pure, DOM-free and deterministic, like every other module here.
 */

import { assignLayers, hashId } from './layered.js';

/** Minimum clear arc between two marks on a ring, in pixels. */
const MIN_ARC_GAP = 18;
/** Clear space between one ring's outer edge and the next ring's inner edge. */
const RING_GAP = 90;
/** How much of the box the outermost ring may use before everything is scaled down. */
const FILL = 0.94;

/**
 * The circular mean of a list of angles, in radians.
 *
 * Sums unit vectors and takes the bearing of the result, which is the only averaging that
 * respects the wrap at 2π. Returns `null` for an empty list, and for a set whose vectors
 * cancel exactly — two parents diametrically opposite have no meaningful midpoint, and
 * picking one of the two arbitrarily would be a coin toss dressed as a position.
 */
export function circularMean(angles) {
  if (!angles.length) return null;
  let sumX = 0;
  let sumY = 0;
  for (const angle of angles) {
    sumX += Math.cos(angle);
    sumY += Math.sin(angle);
  }
  if (Math.abs(sumX) < 1e-9 && Math.abs(sumY) < 1e-9) return null;
  const mean = Math.atan2(sumY, sumX);
  return mean < 0 ? mean + Math.PI * 2 : mean;
}

/** Parent and child ids across adjacent rings. */
function relations(rings, edges) {
  const ringOf = new Map();
  rings.forEach((ring, r) => ring.forEach((node) => ringOf.set(node.id, r)));

  const parents = new Map();
  const children = new Map();
  for (const ring of rings) {
    for (const node of ring) {
      parents.set(node.id, []);
      children.set(node.id, []);
    }
  }

  // Sorted, so wedges are allocated and circular means summed in a fixed order.
  const ordered = edges
    .slice()
    .sort((a, b) =>
      a.source < b.source
        ? -1
        : a.source > b.source
          ? 1
          : a.target < b.target
            ? -1
            : a.target > b.target
              ? 1
              : 0,
    );

  for (const edge of ordered) {
    const from = ringOf.get(edge.source);
    const to = ringOf.get(edge.target);
    if (from === undefined || to === undefined || from === to) continue;
    const [inner, outer] = from < to ? [edge.source, edge.target] : [edge.target, edge.source];
    if (!parents.get(outer).includes(inner)) parents.get(outer).push(inner);
    if (!children.get(inner).includes(outer)) children.get(inner).push(outer);
  }
  return { parents, children, ringOf };
}

/**
 * Allocate every node an angular wedge, proportional to what its subtree needs.
 *
 * ⚠️ **This is the part that makes clusters work, and leaving it out looked fine until it
 * did not.** An earlier version placed each node at the circular mean of its parents and
 * nothing else. Measured on F10: the commits clustered correctly into three tight groups
 * of eight — but the three *pull requests* sat at 9°, 30° and 50°, because a single issue
 * at the centre has no bearing for them to inherit, so they fell back to arbitrary
 * angles. Three groups each needing about 59° of ring cannot fit under parents 41° apart,
 * so the commit groups were pushed away from the pull requests they belong to and the
 * clustering was destroyed by the very thing meant to create it.
 *
 * A parent must therefore be given as much of the circle as its children need. Demand is
 * computed outwards-in — a leaf demands its own width, a parent demands the greater of its
 * own width and the sum of its children's — and then the circle is divided top-down in
 * that proportion. This is the standard radial-tree construction, and it is what makes a
 * pull request with thirty commits occupy a wide wedge and one with two occupy a narrow
 * one.
 *
 * ⚠️ A node with several parents is counted in **one** wedge only, chosen deterministically
 * as its first parent in sorted order. Counting it in both would allocate its width twice
 * and leave the circle over-subscribed; it is placed at the mean of all its parents
 * afterwards, so it still ends up between them.
 */
function allocateWedges(rings, relation, radii, radius, gap) {
  const { parents, children } = relation;

  // Which wedge each node is counted in, so a shared child is not paid for twice.
  const primary = new Map();
  for (const ring of rings) {
    for (const node of ring) {
      const mine = (parents.get(node.id) || []).slice().sort();
      if (mine.length) primary.set(node.id, mine[0]);
    }
  }

  const ownWidth = (node, r) => (2 * radius(node) + gap) / Math.max(1, radii[r] || 1);

  // Demand, computed from the outermost ring inwards.
  const demand = new Map();
  for (let r = rings.length - 1; r >= 0; r--) {
    for (const node of rings[r]) {
      const mine = (children.get(node.id) || []).filter((id) => primary.get(id) === node.id);
      const below = mine.reduce((sum, id) => sum + (demand.get(id) ?? 0), 0);
      demand.set(node.id, Math.max(ownWidth(node, r), below));
    }
  }

  // Hand out the circle, from the inside out.
  const angle = new Map();
  const wedge = new Map();

  const share = (members, from, span) => {
    const total = members.reduce((sum, node) => sum + (demand.get(node.id) ?? 0), 0) || 1;
    let cursor = from;
    for (const node of members) {
      const width = ((demand.get(node.id) ?? 0) / total) * span;
      wedge.set(node.id, [cursor, cursor + width]);
      angle.set(node.id, cursor + width / 2);
      cursor += width;
    }
  };

  share(rings[0], 0, Math.PI * 2);

  for (let r = 1; r < rings.length; r++) {
    // Group this ring by the wedge it belongs to, keeping ring order within each group so
    // the crossing-free property of a tree is preserved.
    const groups = new Map();
    const orphans = [];
    for (const node of rings[r]) {
      const owner = primary.get(node.id);
      if (owner == null || !wedge.has(owner)) orphans.push(node);
      else {
        if (!groups.has(owner)) groups.set(owner, []);
        groups.get(owner).push(node);
      }
    }

    for (const [owner, members] of groups) {
      const [from, to] = wedge.get(owner);
      share(members, from, to - from);
    }

    /*
     * Anything with no parent inside — a commit linked only to an issue two rings in, or
     * an object the traversal reached by a route this ring does not carry — is given an
     * equal share of whatever the wedges left over. Dropping it or stacking it on the
     * origin would both be worse: it is real data and it has to be somewhere findable.
     */
    if (orphans.length) {
      const claimed = [...groups.values()].flat().length;
      const spare = (Math.PI * 2 * orphans.length) / Math.max(1, claimed + orphans.length);
      share(orphans, Math.PI * 2 - spare, spare);
    }
  }

  return { angle, primary };
}

/**
 * Spread a ring's nodes around it, honouring their preferred angles.
 *
 * Sorted by preference, then walked once around enforcing the minimum arc — the same
 * shape of algorithm as the layered layout's row separation, and for the same reason: one
 * pass guarantees the spacing, and a rotation afterwards removes the bias that walking in
 * one direction introduces.
 */
function placeRing(ring, preferred, radiusOf, ringR, gap) {
  const angleFor = (node) => (2 * radiusOf(node) + gap) / Math.max(1, ringR);

  const withAngle = ring.map((node, index) => ({
    node,
    index,
    want: preferred.get(node.id) ?? ((hashId(node.id) & 0xffff) / 0x10000) * Math.PI * 2,
  }));
  withAngle.sort((a, b) => a.want - b.want || a.index - b.index);

  const placed = new Map();
  let cursor = null;
  for (const entry of withAngle) {
    const half = angleFor(entry.node) / 2;
    let angle = entry.want;
    if (cursor !== null && angle < cursor + half) angle = cursor + half;
    placed.set(entry.node.id, angle);
    cursor = angle + half;
  }

  // Closing the circle: if the walk has run past a full turn the ring is genuinely full,
  // and an equal share is the honest answer — the alternative is two marks on one spot.
  const last = withAngle[withAngle.length - 1];
  const first = withAngle[0];
  if (first && last && placed.get(last.node.id) - placed.get(first.node.id) > Math.PI * 2 - angleFor(first.node)) {
    withAngle.forEach((entry, i) => placed.set(entry.node.id, (i / withAngle.length) * Math.PI * 2));
    return placed;
  }

  const drift = circularMean(
    withAngle
      .filter((entry) => preferred.has(entry.node.id))
      .map((entry) => placed.get(entry.node.id) - entry.want),
  );
  if (drift != null) {
    const shift = drift > Math.PI ? drift - Math.PI * 2 : drift;
    for (const [id, angle] of placed) placed.set(id, angle - shift);
  }
  return placed;
}

/**
 * Lay a sub-log out in concentric rings.
 *
 * @returns {{positions: Map, rings: Array<Array>, waypoints: Map, radii: number[]}}
 */
export function layoutRadial(nodes, edges, { width, height, padding = 60, radiusOf } = {}) {
  const radius = radiusOf || ((node) => node.radius ?? 8);
  if (!nodes.length) return { positions: new Map(), rings: [], waypoints: new Map(), radii: [] };

  const rings = assignLayers(nodes);
  const relation = relations(rings, edges);

  /*
   * ⚠️ A ring may need more room than the box has. The gap shrinks first — crowding is a
   * legible complaint — and only then is the whole drawing scaled, because scaling shrinks
   * the *spacing* while the marks keep their drawn size. Same trap the layered layout hit.
   */
  const available = Math.min(width, height) / 2 - padding;
  let gap = MIN_ARC_GAP;
  let radii = ringRadii(rings, radius, gap);
  while (radii[radii.length - 1] > available && gap > 2) {
    gap = Math.max(2, gap - 4);
    radii = ringRadii(rings, radius, gap);
  }

  const { angle: wedgeAngle } = allocateWedges(rings, relation, radii, radius, gap);

  const angles = new Map();
  const positions = new Map();

  rings.forEach((ring, r) => {
    // A single innermost node goes exactly in the middle: a ring of one is a point, and
    // putting it on a circle would leave a hole with nothing to explain it.
    if (r === 0 && ring.length === 1) {
      positions.set(ring[0].id, { x: 0, y: 0 });
      return;
    }

    const preferred = new Map();
    for (const node of ring) {
      // The wedge is where this node *belongs*; the mean of its parents is where it is
      // *pulled*. They agree for a node with one parent, and for a shared child the mean
      // draws it toward the boundary between the wedges claiming it.
      const known = (relation.parents.get(node.id) || [])
        .map((id) => angles.get(id))
        .filter((value) => value !== undefined);
      const mean = known.length > 1 ? circularMean(known) : null;
      const wedge = wedgeAngle.get(node.id);
      if (mean != null) preferred.set(node.id, mean);
      else if (wedge != null) preferred.set(node.id, wedge);
    }

    const placed = placeRing(ring, preferred, radius, radii[r], gap);
    for (const [id, value] of placed) {
      angles.set(id, value);
      positions.set(id, { x: Math.cos(value) * radii[r], y: Math.sin(value) * radii[r] });
    }
  });

  /*
   * A link that skips a ring — an issue joined straight to a commit — would otherwise run
   * across the pull-request ring. It is given one waypoint on that ring, at the bearing
   * halfway between its two ends, so it passes *between* the pull requests rather than
   * over them. The renderer already knows how to bend a line through a waypoint.
   */
  const waypoints = new Map();
  const ringOf = new Map();
  rings.forEach((ring, r) => ring.forEach((node) => ringOf.set(node.id, r)));

  for (const edge of edges) {
    const from = ringOf.get(edge.source);
    const to = ringOf.get(edge.target);
    if (from === undefined || to === undefined || Math.abs(from - to) <= 1) continue;

    const key =
      edge.source < edge.target
        ? `${edge.source}||${edge.target}`
        : `${edge.target}||${edge.source}`;
    if (waypoints.has(key)) continue;

    const between = circularMean(
      [angles.get(edge.source), angles.get(edge.target)].filter((a) => a !== undefined),
    );
    if (between == null) continue;

    const low = Math.min(from, to);
    const high = Math.max(from, to);
    const via = [];
    for (let r = low + 1; r < high; r++) {
      via.push({ x: Math.cos(between) * radii[r], y: Math.sin(between) * radii[r] });
    }
    waypoints.set(key, from < to ? via : via.reverse());
  }

  centreInBox(positions, waypoints, { width, height, padding, nodes, radius });
  return { positions, rings, waypoints, radii };
}

/**
 * How big a ring must be to hold its nodes without crowding.
 *
 * Circumference has to cover every node's width plus a gap, so the radius follows from the
 * contents rather than being chosen — a busy ring grows outwards instead of crowding. It
 * must also clear the ring inside it.
 */
function ringRadius(ring, innerRadius, innerMax, radius, gap) {
  const needed = ring.reduce((sum, node) => sum + 2 * radius(node) + gap, 0);
  const fromContents = needed / (Math.PI * 2);
  const outerMax = Math.max(0, ...ring.map(radius));
  const fromClearance = innerRadius + innerMax + RING_GAP + outerMax;
  return Math.max(fromContents, fromClearance);
}

function ringRadii(rings, radius, gap) {
  const radii = [];
  let previous = 0;
  let previousMax = 0;
  rings.forEach((ring, r) => {
    if (r === 0 && ring.length === 1) {
      radii.push(0);
      previous = 0;
      previousMax = radius(ring[0]);
      return;
    }
    const value = ringRadius(ring, previous, previousMax, radius, gap);
    radii.push(value);
    previous = value;
    previousMax = Math.max(0, ...ring.map(radius));
  });
  return radii;
}

/**
 * Move the drawing from origin-centred coordinates into the box, scaling only if it must.
 *
 * Scaling **down** shrinks the distances between marks while the marks keep their size, so
 * it is a last resort rather than a fit-to-window default — the same reasoning the layered
 * layout's fill cap rests on.
 */
function centreInBox(positions, waypoints, { width, height, padding, nodes, radius }) {
  const radiusById = new Map(nodes.map((node) => [node.id, radius(node)]));
  let extent = 0;
  for (const [id, at] of positions) {
    extent = Math.max(extent, Math.hypot(at.x, at.y) + (radiusById.get(id) ?? 0));
  }

  const available = Math.min(width, height) / 2 - padding;
  const scale = extent > 0 && extent > available ? (available * FILL) / extent : 1;

  const shift = (point) => ({
    x: width / 2 + point.x * scale,
    y: height / 2 + point.y * scale,
  });
  for (const [id, at] of positions) positions.set(id, shift(at));
  for (const [key, via] of waypoints) waypoints.set(key, via.map(shift));
}
