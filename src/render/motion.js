/**
 * Movement for the off mode: settling into place, and a slow idle drift.
 *
 * Graph tools move. Neo4j's browser, Gephi and the rest run a live simulation, so their
 * nodes glide into position and keep breathing afterwards, and a picture that simply
 * appears reads as a diagram rather than as a graph you can poke at. This supplies that
 * without the simulation.
 *
 * ⚠️ **Motion here is presentation only, and that is a hard rule rather than an
 * implementation detail.** The layout is a pure function of the sub-log — `layered.js` and
 * `radial.js` both return the same coordinates on every call, which is what makes a
 * re-render leave the picture alone and what lets two people compare two screenshots. If
 * movement fed back into position, the resting arrangement would depend on when you
 * looked at it. So this module animates *toward* the computed positions and never changes
 * them: settling is a path to the answer, and the drift is a small offset around it that
 * averages to nothing.
 *
 * Everything except the frame loop is a pure function, so the arithmetic is testable
 * without a browser; the DOM appears only as `apply` callbacks the caller supplies.
 */

/** How long a node takes to slide into place after a layout change. */
export const SETTLE_MS = 620;
/** How far a resting node wanders, in pixels. */
const DRIFT_PX = 2.4;
/** One full drift cycle. Slow on purpose — this is a sign of life, not an animation. */
const DRIFT_PERIOD_MS = 5200;

/**
 * Cubic ease-out: quick to start, gentle to finish.
 *
 * The same curve `render/nodes.js` uses for the timeline's burst tween, so the two modes
 * move in the same way rather than each having a house style.
 */
export function easeOutCubic(t) {
  const clamped = Math.max(0, Math.min(1, t));
  return 1 - (1 - clamped) ** 3;
}

/**
 * A stable phase per node, so the drift is deterministic.
 *
 * ⚠️ `Math.random()` is forbidden here for the usual reason — it is forbidden everywhere in
 * this project — but also for a specific one: with a random phase, two screenshots of the
 * same sub-log taken a second apart would differ by more than the drift, because every
 * node would have restarted somewhere else. Deriving the phase from the id means the
 * motion is a function of the data and the clock, and nothing else.
 */
export function driftPhase(id) {
  let hash = 0x811c9dc5;
  const text = String(id);
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return ((hash >>> 0) / 0xffffffff) * Math.PI * 2;
}

/**
 * How far a node has wandered from its true position, at this instant.
 *
 * The two axes run at different rates, so a node traces a slow open curve rather than a
 * circle — a ring of nodes all orbiting in step would read as the whole picture rotating,
 * which is a claim about the drawing that nothing in the data supports.
 *
 * @returns {{dx: number, dy: number}} an offset, never a position
 */
export function driftOffset(id, elapsedMs, { amplitude = DRIFT_PX, period = DRIFT_PERIOD_MS } = {}) {
  const phase = driftPhase(id);
  const turn = (Math.PI * 2 * elapsedMs) / period;
  return {
    dx: Math.sin(turn + phase) * amplitude,
    dy: Math.cos(turn * 0.73 + phase * 1.7) * amplitude * 0.8,
  };
}

/**
 * Where a node is partway through settling.
 *
 * `from` is where it was drawn a moment ago and `to` is where the layout says it belongs.
 * A node with nowhere to come from starts where it is going, so a first draw has nothing
 * to animate rather than flying in from a corner.
 */
export function settlePosition(from, to, progress) {
  if (!from) return { x: to.x, y: to.y };
  const eased = easeOutCubic(progress);
  return {
    x: from.x + (to.x - from.x) * eased,
    y: from.y + (to.y - from.y) * eased,
  };
}

/**
 * Whether the viewer has asked for less movement.
 *
 * Honoured rather than offered as a setting: a vestibular disorder is not a preference,
 * and the operating system already knows the answer. With it set, nodes appear where they
 * belong and stay there — the picture is identical, only the journey is gone.
 */
export function prefersReducedMotion() {
  return Boolean(globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches);
}

/**
 * Drive a scene: settle its marks into place, then let them drift.
 *
 * The caller supplies what to move and how to move it, so this module never touches the
 * DOM directly and can be exercised with a stub clock and stub `apply` functions.
 *
 * @param {object} [options]
 * @param {boolean} [options.reduced]  skip all movement
 * @param {Function} [options.now]     clock, injectable for tests
 * @param {Function} [options.schedule] frame scheduler, injectable for tests
 * @param {Function} [options.cancel]
 */
export function createMotion({
  reduced = prefersReducedMotion(),
  now = () => performance.now(),
  schedule = (fn) => requestAnimationFrame(fn),
  cancel = (handle) => cancelAnimationFrame(handle),
} = {}) {
  let frame = null;
  let scene = null;
  let startedAt = 0;

  function paint(elapsed) {
    if (!scene) return;
    const settling = Math.min(1, elapsed / SETTLE_MS);

    const at = new Map();
    for (const mark of scene.marks) {
      const base = settlePosition(mark.from, mark, settling);
      // Drift fades in as settling finishes, so the two never fight over the same node.
      const drift = reduced ? { dx: 0, dy: 0 } : driftOffset(mark.id, elapsed);
      const point = { x: base.x + drift.dx * settling, y: base.y + drift.dy * settling };
      at.set(mark.id, point);
      mark.apply(point);
    }

    // Edges follow their ends. Recomputed rather than transformed, because an edge is
    // defined by its two endpoints and moving it any other way would let it come adrift
    // from the marks it joins — visibly, and only while something was moving.
    for (const edge of scene.edges) {
      const from = at.get(edge.source);
      const to = at.get(edge.target);
      if (from && to) edge.apply(from, to);
    }
  }

  function tick() {
    const elapsed = now() - startedAt;
    paint(elapsed);
    // The drift never ends, so the loop never ends — but only while a scene is mounted,
    // and `stop()` is called on every re-render before the next scene replaces it.
    frame = reduced && elapsed >= SETTLE_MS ? null : schedule(tick);
  }

  return {
    /**
     * Mount a scene and start moving it.
     *
     * @param {{marks: Array, edges: Array}} next
     *   `marks` are `{id, x, y, from?, apply(point)}`; `edges` are
     *   `{source, target, apply(from, to)}`.
     */
    play(next) {
      stop();
      scene = next;
      startedAt = now();
      if (!scene?.marks?.length) return;
      paint(0);
      frame = schedule(tick);
    },
    stop,
    isRunning: () => frame !== null,
    reduced,
  };

  function stop() {
    if (frame !== null) cancel(frame);
    frame = null;
  }
}
