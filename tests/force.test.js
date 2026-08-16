import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  layoutForce,
  fitPositions,
  relaxOverlaps,
  iterationsFor,
  hashId,
} from '../src/layout/force.js';

/**
 * The force layout behind the **off** time mode.
 *
 * Three of these tests are the mode's acceptance criteria rather than ordinary coverage:
 * determinism, insertion-order independence, and stability under expand/collapse. A force
 * layout that re-rolls itself on every render is not a layout, it is an animation — and
 * the failure is invisible in a diff, which is exactly the class of defect this project
 * keeps finding by looking rather than by checking.
 */

const nodesFrom = (...ids) => ids.map((id) => ({ id }));

/** A small hub: one issue, three PRs, two commits under each PR. */
function hubGraph() {
  const nodes = nodesFrom(
    'issue:1',
    'pr:1',
    'pr:2',
    'pr:3',
    'commit:a',
    'commit:b',
    'commit:c',
    'commit:d',
    'commit:e',
    'commit:f',
  );
  const edges = [
    { source: 'issue:1', target: 'pr:1' },
    { source: 'issue:1', target: 'pr:2' },
    { source: 'issue:1', target: 'pr:3' },
    { source: 'pr:1', target: 'commit:a' },
    { source: 'pr:1', target: 'commit:b' },
    { source: 'pr:2', target: 'commit:c' },
    { source: 'pr:2', target: 'commit:d' },
    { source: 'pr:3', target: 'commit:e' },
    { source: 'pr:3', target: 'commit:f' },
  ];
  return { nodes, edges };
}

const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

describe('the force layout is deterministic', () => {
  test('the same graph laid out twice gives bit-identical coordinates', () => {
    const { nodes, edges } = hubGraph();
    const first = layoutForce({ nodes, edges });
    const second = layoutForce({ nodes, edges });

    assert.equal(first.size, second.size);
    for (const [id, position] of first) {
      const other = second.get(id);
      // Bit-identical, not approximately equal. Anything that drifts between two calls
      // on identical input has a source of nondeterminism in it, and "small" today is
      // not a guarantee about tomorrow.
      assert.equal(position.x, other.x, `x drifted for ${id}`);
      assert.equal(position.y, other.y, `y drifted for ${id}`);
    }
  });

  test('the order the caller lists nodes in cannot change the result', () => {
    // Floating-point addition is not associative, so accumulating forces in array order
    // would silently make the picture depend on how the node list was built.
    const { nodes, edges } = hubGraph();
    const forwards = layoutForce({ nodes, edges });
    const backwards = layoutForce({ nodes: nodes.slice().reverse(), edges });

    for (const [id, position] of forwards) {
      const other = backwards.get(id);
      assert.equal(position.x, other.x, `x depends on input order for ${id}`);
      assert.equal(position.y, other.y, `y depends on input order for ${id}`);
    }
  });

  test('the order the caller lists EDGES in cannot change the result either', () => {
    const { nodes, edges } = hubGraph();
    const forwards = layoutForce({ nodes, edges });
    const shuffled = layoutForce({ nodes, edges: edges.slice().reverse() });

    // Bit-identical, like the node-order case: `layoutForce` sorts the edge list before
    // it sums anything. This test failed when written — sorting the nodes alone left the
    // per-edge attraction accumulating in caller order — which is why it is here.
    for (const [id, position] of forwards) {
      const other = shuffled.get(id);
      assert.equal(position.x, other.x, `edge order moved ${id} horizontally`);
      assert.equal(position.y, other.y, `edge order moved ${id} vertically`);
    }
  });

  test('a node is seeded from its own id, never from its index', () => {
    // The stability property in miniature: the same id must hash the same way, and two
    // ids must not collide onto one seed, or two nodes would start on the same point.
    assert.equal(hashId('commit:abc'), hashId('commit:abc'));
    assert.notEqual(hashId('commit:abc'), hashId('commit:abd'));
    assert.notEqual(hashId('pr:1'), hashId('pr:2'));
  });
});

describe('the force layout produces a usable picture', () => {
  test('every node gets a finite position', () => {
    const { nodes, edges } = hubGraph();
    for (const [id, { x, y }] of layoutForce({ nodes, edges })) {
      assert.ok(Number.isFinite(x), `${id} has a non-finite x`);
      assert.ok(Number.isFinite(y), `${id} has a non-finite y`);
    }
  });

  test('no two nodes end up on the same point', () => {
    const { nodes, edges } = hubGraph();
    const positions = [...layoutForce({ nodes, edges }).values()];
    for (let i = 0; i < positions.length; i++) {
      for (let j = i + 1; j < positions.length; j++) {
        assert.ok(distance(positions[i], positions[j]) > 1, 'two nodes are coincident');
      }
    }
  });

  test('coincident starting points still separate', () => {
    // Two nodes seeded onto the identical spot have no direction to push apart along.
    // The tie-break has to come from somewhere deterministic, or they stay welded.
    const nodes = nodesFrom('a', 'b', 'c');
    const previous = new Map([
      ['a', { x: 0, y: 0 }],
      ['b', { x: 0, y: 0 }],
      ['c', { x: 0, y: 0 }],
    ]);
    const positions = layoutForce({ nodes, edges: [], previous });
    const values = [...positions.values()];
    for (let i = 0; i < values.length; i++) {
      for (let j = i + 1; j < values.length; j++) {
        assert.ok(distance(values[i], values[j]) > 0.5, 'coincident nodes did not separate');
      }
    }
  });

  test('connected nodes end up closer than unconnected ones', () => {
    // The whole claim of the mode: relational proximity becomes spatial proximity.
    const nodes = nodesFrom('a1', 'a2', 'b1', 'b2');
    const edges = [
      { source: 'a1', target: 'a2' },
      { source: 'b1', target: 'b2' },
    ];
    const positions = layoutForce({ nodes, edges });
    const withinA = distance(positions.get('a1'), positions.get('a2'));
    const across = distance(positions.get('a1'), positions.get('b1'));
    assert.ok(withinA < across, 'a linked pair must sit closer than an unlinked one');
  });

  test('an empty graph and a single node are both handled', () => {
    assert.equal(layoutForce({ nodes: [], edges: [] }).size, 0);
    const one = layoutForce({ nodes: nodesFrom('only'), edges: [] });
    assert.deepEqual(one.get('only'), { x: 0, y: 0 });
  });

  test('a node with no edges at all is still placed, not flung away', () => {
    // Decision 67: a seed that reaches nothing is a legitimate answer, so an isolated
    // node is a real case rather than a malformed one. Gravity is what bounds it.
    const nodes = nodesFrom('lonely', 'a', 'b');
    const positions = layoutForce({
      nodes,
      edges: [{ source: 'a', target: 'b' }],
      width: 1000,
      height: 700,
    });
    const { x, y } = positions.get('lonely');
    assert.ok(Math.hypot(x, y) < 5000, 'an unconnected node drifted out of any usable box');
  });
});

describe('the force layout is stable under expand and collapse', () => {
  test('adding nodes leaves the existing ones roughly where they were', () => {
    // Expanding a burst must not reshuffle the whole graph. Without a warm start the
    // simulation is a fresh global optimisation and every node moves, which reads as the
    // picture being redrawn from scratch — object constancy destroyed by one click.
    const { nodes, edges } = hubGraph();
    const before = layoutForce({ nodes, edges });

    const expanded = {
      nodes: [...nodes, ...nodesFrom('commit:g', 'commit:h', 'commit:i')],
      edges: [
        ...edges,
        { source: 'pr:1', target: 'commit:g' },
        { source: 'pr:1', target: 'commit:h' },
        { source: 'pr:1', target: 'commit:i' },
      ],
    };
    const after = layoutForce({ ...expanded, previous: before });

    // The span of the picture is the scale to judge movement against.
    const xs = [...before.values()].map((p) => p.x);
    const ys = [...before.values()].map((p) => p.y);
    const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));

    for (const [id, position] of before) {
      const moved = distance(position, after.get(id));
      assert.ok(
        moved < span * 0.35,
        `${id} moved ${Math.round(moved)} of a ${Math.round(span)} span when three nodes were added`,
      );
    }
  });

  test('new nodes appear beside the neighbour they belong to, not across the picture', () => {
    const { nodes, edges } = hubGraph();
    const before = layoutForce({ nodes, edges });
    const after = layoutForce({
      nodes: [...nodes, { id: 'commit:new' }],
      edges: [...edges, { source: 'pr:1', target: 'commit:new' }],
      previous: before,
    });

    const toItsPr = distance(after.get('commit:new'), after.get('pr:1'));
    const toOtherPr = distance(after.get('commit:new'), after.get('pr:3'));
    assert.ok(toItsPr < toOtherPr, 'a new node must land near the node it links to');
  });

  test('a warm start with no changes at all barely moves anything', () => {
    const { nodes, edges } = hubGraph();
    const first = layoutForce({ nodes, edges });
    const second = layoutForce({ nodes, edges, previous: first });
    for (const [id, position] of first) {
      assert.ok(
        distance(position, second.get(id)) < 60,
        `${id} moved on a re-layout of identical input`,
      );
    }
  });
});

describe('the work budget keeps a dense sub-log affordable', () => {
  test('iteration count falls as the graph grows', () => {
    assert.ok(iterationsFor(10) > iterationsFor(300), 'a big graph must run fewer iterations');
    assert.ok(iterationsFor(10) <= 400, 'and never more than the cap');
    assert.ok(iterationsFor(5000) >= 80, 'nor fewer than the floor');
  });

  test('F10-scale density lays out inside a sane time budget', () => {
    // F10 is 300 commits. The timeline's own budget test uses the same shape of check;
    // this one exists because an all-pairs force is the obvious place for this mode to
    // become unusable on exactly the sub-logs a process study cares about.
    const nodes = Array.from({ length: 300 }, (_, i) => ({ id: `commit:${i}` }));
    const edges = Array.from({ length: 299 }, (_, i) => ({
      source: `commit:${i}`,
      target: `commit:${i + 1}`,
    }));
    const started = Date.now();
    const positions = layoutForce({ nodes, edges });
    const elapsed = Date.now() - started;
    assert.equal(positions.size, 300);
    assert.ok(elapsed < 3000, `300 nodes took ${elapsed}ms`);
  });
});

describe('fitting a layout into a box', () => {
  test('scaling preserves relative arrangement', () => {
    const positions = new Map([
      ['a', { x: -100, y: -50 }],
      ['b', { x: 100, y: 50 }],
      ['c', { x: 0, y: 0 }],
    ]);
    const fitted = fitPositions(positions, { width: 800, height: 400, padding: 40 });

    // c is the midpoint before, so it must be the midpoint after.
    assert.ok(Math.abs(fitted.get('c').x - 400) < 1e-6);
    assert.ok(Math.abs(fitted.get('c').y - 200) < 1e-6);
    assert.ok(fitted.get('a').x < fitted.get('c').x);
    assert.ok(fitted.get('b').x > fitted.get('c').x);
  });

  test('everything lands inside the padded box', () => {
    const { nodes, edges } = hubGraph();
    const fitted = fitPositions(layoutForce({ nodes, edges }), {
      width: 900,
      height: 600,
      padding: 40,
    });
    for (const [id, { x, y }] of fitted) {
      assert.ok(x >= 39 && x <= 861, `${id} escaped the box horizontally at ${x}`);
      assert.ok(y >= 39 && y <= 561, `${id} escaped the box vertically at ${y}`);
    }
  });

  test('a degenerate layout does not divide by zero', () => {
    // One node, or a perfectly vertical line, has zero span in a direction.
    const single = fitPositions(new Map([['a', { x: 0, y: 0 }]]), { width: 400, height: 300 });
    assert.deepEqual(single.get('a'), { x: 200, y: 150 });

    const vertical = fitPositions(
      new Map([
        ['a', { x: 0, y: -10 }],
        ['b', { x: 0, y: 10 }],
      ]),
      { width: 400, height: 300 },
    );
    for (const [id, { x, y }] of vertical) {
      assert.ok(Number.isFinite(x) && Number.isFinite(y), `${id} is not finite`);
    }
  });
});

describe('overlap relaxation, because fitting scales positions but not radii', () => {
  test('marks that collide after fitting are pushed apart', () => {
    // ⚠️ Found by looking at F10, not by a check. The simulation separates nodes in its
    // own space; `fitPositions` then scales that space into the viewport, and any fit
    // below 1x brings marks closer in pixels while they keep their drawn size. That put a
    // 40-commit push meta-node on top of the pull request it belongs to, with the label
    // unreadable underneath — 7 colliding pairs on F10, the deepest by 5.6px.
    const nodes = [
      { id: 'big', radius: 20 },
      { id: 'small', radius: 6 },
      { id: 'far', radius: 6 },
    ];
    const positions = new Map([
      ['big', { x: 100, y: 100 }],
      ['small', { x: 110, y: 100 }], // 10px apart, needs 26 + padding
      ['far', { x: 400, y: 400 }],
    ]);

    const relaxed = relaxOverlaps(positions, nodes);
    const gap = Math.hypot(
      relaxed.get('big').x - relaxed.get('small').x,
      relaxed.get('big').y - relaxed.get('small').y,
    );
    assert.ok(gap >= 26, `rims still overlap: ${gap.toFixed(1)}px apart, need 26`);
    // Anything already clear must not be dragged around by the pass.
    assert.deepEqual(relaxed.get('far'), { x: 400, y: 400 });
  });

  test('it is deterministic, including for exactly coincident marks', () => {
    const nodes = [
      { id: 'a', radius: 10 },
      { id: 'b', radius: 10 },
    ];
    const at = () =>
      new Map([
        ['a', { x: 50, y: 50 }],
        ['b', { x: 50, y: 50 }],
      ]);
    const first = relaxOverlaps(at(), nodes);
    const second = relaxOverlaps(at(), nodes);
    for (const id of ['a', 'b']) {
      assert.equal(first.get(id).x, second.get(id).x);
      assert.equal(first.get(id).y, second.get(id).y);
    }
    assert.ok(
      Math.hypot(first.get('a').x - first.get('b').x, first.get('a').y - first.get('b').y) > 19,
      'coincident marks must separate to their combined radii',
    );
  });

  test('it does not depend on the order nodes are passed in', () => {
    const nodes = [
      { id: 'a', radius: 12 },
      { id: 'b', radius: 12 },
      { id: 'c', radius: 12 },
    ];
    const at = () =>
      new Map([
        ['a', { x: 0, y: 0 }],
        ['b', { x: 8, y: 3 }],
        ['c', { x: -5, y: 6 }],
      ]);
    const forwards = relaxOverlaps(at(), nodes);
    const backwards = relaxOverlaps(at(), nodes.slice().reverse());
    for (const id of ['a', 'b', 'c']) {
      assert.equal(forwards.get(id).x, backwards.get(id).x, `${id} depends on input order`);
      assert.equal(forwards.get(id).y, backwards.get(id).y);
    }
  });

  test('a single node, or none, is left alone', () => {
    assert.equal(relaxOverlaps(new Map(), []).size, 0);
    const one = new Map([['a', { x: 3, y: 4 }]]);
    assert.deepEqual(relaxOverlaps(one, [{ id: 'a', radius: 5 }]).get('a'), { x: 3, y: 4 });
  });
});
