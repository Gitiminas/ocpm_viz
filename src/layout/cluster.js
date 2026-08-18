/**
 * The clustered layout for the **off** time mode — the alternative to `layered.js`.
 *
 * Every object becomes a small hub for the things below it: the issue sits in the middle,
 * its pull requests stand off around it, and each pull request's commits fan out around
 * *that pull request* rather than joining one shared ring. This is the "balloon" family of
 * tree drawings, and it is what makes clusters read as clusters — a group is a group
 * because its members are near each other and away from everything else, which a common
 * ring cannot express however carefully the angles are chosen.
 *
 * ⚠️ **It replaced a concentric-ring version, and the reason is worth keeping.** Rings put
 * every commit at one distance from the centre, so on F10 the eighteen pushes belonging to
 * three different pull requests formed one continuous circle. The wedges were correct —
 * each pull request's commits really were contiguous — but a reader cannot see a wedge
 * boundary in an unbroken ring of identical marks, so the picture said "one ring of
 * commits" where the data says "three groups". Reported as wanting more visible clusters,
 * and the ring geometry was the cause rather than the tuning.
 *
 * ## What is kept from the ring version
 *
 * Levels are still assigned **by object type** through the same `assignLayers` rule, so
 * "issue in the middle, then pull requests, then commits" is true by construction rather
 * than by luck, and the vocabulary matches the layered arrangement. Assigning by
 * hop-distance from the seed would make the level a node sits at depend on which object
 * you happened to seed from, so one sub-log would look structurally different from two
 * starting points.
 *
 * It is still **not a tree**: a commit belonging to two pull requests stays one node and
 * is drawn between them, because duplicating it would let a reader count it twice and
 * dropping an edge would hide the convergence object-centric process mining exists to show.
 *
 * ## The algorithm
 *
 *   1. size    every node is measured bottom-up — a leaf is its own radius, a parent is
 *              the ring its children need plus their reach
 *   2. place   top-down, each parent handing its children a share of its fan proportional
 *              to how much room each of them needs
 *   3. settle  nodes claimed by several parents move between them, then overlaps are
 *              pushed apart
 *
 * Pure, DOM-free and deterministic, like every other module here.
 */

import { assignLayers, hashId } from './layered.js';
import { relax } from './relax.js';

/** Clear space between two marks, in pixels. */
const GAP = 20;
/**
 * How hard each kind of mark holds others off, during the relaxation.
 *
 * A pull request has to keep a whole fan's worth of room clear around it, so it pushes far
 * harder than a commit does — two commits inside one fan should sit close, because that
 * closeness is what makes the fan read as one group.
 */
export const CHARGE = { issue: 3.4, pull_request: 2.6, commit: 1 };
/**
 * How much of a full turn a child fan may use.
 *
 * ⚠️ Less than a full circle on purpose: a cluster fans *outward*, away from its parent's
 * own parent. Letting it wrap the whole way round would send a pull request's commits back
 * through the issue in the middle, crossing every other cluster's edges to get there.
 */
const FAN = Math.PI * 1.35;
/** The root has no parent to lean away from, so its children take the whole circle. */
const ROOT_FAN = Math.PI * 2;
/** How much of the box the drawing may fill before it is scaled down. */
const FILL = 0.94;
/**
 * How far a small drawing may be stretched to use the space it has.
 *
 * Capped for the same reason the layered arrangement caps its own: filling the box
 * unconditionally would push two commits of one pull request as far apart as two
 * unrelated ones, and proximity is the entire claim this layout makes. A cap lets a
 * compact graph take the room without pretending to be a big one.
 */
const MAX_FILL_SCALE = 2.6;

/**
 * The circular mean of a list of angles, in radians.
 *
 * Sums unit vectors and takes the bearing of the result, which is the only averaging that
 * respects the wrap at 2π. Returns `null` for an empty list, and for a set whose vectors
 * cancel exactly — two parents diametrically opposite have no meaningful midpoint, and
 * picking one of them would be a coin toss dressed as a position.
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

/** Parent and child ids across adjacent levels, plus each node's level. */
function relations(levels, edges) {
  const levelOf = new Map();
  levels.forEach((level, index) => level.forEach((node) => levelOf.set(node.id, index)));

  const parents = new Map();
  const children = new Map();
  for (const level of levels) {
    for (const node of level) {
      parents.set(node.id, []);
      children.set(node.id, []);
    }
  }

  // Sorted, so fans are shared out and means summed in a fixed order — float addition is
  // not associative, and a layout that depended on link order would not be reproducible.
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
    const from = levelOf.get(edge.source);
    const to = levelOf.get(edge.target);
    if (from === undefined || to === undefined || from === to) continue;
    const [inner, outer] = from < to ? [edge.source, edge.target] : [edge.target, edge.source];
    if (!parents.get(outer).includes(inner)) parents.get(outer).push(inner);
    if (!children.get(inner).includes(outer)) children.get(inner).push(outer);
  }
  return { parents, children, levelOf };
}

/**
 * Measure every node bottom-up: how much room it and everything under it need.
 *
 * `ring` is how far a node's children stand off from it; `reach` is the whole cluster's
 * radius, which is what a *parent* has to budget for. Computing it from the leaves up is
 * what lets a pull request with thirty commits claim a wide share of the circle and one
 * with two claim a narrow one — the alternative, equal shares, wastes most of the drawing
 * on the small clusters and crushes the large one.
 */
export function measure(levels, children, primary, radiusOf) {
  const ring = new Map();
  const reach = new Map();

  for (let index = levels.length - 1; index >= 0; index--) {
    for (const node of levels[index]) {
      const mine = (children.get(node.id) || []).filter((id) => primary.get(id) === node.id);
      if (!mine.length) {
        ring.set(node.id, 0);
        reach.set(node.id, radiusOf(node));
        continue;
      }

      const fan = index === 0 ? ROOT_FAN : FAN;
      const needed = mine.reduce((sum, id) => sum + 2 * reach.get(id) + GAP, 0);
      const widest = Math.max(...mine.map((id) => reach.get(id)));

      // Big enough that the children fit around it side by side, and at least far enough
      // out that the nearest child clears the parent's own mark.
      const value = Math.max(needed / fan, radiusOf(node) + widest + GAP);
      ring.set(node.id, value);
      reach.set(node.id, value + widest);
    }
  }
  return { ring, reach };
}

/**
 * Place a node's children around it, each taking a share of the fan proportional to reach.
 *
 * `facing` is the direction the cluster opens toward — away from whatever this node hangs
 * off — so a fan never doubles back over its own parent.
 */
function placeChildren(node, at, facing, { children, primary, ring, reach, positions, facings }) {
  const mine = (children.get(node.id) || [])
    .filter((id) => primary.get(id) === node.id)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (!mine.length) return;

  const fan = facing === null ? ROOT_FAN : FAN;
  const total = mine.reduce((sum, id) => sum + 2 * reach.get(id) + GAP, 0) || 1;
  const radius = ring.get(node.id);

  // A full turn has no start and no end, so the first child would otherwise sit exactly
  // where the last one ends. Half a share of lead-in puts the seam between two of them.
  let cursor = (facing === null ? 0 : facing - fan / 2) - 0;
  for (const id of mine) {
    const share = ((2 * reach.get(id) + GAP) / total) * fan;
    const angle = cursor + share / 2;
    cursor += share;

    positions.set(id, { x: at.x + Math.cos(angle) * radius, y: at.y + Math.sin(angle) * radius });
    facings.set(id, angle);
  }
}

/**
 * Lay a sub-log out as clusters of clusters.
 *
 * @returns {{positions: Map, levels: Array<Array>, waypoints: Map}}
 */
export function layoutCluster(nodes, edges, { width, height, padding = 60, radiusOf } = {}) {
  const radius = radiusOf || ((node) => node.radius ?? 8);
  if (!nodes.length) return { positions: new Map(), levels: [], waypoints: new Map() };

  const levels = assignLayers(nodes);
  const { parents, children, levelOf } = relations(levels, edges);

  /*
   * ⚠️ A node with several parents is budgeted for in **one** cluster only, chosen
   * deterministically as its first parent in sorted order. Counting it in both would
   * reserve its width twice and leave the drawing over-subscribed; it is moved between its
   * parents afterwards, so it still ends up where both can claim it.
   */
  const primary = new Map();
  for (const level of levels) {
    for (const node of level) {
      const mine = (parents.get(node.id) || []).slice().sort();
      if (mine.length) primary.set(node.id, mine[0]);
    }
  }

  const { ring, reach } = measure(levels, children, primary, radius);

  const positions = new Map();
  const facings = new Map();

  // The roots: one goes in the middle, several share a ring of their own.
  const roots = levels[0] || [];
  if (roots.length === 1) {
    positions.set(roots[0].id, { x: 0, y: 0 });
    facings.set(roots[0].id, null);
  } else if (roots.length > 1) {
    const total = roots.reduce((sum, node) => sum + 2 * reach.get(node.id) + GAP, 0) || 1;
    const rootRing = total / (Math.PI * 2);
    let cursor = 0;
    for (const node of roots) {
      const share = ((2 * reach.get(node.id) + GAP) / total) * Math.PI * 2;
      const angle = cursor + share / 2;
      cursor += share;
      positions.set(node.id, {
        x: Math.cos(angle) * rootRing,
        y: Math.sin(angle) * rootRing,
      });
      facings.set(node.id, angle);
    }
  }

  // Then outwards, level by level: every placed node fans its own children.
  for (const level of levels) {
    for (const node of level) {
      const at = positions.get(node.id);
      if (!at) continue;
      placeChildren(node, at, facings.get(node.id), {
        children,
        primary,
        ring,
        reach,
        positions,
        facings,
      });
    }
  }

  // Anything the tree never reached — a commit linked only to an issue, an object whose
  // one link was filtered out. Dropping it or stacking it on the origin would both be
  // worse: it is real data and it has to be somewhere findable.
  placeStrays(levels, positions, facings, reach, radius);

  /*
   * A node claimed by more than one parent is drawn **between** them. It was budgeted for
   * in one cluster, which is what keeps the circle from being over-subscribed; this is
   * where the other claims are honoured, so a commit shared by two pull requests sits
   * where both of them can be seen to reach it.
   */
  for (const [id, mine] of parents) {
    if (mine.length < 2 || !positions.has(id)) continue;
    const known = mine.map((parentId) => positions.get(parentId)).filter(Boolean);
    if (known.length < 2) continue;
    const mean = {
      x: known.reduce((sum, at) => sum + at.x, 0) / known.length,
      y: known.reduce((sum, at) => sum + at.y, 0) / known.length,
    };
    const own = positions.get(id);
    positions.set(id, { x: (own.x + mean.x) / 2, y: (own.y + mean.y) / 2 });
  }

  /*
   * The rule has said everything it can say; this settles what it could not.
   *
   * Springs, repulsion and collision run over the whole graph while an anchor holds every
   * node toward the position the rule chose — so clusters stay where the fan put them and
   * only the slack moves. That slack is where the cases the rule has nothing to say about
   * live: a commit claimed by two pull requests belongs in one fan and is wanted in two,
   * and two clusters of very different sizes can graze without either parent noticing.
   *
   * ⚠️ **Roots are pinned.** A middle that drifts is not a middle, and "the issue is in
   * the centre" is the most legible thing this arrangement says. Pinning also keeps the
   * whole drawing from wandering off as a body, which springs alone would allow.
   */
  const rootIds = new Set((levels[0] || []).map((node) => node.id));
  const settled = relax(
    nodes.map((node) => ({
      id: node.id,
      radius: radius(node),
      charge: CHARGE[node.lane] ?? 1,
      pinned: rootIds.has(node.id),
    })),
    edges,
    {
      anchors: positions,
      // A pull request hangs further from its issue than a commit hangs from its pull
      // request, which is the same proportion the fans already draw — the springs agree
      // with the rule rather than arguing with it.
      restLength: (edge) => {
        const a = levelOf.get(edge.source);
        const b = levelOf.get(edge.target);
        if (a === undefined || b === undefined) return 110;
        // A link that skips a level joins things two rings apart, so it wants a longer
        // rest length or it would drag a commit up into the pull-request ring.
        if (Math.abs(a - b) > 1) return 200;
        return Math.max(a, b) >= 2 ? 62 : 130;
      },
    },
  );
  for (const [id, at] of settled) positions.set(id, at);

  // A last guarantee. The relaxation gets marks apart in almost every case; this is what
  // makes "almost" into "always", and it is cheap once nothing much is overlapping.
  separate(nodes, positions, radius);

  const waypoints = routeSkips(edges, levelOf, positions);
  centreInBox(nodes, positions, waypoints, { width, height, padding, radius });

  /*
   * ⚠️ Separated **again**, after the fit, and the first pass is not enough on its own.
   * Fitting scales positions but not radii, so a drawing bigger than the box comes back
   * compressed and marks that had just been cleared are touching again — measured on
   * kubernetes #47532, six pairs overlapped after a pass that had left none. The same trap
   * the layered arrangement hit at its own fit step. Running it once more in final
   * coordinates is what makes the guarantee hold in the coordinates anyone actually sees.
   */
  separate(nodes, positions, radius);
  return { positions, levels, waypoints };
}

/** Place anything the tree never reached, on a ring outside everything else. */
function placeStrays(levels, positions, facings, reach, radius) {
  const strays = levels.flat().filter((node) => !positions.has(node.id));
  if (!strays.length) return;

  let extent = 0;
  for (const [id, at] of positions) {
    extent = Math.max(extent, Math.hypot(at.x, at.y) + (reach.get(id) ?? 0));
  }
  const needed = strays.reduce((sum, node) => sum + 2 * radius(node) + GAP, 0);
  const ring = Math.max(extent + GAP * 3, needed / (Math.PI * 2));

  strays.forEach((node, index) => {
    const angle = (index / strays.length) * Math.PI * 2;
    positions.set(node.id, { x: Math.cos(angle) * ring, y: Math.sin(angle) * ring });
    facings.set(node.id, angle);
  });
}

/**
 * Push overlapping marks apart, holding the arrangement otherwise still.
 *
 * Moving a shared node between its parents can put it on top of a neighbour, and two
 * clusters of very different sizes can graze. Splitting each overlap between the pair and
 * iterating settles it without disturbing anything that already had room.
 */
function separate(nodes, positions, radius, { iterations = 40, padding = 6 } = {}) {
  const ordered = nodes
    .filter((node) => positions.has(node.id))
    .slice()
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  for (let pass = 0; pass < iterations; pass++) {
    let moved = false;
    for (let i = 0; i < ordered.length; i++) {
      for (let j = i + 1; j < ordered.length; j++) {
        const a = positions.get(ordered[i].id);
        const b = positions.get(ordered[j].id);
        const need = radius(ordered[i]) + radius(ordered[j]) + padding;

        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let distance = Math.hypot(dx, dy);
        if (distance >= need) continue;

        if (distance < 1e-6) {
          // Coincident marks have no direction to separate along; deriving one from the
          // pair's ids keeps the tie-break deterministic.
          const angle = ((hashId(`${ordered[i].id}|${ordered[j].id}`) & 0xffff) / 0x10000) * Math.PI * 2;
          dx = Math.cos(angle);
          dy = Math.sin(angle);
          distance = 1e-6;
        }

        const shift = (need - distance) / 2;
        const ux = (dx / distance) * shift;
        const uy = (dy / distance) * shift;
        positions.set(ordered[i].id, { x: a.x - ux, y: a.y - uy });
        positions.set(ordered[j].id, { x: b.x + ux, y: b.y + uy });
        moved = true;
      }
    }
    if (!moved) break;
  }
}

/**
 * A waypoint for a link that skips a level, so it bends around what it passes rather than
 * cutting straight through. Placed halfway between the two ends, pushed outward a little.
 */
function routeSkips(edges, levelOf, positions) {
  const waypoints = new Map();
  for (const edge of edges) {
    const from = levelOf.get(edge.source);
    const to = levelOf.get(edge.target);
    if (from === undefined || to === undefined || Math.abs(from - to) <= 1) continue;

    const key =
      edge.source < edge.target
        ? `${edge.source}||${edge.target}`
        : `${edge.target}||${edge.source}`;
    if (waypoints.has(key)) continue;

    const a = positions.get(edge.source);
    const b = positions.get(edge.target);
    if (!a || !b) continue;

    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const away = Math.hypot(mid.x, mid.y) || 1;
    const bend = 0.18 * Math.hypot(b.x - a.x, b.y - a.y);
    waypoints.set(key, [{ x: mid.x + (mid.x / away) * bend, y: mid.y + (mid.y / away) * bend }]);
  }
  return waypoints;
}

/**
 * Move the drawing from origin-centred coordinates into the box, scaling only if it must.
 *
 * Scaling **down** shrinks the distance between marks while the marks keep their size, so
 * it is a last resort rather than a fit-to-window default.
 */
function centreInBox(nodes, positions, waypoints, { width, height, padding, radius }) {
  const radiusById = new Map(nodes.map((node) => [node.id, radius(node)]));

  /*
   * ⚠️ **Fitted to the BOX, not to a circle inscribed in it**, and the difference is most
   * of the screen. The first version measured the drawing's reach from the origin and
   * scaled that against `min(width, height) / 2`, which fits a circle — so on a chart 1450
   * wide and 670 tall it sized everything to a 550px circle and left the remaining
   * two-thirds of the width empty. Measuring the actual bounding box and scaling each way
   * against the room available in that direction uses the space the drawing is given,
   * while one shared factor keeps the aspect and therefore every relative distance.
   */
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [id, at] of positions) {
    const r = radiusById.get(id) ?? 0;
    minX = Math.min(minX, at.x - r);
    maxX = Math.max(maxX, at.x + r);
    minY = Math.min(minY, at.y - r);
    maxY = Math.max(maxY, at.y + r);
  }
  if (!Number.isFinite(minX)) return;

  const spanX = maxX - minX;
  const spanY = maxY - minY;
  const roomX = Math.max(1, width - 2 * padding);
  const roomY = Math.max(1, height - 2 * padding);

  const fit = Math.min(
    spanX > 0 ? roomX / spanX : Infinity,
    spanY > 0 ? roomY / spanY : Infinity,
  );
  const scale = Number.isFinite(fit) ? Math.min(MAX_FILL_SCALE, fit * FILL) : 1;

  const centreX = (minX + maxX) / 2;
  const centreY = (minY + maxY) / 2;
  const shift = (point) => ({
    x: width / 2 + (point.x - centreX) * scale,
    y: height / 2 + (point.y - centreY) * scale,
  });
  for (const [id, at] of positions) positions.set(id, shift(at));
  for (const [key, via] of waypoints) waypoints.set(key, via.map(shift));
}
