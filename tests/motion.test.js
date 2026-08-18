import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  createMotion,
  driftOffset,
  driftPhase,
  easeOutCubic,
  settlePosition,
  pushApart,
  SETTLE_MS,
} from '../src/render/motion.js';

/**
 * Movement in the off mode.
 *
 * The property that matters most is the one that is easiest to lose: motion must never
 * become part of the layout. The marks are animated *toward* positions the layout
 * computed, and the drift is an offset around them — so the resting arrangement is still
 * a pure function of the sub-log, and two screenshots taken a minute apart still show the
 * same picture.
 */

/** A scene of `n` marks, recording where each was last painted. */
function scene(n, { from = null } = {}) {
  const painted = new Map();
  const marks = Array.from({ length: n }, (_, i) => ({
    id: `n_commit:${i}`,
    x: 100 + i * 50,
    y: 200,
    from: from ? { x: 0, y: 0 } : undefined,
    apply(point) {
      painted.set(this.id, point);
    },
  }));
  const drawn = [];
  const edges = marks.slice(1).map((mark, i) => ({
    source: marks[i].id,
    target: mark.id,
    apply(a, b) {
      drawn.push([a, b]);
    },
  }));
  return { marks, edges, painted, drawn };
}

/** A clock and scheduler under the test's control, so nothing depends on real time. */
function harness() {
  let time = 0;
  const queue = [];
  return {
    now: () => time,
    schedule: (fn) => queue.push(fn) && queue.length,
    cancel: () => queue.splice(0, queue.length),
    advance(ms) {
      time += ms;
      const due = queue.splice(0, queue.length);
      for (const fn of due) fn();
    },
  };
}

describe('the easing and the settle path', () => {
  test('easing runs from 0 to 1 and is clamped outside', () => {
    assert.equal(easeOutCubic(0), 0);
    assert.equal(easeOutCubic(1), 1);
    assert.equal(easeOutCubic(-5), 0);
    assert.equal(easeOutCubic(9), 1);
    assert.ok(easeOutCubic(0.5) > 0.5, 'ease-out must be past halfway at the midpoint');
  });

  test('settling starts at the old position and ends exactly at the new one', () => {
    const from = { x: 0, y: 0 };
    const to = { x: 100, y: 50 };
    assert.deepEqual(settlePosition(from, to, 0), { x: 0, y: 0 });
    assert.deepEqual(settlePosition(from, to, 1), { x: 100, y: 50 });
  });

  test('a mark with nowhere to come from starts where it belongs', () => {
    // A first draw has nothing to animate; flying in from a corner would be invention.
    assert.deepEqual(settlePosition(undefined, { x: 7, y: 9 }, 0), { x: 7, y: 9 });
    assert.deepEqual(settlePosition(null, { x: 7, y: 9 }, 0.5), { x: 7, y: 9 });
  });
});

describe('the drift is a function of the data and the clock, nothing else', () => {
  test('the same node drifts identically on two runs', () => {
    // ⚠️ No Math.random, and not only because this project forbids it: with a random
    // phase, two screenshots of one sub-log seconds apart would differ by more than the
    // drift, because every node would have restarted somewhere else.
    for (const t of [0, 500, 3000]) {
      assert.deepEqual(driftOffset('n_commit:a', t), driftOffset('n_commit:a', t));
    }
  });

  test('two nodes are out of phase, so the picture does not pulse in step', () => {
    assert.notEqual(driftPhase('n_commit:a'), driftPhase('n_commit:b'));
    const a = driftOffset('n_commit:a', 800);
    const b = driftOffset('n_commit:b', 800);
    assert.ok(Math.abs(a.dx - b.dx) > 1e-6 || Math.abs(a.dy - b.dy) > 1e-6);
  });

  test('the two axes run at different rates, so nodes trace a curve rather than a circle', () => {
    // A ring of nodes all orbiting in step would read as the whole drawing rotating,
    // which is a claim about the picture that nothing in the data supports.
    const samples = [0, 400, 900, 1500, 2600].map((t) => driftOffset('n_commit:a', t));
    const ratios = samples.map((s) => (s.dy === 0 ? Infinity : s.dx / s.dy));
    assert.ok(new Set(ratios.map((r) => r.toFixed(3))).size > 1, 'the offset traces a circle');
  });

  test('it stays small — a wander, not a journey', () => {
    for (let t = 0; t < 12000; t += 97) {
      const { dx, dy } = driftOffset('n_pr:1', t);
      assert.ok(Math.abs(dx) <= 2.5 && Math.abs(dy) <= 2.5, `drifted ${dx},${dy} at ${t}ms`);
    }
  });

  test('averaged over a cycle it comes to nothing, so position is unchanged', () => {
    // The whole justification for drifting at all: it is an offset around the computed
    // position, not a contribution to it.
    let sumX = 0;
    let sumY = 0;
    const steps = 2000;
    for (let i = 0; i < steps; i++) {
      const { dx, dy } = driftOffset('n_issue:1', (i / steps) * 5200 * 100);
      sumX += dx;
      sumY += dy;
    }
    assert.ok(Math.abs(sumX / steps) < 0.05, `mean x drift ${sumX / steps}`);
    assert.ok(Math.abs(sumY / steps) < 0.05, `mean y drift ${sumY / steps}`);
  });
});

describe('driving a scene', () => {
  test('marks land exactly on their computed positions once settled', () => {
    const clock = harness();
    const motion = createMotion({ reduced: false, ...clock });
    const s = scene(3, { from: true });
    motion.play(s);

    clock.advance(SETTLE_MS * 2);
    for (const mark of s.marks) {
      const at = s.painted.get(mark.id);
      // Within the drift, which is the point: the drift is around the position, not away.
      assert.ok(Math.abs(at.x - mark.x) <= 2.5, `${mark.id} settled at ${at.x}, wanted ${mark.x}`);
      assert.ok(Math.abs(at.y - mark.y) <= 2.5);
    }
    motion.stop();
  });

  test('edges are recomputed from wherever their ends are', () => {
    // Transforming an edge instead would let it come adrift from the marks it joins,
    // visibly, and only while something was moving.
    const clock = harness();
    const motion = createMotion({ reduced: false, ...clock });
    const s = scene(3, { from: true });
    motion.play(s);
    clock.advance(100);

    assert.ok(s.drawn.length > 0, 'edges must be redrawn as their ends move');
    const [a, b] = s.drawn[s.drawn.length - 1];
    assert.ok(Number.isFinite(a.x) && Number.isFinite(b.x));
    motion.stop();
  });

  test('reduced motion puts everything where it belongs and stops', () => {
    // Honoured rather than offered as a setting: the same picture, without the journey.
    const clock = harness();
    const motion = createMotion({ reduced: true, ...clock });
    const s = scene(2, { from: true });
    motion.play(s);

    clock.advance(SETTLE_MS + 50);
    for (const mark of s.marks) {
      assert.deepEqual(s.painted.get(mark.id), { x: mark.x, y: mark.y }, 'no drift, no offset');
    }
    clock.advance(1000);
    assert.equal(motion.isRunning(), false, 'the loop must not run forever for no reason');
  });

  test('playing a new scene stops the old one', () => {
    // Every re-render replaces the scene. Two loops running at once would fight over the
    // same nodes, and the older one would be driving marks that no longer exist.
    const clock = harness();
    const motion = createMotion({ reduced: false, ...clock });
    const first = scene(2, { from: true });
    motion.play(first);
    clock.advance(50);
    const before = first.painted.get(first.marks[0].id);

    motion.play(scene(2, { from: true }));
    clock.advance(200);
    assert.deepEqual(
      first.painted.get(first.marks[0].id),
      before,
      'the replaced scene must stop being painted',
    );
    motion.stop();
  });

  test('an empty scene is not an animation', () => {
    const clock = harness();
    const motion = createMotion({ reduced: false, ...clock });
    motion.play({ marks: [], edges: [] });
    assert.equal(motion.isRunning(), false);
  });

  test('stopping is idempotent and safe before anything played', () => {
    const motion = createMotion({ reduced: false, ...harness() });
    motion.stop();
    motion.stop();
    assert.equal(motion.isRunning(), false);
  });
});

describe('dragging pushes what is in the way', () => {
  test('an overlapping neighbour is moved clear', () => {
    // Without this a reader can stack the whole graph on one point — a picture that says
    // nothing and cannot be recovered from except by resetting.
    const marks = [
      { id: 'a', x: 100, y: 100, radius: 12 },
      { id: 'b', x: 108, y: 100, radius: 12 },
    ];
    pushApart(marks);
    const gap = Math.hypot(marks[0].x - marks[1].x, marks[0].y - marks[1].y);
    assert.ok(gap >= 24, `still overlapping: ${gap.toFixed(1)} apart, need 24`);
  });

  test('the mark under the pointer does not move — it goes where it was put', () => {
    const marks = [
      { id: 'dragged', x: 100, y: 100, radius: 12 },
      { id: 'other', x: 104, y: 100, radius: 12 },
    ];
    pushApart(marks, { fixedId: 'dragged' });
    assert.equal(marks[0].x, 100, 'the dragged mark must land exactly where the pointer is');
    assert.equal(marks[0].y, 100);
    assert.ok(marks[1].x > 104, 'and the other one takes the whole shove');
  });

  test('a shove propagates through a crowd rather than stopping at the first neighbour', () => {
    const marks = Array.from({ length: 6 }, (_, i) => ({
      id: `n${i}`,
      x: 100 + i * 4,
      y: 100,
      radius: 10,
    }));
    pushApart(marks, { fixedId: 'n0' });
    const sorted = marks.slice().sort((a, b) => a.x - b.x);
    for (let i = 1; i < sorted.length; i++) {
      const gap = sorted[i].x - sorted[i - 1].x - sorted[i].radius - sorted[i - 1].radius;
      assert.ok(gap > -1e-6, `${sorted[i].id} still overlaps its neighbour`);
    }
  });

  test('marks already clear of each other are left exactly alone', () => {
    const marks = [
      { id: 'a', x: 0, y: 0, radius: 10 },
      { id: 'b', x: 400, y: 400, radius: 10 },
    ];
    pushApart(marks);
    assert.deepEqual(marks, [
      { id: 'a', x: 0, y: 0, radius: 10 },
      { id: 'b', x: 400, y: 400, radius: 10 },
    ]);
  });

  test('exactly coincident marks separate, deterministically', () => {
    const at = () => [
      { id: 'a', x: 50, y: 50, radius: 10 },
      { id: 'b', x: 50, y: 50, radius: 10 },
    ];
    const first = pushApart(at());
    const second = pushApart(at());
    assert.deepEqual(first, second, 'the tie-break must not vary between runs');
    assert.ok(Math.hypot(first[0].x - first[1].x, first[0].y - first[1].y) > 19);
  });

  test('it does not depend on the order the marks are given in', () => {
    const build = () => [
      { id: 'a', x: 100, y: 100, radius: 12 },
      { id: 'b', x: 106, y: 103, radius: 12 },
      { id: 'c', x: 96, y: 108, radius: 12 },
    ];
    const forwards = pushApart(build());
    const backwards = pushApart(build().reverse());
    for (const id of ['a', 'b', 'c']) {
      const a = forwards.find((m) => m.id === id);
      const b = backwards.find((m) => m.id === id);
      assert.equal(a.x, b.x, `${id} depends on input order`);
      assert.equal(a.y, b.y);
    }
  });
});

describe('a gesture holds the drift still', () => {
  test('held, a mark stays exactly where it is put across repaints', () => {
    /*
     * ⚠️ Reported as the picture being "weird and jittery" while dragging, and that is
     * what it was: `repaint()` paints at the current elapsed time, so every pointer event
     * recomputed the idle wander — up to ±2.4px per mark, per event, on top of whatever
     * the drag was moving. Two things writing positions at pointer rate, one of them for
     * no reason.
     */
    const clock = harness();
    const motion = createMotion({ reduced: false, ...clock });
    const s = scene(3);
    motion.play(s);
    clock.advance(SETTLE_MS * 2);

    motion.hold();
    motion.repaint();
    const held = new Map([...s.painted].map(([id, at]) => [id, { ...at }]));

    // Time passes, as it does during a drag.
    clock.advance(900);
    motion.repaint();
    for (const [id, at] of s.painted) {
      assert.deepEqual(at, held.get(id), `${id} moved while the gesture was held`);
    }
    motion.stop();
  });

  test('released, it breathes again — and does not jump to catch up', () => {
    // Held at the settled point rather than at the current time, so letting go does not
    // snap the whole picture to wherever the wander had got to while you were busy.
    const clock = harness();
    const motion = createMotion({ reduced: false, ...clock });
    const s = scene(2);
    motion.play(s);
    clock.advance(SETTLE_MS * 2);

    motion.hold();
    motion.repaint();
    const before = new Map([...s.painted].map(([id, at]) => [id, { ...at }]));

    clock.advance(4000);
    motion.release();
    motion.repaint();
    for (const [id, at] of s.painted) {
      const was = before.get(id);
      assert.ok(
        Math.hypot(at.x - was.x, at.y - was.y) < 3,
        `${id} jumped ${Math.hypot(at.x - was.x, at.y - was.y).toFixed(1)}px on release`,
      );
    }
    motion.stop();
  });
});
