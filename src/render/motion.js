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
 * Push marks apart until none overlaps, holding one of them still.
 *
 * ⚠️ **Because dragging one mark on top of another is otherwise allowed**, and nothing
 * stops a reader stacking the whole graph on a single point — a picture that says nothing
 * and cannot be recovered from except by resetting. Marks that are in the way now move
 * aside, which is what a graph tool does and what makes dragging useful for untangling
 * rather than just for hiding things.
 *
 * The dragged mark is held fixed: it goes exactly where the pointer says. Everything else
 * splits each overlap between the pair, iterating so a shove propagates through a crowd
 * instead of stopping at the first neighbour. Pure, so the arithmetic is checkable without
 * a pointer.
 *
 * @param {Array} marks     `{id, x, y, radius}` — mutated in place
 * @param {object} [options]
 * @param {string} [options.fixedId]  the mark under the pointer, which does not move
 */
export function pushApart(marks, { fixedId = null, padding = 6, iterations = 24 } = {}) {
  const ordered = marks.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  for (let pass = 0; pass < iterations; pass++) {
    let moved = false;
    for (let i = 0; i < ordered.length; i++) {
      for (let j = i + 1; j < ordered.length; j++) {
        const a = ordered[i];
        const b = ordered[j];
        const need = (a.radius ?? 8) + (b.radius ?? 8) + padding;

        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let distance = Math.hypot(dx, dy);
        if (distance >= need) continue;

        if (distance < 1e-6) {
          // Exactly coincident marks have no direction to separate along. Deriving one
          // from the pair's ids keeps it deterministic; anything random would not be.
          const angle = driftPhase(`${a.id}|${b.id}`);
          dx = Math.cos(angle);
          dy = Math.sin(angle);
          distance = 1e-6;
        }

        const aFixed = a.id === fixedId;
        const bFixed = b.id === fixedId;
        if (aFixed && bFixed) continue;

        // The held mark takes none of the shove, so its neighbour absorbs all of it.
        const shove = need - distance;
        const aShare = aFixed ? 0 : bFixed ? shove : shove / 2;
        const bShare = bFixed ? 0 : aFixed ? shove : shove / 2;
        const ux = dx / distance;
        const uy = dy / distance;

        a.x -= ux * aShare;
        a.y -= uy * aShare;
        b.x += ux * bShare;
        b.y += uy * bShare;
        moved = true;
      }
    }
    if (!moved) break;
  }
  return marks;
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
  /*
   * ⚠️ **The drift is frozen during a gesture**, and leaving it running was a real defect.
   * `repaint()` paints at the current elapsed time, so every pointer event recomputed the
   * idle wander — up to ±2.4px per mark, per event, on top of whatever the drag was
   * moving. Reported as the picture being "weird and jittery" while dragging, and that is
   * exactly what it was: two things writing positions at pointer rate, one of them for no
   * reason. A gesture is a deliberate act; nothing should be breathing under it.
   */
  let heldAt = null;

  function paint(elapsed) {
    if (!scene) return;
    const settling = Math.min(1, elapsed / SETTLE_MS);

    const at = new Map();
    for (const mark of scene.marks) {
      const base = settlePosition(mark.from, mark, settling);
      // Drift fades in as settling finishes, so the two never fight over the same node.
      const drift =
        reduced || heldAt !== null ? { dx: 0, dy: 0 } : driftOffset(mark.id, elapsed);
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
     * Repaint immediately, without waiting for a frame.
     *
     * Dragging needs this: with reduced motion the loop stops once everything has
     * settled, so a dragged mark would not be redrawn and would appear stuck until
     * something else happened.
     */
    repaint() {
      if (scene) paint(Math.max(SETTLE_MS, heldAt ?? now() - startedAt));
    },

    /**
     * Hold the drift still for the duration of a gesture, and let it go afterwards.
     *
     * Held at the settled point rather than at the current elapsed time, so releasing does
     * not jump the whole picture to wherever the wander had got to while you were busy.
     */
    hold() {
      heldAt = SETTLE_MS;
    },
    release() {
      heldAt = null;
      startedAt = now();
    },

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
