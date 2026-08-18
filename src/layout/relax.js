/**
 * A short, deterministic relaxation pass over an already-placed layout.
 *
 * The clustered layout hand-places every node from a rule: a child sits in its parent's
 * fan, at a share proportional to what its own subtree needs. That rule is what makes the
 * picture explainable — you can say *why* a mark is where it is — and it is why the
 * arrangement is reproducible. What it cannot do is settle the cases the rule does not
 * cover: a commit claimed by two pull requests belongs in one fan and is wanted in two,
 * and clusters of very different sizes graze each other in ways no per-parent rule sees.
 *
 * So this does not replace the rule, it finishes it. Springs, repulsion and collision run
 * over the whole graph for a fixed number of steps, while an **anchor** force holds every
 * node toward the position the rule chose for it. The anchor is the whole design: with it
 * strong the picture is the computed one with softer edges, with it weak it is a free
 * force layout. Only the slack is emergent, and the slack is exactly where the shared
 * nodes live.
 *
 * ⚠️ **Not `d3-force`, and the reason is structural rather than preference.** d3 arrives
 * from a CDN and nothing under `layout/` imports it — the test suite has no d3 at all, so
 * a layout depending on it could only be exercised by rendering the page, which by this
 * project's own rule would put it in the wrong folder. This descends from the hand-written
 * Fruchterman–Reingold layout in commit `d9529f4`, which was deleted when the layered
 * arrangement replaced it; what survives here is its arithmetic, not its role.
 *
 * Deterministic throughout: no `Math.random`, no clock, and both lists sorted before
 * anything is summed, because float addition is not associative and a layout that depended
 * on link order would not be reproducible.
 */

/** How hard a spring pulls an edge toward its ideal length. */
const SPRING = 0.32;
/** How hard two marks push apart, scaled by their sizes. */
const REPULSION = 0.9;
/**
 * How hard a node is held to the position the layout rule chose for it.
 *
 * ⚠️ **The dial between two designs.** High, and this is the clustered layout with its
 * corners knocked off; low, and it is a free force layout, which was tried and rejected
 * because where a cluster landed became arbitrary. It sits nearer the high end on purpose:
 * the rule should still be visible in the result, and what is bought here is the handful
 * of placements the rule has nothing to say about.
 */
const ANCHOR = 0.14;
/** Clear space to keep between two marks. */
const PADDING = 6;
/** Longest step a node may take, shrinking to nothing as the pass cools. */
const MAX_STEP = 26;

export const DEFAULT_ITERATIONS = 160;

/**
 * Settle a layout.
 *
 * @param {Array} nodes    `{id, radius, pinned?}` — a pinned node never moves
 * @param {Array} edges    `{source, target}`
 * @param {object} options
 * @param {Map}    options.anchors      id → `{x, y}`, the position the rule chose
 * @param {Function} [options.restLength]  `(edge) => px`, the length a spring wants to be
 * @returns {Map<string, {x: number, y: number}>}
 */
export function relax(
  nodes,
  edges,
  {
    anchors,
    seed = null,
    restLength = () => 90,
    iterations = DEFAULT_ITERATIONS,
    spring = SPRING,
    repulsion = REPULSION,
    anchor = ANCHOR,
    padding = PADDING,
  } = {},
) {
  const ordered = nodes
    .filter((node) => anchors.has(node.id))
    .slice()
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const positions = new Map();
  if (!ordered.length) return positions;

  const index = new Map(ordered.map((node, i) => [node.id, i]));
  const count = ordered.length;

  const x = new Float64Array(count);
  const y = new Float64Array(count);
  const dx = new Float64Array(count);
  const dy = new Float64Array(count);
  const radii = new Float64Array(count);
  const charges = new Float64Array(count);
  const anchorX = new Float64Array(count);
  const anchorY = new Float64Array(count);
  const pinned = new Uint8Array(count);

  ordered.forEach((node, i) => {
    const home = anchors.get(node.id);
    // ⚠️ Where a node *starts* and where it is *pulled back to* are two different things,
    // and separating them is what lets this run during a drag. At layout time they are
    // the same — the rule's position, settled in place. Mid-drag the seed is wherever
    // everything currently is, while the anchor stays the arrangement's home, so
    // neighbours follow the pointer without the whole picture forgetting its shape.
    const start = seed?.get(node.id) ?? home;
    x[i] = start.x;
    y[i] = start.y;
    anchorX[i] = home.x;
    anchorY[i] = home.y;
    radii[i] = node.radius ?? 8;
    charges[i] = node.charge ?? 1;
    pinned[i] = node.pinned ? 1 : 0;
  });

  // Sorted for the same reason as the nodes: the sums below must not depend on the order
  // the caller happened to build its list in.
  const springs = edges
    .filter((edge) => index.has(edge.source) && index.has(edge.target))
    .map((edge) => ({
      a: index.get(edge.source),
      b: index.get(edge.target),
      length: restLength(edge),
      key: edge.source < edge.target
        ? `${edge.source}|${edge.target}`
        : `${edge.target}|${edge.source}`,
    }))
    .sort((p, q) => (p.key < q.key ? -1 : p.key > q.key ? 1 : 0));

  for (let step = 0; step < iterations; step++) {
    dx.fill(0);
    dy.fill(0);

    // Repulsion, every pair, visited once and applied to both ends — equal and opposite by
    // construction rather than by two separately rounded approximations.
    for (let i = 0; i < count; i++) {
      for (let j = i + 1; j < count; j++) {
        let deltaX = x[i] - x[j];
        let deltaY = y[i] - y[j];
        let distance = Math.hypot(deltaX, deltaY);
        if (distance < 1e-6) {
          // Coincident marks have no direction to part along; the index pair gives a
          // deterministic one, where anything random would not.
          deltaX = ((i * 7919 + j * 104729) % 97) / 97 - 0.5;
          deltaY = ((i * 104729 + j * 7919) % 89) / 89 - 0.5;
          distance = 1e-6;
        }
        /*
         * ⚠️ **How hard two marks push depends on what they are.** A pull request needs
         * room for a whole fan of commits around it, so it has to hold other pull requests
         * much further off than two commits need to hold each other. One uniform charge
         * gives the opposite: with it low the clusters collide, with it high the commits
         * inside a fan are blown apart and the fan stops reading as one thing.
         */
        const reach = radii[i] + radii[j] + padding;
        const force =
          (repulsion * charges[i] * charges[j] * reach * reach) / Math.max(distance, 1);
        const ux = (deltaX / distance) * force;
        const uy = (deltaY / distance) * force;
        dx[i] += ux;
        dy[i] += uy;
        dx[j] -= ux;
        dy[j] -= uy;
      }
    }

    // Springs, pulling each edge toward the length its kind wants.
    for (const link of springs) {
      const deltaX = x[link.b] - x[link.a];
      const deltaY = y[link.b] - y[link.a];
      const distance = Math.max(1e-6, Math.hypot(deltaX, deltaY));
      const force = spring * (distance - link.length);
      const ux = (deltaX / distance) * force;
      const uy = (deltaY / distance) * force;
      dx[link.a] += ux;
      dy[link.a] += uy;
      dx[link.b] -= ux;
      dy[link.b] -= uy;
    }

    // The anchor. Everything above is a suggestion; this is what keeps the result
    // recognisable as the arrangement the layout rule computed.
    for (let i = 0; i < count; i++) {
      dx[i] += (anchorX[i] - x[i]) * anchor * 40;
      dy[i] += (anchorY[i] - y[i]) * anchor * 40;
    }

    // Cool linearly, and cap each step: that cap is what turns this from an oscillation
    // into a settling.
    const limit = MAX_STEP * (1 - step / iterations);
    for (let i = 0; i < count; i++) {
      if (pinned[i]) continue;
      const length = Math.hypot(dx[i], dy[i]);
      if (length < 1e-9) continue;
      const capped = Math.min(length, limit);
      x[i] += (dx[i] / length) * capped;
      y[i] += (dy[i] / length) * capped;
    }
  }

  for (let i = 0; i < count; i++) positions.set(ordered[i].id, { x: x[i], y: y[i] });
  return positions;
}
