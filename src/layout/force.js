/**
 * A small, deterministic force-directed layout.
 *
 * Used by the **off** time mode, where position is reassigned from time to
 * relationship structure. Pure arithmetic and DOM-free, like everything else under
 * `layout/`, so "where does this node land" is assertable without a browser.
 *
 * ⚠️ **Deliberately hand-written rather than `d3-force`, and the reason is structural.**
 * d3 arrives from a CDN in `index.html`; nothing under `layout/` imports it and the test
 * suite has no d3 at all (see `render/format.js`'s header for the same argument applied
 * to time formatting). A layout engine that could only be exercised by rendering the page
 * would sit in the wrong folder by this project's own test — "if a function needs the DOM
 * to be tested, it is in the wrong folder". The algorithm below is Fruchterman–Reingold,
 * which is about forty lines and is also easier to defend in writing than a dependency.
 *
 * ## The three properties that are load-bearing
 *
 * 1. **Deterministic.** No `Math.random`, no clock, no animation loop. The same input
 *    produces bit-identical output on every call, which is what lets a re-render leave
 *    the picture where it was instead of quietly re-rolling it.
 * 2. **Insertion-order independent.** Nodes are sorted by id before anything runs.
 *    Floating-point addition is not associative, so accumulating forces in array order
 *    would make the layout depend on the order the caller happened to build its list —
 *    a difference no test would think to look for and every caller could trip over.
 * 3. **Warm-startable.** Given `previous` positions, a node that already existed starts
 *    where it was and the simulation runs cooler. This is what stops expanding a burst
 *    from reshuffling the whole graph: the twenty commits that appear are placed near the
 *    meta-node they came out of, and everything else barely moves.
 */

/**
 * Fixed pair-work budget, in distance computations.
 *
 * Repulsion is all-pairs, so cost is `iterations × n²/2`. Rather than a fixed iteration
 * count — which is fast on a 13-object sub-log and slow on F10's 300 commits — the
 * iteration count is derived from n so the *total* work stays flat. It is a pure function
 * of the node count, so determinism is unaffected.
 */
const PAIR_BUDGET = 4_000_000;
const MIN_ITERATIONS = 80;
const MAX_ITERATIONS = 400;

/** Below this separation two nodes are treated as this far apart, so forces stay finite. */
const EPSILON = 0.01;

export function iterationsFor(nodeCount) {
  const pairs = Math.max(1, (nodeCount * (nodeCount - 1)) / 2);
  const budgeted = Math.floor(PAIR_BUDGET / pairs);
  return Math.max(MIN_ITERATIONS, Math.min(MAX_ITERATIONS, budgeted));
}

/**
 * A 32-bit hash of a string, used to seed a node's starting position.
 *
 * FNV-1a. The point is not randomness but **stability**: a node's start depends on its
 * own id and on nothing else, so adding or removing other nodes cannot move it. Seeding
 * by array index would be equally deterministic and much worse — every insertion would
 * shift the index of everything after it, which is precisely the reshuffle this layout
 * is required not to do.
 */
export function hashId(id) {
  let hash = 0x811c9dc5;
  const text = String(id);
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    // The FNV prime, by shift-and-add: `hash * 16777619` overflows the 53-bit float
    // mantissa and loses low bits, which would collapse distinct ids onto one seed.
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash >>> 0;
}

/** Two independent unit fractions from one id, for angle and radius. */
function seedPosition(id, radius) {
  const hash = hashId(id);
  const angle = ((hash & 0xffff) / 0x10000) * Math.PI * 2;
  const spread = Math.sqrt(((hash >>> 16) & 0xffff) / 0x10000);
  return { x: Math.cos(angle) * spread * radius, y: Math.sin(angle) * spread * radius };
}

/**
 * Lay out a graph.
 *
 * @param {object}   options
 * @param {Array}    options.nodes     `[{id, radius?, fixed?}]` — `radius` widens a node's
 *                                     personal space, so a collapsed burst standing for
 *                                     twenty commits pushes harder than one commit does
 * @param {Array}    options.edges     `[{source, target}]`, ids; unknown ends are ignored
 * @param {Map}      [options.previous] id → `{x, y}` from the last layout, for a warm start
 * @param {number}   [options.width]   the box the layout is scaled into
 * @param {number}   [options.height]
 * @param {number}   [options.iterations] override, for tests that need a cheap run
 * @returns {Map<string, {x: number, y: number}>} one entry per node, centred on (0,0)
 */
export function layoutForce({
  nodes,
  edges = [],
  previous = null,
  width = 1000,
  height = 700,
  iterations = null,
}) {
  // Property 2: one canonical order, whatever order the caller built its lists in.
  //
  // ⚠️ **Edges have to be sorted as well as nodes, and that was learned from a failing
  // test rather than reasoned out.** Sorting only the nodes leaves the per-edge
  // attraction being summed in whatever order the caller happened to emit its links —
  // and float addition is not associative, so the same graph laid out from a reversed
  // link array drifted apart. It also decides the order neighbours are averaged in when
  // a new node is placed. Duplicate edges between one pair are kept, not deduplicated:
  // two detection methods finding the same pair is a real signal and pulling twice is
  // the honest reading of it.
  const ordered = nodes.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const orderedEdges = edges
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
  const count = ordered.length;
  const positions = new Map();
  if (count === 0) return positions;
  if (count === 1) {
    positions.set(ordered[0].id, { x: 0, y: 0 });
    return positions;
  }

  const area = width * height;
  // Fruchterman–Reingold's ideal edge length: the side of the square each node would get
  // if the drawing area were divided equally between them.
  const k = Math.sqrt(area / count);
  const index = new Map(ordered.map((node, i) => [node.id, i]));

  const x = new Float64Array(count);
  const y = new Float64Array(count);
  const dx = new Float64Array(count);
  const dy = new Float64Array(count);
  const radii = new Float64Array(count);
  const pinned = new Uint8Array(count);

  // ---- starting positions ---------------------------------------------------
  //
  // A node that was on screen a moment ago starts where it was; a genuinely new node
  // starts at the mean of whichever neighbours are already placed, and falls back to its
  // own id-seeded spot when it has none. That ordering is what makes an expanded burst
  // unfold *in place* rather than flinging its members across the picture.
  const neighbours = new Map(ordered.map((node) => [node.id, []]));
  for (const edge of orderedEdges) {
    if (!index.has(edge.source) || !index.has(edge.target)) continue;
    neighbours.get(edge.source).push(edge.target);
    neighbours.get(edge.target).push(edge.source);
  }

  const seedRadius = Math.min(width, height) / 2;
  ordered.forEach((node, i) => {
    radii[i] = node.radius ?? 0;
    pinned[i] = node.fixed ? 1 : 0;

    const remembered = previous?.get(node.id);
    if (remembered && Number.isFinite(remembered.x) && Number.isFinite(remembered.y)) {
      x[i] = remembered.x;
      y[i] = remembered.y;
      return;
    }
    if (previous) {
      let sumX = 0;
      let sumY = 0;
      let seen = 0;
      for (const other of neighbours.get(node.id)) {
        const at = previous.get(other);
        if (!at || !Number.isFinite(at.x) || !Number.isFinite(at.y)) continue;
        sumX += at.x;
        sumY += at.y;
        seen += 1;
      }
      if (seen) {
        // Nudged off the exact centroid by the node's own seed, or every member of an
        // expanded burst would start on the identical point and repulsion would have to
        // resolve a perfect tie — which it cannot do without a direction to push in.
        const jitter = seedPosition(node.id, k / 4);
        x[i] = sumX / seen + jitter.x;
        y[i] = sumY / seen + jitter.y;
        return;
      }
    }
    const seeded = seedPosition(node.id, seedRadius);
    x[i] = seeded.x;
    y[i] = seeded.y;
  });

  // ---- the simulation -------------------------------------------------------
  //
  // A warm start runs cooler: the previous layout is treated as most of the answer, so
  // the temperature begins at a fraction of the cold-start value and nothing already
  // settled gets thrown across the picture by the arrival of a few new nodes.
  const steps = iterations ?? iterationsFor(count);
  const startTemperature = (previous ? 0.12 : 1) * Math.min(width, height) * 0.1;

  for (let step = 0; step < steps; step++) {
    dx.fill(0);
    dy.fill(0);

    // Repulsion, every pair. Each pair is visited once and applied to both ends, which
    // halves the work and — more usefully — makes the two forces exactly equal and
    // opposite instead of two separately-rounded approximations of each other.
    for (let i = 0; i < count; i++) {
      for (let j = i + 1; j < count; j++) {
        let deltaX = x[i] - x[j];
        let deltaY = y[i] - y[j];
        let distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
        if (distance < EPSILON) {
          // Coincident nodes have no direction to separate along. Deriving one from the
          // pair's ids keeps the tie-break deterministic; anything random would not be.
          const angle = ((hashId(`${ordered[i].id}|${ordered[j].id}`) & 0xffff) / 0x10000) * Math.PI * 2;
          deltaX = Math.cos(angle) * EPSILON;
          deltaY = Math.sin(angle) * EPSILON;
          distance = EPSILON;
        }
        // Personal space: a burst meta-node standing for twenty commits is drawn bigger,
        // so it must repel from its edge rather than from its centre.
        const gap = Math.max(EPSILON, distance - radii[i] - radii[j]);
        const force = (k * k) / gap;
        const unitX = deltaX / distance;
        const unitY = deltaY / distance;
        dx[i] += unitX * force;
        dy[i] += unitY * force;
        dx[j] -= unitX * force;
        dy[j] -= unitY * force;
      }
    }

    // Attraction along edges.
    //
    // ⚠️ **Measured rim to rim, not centre to centre.** With centre distances a big node
    // is pulled in until repulsion happens to balance, which on F10 left 40-commit push
    // meta-nodes sitting on top of the pull request they belong to — the label unreadable
    // underneath. Subtracting both radii makes the attraction fall to zero exactly when
    // the two marks touch, so an edge pulls things adjacent rather than overlapping.
    for (const edge of orderedEdges) {
      const a = index.get(edge.source);
      const b = index.get(edge.target);
      if (a === undefined || b === undefined || a === b) continue;
      const deltaX = x[a] - x[b];
      const deltaY = y[a] - y[b];
      const distance = Math.max(EPSILON, Math.sqrt(deltaX * deltaX + deltaY * deltaY));
      const rim = Math.max(0, distance - radii[a] - radii[b]);
      const force = (rim * rim) / k;
      const unitX = (deltaX / distance) * force;
      const unitY = (deltaY / distance) * force;
      dx[a] -= unitX;
      dy[a] -= unitY;
      dx[b] += unitX;
      dy[b] += unitY;
    }

    // Gravity, toward the origin. Without it the components of a disconnected sub-log —
    // and decision 67 says a seed reaching nothing is a legitimate answer, so they do
    // occur — drift apart forever under pure repulsion.
    for (let i = 0; i < count; i++) {
      dx[i] -= x[i] * 0.06;
      dy[i] -= y[i] * 0.06;
    }

    // Cool linearly, and never let one step move a node further than the temperature
    // allows: that cap is what turns this from an oscillation into a settling.
    const temperature = startTemperature * (1 - step / steps);
    for (let i = 0; i < count; i++) {
      if (pinned[i]) continue;
      const length = Math.sqrt(dx[i] * dx[i] + dy[i] * dy[i]);
      if (length < EPSILON) continue;
      const limited = Math.min(length, temperature);
      x[i] += (dx[i] / length) * limited;
      y[i] += (dy[i] / length) * limited;
    }
  }

  // ---- centre on the origin -------------------------------------------------
  //
  // The caller places the drawing; this only guarantees the result is centred, so a
  // layout that happened to drift does not hand back an off-screen picture.
  let meanX = 0;
  let meanY = 0;
  for (let i = 0; i < count; i++) {
    meanX += x[i];
    meanY += y[i];
  }
  meanX /= count;
  meanY /= count;

  for (let i = 0; i < count; i++) {
    positions.set(ordered[i].id, { x: x[i] - meanX, y: y[i] - meanY });
  }
  return positions;
}

/**
 * Push overlapping marks apart, in the space they are actually drawn in.
 *
 * ⚠️ **Needed because fitting scales positions but not radii.** The simulation separates
 * nodes in its own coordinate space, and `fitPositions` then scales that space into the
 * viewport — so any fit below 1× brings marks closer together in pixels while they keep
 * their drawn size. Measured on F10 before this existed: 7 overlapping pairs, the deepest
 * by 5.6px, which is what put a 40-commit push meta-node on top of its pull request.
 *
 * Deliberately a *separate* pass rather than a force in the simulation. It works on the
 * final pixel coordinates, which is the only place the true overlap is known, and it
 * moves only pairs that actually collide — so the structure the simulation found survives
 * it. Deterministic: a fixed iteration count, pairs visited in sorted id order, and the
 * same id-derived tie-break as the simulation for exactly coincident marks.
 *
 * @param {Map} positions   id → `{x, y}`, already fitted
 * @param {Array} nodes     `[{id, radius}]`
 * @param {object} [options]
 * @param {number} [options.padding]     extra breathing room between rims
 * @param {number} [options.iterations]
 */
export function relaxOverlaps(positions, nodes, { padding = 4, iterations = 24 } = {}) {
  const ordered = nodes
    .filter((node) => positions.has(node.id))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (ordered.length < 2) return positions;

  const point = new Map([...positions].map(([id, at]) => [id, { x: at.x, y: at.y }]));

  for (let step = 0; step < iterations; step++) {
    let moved = false;
    for (let i = 0; i < ordered.length; i++) {
      for (let j = i + 1; j < ordered.length; j++) {
        const a = point.get(ordered[i].id);
        const b = point.get(ordered[j].id);
        const need = (ordered[i].radius ?? 0) + (ordered[j].radius ?? 0) + padding;

        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let distance = Math.hypot(dx, dy);
        if (distance >= need) continue;

        if (distance < EPSILON) {
          const angle =
            ((hashId(`${ordered[i].id}|${ordered[j].id}`) & 0xffff) / 0x10000) * Math.PI * 2;
          dx = Math.cos(angle);
          dy = Math.sin(angle);
          distance = EPSILON;
        }
        // Half the shortfall each, so neither mark is privileged over the other.
        const shift = (need - distance) / 2;
        const ux = (dx / distance) * shift;
        const uy = (dy / distance) * shift;
        a.x -= ux;
        a.y -= uy;
        b.x += ux;
        b.y += uy;
        moved = true;
      }
    }
    // Settled early: the usual case, and worth exiting for so the cost is paid only by
    // the layouts that actually collide.
    if (!moved) break;
  }

  const out = new Map();
  for (const [id, at] of point) out.set(id, at);
  return out;
}

/**
 * Scale a layout to fit a box, preserving aspect ratio.
 *
 * Separate from `layoutForce` because fitting is a presentation concern that depends on
 * the viewport, while the simulation is a property of the graph. Keeping them apart means
 * a resize refits without re-simulating — and refitting cannot move nodes relative to one
 * another, which is the whole point.
 */
export function fitPositions(positions, { width, height, padding = 40 }) {
  const fitted = new Map();
  if (positions.size === 0) return fitted;

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const { x, y } of positions.values()) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }

  const spanX = maxX - minX;
  const spanY = maxY - minY;
  const usableWidth = Math.max(1, width - 2 * padding);
  const usableHeight = Math.max(1, height - 2 * padding);
  // A single node, or a perfectly vertical or horizontal arrangement, has a zero span in
  // one direction: scale by the other rather than dividing by zero into NaN.
  const scale = Math.min(
    spanX > 0 ? usableWidth / spanX : Infinity,
    spanY > 0 ? usableHeight / spanY : Infinity,
  );
  const factor = Number.isFinite(scale) ? scale : 1;

  const centreX = (minX + maxX) / 2;
  const centreY = (minY + maxY) / 2;
  for (const [id, { x, y }] of positions) {
    fitted.set(id, {
      x: width / 2 + (x - centreX) * factor,
      y: height / 2 + (y - centreY) * factor,
    });
  }
  return fitted;
}
