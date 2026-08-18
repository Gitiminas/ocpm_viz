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

import { assignLayers, hashId, LAYER_ORDER } from './layered.js';
import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCollide,
  forceX,
  forceY,
} from '../../vendor/d3-force.js';

/** Clear space between two marks, in pixels. */
const GAP = 20;
/**
 * How hard each kind of mark holds others off.
 *
 * A pull request has to keep a whole fan's worth of room clear around it; two commits
 * inside one fan should sit close, because that closeness is what makes the fan read as
 * one group. One uniform charge cannot do both: low enough for the second and the clusters
 * collide, high enough for the first and the fans blow open.
 */
export const CHARGE = { issue: -400, pull_request: -400, commit: -35 };

/**
 * How long each kind of link wants to be, in pixels.
 *
 * ⚠️ **Every kind in the data model is named here, and the fallback exists only to be
 * unreachable.** The link vocabulary is four qualifiers over three lane pairs (decision
 * 43), so an unnamed kind would be one nobody decided about, quietly taking whatever the
 * library happens to use. `commit ↔ issue` is the level-skipping one — `references_issue`,
 * a commit naming an issue directly — and it is long on purpose: measured earlier, a short
 * rest length there hauls commits out of their fan and up into the pull-request ring.
 */
const LINK_DISTANCE = {
  'issue|pull_request': 130,
  'commit|pull_request': 50,
  'commit|issue': 200,
};

/** Springs to a pull request's commits pull harder — that fan is the tightest grouping. */
const LINK_STRENGTH = { 'commit|pull_request': 0.9 };
const DEFAULT_LINK_STRENGTH = 0.7;

/** How firmly everything is drawn toward the middle, so components cannot drift apart. */
const CENTRING = 0.05;
/** Extra clear space the collision force keeps between two marks. */
const COLLIDE_PADDING = 5;
/**
 * Beyond this distance two marks stop pushing each other at all.
 *
 * ⚠️ Without a cutoff, repulsion between two marks that share no link has nothing to
 * balance it, and while a drag holds the simulation warm the pair separates without
 * limit — measured on kubernetes #47532: dragging one pull request 240px moved every
 * one of the 23 unrelated marks more than 30px, one of them 500px, and on F10 three left
 * the box altogether. Repulsion is a *local* claim ("do not sit on me"), so it is given a
 * local range. Long enough to keep two fans from touching, and no longer.
 */
const CHARGE_RANGE = 260;
/**
 * How firmly a mark holds its cluster's room against marks that are not part of it.
 *
 * Under 1 on purpose: a footprint is a *claim*, and where two claims cannot both be met
 * — a pull request pinned by the pointer inside another's fan — the springs and the
 * collision force still get a say. Ties are settled by compromise rather than by whichever
 * force ran last.
 */
const FOOTPRINT_STRENGTH = 0.5;
/**
 * How firmly a dragged picture remembers where everything was.
 *
 * The drag simulation carries no centring force — that would haul the neighbourhood back
 * toward the middle of a drawing the reader is deliberately pulling something out of.
 * What it needs instead is a memory: each free mark is drawn gently toward where it stood
 * when the gesture began, so a drag rearranges the neighbourhood of the mark in hand and
 * leaves the orientation of the picture alone. Strong enough that an unrelated mark
 * drifts a few pixels and comes back rather than wandering off. Marks linked to the one in
 * hand carry no memory at all (see `createDragSimulation`): they ARE the neighbourhood
 * being rearranged, and a spring home would leave a dragged fan permanently stretched —
 * measured at 81px against a 50px rest length before that exemption existed.
 */
const HOME_STRENGTH = 0.08;
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
 * Capped for the same reason the layered arrangement caps its own. A uniform scale keeps
 * every *ratio* of distances — but the marks do not scale with it, and a reader judges
 * "near" against the size of the marks. Blow a three-node sub-log up to fill a screen and
 * its 50px rest length becomes 300px of empty canvas: proximity, which is the entire claim
 * this layout makes, stops reading as proximity. A cap lets a compact graph take the room
 * without pretending to be a big one.
 *
 * ⚠️ If the picture looks small, check the FRAME before touching this. The cap was blamed
 * for a cramped picture that was in fact fitted into a surface still shortened by the
 * minimap (`markMode` in `main.js`) and framed by the timeline's margins
 * (`STRUCTURAL_MARGIN` in `render/timeline.js`). Neither was this number.
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
 * The level a lane sits at, for the footprint force. Same order the layers use, so
 * "deeper" means the same thing here as it does in `assignLayers`.
 */
const levelOfLane = (lane) => {
  const level = LAYER_ORDER.indexOf(lane);
  return level === -1 ? LAYER_ORDER.length : level;
};

/**
 * Which pairs of marks the footprint force keeps apart, and how far.
 *
 * A mark's `footprint` is the radius of the cluster hanging off it — its own radius for a
 * leaf, the whole fan's reach for a hub. Two marks that have nothing to do with each other
 * must stay `footprint + footprint + padding` apart, which is what stops a pull request's
 * fan from grazing its neighbour's and keeps a foreign issue from nesting inside one.
 *
 * ⚠️ **What "nothing to do with each other" excludes, and why each exclusion is there:**
 *
 *   ancestor / descendant   a pull request sits *inside* its issue's footprint by
 *                           design, and its commits inside its own. Constraining these
 *                           would blow every cluster open from within.
 *   co-parents              two issues that share a pull request, or two pull requests
 *                           that share a commit, are legitimately close — the shared
 *                           node is drawn between them (see `layoutCluster`). Holding
 *                           them a full footprint apart would stretch the very link that
 *                           makes them neighbours.
 *   two leaves              radius + radius is exactly what the collision force already
 *                           enforces; listing the pair twice would double-count it.
 *
 * Siblings — two pull requests of one issue, two commits of one pull request — are *not*
 * exempt. Sharing a parent is what makes them neighbours in the ring; it is not a licence
 * to overlap, and keeping sibling fans apart is the whole point.
 *
 * Exported for the tests, which pin the exemptions: each one is a rule that, if silently
 * dropped, would produce a picture that looks plausible and is wrong.
 *
 * @param {Array<{id:string, lane:string, radius:number, footprint?:number}>} nodes
 * @param {Array<{source:string|object, target:string|object}>} links
 * @param {number} padding
 * @returns {Array<{a:object, b:object, need:number}>}
 */
export function footprintPairs(nodes, links, padding = GAP) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const footprint = (node) => node.footprint ?? node.radius ?? 0;
  const isHub = (node) => footprint(node) > (node.radius ?? 0);
  const idOf = (end) => (typeof end === 'object' ? end.id : end);

  // Down-neighbours: the linked marks one level deeper. Ancestry follows these.
  const below = new Map(nodes.map((node) => [node.id, new Set()]));
  for (const link of links) {
    const a = byId.get(idOf(link.source));
    const b = byId.get(idOf(link.target));
    if (!a || !b) continue;
    const la = levelOfLane(a.lane);
    const lb = levelOfLane(b.lane);
    if (la < lb) below.get(a.id).add(b.id);
    else if (lb < la) below.get(b.id).add(a.id);
  }

  // Everything reachable going only downwards — three levels, so this is small.
  const descendants = new Map();
  const descend = (id) => {
    if (descendants.has(id)) return descendants.get(id);
    const found = new Set();
    for (const child of below.get(id) ?? []) {
      found.add(child);
      for (const deeper of descend(child)) found.add(deeper);
    }
    descendants.set(id, found);
    return found;
  };
  for (const node of nodes) descend(node.id);

  const shareAChild = (a, b) => {
    for (const child of below.get(a.id)) if (below.get(b.id).has(child)) return true;
    return false;
  };

  const pairs = [];
  // In id order on both sides: the force sums in list order, and float addition is not
  // associative, so an unordered pair list would make the picture depend on input order.
  const ordered = nodes.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (let i = 0; i < ordered.length; i++) {
    for (let j = i + 1; j < ordered.length; j++) {
      const a = ordered[i];
      const b = ordered[j];
      if (!isHub(a) && !isHub(b)) continue;
      if (descendants.get(a.id).has(b.id) || descendants.get(b.id).has(a.id)) continue;
      if (levelOfLane(a.lane) === levelOfLane(b.lane) && shareAChild(a, b)) continue;
      pairs.push({ a, b, need: footprint(a) + footprint(b) + padding });
    }
  }
  return pairs;
}

/**
 * A force that keeps whole clusters apart, not just marks.
 *
 * `forceCollide` knows each mark's radius and nothing else, so it lets one pull request's
 * fan run straight through another's as long as no two marks touch — the fans on
 * kubernetes #47532 did exactly that. This force treats a hub as if it were as large as
 * the cluster it carries. It is written like `forceCollide`: a positional correction split
 * between the pair, applied through the velocities so damping still applies, and not
 * scaled by alpha so the claim holds all the way to rest.
 *
 * Which pairs, and how far, is decided once in `initialize` by `footprintPairs`; the
 * per-tick work is one distance per constrained pair.
 */
export function forceFootprint(links, { padding = GAP, strength = FOOTPRINT_STRENGTH } = {}) {
  let pairs = [];

  function force() {
    for (const { a, b, need } of pairs) {
      let dx = b.x - a.x;
      let dy = b.y - a.y;
      let distance = Math.hypot(dx, dy);
      if (distance >= need) continue;
      if (distance < 1e-6) {
        // Coincident: pick a direction from the ids, so the tie-break is deterministic.
        const angle = ((hashId(`${a.id}|${b.id}`) & 0xffff) / 0x10000) * Math.PI * 2;
        dx = Math.cos(angle);
        dy = Math.sin(angle);
        distance = 1e-6;
      }
      const push = ((need - distance) / distance) * strength * 0.5;
      // A pinned mark (fx/fy set) does not move; d3 resets its position each tick, so
      // giving it velocity is harmless — but the free partner should then take the whole
      // correction rather than half, or the pair never separates.
      const aFixed = a.fx != null && a.fy != null;
      const bFixed = b.fx != null && b.fy != null;
      const shareA = aFixed ? 0 : bFixed ? 2 : 1;
      const shareB = bFixed ? 0 : aFixed ? 2 : 1;
      a.vx -= dx * push * shareA;
      a.vy -= dy * push * shareA;
      b.vx += dx * push * shareB;
      b.vy += dy * push * shareB;
    }
  }

  force.initialize = (nodes) => {
    pairs = footprintPairs(nodes, links, padding);
  };

  return force;
}

/**
 * Apply the shared force configuration to a simulation.
 *
 * ⚠️ **One configuration, two callers.** The layout ticks a simulation to convergence; a
 * drag runs one live. If the two were tuned separately they would disagree — a mark would
 * settle in one place when the picture was drawn and drift to another the moment it was
 * touched, and the reader would have no way to know which was the arrangement's real
 * answer. Defining it once is what makes dragging feel like moving the same graph rather
 * than provoking a different one.
 *
 * Nodes may carry a `footprint` — the radius of the cluster hanging off them, in the same
 * pixels as their positions — which `forceFootprint` uses to keep whole clusters apart.
 * A node without one is treated as a leaf.
 */
export function withForces(simulation, links, laneOf) {
  const kind = (link) => {
    const a = laneOf.get(typeof link.source === 'object' ? link.source.id : link.source);
    const b = laneOf.get(typeof link.target === 'object' ? link.target.id : link.target);
    return [a, b].sort().join('|');
  };

  return simulation
    .force(
      'link',
      forceLink(links)
        .id((node) => node.id)
        .distance((link) => LINK_DISTANCE[kind(link)] ?? 110)
        .strength((link) => LINK_STRENGTH[kind(link)] ?? DEFAULT_LINK_STRENGTH),
    )
    .force(
      'charge',
      forceManyBody()
        .strength((node) => CHARGE[node.lane] ?? CHARGE.commit)
        .distanceMax(CHARGE_RANGE),
    )
    .force(
      'collide',
      forceCollide().radius((node) => node.radius + COLLIDE_PADDING),
    )
    .force('footprint', forceFootprint(links));
}

/**
 * A live simulation for dragging: same forces, running rather than ticked.
 *
 * ⚠️ **This is what a hand-rolled relaxation could not give.** Solving from scratch on
 * every pointer event has no velocity, so marks lurch toward equilibrium and stop dead —
 * reported as "weird and springy". A simulation carries momentum and damps it, which is
 * why every graph tool feels the way it does. `velocityDecay` is the whole feel: lower and
 * the picture wobbles for seconds after you let go, higher and it may as well be the
 * solver it replaced.
 *
 * Two things hold the picture together while it runs, and both were missing in the
 * version that scattered kubernetes #47532 across the screen:
 *
 *   home springs   every free mark is drawn toward where it stood when the gesture began
 *                  (`homeX` / `homeY`, taken from the node's position on entry) — except
 *                  the marks linked to the one in hand, which are the neighbourhood being
 *                  rearranged and follow it freely. The rest of the picture keeps its
 *                  orientation, so what the reader learned from it still holds.
 *   the anchor     the root the layout pinned stays pinned here too, unless it is the mark
 *                  in hand. The layout pins it so the drawing cannot rotate or drift as a
 *                  body between renders; letting a drag do exactly that undid the point.
 *
 * ⚠️ Mutates the nodes it is given, as d3-force always does — and additionally stamps
 * `homeX` / `homeY` / `homeStrength` where they are absent. Callers pass throwaway seeds.
 *
 * Returned stopped. The caller pins the mark in hand (`fx`/`fy`) BEFORE calling this, so
 * its neighbours can be told apart from the rest; then reheats it and drives its own
 * redraw from the tick event.
 *
 * @param {Array}  nodes  the mark being dragged already carries `fx`/`fy`
 * @param {Array}  links
 * @param {object} [options]
 * @param {string|null} [options.anchorId]  the layout's pinned root, held still unless
 *   it is the mark being dragged (which the caller has already pinned by setting `fx`)
 * @param {number} [options.homeStrength]
 */
export function createDragSimulation(
  nodes,
  links,
  { anchorId = null, homeStrength = HOME_STRENGTH } = {},
) {
  const laneOf = new Map(nodes.map((node) => [node.id, node.lane]));
  const idOf = (end) => (typeof end === 'object' ? end.id : end);

  // The marks in hand are the pinned ones that are not the anchor; their graph neighbours
  // are the neighbourhood, and go without a memory.
  const held = new Set(
    nodes.filter((node) => node.fx != null && node.id !== anchorId).map((node) => node.id),
  );
  const neighbourhood = new Set();
  for (const link of links) {
    const a = idOf(link.source);
    const b = idOf(link.target);
    if (held.has(a)) neighbourhood.add(b);
    if (held.has(b)) neighbourhood.add(a);
  }

  for (const node of nodes) {
    node.homeX ??= node.x;
    node.homeY ??= node.y;
    node.homeStrength ??= neighbourhood.has(node.id) ? 0 : homeStrength;
    if (node.id === anchorId && node.fx == null) {
      node.fx = node.x;
      node.fy = node.y;
    }
  }
  return withForces(forceSimulation(nodes), links, laneOf)
    .force('homeX', forceX((node) => node.homeX).strength((node) => node.homeStrength))
    .force('homeY', forceY((node) => node.homeY).strength((node) => node.homeStrength))
    .velocityDecay(0.55)
    .alphaDecay(0.06)
    .stop();
}
/**
 * Lay a sub-log out as clusters of clusters.
 *
 * @returns {{positions: Map, levels: Array<Array>, waypoints: Map, footprints: Map,
 *   anchorId: string|null}} — `footprints` is each node's cluster radius in the SAME
 *   pixels as `positions` (post-fit), so a drag can hand it straight to the simulation;
 *   `anchorId` is the one root the relaxation pinned, so a drag can keep it pinned
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
   * The rule has said everything it can say; the simulation settles what it could not.
   *
   * The balloon placement above is the **seed**, not a suggestion to be overruled: it puts
   * every node in its parent's fan by a stated rule, which is what makes the arrangement
   * explainable and keeps it recognisable from one sub-log to the next. What a per-parent
   * rule cannot do is settle the cases it does not cover — a commit claimed by two pull
   * requests belongs in one fan and is wanted in two, and clusters of very different sizes
   * graze each other without either parent noticing. Springs, charges and collision do
   * that, starting from the answer the rule already gave.
   *
   * ⚠️ **The simulation never runs itself.** `forceSimulation` starts an internal timer on
   * construction, so it is stopped immediately and ticked by hand to convergence. A layout
   * that animated its own way to an answer would make the result depend on when it was
   * looked at, and this one has to be a pure function of the sub-log. The ease-in a reader
   * actually sees is presentation and lives in `render/motion.js`.
   */
  /*
   * ⚠️ **Only ONE root is pinned — the busiest — and the rest are left to the forces.**
   *
   * Pinning every root froze the seed's guess about where they belong, and the seed shares
   * the innermost ring by demand, so a minor issue got a sliver of it and could never
   * reach its own work. Measured on kubernetes #47532: issue #64894's single pull request
   * sat 316px away against a rest length of 130, and F4's two issues 306 and 394 away.
   * Freed, #64894 lands at 141. The other issues were not so much placed as parked, which
   * is what made them look like afterthoughts.
   *
   * One root stays pinned so the drawing has something to be built around, and so it
   * cannot rotate or drift as a body between renders. Busiest by link count, with the id
   * as a tie-break, because that is stable and is also the one a reader is most likely to
   * have come for.
   */
  const degree = new Map();
  for (const edge of edges) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }
  const anchorRoot = (levels[0] || [])
    .slice()
    .sort(
      (a, b) =>
        (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0) || (a.id < b.id ? -1 : 1),
    )[0];
  const rootIds = new Set(anchorRoot ? [anchorRoot.id] : []);

  const simNodes = nodes
    .filter((node) => positions.has(node.id))
    .slice()
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((node) => {
      const at = positions.get(node.id);
      const seed = {
        id: node.id,
        lane: node.lane,
        radius: radius(node),
        // The whole cluster's radius, so `forceFootprint` can keep fans apart. Pre-fit
        // pixels, like everything else in the simulation.
        footprint: reach.get(node.id) ?? radius(node),
        x: at.x,
        y: at.y,
      };
      // Roots are pinned. A middle that drifts is not a middle, and pinning is also what
      // stops the springs walking the whole drawing off as a body.
      if (rootIds.has(node.id)) {
        seed.fx = at.x;
        seed.fy = at.y;
      }
      return seed;
    });

  const laneOf = new Map(simNodes.map((node) => [node.id, node.lane]));
  const kindOf = (link) => {
    const a = laneOf.get(typeof link.source === 'object' ? link.source.id : link.source);
    const b = laneOf.get(typeof link.target === 'object' ? link.target.id : link.target);
    return [a, b].sort().join('|');
  };

  // Sorted, like the nodes: the simulation accumulates forces in list order and float
  // addition is not associative, so an unsorted list would make the result depend on the
  // order the caller happened to build its links in.
  const simLinks = edges
    .filter((edge) => positions.has(edge.source) && positions.has(edge.target))
    .map((edge) => ({ source: edge.source, target: edge.target }))
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

  const simulation = withForces(forceSimulation(simNodes), simLinks, laneOf)
    /*
     * Toward the ORIGIN, which is where the seed is centred — the drawing is only moved
     * into the canvas afterwards, by `centreInBox`. Aiming at the canvas centre here would
     * shove everything into a corner of a space it is not in yet.
     *
     * ⚠️ **The two are deliberately unequal, in proportion to the canvas.** Equal centring
     * pulls a graph into a circle, and a circle can never use a wide box: fitted into
     * 1100×620 it fills the height and leaves nearly half the width empty — measured at
     * 18–38% of the width against ~70% of the height. Pulling more gently sideways than
     * vertically lets the drawing take the shape of the space it has to live in, without
     * distorting anything, because the forces act on the layout rather than on the
     * finished picture.
     */
    .force('x', forceX(0).strength(CENTRING * Math.min(1, height / width)))
    .force('y', forceY(0).strength(CENTRING * Math.min(1, width / height)))
    .stop();

  while (simulation.alpha() > simulation.alphaMin()) simulation.tick();

  for (const node of simNodes) positions.set(node.id, { x: node.x, y: node.y });

  const waypoints = routeSkips(edges, levelOf, positions);
  const scale = centreInBox(nodes, positions, waypoints, { width, height, padding, radius });

  /*
   * ⚠️ Separated **again**, after the fit, and the first pass is not enough on its own.
   * Fitting scales positions but not radii, so a drawing bigger than the box comes back
   * compressed and marks that had just been cleared are touching again — measured on
   * kubernetes #47532, six pairs overlapped after a pass that had left none. The same trap
   * the layered arrangement hit at its own fit step. Running it once more in final
   * coordinates is what makes the guarantee hold in the coordinates anyone actually sees.
   */
  separate(nodes, positions, radius);

  /*
   * ⚠️ Footprints leave here in POST-FIT pixels — trap 8.1 again. The simulation measured
   * reach against pre-fit rest lengths; a drag will compare it against on-screen positions,
   * so it is scaled by the same factor the positions were. A leaf's footprint is its
   * radius, which the fit does not scale, so leaves are left alone.
   */
  const footprints = new Map();
  for (const node of nodes) {
    const own = radius(node);
    const cluster = reach.get(node.id) ?? own;
    footprints.set(node.id, cluster > own ? cluster * scale : own);
  }
  return { positions, levels, waypoints, footprints, anchorId: anchorRoot?.id ?? null };
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
 *
 * @returns {number} the factor positions were multiplied by, so a caller can put any other
 *   pre-fit length — a footprint, a rest length — into the same pixels
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
  if (!Number.isFinite(minX)) return 1;

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
  return scale;
}
